/**
 * Integration (Tier 2) — CMT-1006. The REAL /internal/stop-gate/evaluate route
 * (createRoutes) in shadow mode answers the Stop hook immediately and records
 * the authority's verdict after a call slower than the hook's blocking budget.
 * Before this fix every off-Claude authority call (p50 ~4.7s) hit the 2s budget,
 * the breaker stayed open from 2026-08-20, and the events table stayed empty.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { StopGateDb } from '../../src/core/StopGateDb.js';
import { UnjustifiedStopGate } from '../../src/core/UnjustifiedStopGate.js';
import { setMode, _resetForTests } from '../../src/server/stopGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const SELF_DEFERRAL = JSON.stringify({
  decision: 'allow',
  rule: 'U_SELF_DEFERRAL',
  evidence_pointer: {},
  rationale: 'handed an agent-ownable step to the operator',
  selfDeferral: true,
  confidence: 'high',
  deferredWorkIsAgentOwnable: true,
  turnEnding: true,
});

const BODY = {
  sessionId: 'sess-shadow-budget',
  evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: 1 },
  untrustedContent: { stopReason: 'want me to run it, or steer me elsewhere?', recentTurns: [] },
};

let dir = '';
let db: StopGateDb | null = null;
let server: Server | null = null;

beforeEach(() => {
  _resetForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-shadow-budget-'));
});
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
  server = null;
  db?.close();
  db = null;
  _resetForTests();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/stop-gate-shadow-deferred-budget.test.ts:cleanup' });
});

async function boot(intelligence: IntelligenceProvider, developmentAgent = true): Promise<string> {
  db = new StopGateDb({ dbPath: path.join(dir, 'stop-gate.db') });
  // clientTimeoutMs 50 stands in for the hook's 2s blocking budget; the
  // provider below is slower than it, as the real off-Claude route is.
  const gate = new UnjustifiedStopGate({ intelligence, selfDeferralGuardEnabled: true, clientTimeoutMs: 50, breakerStateStore: db, breakerKey: 'shadow-budget' });
  const app = express();
  app.use(express.json());
  app.use(authMiddleware('test-token', 'test-agent'));
  app.use(createRoutes({
    config: { authToken: 'test-token', stateDir: dir, projectDir: dir, projectName: 'echo', port: 0, developmentAgent },
    stateDir: dir,
    startTime: new Date(),
    unjustifiedStopGate: gate,
    stopGateDb: db,
  } as any));
  server = app.listen(0);
  await new Promise<void>(r => server!.once('listening', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function post(url: string): Promise<Response> {
  return fetch(`${url}/internal/stop-gate/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(BODY),
  });
}

async function waitForRows(n: number, ms = 3_000): Promise<ReturnType<StopGateDb['recentEvents']>> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rows = db!.recentEvents(10);
    if (rows.length >= n) return rows;
    await new Promise(r => setTimeout(r, 20));
  }
  return db!.recentEvents(10);
}

const slow = (ms: number, body = SELF_DEFERRAL): IntelligenceProvider => ({
  evaluate: () => new Promise(resolve => setTimeout(() => resolve(body), ms)),
});

describe('stop-gate shadow mode — deferred recording on the wide budget', () => {
  it('answers allow at once, then records the slow verdict with its self-deferral columns', async () => {
    const url = await boot(slow(300));
    setMode('shadow');
    const t0 = Date.now();
    const res = await post(url);
    const json = await res.json() as Record<string, unknown>;
    expect(Date.now() - t0).toBeLessThan(250); // not held for the 300ms call
    expect(json).toMatchObject({ decision: 'allow', reminder: '', shadow: 'deferred' });

    const rows = await waitForRows(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'shadow', decision: 'allow', rule: 'U_SELF_DEFERRAL', invalidKind: null, selfDeferral: 1, confidence: 'high' });
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(250);
  });

  it('enforce mode keeps the blocking budget: the same slow call fails open as timeout', async () => {
    const url = await boot(slow(300));
    setMode('enforce');
    const json = await (await post(url)).json() as Record<string, unknown>;
    expect(json).toMatchObject({ decision: 'allow', failOpen: 'timeout' });
    expect(json.shadow).toBeUndefined();
  });

  it('a malformed shadow verdict still records its failure row after the hook was answered', async () => {
    const url = await boot(slow(100, 'not json'));
    setMode('shadow');
    const json = await (await post(url)).json() as Record<string, unknown>;
    expect(json).toMatchObject({ decision: 'allow', shadow: 'deferred' });
    const rows = await waitForRows(1);
    expect(rows[0]).toMatchObject({ decision: null, invalidKind: 'malformed' });
  });

  it('bounds concurrent shadow calls; a stop past the cap is answered and counted, not judged', async () => {
    let calls = 0;
    const url = await boot({ evaluate: () => { calls += 1; return new Promise(r => setTimeout(() => r(SELF_DEFERRAL), 400)); } });
    setMode('shadow');
    const first = await Promise.all([post(url), post(url), post(url), post(url)].map(p => p.then(r => r.json())));
    for (const j of first) expect(j).toMatchObject({ shadow: 'deferred' });
    const over = await (await post(url)).json() as Record<string, unknown>;
    expect(over).toMatchObject({ decision: 'allow', shortCircuit: 'shadow-capacity' });
    const rows = await waitForRows(4);
    expect(rows).toHaveLength(4);
    expect(calls).toBe(4);
    const log = await (await fetch(`${url}/internal/stop-gate/log`, { headers: { Authorization: 'Bearer test-token' } })).json() as { shadow: { inFlight: number; skippedAtCapacity: number } };
    expect(log.shadow).toEqual({ inFlight: 0, skippedAtCapacity: 1 });
  });

  it('a slot stays held while a timed-out provider call is still running', async () => {
    let calls = 0;
    // 31s > the 30s shadow budget would be too slow for a test; instead the
    // route budget is clamped up from clientTimeoutMs, so use a call that
    // never resolves within the test and assert the slots stay occupied.
    const url = await boot({ evaluate: () => { calls += 1; return new Promise(() => {}); } });
    setMode('shadow');
    for (let i = 0; i < 4; i++) expect(await (await post(url)).json()).toMatchObject({ shadow: 'deferred' });
    expect(await (await post(url)).json()).toMatchObject({ shortCircuit: 'shadow-capacity' });
    expect(calls).toBe(4);
  });

  it('a fleet agent (self-deferral soak dark) keeps the blocking budget in shadow mode', async () => {
    const url = await boot(slow(300), false);
    setMode('shadow');
    const json = await (await post(url)).json() as Record<string, unknown>;
    expect(json).toMatchObject({ decision: 'allow', failOpen: 'timeout' });
    expect(json.shadow).toBeUndefined();
  });

  it('a session past the continue-ceiling is still judged in deferred shadow mode', async () => {
    const url = await boot(slow(50));
    for (let i = 0; i < 5; i++) db!.incrementContinueCount(BODY.sessionId, Date.now());
    setMode('shadow');
    expect(await (await post(url)).json()).toMatchObject({ shadow: 'deferred' });
    const rows = await waitForRows(1);
    expect(rows[0]).toMatchObject({ decision: 'allow', rule: 'U_SELF_DEFERRAL' });
  });
});
