/**
 * Tier-2 integration — full HTTP pipeline for the cross-machine account & quota
 * sharing surface (spec: cross-machine-account-quota-sharing.md §10).
 * Boots a real Express app with createRoutes() + the real authMiddleware, and a real
 * MachinePoolRegistry feeding canServe. Hermetic — zero network, zero credentials.
 *
 * Proves: GET /serve-failover 200 when enabled / 503 when dark; GET /pool carries the
 * per-machine canServe summary; Bearer-401.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import {
  ServeFailoverEngine,
  DEFAULT_SERVE_FAILOVER_POLICY,
} from '../../src/core/ServeFailoverEngine.js';
import { HonestDegradationNotifier, DEFAULT_HONEST_DEGRADATION_POLICY } from '../../src/core/HonestDegradationNotifier.js';
import { WalledEnrollmentOfferStub } from '../../src/core/WalledEnrollmentOffer.js';

const AUTH = 'test-serve-failover';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function buildRegistry(): MachinePoolRegistry {
  const reg = new MachinePoolRegistry({
    listMachines: () => [{ machineId: 'self' }, { machineId: 'peerA' }],
    clockSkewToleranceMs: 60_000,
    failoverThresholdMs: 120_000,
    now: () => Date.now(),
  });
  // self is walled, peerA can serve.
  reg.recordHeartbeat({ machineId: 'self', selfReportedLastSeen: new Date().toISOString(), canServe: { hasNonWalledAccount: false, servesChannels: { telegram: { chatIds: ['100'] } } } });
  reg.recordHeartbeat({ machineId: 'peerA', selfReportedLastSeen: new Date().toISOString(), canServe: { hasNonWalledAccount: true, servesChannels: { telegram: { chatIds: ['100'] } } } });
  return reg;
}

function makeApp(opts: { enabled: boolean; dryRun?: boolean }): express.Express {
  const reg = buildRegistry();
  const notifier = new HonestDegradationNotifier({
    policy: DEFAULT_HONEST_DEGRADATION_POLICY,
    isDryRun: () => opts.dryRun ?? true,
    sendPerTopicNotice: () => {},
    sendAggregatedNotice: () => {},
  });
  const engine = new ServeFailoverEngine({
    policy: DEFAULT_SERVE_FAILOVER_POLICY,
    selfMachineId: () => 'self',
    getMachines: () => reg.getCapacities(),
    ownerOf: () => 'self',
    ownershipEpoch: () => 0,
    isEnabled: () => opts.enabled,
    isDryRun: () => opts.dryRun ?? true,
    localServeability: () => ({ canServe: false, certain: true }),
    executeTransfer: async () => ({ ok: true, bounced: false }),
    emitHonestDegradation: (t, r) => notifier.notify(t, r),
    audit: () => {},
  });
  const enrollmentStub = new WalledEnrollmentOfferStub({ isEnabled: () => opts.enabled, isDryRun: () => opts.dryRun ?? true, surfaceOffer: () => {} });
  const serveFailover = {
    engine,
    notifier,
    enrollmentStub,
    policy: DEFAULT_SERVE_FAILOVER_POLICY,
    readAuditTail: () => [{ ts: 'x', topicId: 'T1', outcome: 'dry-run' }],
    isEnabled: () => opts.enabled,
    isDryRun: () => opts.dryRun ?? true,
  };
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH));
  const ctx = {
    config: { authToken: AUTH, stateDir: '/tmp', port: 0, subscriptionPool: { serveFailover: { enabled: opts.enabled, dryRun: opts.dryRun ?? true } } },
    startTime: new Date(),
    machinePoolRegistry: reg,
    serveFailover,
  } as never;
  app.use(createRoutes(ctx));
  return app;
}

describe('/serve-failover + /pool canServe (integration)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  const api = (p: string, init?: RequestInit) =>
    fetch(server.url + p, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` }, ...init })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('DARK: GET /serve-failover 503 when disabled', async () => {
    server = await listen(makeApp({ enabled: false }));
    const r = await api('/serve-failover');
    expect(r.status).toBe(503);
    expect(r.body.enabled).toBe(false);
  });

  it('LIVE: GET /serve-failover 200 when enabled, reports policy + walled machines + audit tail', async () => {
    server = await listen(makeApp({ enabled: true, dryRun: true }));
    const r = await api('/serve-failover');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.policy.minSeatDwellMs).toBe(DEFAULT_SERVE_FAILOVER_POLICY.minSeatDwellMs);
    // self is walled → it appears in walledMachines.
    expect(r.body.walledMachines.map((w: { machineId: string }) => w.machineId)).toContain('self');
    expect(Array.isArray(r.body.auditTail)).toBe(true);
  });

  it('GET /pool carries the per-machine canServe summary', async () => {
    server = await listen(makeApp({ enabled: true }));
    const r = await api('/pool');
    expect(r.status).toBe(200);
    const self = r.body.machines.find((m: { machineId: string }) => m.machineId === 'self');
    const peer = r.body.machines.find((m: { machineId: string }) => m.machineId === 'peerA');
    expect(self.canServe.hasNonWalledAccount).toBe(false);
    expect(peer.canServe.hasNonWalledAccount).toBe(true);
  });

  it('Bearer required: 401 without auth', async () => {
    server = await listen(makeApp({ enabled: true }));
    const r = await fetch(server.url + '/serve-failover').then((x) => x.status);
    expect(r).toBe(401);
  });
});
