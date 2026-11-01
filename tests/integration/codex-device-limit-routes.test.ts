/**
 * Integration — the HTTP surface of the Codex device-limit tripwire
 * (spec docs/specs/codex-device-limit-tripwire.md §8 and "Testing: Integration").
 *
 * A real Express app with createRoutes(), a REAL SubscriptionPool and SubscriptionLoginLedger over
 * a temp dir, a REAL QuotaPoller (fake Codex reader, never a real `codex`), the production wiring
 * (`buildCodexDeviceLimitWiring` + `installCodexDeviceLimitWiring`, exactly as server.ts does), and
 * a REAL sign-in repair runtime for the blockers read. `?scope=pool` fans out to live peer HTTP
 * servers: one on new code (a second createRoutes app) and one bare peer on older code whose rows
 * carry no `statusCause` at all.
 *
 * A bench is written with the tripwire's own one-write shape (`pool.update` with status +
 * statusCause); the state machine that produces it is covered by the unit wiring test and the e2e
 * lifecycle test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
import { QuotaPoller } from '../../src/core/QuotaPoller.js';
import { buildCodexDeviceLimitWiring, installCodexDeviceLimitWiring } from '../../src/core/codexDeviceLimitWiring.js';
import { createSubscriptionReloginRuntime, subscriptionReloginRouteContext, type SubscriptionReloginRuntime } from '../../src/core/SubscriptionReloginRuntime.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import type { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import type { IdentityOracle } from '../../src/core/CredentialLocationLedger.js';
import type { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';
import type { ClaudePasteBackController } from '../../src/core/ClaudePasteBackController.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE = 'm-self';
const TOKEN = 'device-limit-int-token';

const servers: http.Server[] = [];
async function listen(app: express.Express): Promise<string> {
  const srv = app.listen(0);
  servers.push(srv);
  await new Promise((r) => srv.once('listening', r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

function benchShape(nowIso: string) {
  return {
    status: 'needs-reauth' as const, statusCause: 'codex-device-limit' as const, deviceLimitSince: nowIso,
    deviceLimitNextReadAt: new Date(Date.parse(nowIso) + 3_600_000).toISOString(), deviceLimitRefusedReads: 0,
    deviceLimitReadsStopped: false,
  };
}

function addCodex(pool: SubscriptionPool, dir: string, id: string) {
  pool.addFixture({ id, nickname: `nick-${id}`, email: `${id}@example.test`, provider: 'openai', framework: 'codex-cli', configHome: path.join(dir, `.${id}`) });
}

describe('Codex device-limit tripwire — HTTP routes (integration)', () => {
  let dir: string;
  let pool: SubscriptionPool;
  let ledger: SubscriptionLoginLedger;
  let poller: QuotaPoller;
  let runtime: SubscriptionReloginRuntime;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-routes-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    pool = new SubscriptionPool({ stateDir: dir });
    addCodex(pool, dir, 'codex-a');
    addCodex(pool, dir, 'codex-b');
    ledger = new SubscriptionLoginLedger({ stateDir: dir, machineId: MACHINE, writeEnabled: true });
    poller = new QuotaPoller({
      pool,
      codexLiveUsageReaderDetailed: async () => ({ kind: 'unavailable' }),
      codexUsageReader: async () => null,
    });
    runtime = createSubscriptionReloginRuntime({ stateDir: dir, projectDir: dir, machineId: MACHINE,
      seatLease: new PlaywrightSeatLease({ filePath: path.join(dir, 'seat-lease.json') }),
      mode: 'approval', pool, ledger,
      enrollment: { getById: () => null, start: vi.fn(), refresh: vi.fn() } as unknown as EnrollmentWizard,
      profiles: { resolve: () => ({ profile: null }), listProfiles: () => [] } as unknown as PlaywrightProfileRegistry,
      quotaPoller: poller,
      identityOracle: { resolveSlotTenant: vi.fn() } as unknown as IdentityOracle,
      pasteBack: { finish: vi.fn() } as unknown as ClaudePasteBackController,
      createBrowser: () => { throw new Error('a route read must never open a browser'); },
      resolveSecret: async () => null, supervise: async ({ allowedActions }) => allowedActions[0],
    });
  });

  afterEach(async () => {
    installCodexDeviceLimitWiring(null);
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    try { runtime.close(); } catch { /* @silent-fallback-ok: already closed */ }
    try { ledger.close(); } catch { /* @silent-fallback-ok: already closed */ }
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/codex-device-limit-routes.test.ts:cleanup' });
  });

  function installWiring() {
    const wiring = buildCodexDeviceLimitWiring({
      pool, ledger, quotaPoller: poller, machineId: MACHINE, stateDir: dir, logsDir: path.join(dir, 'logs'),
      config: () => ({ enabled: true, ignoreAccounts: [] }), judgeConfig: () => undefined,
      readKey: () => null, referee: null, listSessions: () => [],
      swap: async () => ({ swapped: false, reason: 'test' }),
      endRepairs: (id) => runtime.endForDeviceLimit(id),
      raiseNotice: () => {}, clearNotice: () => {},
    });
    installCodexDeviceLimitWiring(wiring);
    return wiring;
  }

  function ctxFor(extra: Record<string, unknown> = {}): any {
    return {
      config: { authToken: TOKEN, stateDir: dir, port: 0, dashboardPin: '123456' },
      startTime: new Date(),
      subscriptionPool: pool,
      subscriptionLoginLedger: ledger,
      subscriptionIdentityOracle: { resolveSlotTenant: async () => ({ email: 'x@example.test' }) },
      subscriptionEmailBarrier: { isBlocking: () => false },
      quotaPoller: poller,
      subscriptionRelogin: subscriptionReloginRouteContext(runtime),
      ...extra,
    };
  }

  async function boot(ctx: any): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    return listen(app);
  }

  const get = async (base: string, p: string) => {
    const r = await fetch(base + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: r.status, body: await r.json() as any };
  };

  it('GET /subscription-pool: statusCause on every row (null when none) and deviceLimit null when the tripwire is not running', async () => {
    const base = await boot(ctxFor());
    const r = await get(base, '/subscription-pool');
    expect(r.status).toBe(200);
    expect(r.body.accounts).toHaveLength(2);
    for (const a of r.body.accounts) {
      expect(a).toHaveProperty('statusCause');
      expect(a.statusCause).toBeNull();
    }
    expect(r.body).toHaveProperty('deviceLimit');
    expect(r.body.deviceLimit).toBeNull();
  });

  it('GET /subscription-pool: a benched row carries codex-device-limit and the deviceLimit block reports it', async () => {
    installWiring();
    pool.update('codex-a', benchShape(new Date().toISOString()));
    const base = await boot(ctxFor());
    const r = await get(base, '/subscription-pool');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.accounts.map((a: any) => [a.id, a]));
    expect(byId['codex-a'].statusCause).toBe('codex-device-limit');
    expect(byId['codex-a'].status).toBe('needs-reauth');
    expect(byId['codex-b'].statusCause).toBeNull();
    expect(r.body.deviceLimit).toMatchObject({
      enabled: true, benchedNow: 1, suspectedNow: 0, refusingAlike: false, executableCodexAccounts: 1,
      judge: expect.objectContaining({ judged: 0 }),
      mover: expect.objectContaining({ moved: 0 }),
    });
  });

  it('GET /subscription-pool?scope=pool: a peer on older code reads unknown, a peer on new code keeps its own cause', async () => {
    installWiring();
    pool.update('codex-a', benchShape(new Date().toISOString()));

    // Older peer: rows have no statusCause key at all.
    const oldApp = express();
    oldApp.get('/subscription-pool', (_req, res) => {
      res.json({ enabled: true, count: 1, accounts: [{ id: 'old-peer-acct', provider: 'openai', framework: 'codex-cli', status: 'needs-reauth' }] });
    });
    const oldPeer = await listen(oldApp);

    // New-code peer: a real routes app over its own pool, with one benched and one clean account.
    const peerDir = path.join(dir, 'peer');
    fs.mkdirSync(peerDir, { recursive: true });
    const peerPool = new SubscriptionPool({ stateDir: peerDir });
    addCodex(peerPool, peerDir, 'peer-benched');
    addCodex(peerPool, peerDir, 'peer-clean');
    peerPool.update('peer-benched', benchShape(new Date().toISOString()));
    const newPeer = await boot({
      config: { authToken: TOKEN, stateDir: peerDir, port: 0 }, startTime: new Date(),
      subscriptionPool: peerPool,
      subscriptionIdentityOracle: { resolveSlotTenant: async () => ({ email: 'x@example.test' }) },
      subscriptionEmailBarrier: { isBlocking: () => false },
    });

    const base = await boot(ctxFor({
      meshSelfId: MACHINE,
      machinePoolRegistry: { getCapacity: () => null },
      resolvePeerUrls: () => [{ machineId: 'm-old', url: oldPeer }, { machineId: 'm-new', url: newPeer }],
    }));
    const r = await get(base, '/subscription-pool?scope=pool');
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('pool');
    expect(r.body.pool.failed).toEqual([]);
    const byId = Object.fromEntries(r.body.accounts.map((a: any) => [a.id, a]));
    // Self rows: present on new code, null = no cause.
    expect(byId['codex-a']).toMatchObject({ statusCause: 'codex-device-limit', remote: false, machineId: MACHINE });
    expect(byId['codex-b']).toMatchObject({ statusCause: null, remote: false });
    // A missing field from an older peer is unknown, never "clear".
    expect(byId['old-peer-acct']).toMatchObject({ statusCause: 'unknown', remote: true, machineId: 'm-old' });
    // A new-code peer's own answer is kept as-is, both sides of the boundary.
    expect(byId['peer-benched']).toMatchObject({ statusCause: 'codex-device-limit', remote: true, machineId: 'm-new' });
    expect(byId['peer-clean']).toMatchObject({ statusCause: null, remote: true });
    // deviceLimit is THIS machine's block only.
    expect(r.body.deviceLimit).toMatchObject({ benchedNow: 1 });
  });

  it('GET /subscription-relogin: a benched account is a device-limit-benched blocker; a clean one is not listed', async () => {
    installWiring();
    pool.update('codex-a', benchShape(new Date().toISOString()));
    // The tripwire's best-effort ledger write: an open episode with the device-limit cause.
    ledger.recordObservation({ accountId: 'codex-a', at: new Date().toISOString(),
      outcome: { kind: 'transition-to-needs-reauth', causeClass: 'codex-device-limit', corroboration: 'exchange-corroborated' } });
    const base = await boot(ctxFor());
    const r = await get(base, '/subscription-relogin');
    expect(r.status).toBe(200);
    expect(r.body.blockers).toEqual([
      { accountId: 'codex-a', machineId: MACHINE, framework: 'codex-cli', reason: 'device-limit-benched' },
    ]);
    // And no repair is admitted for it by the same runtime the route reads.
    await runtime.service.tick();
    expect(runtime.store.list()).toEqual([]);
  });

  it('PATCH /subscription-pool/:id releases a bench (the store rule clears every bench field) and cannot set one', async () => {
    installWiring();
    pool.update('codex-a', benchShape(new Date().toISOString()));
    const base = await boot(ctxFor());
    const patch = (id: string, body: unknown) => fetch(`${base}/subscription-pool/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() as any }));

    // A Bearer holder cannot bench.
    const refused = await patch('codex-b', { status: 'needs-reauth', statusCause: 'codex-device-limit' });
    expect(refused.status).toBe(400);
    expect(pool.get('codex-b')!.statusCause).toBeUndefined();
    expect(pool.get('codex-b')!.status).toBe('active');

    // Operator set-active releases.
    const released = await patch('codex-a', { status: 'active' });
    expect(released.status).toBe(200);
    const a = pool.get('codex-a')!;
    expect(a.status).toBe('active');
    for (const f of ['statusCause', 'deviceLimitSince', 'deviceLimitSuspectedAt', 'deviceLimitNextReadAt', 'deviceLimitRefusedReads', 'deviceLimitReadsStopped'] as const) {
      expect(a[f]).toBeUndefined();
    }
    const r = await get(base, '/subscription-pool');
    expect(r.body.accounts.find((x: any) => x.id === 'codex-a').statusCause).toBeNull();
    expect(r.body.deviceLimit).toMatchObject({ benchedNow: 0 });
  });
});
