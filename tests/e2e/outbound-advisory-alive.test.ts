// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the outbound-advisory
 * surface (spec outbound-jargon-filepath-gap §2.4): POST /messaging/preflight
 * and GET /messaging/advisory-log.
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer through the
 * production init path (same as server.ts) and proves the routes answer
 * 200 — not 404 (unregistered) and not 503 (dead wiring) — that auth is
 * enforced, that the audit JSONL lands on disk where the docs say it does,
 * and that the live-config kill switch flips the preflight to disabled
 * WITHOUT a restart.
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
  return { listRunningSessions: () => [], getSession: () => null, clearInjectionTracker: () => undefined };
}

describe('Outbound advisory E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-outbound-advisory';
  const liveValues: Record<string, unknown> = {};

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-advisory-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      // Production-shaped liveConfig handle (set + get) — same as server.ts.
      liveConfig: {
        set: (p: string, v: unknown) => {
          liveValues[p] = v;
        },
        get: <T,>(p: string, def: T): T => (p in liveValues ? (liveValues[p] as T) : def),
      },
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/outbound-advisory-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('POST /messaging/preflight is alive (200, advisories composed) on the production init path', async () => {
    const res = await request(app)
      .post('/messaging/preflight')
      .set(auth())
      .send({
        text: 'Reminder: review /Users/justin/projects/overdue.md today',
        messageKind: 'automated',
        topicId: 12476,
        jobSlug: 'evolution-overdue-check',
      });
    expect(res.status).toBe(200);
    expect(res.body.advisories.length).toBeGreaterThan(0);
    expect(res.body.advisories[0].code).toBe('RAW_FILE_PATH');
  });

  it('the audit JSONL actually lands on disk where the docs say (logs/outbound-advisory.jsonl)', async () => {
    const logPath = path.join(tmpDir, 'logs', 'outbound-advisory.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]).action).toBe('advised');
  });

  it('GET /messaging/advisory-log is alive and returns the entry', async () => {
    const res = await request(app).get('/messaging/advisory-log?limit=10').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].jobSlug).toBe('evolution-overdue-check');
  });

  it('both routes require the bearer token (401 without)', async () => {
    const pf = await request(app)
      .post('/messaging/preflight')
      .send({ text: 'x', messageKind: 'reply' });
    expect(pf.status).toBe(401);
    const log = await request(app).get('/messaging/advisory-log');
    expect(log.status).toBe(401);
  });

  it('the live-config kill switch disables the preflight WITHOUT a restart', async () => {
    liveValues['messaging.outboundAdvisory.enabled'] = false;
    const res = await request(app)
      .post('/messaging/preflight')
      .set(auth())
      .send({
        text: 'Reminder: review /Users/justin/projects/overdue.md today',
        messageKind: 'automated',
        topicId: 12476,
        jobSlug: 'evolution-overdue-check',
      });
    expect(res.status).toBe(200);
    expect(res.body.advisories).toEqual([]);
    expect(res.body.disabled).toBe(true);
    delete liveValues['messaging.outboundAdvisory.enabled'];
  });
});
