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
import DatabaseCtor from 'better-sqlite3';
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

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      apprenticeshipPeerCycleReader: async (instanceId) => ({
        cycles: instanceId === 'cross-agent-layer' ? [{
          id: 'echo-owned-keystone', instanceId, cycleNumber: 1,
          createdAt: '2026-07-16T18:00:00.000Z', task: 'Echo drove Codey remotely', menteeOutput: 'output',
          mentorFlagged: [], overseerDifferential: [], coaching: '', infraItems: [],
          kind: 'mentor-mentee-differential', status: 'open', channel: 'threadline-backup',
          operatorSeatUx: null, transcriptAudit: null,
        }] : [],
        sources: [{ agent: 'echo', port: 4042, cycleCount: instanceId === 'cross-agent-layer' ? 1 : 0, truncated: false }],
        complete: true,
        omittedPeerCount: 0,
      }),
    });
    await server.start();
    app = server.getApp();

    // Cycle recording is referentially tied to LIVE registry state. Seed the
    // active instances used by the drive/coverage tests through the real API.
    for (const id of ['echo-to-codey', 'role-drift', 'dormant-layer', 'cross-agent-layer']) {
      await request(app)
        .post('/apprenticeship/instances')
        .set({ Authorization: `Bearer ${AUTH}` })
        .send({ id, instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null })
        .expect(201);
      await request(app)
        .post(`/apprenticeship/instances/${id}/transition`)
        .set({ Authorization: `Bearer ${AUTH}` })
        .send({ to: 'active' })
        .expect(200);
    }
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
        operatorSeatUx: { dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0, modalitiesExercised: ['text'], duringRestartChurn: false },
        mentorFlagged: ['mentor finding'],
        overseerDifferential: ['overseer finding'],
        coaching: 'coaching note',
        infraItems: ['infra follow-up'],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.overseerDifferential).toEqual(['overseer finding']);
  });

  it('the transcript-audit gate is ALIVE through AgentServer: telegram-playwright refuses without it, records with it', async () => {
    const base = {
      instanceId: 'echo-to-codey',
      cycleNumber: 3,
      task: 'Playwright drive of the mentee',
      menteeOutput: 'mentee output',
      channel: 'telegram-playwright',
      operatorSeatUx: { dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0, modalitiesExercised: ['text'], duringRestartChurn: false },
    };

    const refused = await request(app).post('/apprenticeship/cycles').set(auth()).send({ ...base, id: 'e2e-tp-refused' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('transcriptAudit is required for telegram-playwright cycles');

    const accepted = await request(app).post('/apprenticeship/cycles').set(auth()).send({
      ...base,
      id: 'e2e-tp-audited',
      transcriptAudit: {
        topicIds: [1052],
        window: { start: '2026-06-03T07:00:00.000Z', end: '2026-06-03T08:00:00.000Z' },
        summary: { total: 0 },
        findingDedupKeys: [],
        generatedAt: '2026-06-03T08:01:00.000Z',
        ledger: 'dry-run',
      },
    });
    expect(accepted.status).toBe(201);

    const fetched = await request(app).get('/apprenticeship/cycles/e2e-tp-audited').set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body.transcriptAudit.ledger).toBe('dry-run');
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
        operatorSeatUx: { dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0, modalitiesExercised: ['text'], duringRestartChurn: false },
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
        operatorSeatUx: { dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0, modalitiesExercised: ['text'], duringRestartChurn: false },
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
        operatorSeatUx: { dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0, modalitiesExercised: ['text'], duringRestartChurn: false },
        kind: 'overseer-apprentice-devreview',
      })
      .expect(201);

    const res = await request(app).get('/apprenticeship/instances/role-drift/role-coverage').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.driftWarning).toBe(true);
    expect(res.body.axes['mentor-mentee-differential'].fired).toBe(false);
    expect(res.body.axes['overseer-apprentice-devreview'].cycleCount).toBe(2);
    // keystoneBalance (2026-06-06 mentor/mentee balance signal) is ALIVE through
    // the real AgentServer: this instance reviewed twice but never drove its
    // mentee, so the deepest layer reads as starved — observe-only, never gates.
    expect(res.body.keystoneBalance.starved).toBe(true);
    expect(res.body.keystoneBalance.keystoneAxis).toBe('mentor-mentee-differential');
    expect(res.body.keystoneBalance.oversightSinceKeystone).toBe(2);
    // dormancy dimension is ALIVE through AgentServer: the keystone never fired
    // here, so it is not dormant, but the fields are surfaced (not undefined).
    expect(res.body.keystoneBalance.dormant).toBe(false);
    expect(res.body.keystoneBalance.lastKeystoneAgeMs).toBeNull();
    expect(typeof res.body.keystoneBalance.dormancyThresholdMs).toBe('number');
  });

  it('keystoneBalance dormancy is ALIVE through AgentServer: a long-stale keystone reads dormant, not starved', async () => {
    // A single keystone drive stamped far in the past (unset channel → grandfathered
    // → fires the keystone), nothing since. The real AgentServer store uses the real
    // clock, so this is far older than the 6h default → dormant without being starved.
    await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'e2e-keystone-stale-1',
        instanceId: 'dormant-layer',
        cycleNumber: 1,
        createdAt: '2026-06-03T08:00:00.000Z',
        task: 'mentee drive long ago',
        menteeOutput: 'output',
        operatorSeatUx: { dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0, modalitiesExercised: ['text'], duringRestartChurn: false },
        kind: 'mentor-mentee-differential',
      })
      .expect(201);

    const res = await request(app).get('/apprenticeship/instances/dormant-layer/role-coverage').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.keystoneBalance.starved).toBe(false); // no oversight piled up since
    expect(res.body.keystoneBalance.dormant).toBe(true); // but long silent → dormant
    expect(res.body.keystoneBalance.lastKeystoneAgeMs).toBeGreaterThan(6 * 60 * 60 * 1000);
    expect(res.body.keystoneBalance.reason).toMatch(/dormant/i);
  });

  it('cross-agent keystone evidence is ALIVE through AgentServer and prevents a false starved result', async () => {
    const res = await request(app).get('/apprenticeship/instances/cross-agent-layer/role-coverage').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.axes['mentor-mentee-differential']).toMatchObject({ fired: true, cycleCount: 1 });
    expect(res.body.keystoneBalance.starved).toBe(false);
    expect(res.body.aggregation).toMatchObject({ scope: 'registered-agents', complete: true });
    expect(res.body.aggregation.peerSources).toContainEqual(expect.objectContaining({ agent: 'echo', cycleCount: 1 }));
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/apprenticeship/instances');
    expect(res.status).toBe(401);
  });

  it('refuses phantom/non-active cycles and retains a disposed pending instance', async () => {
    await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({ id: 'phantom-cycle', instanceId: 'missing-instance', cycleNumber: 1, task: 'must refuse', menteeOutput: 'none' })
      .expect(400);

    await request(app)
      .post('/apprenticeship/instances')
      .set(auth())
      .send({ id: 'miscreated-pending', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null })
      .expect(201);
    await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({ id: 'pending-cycle', instanceId: 'miscreated-pending', cycleNumber: 1, task: 'must refuse', menteeOutput: 'none' })
      .expect(400);

    const disposed = await request(app)
      .post('/apprenticeship/instances/miscreated-pending/transition')
      .set(auth())
      .send({ to: 'abandoned' });
    expect(disposed.status).toBe(200);
    expect(disposed.body.instance.status).toBe('abandoned');

    const retained = await request(app).get('/apprenticeship/instances/miscreated-pending').set(auth());
    expect(retained.status).toBe(200);
    expect(retained.body.status).toBe('abandoned');
  });

  it('keeps the production integrity route alive with a legacy bad-kind row', async () => {
    await request(app)
      .post('/apprenticeship/instances')
      .set(auth())
      .send({ id: 'legacy-kind-instance', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null })
      .expect(201);
    await request(app)
      .post('/apprenticeship/instances/legacy-kind-instance/transition')
      .set(auth())
      .send({ to: 'active' })
      .expect(200);
    await request(app)
      .post('/apprenticeship/cycles')
      .set(auth())
      .send({
        id: 'legacy-bad-kind-e2e',
        instanceId: 'legacy-kind-instance',
        cycleNumber: 1,
        task: 'legacy',
        menteeOutput: 'kept',
        operatorSeatUx: { dupNotices: 0, infraNoiseMsgs: 0, asksOfUser: 0, contentFreeUpdates: 0, modalitiesExercised: ['text'], duringRestartChurn: false },
      })
      .expect(201);

    const db = new DatabaseCtor(path.join(stateDir, 'server-data', 'apprenticeship-cycles.db'));
    db.prepare(`UPDATE apprenticeship_cycles SET kind = 'mentorship' WHERE id = ?`).run('legacy-bad-kind-e2e');
    db.close();

    const report = await request(app).get('/apprenticeship/cycles/integrity').set(auth());
    expect(report.status).toBe(200);
    expect(report.body.scanned).toBeGreaterThanOrEqual(1);
  });

  it('full lifecycle: create → transition pending→active gated on the real on-disk harvest', async () => {
    const created = await request(app)
      .post('/apprenticeship/instances')
      .set(auth())
      .send({ id: 'lifecycle-instance', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');

    // The start gate reads the real harvest at the canonical path via the
    // production-wired default deps → allowed.
    const transitioned = await request(app)
      .post('/apprenticeship/instances/lifecycle-instance/transition')
      .set(auth())
      .send({ to: 'active' });
    expect(transitioned.status).toBe(200);
    expect(transitioned.body.ok).toBe(true);
    expect(transitioned.body.instance.status).toBe('active');

    // The instance persisted and is visible in the list.
    const list = await request(app).get('/apprenticeship/instances').set(auth());
    expect(list.body.instances.some((i: { id: string; status: string }) => i.id === 'lifecycle-instance' && i.status === 'active')).toBe(true);
  });
});
