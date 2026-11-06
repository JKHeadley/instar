/**
 * HTTP pipeline for the phone's native Accounts, What thinking costs and Resource usage reads
 * (docs/specs/mobile-native-capacity-screens.md) through the production authMiddleware +
 * deviceAuthenticator: an owner phone and the bearer token are served; an MSP phone (refused by the
 * device layer's ownerOnly), a demoted phone, a removed person's phone, a revoked phone, an unsigned
 * or tampered request, the notification read token and a POST are refused. The answers carry no
 * login folder, path, id, credential reference, lease holder or raw error text.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, DEVICE_ALLOWLIST, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobileCapacityRoutes, type MobileCapacityDeps } from '../../src/server/mobileCapacityRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const NOW = Date.parse('2026-11-04T02:00:00.000Z');
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-capacity-screens.test.ts' });
});

const accountsPayload = {
  enabled: true,
  accounts: [
    { id: 'justin-max', nickname: 'Justin Max', email: 'justin@example.com', provider: 'anthropic', framework: 'claude-code', configHome: '/Users/x/.claude-justin', status: 'active', loginCheck: 'ok',
      identityDrift: { evidence: 'drift-evidence-xyz' }, statusCause: null,
      lastQuota: { fiveHour: { utilizationPct: 62, resetsAt: '2026-11-04T04:10:00.000Z' }, sevenDay: { utilizationPct: 30, resetsAt: '2026-11-08T00:00:00.000Z' }, measuredAt: '2026-11-04T01:55:00.000Z' },
      machineId: 'm_self', machineNickname: 'Studio', remote: false },
    { id: 'adriana-pro', nickname: 'Adriana Pro', email: 'adriana@example.com', provider: 'anthropic', framework: 'claude-code', configHome: '/Users/x/.claude-adriana', status: 'needs-reauth', loginCheck: 'signed-out',
      machineId: 'm_peer', machineNickname: 'Mac Mini', remote: true },
  ],
  emailGaps: [{ accountId: 'gap', nickname: 'gap@example.org' }],
  pool: { selfMachineId: 'm_self', failed: [{ machineId: 'm_far', error: 'HTTP 500 at /Users/x' }] },
  deviceLimit: { secretCounter: 3 },
};
const spendSummary = {
  rows: [
    { door: 'openrouter', modelId: 'gpt-6-luna', costBasis: 'internal-derived', netUsd: 4.2, tokensIn: 100000, tokensOut: 20000 },
    { door: 'claude-code', modelId: 'claude-opus-4-8-20260115', costBasis: 'subscription-zero', netUsd: 0, tokensIn: 900000, tokensOut: 100000 },
  ],
  totals: { netUsd: 4.2, tokensIn: 1000000, tokensOut: 120000 },
  horizonNote: null,
};
const caps = { keys: [{ keyRef: 'openrouter-key-SECRETREF', provider: 'openrouter', door: 'openrouter', lifetimeCapUsd: 60, dailyCapUsd: 25, committedLifetimeUsd: 40, committedDayUsd: 3, frozen: false, goLiveState: 'live', meteredLeaseHolder: 'm_holder_machine' }], storeError: 'caps store unreadable: /Users/x/.instar/caps.json' };

function deps(over: Partial<MobileCapacityDeps> = {}): MobileCapacityDeps {
  return {
    accountsView: async () => accountsPayload,
    inUseAccountId: async () => 'justin-max',
    localRepairs: () => [],
    spendSummary: () => ({ ok: true, data: spendSummary }),
    tokens: () => ({ ok: true, data: { summary: { sessionsActive: 4, totalTokens: 1200000 }, codex: { sessionCount: 1, totalTokens: 50000 } } }),
    peerSpend: async () => [{ name: 'Mac Mini', isSelf: false, summary: { ok: false, off: false, unreached: true }, tokens: { ok: false, off: false, unreached: true } }],
    spendCaps: () => ({ ok: true, data: caps }),
    spendStatus: () => ({ ok: true, data: { lifecycleState: 'enabled', enforcementReady: true, machineId: 'm_holder_machine', machineNickname: 'Studio', enableSources: { state: 'config-enabled' } } }),
    resourceSources: () => [
      { source: 'aggregate', currentCpuPercent: 12, currentRssBytes: 1.4e9, avgCpuPercent: 10, peakCpuPercent: 40, peakRssBytes: 2e9, newestTs: NOW - 30_000 },
      { source: 'agent-server', currentCpuPercent: 3, currentRssBytes: 4e8, avgCpuPercent: 2, peakCpuPercent: 9, peakRssBytes: 5e8, newestTs: NOW - 30_000 },
      { source: 'session:sess-uuid-1', currentCpuPercent: 8, currentRssBytes: 6e8, avgCpuPercent: 6, peakCpuPercent: 30, peakRssBytes: 7e8, newestTs: NOW - 30_000 },
    ],
    runningSessionNames: () => new Map([['sess-uuid-1', 'echo-capacity-build']]),
    nicknameOf: (id) => (id === 'm_self' ? 'Studio' : id === 'm_peer' ? 'Mac Mini' : id === 'm_far' ? 'Laptop' : id === 'm_holder_machine' ? 'Studio' : null),
    selfName: () => 'Studio',
    selfMachineIds: () => ['m_holder_machine', 'm_self'],
    bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    now: () => NOW,
    ...over,
  };
}

function setup(over: Partial<MobileCapacityDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcap-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const pdeps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' };
  const svc = new MobilePairingService(pdeps);
  services.push(svc);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobileCapacityRoutes(router, deps(over));
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }) => {
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, id: created.device.id };
  };
  const owner = pair();
  return { app, svc, dev: owner.dev, id: owner.id, pair };
}

let tick = 0;
function signedGet(c: { app: express.Express; dev: ReturnType<typeof makeDevice>; id: string }, p: string) {
  const time = String(Date.now() + (tick++ % 1000));
  const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', p, time, undefined));
  return request(c.app).get(p).set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
}

const ROUTES = ['/mobile/accounts', '/mobile/spend', '/mobile/resources'];
const LEAKS = ['/Users/x', 'configHome', 'claude-justin', 'drift-evidence-xyz', 'm_self', 'm_peer', 'm_far', 'm_holder_machine', 'justin-max', 'adriana-pro', 'SECRETREF', 'openrouter-key', 'meteredLeaseHolder', 'keyRef', 'caps.json', 'HTTP 500', 'gap@example.org', 'secretCounter', 'sess-uuid-1', 'enableSources'];

describe('owner phone: served, trimmed', () => {
  it('GET /mobile/accounts lists sign-in problems first with usage windows, no folders or ids', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/accounts');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ schemaVersion: 1, enabled: true, needsSignIn: 1, usable: 1, unread: { count: 1, names: ['Laptop'] } });
    expect(r.body.headline).toBe('1 account needs signing in (on the machines that answered).');
    expect(r.body.accounts.map((a: { name: string }) => a.name)).toEqual(['Adriana Pro', 'Justin Max']);
    expect(r.body.accounts[0]).toMatchObject({ signIn: 'needs-sign-in', email: 'adriana@example.com', machines: [{ name: 'Mac Mini', isSelf: false, state: 'attn', label: 'needs sign-in' }] });
    expect(r.body.accounts[1]).toMatchObject({ signIn: 'signed-in', inUse: true, kind: 'Claude', usageLine: '62% of 5-hour', windows: [{ label: '5-hour', pct: 62, resetsAt: '2026-11-04T04:10:00.000Z' }, { label: 'weekly', pct: 30 }] });
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('GET /mobile/accounts does not count an unconfirmed sign-in, and survives an unreadable blocker list', async () => {
    const quiet = await signedGet(setup({ reloginBlockers: async () => [{ accountId: 'adriana-pro', machineId: 'm_peer', reason: 'no-open-incident' }] }), '/mobile/accounts');
    expect(quiet.status).toBe(200);
    expect(quiet.body.needsSignIn).toBe(0);
    expect(quiet.body.headline).not.toContain('signing in');
    const adriana = quiet.body.accounts.find((a: { name: string }) => a.name === 'Adriana Pro');
    expect(adriana.machines[0]).toMatchObject({ state: 'unknown', label: 'sign-in not confirmed; still checking' });
    const down = await signedGet(setup({ reloginBlockers: async () => { throw new Error('unreachable'); } }), '/mobile/accounts');
    expect(down.status).toBe(200);
    expect(down.body.needsSignIn).toBe(1);
  });

  it('GET /mobile/spend gives recorded cost with its basis, limits without the credential reference, token totals', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/spend?window=today');
    expect(r.status).toBe(200);
    // NOW is 02:00 UTC: cost covers whole UTC days from yesterday 00:00; tokens the exact 24 hours.
    expect(r.body.window).toEqual({ key: 'today', label: 'Today', costSince: '2026-11-03T00:00:00.000Z', tokensSince: '2026-11-03T02:00:00.000Z' });
    expect(r.body.headline).toBe('About $4.20 of pay-per-use cost today on the machine that answered.');
    expect(r.body.recorded.rows[0]).toMatchObject({ model: 'GPT-6 Luna', route: 'OpenRouter', basis: 'estimated', usd: 4.2 });
    expect(r.body.recorded.machines).toEqual([
      { name: 'Studio', isSelf: true, state: 'ok', netUsd: 4.2, unpricedTokens: 0 },
      { name: 'Mac Mini', isSelf: false, state: 'unreached', netUsd: null, unpricedTokens: null },
    ]);
    expect(r.body.limits).toMatchObject({ routesState: 'ok', controlsState: 'ok', storeUnreadable: true, sentence: 'Limits are on and enforcing on this machine.', routesSentence: '1 paid route is open.' });
    expect(r.body.limits.routes[0]).toMatchObject({ name: 'OpenRouter · OpenRouter', status: 'Open', committedDayUsd: 3, dailyCapUsd: 25, heldBy: 'this machine', committedElsewhere: false });
    expect(r.body.conversations.claude).toMatchObject({ count: 4, tokens: 1200000 });
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('GET /mobile/resources names sessions, never their ids', async () => {
    const c = setup();
    const r = await signedGet(c, '/mobile/resources');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, machine: 'Studio', windowHours: 1, headline: 'Instar is using 12% CPU and 1.4 GB of memory now (peak 40% in the last hour).' });
    expect(r.body.sessions[0]).toMatchObject({ name: 'echo-capacity-build', cpuPercent: 8, ended: false, stale: false });
    expect(r.body.server).toMatchObject({ name: 'The agent server', cpuPercent: 3 });
    const text = JSON.stringify(r.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('the bearer token is served too', async () => {
    const c = setup();
    for (const p of ROUTES) expect((await request(c.app).get(p).set('Authorization', 'Bearer tok-1')).status, p).toBe(200);
  });

  it('a spend part that throws reads as unavailable while the other parts still show', async () => {
    const c = setup({ spendCaps: () => { throw new Error('boom /Users/x'); } });
    const r = await signedGet(c, '/mobile/spend');
    expect(r.status).toBe(200);
    expect(r.body.limits.routesState).toBe('unavailable');
    expect(r.body.recorded.state).toBe('ok');
    expect(JSON.stringify(r.body)).not.toContain('boom');
  });

  it('a read that throws answers a fixed error code', async () => {
    const c = setup({ accountsView: async () => { throw new Error('peer exploded at /Users/x'); }, resourceSources: () => { throw new Error('db'); } });
    const a = await signedGet(c, '/mobile/accounts');
    expect(a.status).toBe(500);
    expect(a.body).toEqual({ error: 'accounts-unavailable' });
    expect((await signedGet(c, '/mobile/resources')).body).toEqual({ error: 'resources-unavailable' });
  });
});

describe('refused', () => {
  it('an MSP phone gets 403 owner-phone-required from the device layer on every route', async () => {
    let reads = 0;
    const c = setup({ accountsView: async () => { reads++; return accountsPayload; } });
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    for (const p of ROUTES) {
      const r = await signedGet({ app: c.app, dev: msp.dev, id: msp.id }, p);
      expect(r.status, p).toBe(403);
      expect(r.body.error).toBe('owner-phone-required');
    }
    expect(reads).toBe(0);
  });

  it('a phone demoted from owner to MSP is refused on its next read', async () => {
    const c = setup();
    expect((await signedGet(c, '/mobile/resources')).status).toBe(200);
    c.svc.devices.setPerson(c.id, { userId: 'justin', role: 'msp' });
    const r = await signedGet(c, '/mobile/resources');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner-phone-required');
  });

  it('a phone whose person was removed gets person-unknown before the route runs', async () => {
    const c = setup();
    const ghost = c.pair({ userId: 'nobody', role: 'msp' } as never);
    const r = await signedGet({ app: c.app, dev: ghost.dev, id: ghost.id }, '/mobile/accounts');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('person-unknown');
  });

  it('a revoked phone is refused', async () => {
    const c = setup();
    c.svc.devices.revoke(c.id);
    for (const p of ROUTES) expect((await signedGet(c, p)).status, p).toBe(401);
  });

  it('an unsigned device request, a tampered path or query and no credentials are refused', async () => {
    const c = setup();
    for (const p of ROUTES) {
      expect((await request(c.app).get(p).set('X-Instar-Device', c.id)).status, p).toBe(401);
      expect((await request(c.app).get(p)).status, p).toBe(401);
    }
    const time = String(Date.now());
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'GET', '/mobile/spend?window=today', time, undefined));
    const tampered = await request(c.app).get('/mobile/spend?window=month').set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(tampered.status).toBe(401);
  });

  it('the notification read token does not open these routes', async () => {
    const c = setup();
    for (const p of ROUTES) {
      const r = await request(c.app).get(p).set('X-Instar-Device', c.id).set('X-Instar-Notify-Token', 'a'.repeat(64));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('notify-token-not-allowed');
    }
  });

  it('allowlist: GET only, owner only, own bucket; raw routes stay off; a POST is refused', async () => {
    for (const p of ROUTES) {
      const rule = DEVICE_ALLOWLIST.find((x) => x.method === 'GET' && x.re.test(p));
      expect(rule, p).toBeDefined();
      expect([...rule!.statuses]).toEqual(['active']);
      expect(rule).toMatchObject({ body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'capacity-reads' });
      expect(rule!.unassignedOk).toBeUndefined();
      expect(DEVICE_ALLOWLIST.some((x) => x.method !== 'GET' && x.re.test(p))).toBe(false);
    }
    for (const p of ['/subscription-pool', '/subscription-pool/in-use', '/subscription-relogin', '/routing-spend/summary', '/routing-spend/caps', '/routing-spend/enable-status', '/tokens/summary', '/resources/summary', '/resources/samples']) {
      expect(DEVICE_ALLOWLIST.some((x) => x.re.test(p)), p).toBe(false);
    }
    const c = setup();
    const time = String(Date.now());
    const raw = Buffer.from('{}');
    const sig = c.dev.sign(canonicalString(c.id, HOST, 'POST', '/mobile/spend', time, raw));
    const post = await request(c.app).post('/mobile/spend').set('Content-Type', 'application/json')
      .set('X-Instar-Device', c.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig).send('{}');
    expect(post.status).toBe(403);
    expect(post.body.error).toBe('device-not-allowed');
  });

  it('the shared bucket stops a phone after 20 reads a minute', async () => {
    const c = setup();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await signedGet(c, ROUTES[i % 3])).status;
    expect(last).toBe(429);
  });
});
