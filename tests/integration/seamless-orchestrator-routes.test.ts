/**
 * Integration tests for the seamless-orchestrator routes (llm-seamlessness-orchestrator.md §Component3):
 *   POST /intelligence/seamless-orchestrator/tick  — drives one manual soak tick
 *   GET  /intelligence/seamless-orchestrator/audit — the bounded audit tail + last-tick surface
 * Exercises the real Express routes over a fake poller: 200 + shape when the poller is wired
 * (the dev-gated-dark orchestrator is live), 503 when it is null (dark on the fleet).
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

interface FakePoller {
  tick(): Promise<unknown>;
  getLastTick(): unknown;
  getLastTickAt(): number | null;
  isBreakerOpen(): boolean;
}

function fakePoller(over: Partial<FakePoller> = {}): FakePoller {
  return {
    tick: async () => ({ ranProposePath: true, suspended: false, reason: 'ok', proposalCount: 1, actuated: 1, refused: 0 }),
    getLastTick: () => ({ ranProposePath: true, suspended: false, reason: 'ok', proposalCount: 1, actuated: 1, refused: 0 }),
    getLastTickAt: () => 1_700_000_000_000,
    isBreakerOpen: () => false,
    ...over,
  };
}

function ctxWith(orchestratorPoller: FakePoller | null, stateDir: string): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    orchestratorPoller,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(orchestratorPoller: FakePoller | null, stateDir: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(orchestratorPoller, stateDir)));
  return app;
}

function tmpStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-routes-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  return path.join(dir, '.instar');
}

describe('POST /intelligence/seamless-orchestrator/tick (integration)', () => {
  it('drives one tick and returns 200 {ran, tick} when the poller is wired', async () => {
    const res = await request(appWith(fakePoller(), tmpStateDir())).post('/intelligence/seamless-orchestrator/tick');
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
    expect(res.body.tick).toMatchObject({ proposalCount: 1, actuated: 1 });
  });

  it('reports ran:false when the poller no-ops (reentrancy → null)', async () => {
    const res = await request(appWith(fakePoller({ tick: async () => null }), tmpStateDir())).post('/intelligence/seamless-orchestrator/tick');
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(false);
  });

  it('returns 503 when the orchestrator is dark (poller null)', async () => {
    const res = await request(appWith(null, tmpStateDir())).post('/intelligence/seamless-orchestrator/tick');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/i);
  });
});

describe('GET /intelligence/seamless-orchestrator/audit (integration)', () => {
  it('returns 200 with the audit tail + last-tick surface when wired', async () => {
    const stateDir = tmpStateDir();
    // seed a would-actuate audit row where the route reads it (agent-home logs/)
    const logDir = path.join(stateDir, '..', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const row = { ts: '2026-07-05T12:00:00.000Z', action: 'preload-artifact', targetTopic: 7, decision: 'would-actuate', dryRun: true };
    fs.writeFileSync(path.join(logDir, 'orchestrator-actions.jsonl'), JSON.stringify(row) + '\n');
    const res = await request(appWith(fakePoller(), stateDir)).get('/intelligence/seamless-orchestrator/audit');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries[0]).toMatchObject({ decision: 'would-actuate', targetTopic: 7 });
    expect(res.body.lastTick).toMatchObject({ proposalCount: 1 });
    expect(res.body.breakerOpen).toBe(false);
  });

  it('returns an empty tail (not an error) when no audit log exists yet', async () => {
    const res = await request(appWith(fakePoller(), tmpStateDir())).get('/intelligence/seamless-orchestrator/audit');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('returns 503 when the orchestrator is dark (poller null)', async () => {
    const res = await request(appWith(null, tmpStateDir())).get('/intelligence/seamless-orchestrator/audit');
    expect(res.status).toBe(503);
  });
});
