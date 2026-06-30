// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration (Tier 2 / feature-alive) — GET /pool/reconciler (Fix #3 observability).
 * The REAL route in createRoutes() behind the real authMiddleware: 503 when the reconciler
 * is absent (single-machine / dark), 200 with the last-tick status when present, and the
 * per-topic decision explanation with ?topic=N. Proves the AgentServer ctx wiring is live.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { OwnershipReconciler } from '../../src/core/OwnershipReconciler.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'pool-reconciler-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/pool-reconciler-route.test.ts' }); } catch { /* best-effort */ } }
});

function ctxFor(overrides?: Partial<RouteContext>): RouteContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-recon-ctx-'));
  tmpDirs.push(tmp);
  const stateDir = path.join(tmp, 'project', '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ monitoring: {}, scheduler: {} }));
  return {
    config: { projectName: 'pool-recon', projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: AUTH, monitoring: {}, sessions: {} as unknown, scheduler: {} as unknown } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(), meshSelfId: 'm-self',
    ...overrides,
  } as unknown as RouteContext;
}

function appWith(overrides: Partial<RouteContext>): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctxFor(overrides)));
  return app;
}

/** A real OwnershipReconciler with one topic (700) m_b owns, pinned to m_a. */
function makeReconciler(): OwnershipReconciler {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-recon-route-'));
  tmpDirs.push(tmp);
  const nonces = new Set<string>();
  const reg = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
  reg.cas({ type: 'place', machineId: 'm_b' }, { sessionKey: '700', sender: 'm_b', nonce: 'p' });
  reg.cas({ type: 'claim', machineId: 'm_b' }, { sessionKey: '700', sender: 'm_b', nonce: 'c' });
  const pinStore = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
  pinStore.set('700', 'm_a');
  return new OwnershipReconciler({
    enabled: () => true, dryRun: () => false, selfMachineId: 'm_b',
    pinStore, ownership: reg,
    machines: () => [{ machineId: 'm_a', online: true, lastSeenMs: Date.now() }, { machineId: 'm_b', online: true, lastSeenMs: Date.now() }],
    isTopicBusy: () => false, emitPlacement: () => {}, debounceMs: 0,
  });
}

describe('GET /pool/reconciler', () => {
  it('401 without a Bearer token', async () => {
    expect((await request(appWith({ ownershipReconciler: makeReconciler() })).get('/pool/reconciler')).status).toBe(401);
  });

  it('503 when the reconciler is absent (single-machine / dark)', async () => {
    const res = await request(appWith({})).get('/pool/reconciler').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not active/i);
  });

  it('200 with the last-tick status when the reconciler is wired', async () => {
    const rec = makeReconciler();
    rec.tick();
    const res = await request(appWith({ ownershipReconciler: rec })).get('/pool/reconciler').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.status).toBeTruthy();
    expect(res.body.status.machinesCount).toBe(2);
    expect(res.body.status.selfMachineId).toBe('m_b');
  });

  it('200 with a per-topic decision explanation via ?topic=N', async () => {
    const res = await request(appWith({ ownershipReconciler: makeReconciler() })).get('/pool/reconciler?topic=700').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.topic.decision).toBe('transfer'); // m_b owns 700, pinned to m_a → would transfer
    expect(res.body.topic.preferredMachine).toBe('m_a');
  });
});
