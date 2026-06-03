// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Apprenticeship Program
 * (Apprenticeship Step 1).
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for a feature with
 * API routes — is it actually alive on the production init path (returns 200,
 * not 404/503)? This boots the REAL AgentServer (the same path server.ts uses)
 * and verifies:
 *   1. GET /apprenticeship/instances returns 200 through AgentServer (not 503).
 *   2. POST /apprenticeship/cycles returns 201 through AgentServer (not 503).
 *   3. GET /apprenticeship/cycles/overdue returns 200 through AgentServer
 *      when the default-off SLA monitor is explicitly enabled.
 *   4. GET /apprenticeship/instances/:id/role-coverage returns 200 through
 *      AgentServer (not 503) and reports drift for a dormant mentor loop.
 *   5. The route requires Bearer auth.
 *   6. The full lifecycle works end-to-end through the wired program: create →
 *      transition pending→active gated on a real on-disk harvest at the
 *      canonical path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

const SCHEMA_ID = 'apprenticeship-retro-harvest/v1';
function buildHarvest(): string {
  const fm: Record<string, unknown> = {
    schema: SCHEMA_ID,
    instanceType: 'mentorship',
    from: 'echo',
    to: 'codey',
    framework: 'codex-cli',
    harvestedAt: '2026-06-02T03:00:00Z',
    scopeMode: 'full',
    completeness: 'complete',
    sourcesCovered: {
      ledger: { read: true, issueCount: 12 },
      playbook: { read: true, entryCount: 3 },
      memory: { read: true, files: 40 },
      threads: [{ id: 13435, messagesRead: 500, truncated: false }],
      prs: [666],
    },
    counts: { lessons: 1, metaLessons: 1, processInsights: 1 },
    seededToPlaybook: [],
    redaction: { scrubber: 'correction-scrub@v1', findingsRemoved: 2, scrubbedAt: '2026-06-02T03:00:00Z' },
    fidelityReview: { reviewer: 'indep', verdict: 'faithful', at: '2026-06-02T03:05:00Z' },
    programNeeds: 1,
  };
  const yamlLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  const body = ['## Lessons', '- l. ledger:4c4a8ded', '## Meta-lessons', '- m. thread:13435#m1', '## Process-insights', '- p.', '## What the program needs', '- need-001 x.'].join('\n');
  return `---\n${yamlLines}\n---\n\n${body}\n`;
}

describe('Apprenticeship Program E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-apprenticeship';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprenticeship-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // The bootstrap harvest at its canonical path under projectDir (=tmpDir).
    const harvestRel = 'docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md';
    const harvestFull = path.join(tmpDir, harvestRel);
    fs.mkdirSync(path.dirname(harvestFull), { recursive: true });
    fs.writeFileSync(harvestFull, buildHarvest());

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: { apprenticeshipCycleSla: { enabled: true, overdueAfterMinutes: 120 } }, updates: {},
    } as InstarConfig;

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/apprenticeship-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /apprenticeship/instances is alive (200, not 503) through AgentServer', async () => {
    const res = await request(app).get('/apprenticeship/instances').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.instances)).toBe(true);
  });

  it('POST /apprenticeship/cycles is alive (201, not 503) through AgentServer', async () => {
    const res = await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'e2e-cycle-1',
        instanceId: 'echo-to-codey',
        cycleNumber: 1,
        task: 'Run an apprenticeship differential cycle',
        menteeOutput: 'raw mentee output',
        mentorFlagged: ['mentor finding'],
        overseerDifferential: ['overseer finding'],
        coaching: 'coaching note',
        infraItems: ['infra follow-up'],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.overseerDifferential).toEqual(['overseer finding']);
  });

  it('GET /apprenticeship/cycles/overdue is alive (200, not 503) through AgentServer when enabled', async () => {
    await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'e2e-cycle-overdue',
        instanceId: 'echo-to-codey',
        cycleNumber: 2,
        createdAt: '2026-06-02T00:00:00.000Z',
        task: 'Run an older apprenticeship differential cycle',
        menteeOutput: 'old output',
      })
      .expect(201);

    const res = await request(app).get('/apprenticeship/cycles/overdue').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.overdue.some((c: { id: string }) => c.id === 'e2e-cycle-overdue')).toBe(true);
  });

  it('GET /apprenticeship/instances/:id/role-coverage is alive and observe-only through AgentServer', async () => {
    await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'e2e-role-review-1',
        instanceId: 'role-drift',
        cycleNumber: 1,
        createdAt: '2026-06-03T08:00:00.000Z',
        task: 'Overseer review 1',
        menteeOutput: 'review output',
        kind: 'overseer-apprentice-devreview',
      })
      .expect(201);
    await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'e2e-role-review-2',
        instanceId: 'role-drift',
        cycleNumber: 2,
        createdAt: '2026-06-03T09:00:00.000Z',
        task: 'Overseer review 2',
        menteeOutput: 'review output',
        kind: 'overseer-apprentice-devreview',
      })
      .expect(201);

    const res = await request(app).get('/apprenticeship/instances/role-drift/role-coverage').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.driftWarning).toBe(true);
    expect(res.body.axes['mentor-mentee-differential'].fired).toBe(false);
    expect(res.body.axes['overseer-apprentice-devreview'].cycleCount).toBe(2);
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/apprenticeship/instances');
    expect(res.status).toBe(401);
  });

  it('full lifecycle: create → transition pending→active gated on the real on-disk harvest', async () => {
    const created = await request(app)
      .post('/apprenticeship/instances')
      .set(auth())
      .send({ id: 'echo-to-codey', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');

    // The start gate reads the real harvest at the canonical path via the
    // production-wired default deps → allowed.
    const transitioned = await request(app)
      .post('/apprenticeship/instances/echo-to-codey/transition')
      .set(auth())
      .send({ to: 'active' });
    expect(transitioned.status).toBe(200);
    expect(transitioned.body.ok).toBe(true);
    expect(transitioned.body.instance.status).toBe('active');

    // The instance persisted and is visible in the list.
    const list = await request(app).get('/apprenticeship/instances').set(auth());
    expect(list.body.instances.some((i: { id: string; status: string }) => i.id === 'echo-to-codey' && i.status === 'active')).toBe(true);
  });
});
