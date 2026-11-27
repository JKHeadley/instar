/**
 * Integration — dashboard PIN throttle (docs/specs/dashboard-pin-throttle.md), design (b),
 * over the full HTTP pipeline through a real AgentServer.
 *
 * Proves the operator-ratified requirements:
 *  - a cookie-marked owner unlocks instantly with the correct PIN while a flood has drained the cap;
 *  - a brand-new unmarked tunnel browser is refused at the hard cap during that flood;
 *  - a successful unlock sets the signed instar_pin_ok cookie;
 *  - cf-connecting-ip is the client key only over the own-name tunnel path (a forged header to a
 *    non-own Host is ignored; such a loopback caller is unattributable and charged to the shared
 *    unmarked budget only — identity-security piece 1c);
 *  - `security.pinThrottle.enabled: false` is ignored: the throttle still applies (piece 1c);
 *  - a genuinely-local request (loopback Host) unlocks while the tunnel cap is drained (recovery);
 *  - the paired phone-app route is unaffected by the throttle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'itest-auth-token-pinthrottle';
const PIN = '246810';
const PORT = 4042;
const TUNNEL_HOST = 'pinthrottle.trycloudflare.test';

function makeConfig(stateDir: string, throttleEnabled = true): InstarConfig {
  return {
    projectName: 'pin-throttle-itest', projectDir: '/tmp/pt', stateDir, port: PORT,
    authToken: AUTH, dashboardPin: PIN,
    security: { pinThrottle: { enabled: throttleEnabled, globalFailureBudget: 5, coarseFailureBudget: 100, windowMs: 600000, softFailures: 3 } },
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: '/tmp/pt', maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as InstarConfig;
}

let project: TempProject;
let mockSM: MockSessionManager;
let app: ReturnType<AgentServer['getApp']>;

// A tunnel request: Host is the tunnel own-name, cf-connecting-ip is the real client (socket is loopback).
const tunnel = (clientIp: string) => request(app).post('/dashboard/unlock')
  .set('Host', TUNNEL_HOST).set('cf-connecting-ip', clientIp).set('x-forwarded-proto', 'https');
// A genuinely-local request: loopback Host, no cf-connecting-ip, no forwarding header.
const local = () => request(app).post('/dashboard/unlock').set('Host', `127.0.0.1:${PORT}`);

beforeEach(() => {
  project = createTempProject();
  mockSM = createMockSessionManager();
  const server = new AgentServer({
    config: makeConfig(project.stateDir),
    sessionManager: mockSM as any,
    state: project.state,
    tunnel: { url: `https://${TUNNEL_HOST}` },
  } as any);
  app = server.getApp();
});
afterEach(() => { project.cleanup(); });

async function drainCap() {
  // 5+ wrong PINs from distinct tunnel clients drain the global unmarked budget (5).
  for (let i = 0; i < 6; i++) await tunnel(`203.0.113.${i}`).send({ pin: '000000' });
}

describe('dashboard PIN throttle (b) — integration', () => {
  it('a correct PIN unlocks and sets the signed instar_pin_ok cookie', async () => {
    const res = await tunnel('198.51.100.7').send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toContain('instar_pin_ok=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
  });

  it('once the cap is drained, a brand-new unmarked tunnel browser is refused (429), but a cookie-marked owner unlocks instantly', async () => {
    // owner unlocks once to get a cookie
    const first = await tunnel('198.51.100.7').send({ pin: PIN });
    const cookie = String(first.headers['set-cookie']?.[0] ?? '').split(';')[0];
    expect(cookie).toContain('instar_pin_ok=');

    await drainCap();

    // a fresh unmarked browser is refused at the hard cap
    const stranger = await tunnel('203.0.113.250').send({ pin: PIN });
    expect(stranger.status).toBe(429);

    // the cookie-marked owner, from any address, unlocks instantly with the correct PIN
    const owner = await tunnel('203.0.113.251').set('Cookie', cookie).send({ pin: PIN });
    expect(owner.status).toBe(200);
    expect(owner.body.token).toBeDefined();
  });

  it('a genuinely-local request (loopback Host) unlocks even while the tunnel cap is drained (out-of-band recovery)', async () => {
    await drainCap();
    const res = await local().send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('a forged cf-connecting-ip to a NON-own Host is not trusted: the caller is unattributable and charged to the shared budget only', async () => {
    // identity-security-piece1c: Host is not the tunnel own-name → cf-connecting-ip is ignored. The
    // socket is loopback, so the real client cannot be told: it is charged to the global unmarked
    // budget only — never to the forged address, and never to a shared 127.0.0.1 key (one stranger
    // must not back off everyone behind the same loopback).
    const forged = (ip: string) => request(app).post('/dashboard/unlock').set('Host', 'evil.example').set('cf-connecting-ip', ip);
    for (let i = 0; i < 3; i++) expect((await forged('9.9.9.1').send({ pin: '000000' })).status).toBe(403);
    // 3 soft failures would back off a per-source key; none applies, so another unattributable caller
    // with the right PIN still unlocks.
    expect((await forged('9.9.9.2').send({ pin: PIN })).status).toBe(200);
    // The forged address was never charged: the real 9.9.9.1 over the own-name tunnel unlocks.
    expect((await tunnel('9.9.9.1').send({ pin: PIN })).status).toBe(200);
    // The shared unmarked budget (5) still bounds unattributable guessing, and the successes above
    // did not reset it: two more wrong PINs drain it, then even the right PIN is refused.
    for (let i = 0; i < 2; i++) expect((await forged(`9.9.9.${10 + i}`).send({ pin: '000000' })).status).toBe(403);
    const res = await forged('9.9.9.200').send({ pin: PIN });
    expect(res.status).toBe(429);
  });

  it('security.pinThrottle.enabled: false is ignored — the throttle still applies and the setting is reported', async () => {
    // identity-security-piece1c: the legacy in-memory limiter (and its "a success resets the global
    // budget") is gone; a stale off switch can never weaken PIN protection.
    const spy = vi.spyOn(DegradationReporter.getInstance(), 'report');
    try {
      project.cleanup(); project = createTempProject();
      const server = new AgentServer({ config: makeConfig(project.stateDir, false), sessionManager: mockSM as any, state: project.state, tunnel: { url: `https://${TUNNEL_HOST}` } } as any);
      app = server.getApp();
      expect(spy.mock.calls.some((c) => (c[0] as { feature: string }).feature === 'DashboardPin.throttleSetting')).toBe(true);
      // Per-source backoff (3 soft failures) — the legacy limiter allowed 5 per address.
      for (let i = 0; i < 3; i++) expect((await tunnel('198.51.100.40').send({ pin: '000000' })).status).toBe(403);
      expect((await tunnel('198.51.100.40').send({ pin: PIN })).status).toBe(429);
      // The hard unmarked cap (5) — the legacy limiter's global was 20.
      await drainCap();
      expect((await tunnel('203.0.113.250').send({ pin: PIN })).status).toBe(429);
      // A success (here, the machine itself) never resets the shared budget.
      expect((await local().send({ pin: PIN })).status).toBe(200);
      expect((await tunnel('203.0.113.251').send({ pin: PIN })).status).toBe(429);
    } finally {
      spy.mockRestore();
    }
  });

  it('a malformed instar_pin_ok cookie does not 500 the unlock route (treated as no marker)', async () => {
    // decodeURIComponent throws on a bad %-escape; the handler must swallow it, not 500.
    const res = await tunnel('198.51.100.33').set('Cookie', 'instar_pin_ok=%').send({ pin: PIN });
    expect(res.status).toBe(200); // unmarked but correct PIN still unlocks; no 500
  });

  it('the paired phone-app route is unaffected by the throttle (not consulted against PinThrottle)', async () => {
    await drainCap();
    // The unlock-check (a non-PIN route) is not gated by the throttle; it answers normally while the
    // PIN cap is drained — representative that the throttle does not bleed into non-unlock routes.
    const res = await request(app).get('/dashboard/unlock-check').set('Host', TUNNEL_HOST).set('x-forwarded-proto', 'https');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accepted');
  });
});

// SEC-070: "local" must not mean "unlimited": other processes on this machine, including
// confined sessions that share the loopback, reach the same local address. An unknown local
// caller gets its own small budget; a browser that unlocked before (signed marker) is never
// capped; the local and remote budgets never drain each other.
describe('dashboard PIN throttle — local guesses are bounded too', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  async function localWrong(n: number, cookie?: string) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = local(); if (cookie) r.set('Cookie', cookie);
      out.push((await r.send({ pin: '000000' })).status);
    }
    return out;
  }

  it('after 10 wrong PINs, an unknown local caller is refused (429) even with the right PIN', async () => {
    expect(await localWrong(10)).toEqual(Array(10).fill(403));
    const res = await local().send({ pin: PIN });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/from this machine/);
  });

  it('the owner is alerted once when the local budget runs out', async () => {
    const spy = vi.spyOn(DegradationReporter.getInstance(), 'report');
    await localWrong(10);
    await local().send({ pin: '000000' });
    const local429 = spy.mock.calls.filter((c) => (c[0] as { feature: string }).feature === 'DashboardPin.localGuessing');
    expect(local429).toHaveLength(1);
  });

  it('a local browser that unlocked before still unlocks after unknown local callers used up the local budget', async () => {
    const first = await local().send({ pin: PIN });
    const cookie = String(first.headers['set-cookie']?.[0] ?? '').split(';')[0];
    expect(cookie).toContain('instar_pin_ok=');
    await localWrong(10);
    expect((await local().send({ pin: PIN })).status).toBe(429); // unknown local caller
    expect((await local().set('Cookie', cookie).send({ pin: PIN })).status).toBe(200); // the owner's browser
  });

  it('a copied marker cookie is not an unlimited pass from this machine: it backs off like a known remote browser', async () => {
    const first = await local().send({ pin: PIN });
    const cookie = String(first.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const statuses = await localWrong(15, cookie);
    expect(statuses).toContain(429);
  });

  it('a correct PIN does not hand a guessing program a fresh local budget', async () => {
    await localWrong(9);
    expect((await local().send({ pin: PIN })).status).toBe(200);
    expect((await local().send({ pin: '000000' })).status).toBe(403); // the 10th failure in the window
    expect((await local().send({ pin: PIN })).status).toBe(429);
  });

  it('the local and remote budgets do not drain each other', async () => {
    await localWrong(10);
    expect((await tunnel('198.51.100.9').send({ pin: PIN })).status).toBe(200); // a remote browser is unaffected
    project.cleanup(); project = createTempProject();
    const server = new AgentServer({ config: makeConfig(project.stateDir), sessionManager: mockSM as any, state: project.state, tunnel: { url: `https://${TUNNEL_HOST}` } } as any);
    app = server.getApp();
    await drainCap();
    expect((await local().send({ pin: PIN })).status).toBe(200); // the machine still unlocks while remote is drained
  });
});
