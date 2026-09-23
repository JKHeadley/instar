/**
 * Integration tests — the operator-triggered COLD PROOF route (Tier 2).
 * Spec: docs/specs/agent-held-google-passkey.md §3.8 (the proof), §3.6 (outcome mapping), §5.1
 * (admission before a proof), §4 (throttle safety), §2 (risk budget), §13 (one browser seat).
 * Real createRoutes() behind the real authMiddleware, real on-disk grant / credential / attempt /
 * health files, the proof browser injected as a scripted fake (the REAL browser against the local
 * WebAuthn fixture is `passkey-cold-proof-fixture.test.ts`), a per-machine seat lease, and the peer
 * state fetch seam so the pool admission sees a partitioned peer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PasskeyCredentialStore } from '../../src/core/PasskeyCredentialStore.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import type { ProofBrowser } from '../../src/core/PasskeyColdProof.js';
import type { ReloginBrowserSnapshot } from '../../src/core/AnthropicReloginBrowserDriver.js';

const AUTH_TOKEN = 'test-passkey-proof-bearer';
const PIN = '161803';

interface Machine { id: string; dir: string; stateDir: string; keys: crypto.KeyPairKeyObjectResult; app: express.Express; ctx: RouteContext & Record<string, unknown>; silent: boolean; seat: PlaywrightSeatLease; profileDirs: string[] }

function machine(id: string, world: Map<string, Machine>, opts: { developmentAgent?: boolean } = {}): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pk-proof-${id}-`));
  const stateDir = path.join(dir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}\n');
  const keys = crypto.generateKeyPairSync('ed25519');
  const pem = (k: crypto.KeyObject) => k.export({ type: 'spki', format: 'pem' }).toString();
  const identityManager = {
    loadIdentity: () => ({ machineId: id }),
    loadSigningKey: () => keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    getSigningPublicKeyPem: (mid: string) => world.get(mid) ? pem(world.get(mid)!.keys.publicKey) : null,
    loadRegistry: () => ({ version: 1, machines: Object.fromEntries([...world.keys()].map((m) => [m, { status: 'active' }])) }),
    getActiveMachines: () => [...world.keys()].map((m) => ({ machineId: m, entry: {} })),
  };
  const seat = new PlaywrightSeatLease({ filePath: path.join(stateDir, 'state', 'seat.json') });
  const profileDirs: string[] = [];
  const ctx = {
    config: { projectName: 'pk', projectDir: dir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent: opts.developmentAgent ?? true, dashboardPin: PIN, sessions: {}, scheduler: {}, secrets: { forceFileKey: true } },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(), meshSelfId: id,
    coordinator: { managers: { identityManager }, holdsLease: () => true },
    listPoolMachines: () => [...world.keys()].map((mid) => ({ machineId: mid, nickname: `nick-${mid}`, lastKnownUrl: `http://${mid}.pool.test` })),
    ropeHealthMonitor: { status: () => ({ peers: [] }) },
    playwrightSeatLease: () => seat,
    passkeyProofUrls: { signIn: 'https://accounts.google.com/v3/signin/identifier', signOut: 'https://accounts.google.com/Logout' },
    fetchPasskeyPeerState: async (peer: { machineId: string }) => {
      const target = world.get(peer.machineId);
      if (!target || target.silent) return { ok: false as const, reason: 'unreachable' as const };
      const res = await request(target.app).get('/passkeys/pool-state').set('Authorization', `Bearer ${AUTH_TOKEN}`).set('X-Instar-Machine-Id', id);
      return res.status === 200 ? { ok: true as const, body: res.body } : { ok: false as const, reason: 'error' as const };
    },
  } as unknown as Machine['ctx'];
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH_TOKEN)); app.use('/', createRoutes(ctx));
  const full: Machine = { id, dir, stateDir, keys, app, ctx, silent: false, seat, profileDirs };
  world.set(id, full);
  return full;
}

function snap(pageClass: ReloginBrowserSnapshot['pageClass']): ReloginBrowserSnapshot {
  return { origin: 'https://accounts.google.com', pageClass, expectedAccountVisible: false, hasGoogleSignIn: false, hasNext: true, hasAuthorize: false, requestedScopes: [] };
}

/** A scripted proof browser: pages in order, an identity read per page, an assertion on Continue. */
function scripted(opts: { pages: ReloginBrowserSnapshot['pageClass'][]; identity?: Array<'match' | 'other' | 'none'>; failOpen?: boolean }): ProofBrowser & { calls: string[] } {
  let i = -1; let asserted = false;
  const calls: string[] = [];
  return {
    calls,
    open: vi.fn(async () => { calls.push('open'); if (opts.failOpen) throw new Error('chrome-launch-failed'); }),
    navigateTo: vi.fn(async (url: string) => { calls.push(`navigate:${new URL(url).pathname}`); }),
    clearBrowsingData: vi.fn(async () => { calls.push('clear'); }),
    snapshot: vi.fn(async () => { i = Math.min(i + 1, opts.pages.length - 1); calls.push(`snapshot:${opts.pages[i]}`); return snap(opts.pages[i]); }),
    click: vi.fn(async (a: string) => { calls.push(`click:${a}`); if (a === 'passkey-continue') asserted = true; }),
    chooseExpectedAccount: vi.fn(async () => {}),
    fillPublic: vi.fn(async (f: string) => { calls.push(`fill:${f}`); }),
    wait: vi.fn(async () => {}),
    addCredential: vi.fn(async () => { calls.push('add'); }),
    removeCredential: vi.fn(async () => { calls.push('remove'); }),
    credentialCount: vi.fn(async () => 1),
    observedAssertion: vi.fn(() => asserted),
    readSignedInIdentity: vi.fn(async () => (opts.identity ?? [])[Math.max(0, i)] ?? 'none'),
    close: vi.fn(async () => { calls.push('close'); }),
  };
}

const RECORD = (email: string, machineId: string) => ({ credentialId: `cred-${email}`, rpId: 'google.com', privateKey: 'pk', userHandle: 'uh', signCount: 0, canonicalEmail: email, mintedOnMachineId: machineId, mintedByAgent: 'echo', mintedAt: new Date().toISOString(), provenance: 'minted' as const, quarantined: false });

describe('passkey cold proof route (integration)', () => {
  const world = new Map<string, Machine>();
  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  const prove = (m: Machine, body: Record<string, unknown>) => request(m.app).post('/passkeys/prove').set(auth()).send(body);
  const seed = async (m: Machine, email: string) => {
    expect((await request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email })).status).toBe(200);
    await new PasskeyCredentialStore({ stateDir: m.stateDir, machineId: m.id, forceFileKey: true }).put(RECORD(email, m.id));
  };
  const install = (m: Machine, browser: ProofBrowser) => { m.ctx.passkeyProofBrowser = (profileDir: string) => { m.profileDirs.push(profileDir); return browser; }; };
  beforeEach(() => world.clear());
  afterEach(() => { for (const m of world.values()) SafeFsExecutor.safeRmSync(m.dir, { recursive: true, force: true, operation: 'tests/integration/passkeys-cold-proof-routes.test.ts:afterEach' }); });

  it('gates: 503 when dark; PIN required; 503 without a proof browser; 501 for a peer target; 404 without a grant; 409 no-credential without a store or a record', async () => {
    const dark = machine('d1', world, { developmentAgent: false });
    expect((await prove(dark, { pin: PIN, email: 'a@example.com' })).status).toBe(503);
    world.clear();
    const m = machine('m1', world);
    expect((await prove(m, { email: 'a@example.com' })).status).toBe(403);
    expect((await prove(m, { pin: PIN })).status).toBe(400);
    expect((await prove(m, { pin: PIN, email: 'a@example.com' })).body).toMatchObject({ error: 'proof-browser-unavailable' });
    install(m, scripted({ pages: ['google-account-identity'] }));
    expect((await prove(m, { pin: PIN, email: 'a@example.com', targetMachineId: 'elsewhere' })).status).toBe(501);
    expect((await prove(m, { pin: PIN, email: 'a@example.com' })).status).toBe(404);
    expect((await request(m.app).post('/passkeys/grant').set(auth()).send({ pin: PIN, email: 'a@example.com' })).status).toBe(200);
    // A grant without a store on disk: the proof must NOT create one.
    const noStore = await prove(m, { pin: PIN, email: 'a@example.com' });
    expect(noStore.status).toBe(409);
    expect(noStore.body).toMatchObject({ error: 'no-credential', reason: 'no passkey store on this machine' });
    expect(fs.existsSync(path.join(m.stateDir, 'secrets', 'passkeys', 'store.enc'))).toBe(false);
    // A store with a record for a DIFFERENT account: absent for this one.
    await new PasskeyCredentialStore({ stateDir: m.stateDir, machineId: m.id, forceFileKey: true }).put(RECORD('z@example.com', m.id));
    expect((await prove(m, { pin: PIN, email: 'a@example.com' })).body).toMatchObject({ error: 'no-credential', reason: 'credential-absent' });
    expect(m.profileDirs).toHaveLength(0);
  });

  it('ready: drives the scripted flow in the cell\'s proof-only profile, records the outcome as operator-origin, publishes the attempt row, and reuses the same profile on a re-proof', async () => {
    const m = machine('m1', world);
    await seed(m, 'a@example.com');
    const browser = scripted({ pages: ['google-account-identity', 'google-passkey-challenge', 'unknown'], identity: ['none', 'none', 'match'] });
    install(m, browser);
    const res = await prove(m, { pin: PIN, email: 'A@Example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'ready', reason: 'signed-in', observedAssertion: true, singleCredential: true, signedInIdentity: 'match', riskPage: false, throttled: false, pauses: [], teardown: { credentialRemoved: true, signedOut: true }, cell: { state: 'healthy' }, transition: null,
      admissionInputs: { suspension: 'not-published-on-this-build', leaseHolder: 'not-published-on-this-build' } });
    expect(res.body.steps.map((s: { pageClass: string; action: string }) => `${s.pageClass}:${s.action}`)).toEqual(['google-account-identity:fill-email', 'google-passkey-challenge:click-passkey-continue', 'unknown:stop']);
    // The proof-only profile lives under the passkey secrets dir, keyed by the store's pseudonymous email key, 0700.
    expect(m.profileDirs).toHaveLength(1);
    expect(m.profileDirs[0].startsWith(path.join(m.stateDir, 'secrets', 'passkeys', 'profiles'))).toBe(true);
    expect(m.profileDirs[0].endsWith('-proof')).toBe(true);
    expect(m.profileDirs[0]).not.toContain('example.com');
    expect(fs.statSync(m.profileDirs[0]).mode & 0o777).toBe(0o700);
    // Teardown order: clear + confirm before add; remove + sign out after; the seat is released.
    const idx = (k: string) => browser.calls.indexOf(k);
    expect(idx('clear')).toBeLessThan(idx('add'));
    expect(idx('remove')).toBeGreaterThan(idx('click:passkey-continue'));
    expect(idx('navigate:/Logout')).toBeGreaterThan(idx('remove'));
    expect(m.seat.acquire('someone-else', 'after the proof').acquired).toBe(true);
    m.seat.release('someone-else');
    // The health record carries the ready proof; the attempt row is published on the pool state every
    // peer reads (the 6h same-account gap is ACROSS machines — see the two-machine case below; the
    // operator may re-run a proof on the same machine).
    const health = await request(m.app).get('/passkeys/health').set(auth());
    expect(health.body.cells).toEqual([expect.objectContaining({ canonicalEmail: 'a@example.com', state: 'healthy', lastProofOutcome: 'ready' })]);
    expect(health.body.cells[0].lastReadyAt).toEqual(expect.any(String));
    const poolState = await request(m.app).get('/passkeys/pool-state').set(auth());
    expect(poolState.body.attempts).toEqual([expect.objectContaining({ canonicalEmail: 'a@example.com', kind: 'proof', machineId: 'm1' })]);
    const again = await prove(m, { pin: PIN, email: 'a@example.com' });
    expect(again.status).toBe(200);
    expect(m.profileDirs).toHaveLength(2);
    expect(m.profileDirs[1]).toBe(m.profileDirs[0]);
    expect((await request(m.app).get('/passkeys/pool-state').set(auth())).body.attempts).toHaveLength(2);
  });

  it('a risk page pauses the account for 7 days; a throttled prompt pauses the account for 24h AND the machine for 1h; both proofs are unknown and later proofs are refused as paused', async () => {
    const m = machine('m1', world);
    await seed(m, 'risk@example.com'); await seed(m, 'thr@example.com'); await seed(m, 'other@example.com');
    install(m, scripted({ pages: ['google-account-identity', 'google-risk-challenge'] }));
    const risk = await prove(m, { pin: PIN, email: 'risk@example.com' });
    expect(risk.status).toBe(200);
    expect(risk.body).toMatchObject({ outcome: 'unknown', reason: 'risk-page', riskPage: true, pauses: ['account-risk-7d'], cell: { state: 'healthy', consecutiveUnknown: 1 } });
    expect((await request(m.app).get('/passkeys/admission?action=prove&email=risk@example.com').set(auth())).body.pause).toMatchObject({ scope: 'account', reason: 'risk' });
    // Another account on the same machine is still admitted (an account pause is per account).
    expect((await request(m.app).get('/passkeys/admission?action=prove&email=other@example.com').set(auth())).body).toMatchObject({ allowed: true, pause: null });
    install(m, scripted({ pages: ['google-account-identity', 'google-passkey-challenge', 'google-passkey-throttled'] }));
    const thr = await prove(m, { pin: PIN, email: 'thr@example.com' });
    expect(thr.body).toMatchObject({ outcome: 'unknown', reason: 'throttled', throttled: true, pauses: ['account-throttled-24h', 'machine-throttled-1h'] });
    // The machine pause now covers EVERY account here.
    const paused = await prove(m, { pin: PIN, email: 'other@example.com' });
    expect(paused.status).toBe(409);
    expect(paused.body).toMatchObject({ error: 'proof-refused', reason: 'paused:throttled', pause: { scope: 'machine' } });
  });

  it('security and credential-rejected land in the cell; a transport failure is unknown (200, no pause); the busy browser seat refuses with 409 and never runs the proof', async () => {
    const m = machine('m1', world);
    await seed(m, 'sec@example.com'); await seed(m, 'rej@example.com'); await seed(m, 'tx@example.com'); await seed(m, 'seat@example.com');
    install(m, scripted({ pages: ['google-account-identity', 'google-passkey-challenge', 'unknown'], identity: ['none', 'none', 'other'] }));
    const sec = await prove(m, { pin: PIN, email: 'sec@example.com' });
    expect(sec.body).toMatchObject({ outcome: 'security', reason: 'different-identity', signedInIdentity: 'other', transition: { from: 'healthy', to: 'security' }, cell: { state: 'security' } });
    install(m, scripted({ pages: ['google-account-identity', 'google-passkey-challenge', 'google-credential-not-recognized'] }));
    const rej = await prove(m, { pin: PIN, email: 'rej@example.com' });
    expect(rej.body).toMatchObject({ outcome: 'credential-rejected', reason: 'google-credential-not-recognized', transition: { from: 'healthy', to: 'rejected' } });
    const failing = scripted({ pages: ['google-account-identity'], failOpen: true });
    install(m, failing);
    const tx = await prove(m, { pin: PIN, email: 'tx@example.com' });
    expect(tx.status).toBe(200);
    expect(tx.body).toMatchObject({ outcome: 'unknown', reason: 'transport:Error', pauses: [], cell: { state: 'healthy', consecutiveUnknown: 1 } });
    // Teardown still runs best-effort (sign-out + close); the credential was never added.
    expect(failing.calls).not.toContain('add');
    expect(failing.calls[0]).toBe('open');
    expect(failing.calls[failing.calls.length - 1]).toBe('close');
    // Seat busy: the proof never opens a browser and no attempt row is written.
    const busy = scripted({ pages: ['google-account-identity'] });
    install(m, busy);
    expect(m.seat.acquire('relogin:other', 'an interactive re-login').acquired).toBe(true);
    const refused = await prove(m, { pin: PIN, email: 'seat@example.com' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'seat-busy', holderLabel: 'an interactive re-login' });
    expect(busy.calls).toEqual([]);
    expect((await request(m.app).get('/passkeys/admission?action=prove&email=seat@example.com').set(auth())).body.sameAccountGap).toMatchObject({ allowed: true });
    m.seat.release('relogin:other');
    expect((await prove(m, { pin: PIN, email: 'seat@example.com' })).status).toBe(200);
    // The security cell also shows up on the pool state every peer reads.
    expect((await request(m.app).get('/passkeys/pool-state').set(auth())).body.cells.find((c: { canonicalEmail: string }) => c.canonicalEmail === 'sec@example.com')).toMatchObject({ health: 'security' });
  });

  it('a partitioned peer refuses the proof before any browser opens (pool-state-unavailable), and a reachable peer admits it', async () => {
    const m1 = machine('m1', world); const m2 = machine('m2', world);
    expect((await request(m1.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'm2' })).status).toBe(200);
    await seed(m1, 'a@example.com');
    const browser = scripted({ pages: ['google-account-identity', 'google-passkey-challenge', 'unknown'], identity: ['none', 'none', 'match'] });
    install(m1, browser);
    m2.silent = true;
    const refused = await prove(m1, { pin: PIN, email: 'a@example.com' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'proof-refused', reason: 'passkey-pool-state-unavailable' });
    expect(browser.calls).toEqual([]);
    m2.silent = false;
    // The pool memo is cached; a tick refreshes it, then the proof is admitted.
    expect((await request(m1.app).post('/passkeys/pool-state/tick').set(auth())).status).toBe(200);
    const ok = await prove(m1, { pin: PIN, email: 'a@example.com' });
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe('ready');
    // The 6h same-account gap ACROSS machines: m2 (same account, its own credential) is refused by the
    // pool memo naming m1, and the refusal happens before its browser opens.
    expect((await request(m2.app).post('/passkeys/issuer-add').set(auth()).send({ pin: PIN, machineId: 'm1' })).status).toBe(200);
    await seed(m2, 'a@example.com');
    const m2Browser = scripted({ pages: ['google-account-identity', 'google-passkey-challenge', 'unknown'], identity: ['none', 'none', 'match'] });
    install(m2, m2Browser);
    expect((await request(m2.app).post('/passkeys/pool-state/tick').set(auth())).status).toBe(200);
    expect((await request(m2.app).get('/passkeys/admission?action=prove&email=a@example.com').set(auth())).body.sameAccountGap).toMatchObject({ allowed: false, blockedBy: 'm1' });
    const gap = await prove(m2, { pin: PIN, email: 'a@example.com' });
    expect(gap.status).toBe(409);
    expect(gap.body).toMatchObject({ error: 'proof-refused', reason: 'same-account-gap', sameAccountGap: { blockedBy: 'm1' } });
    expect(m2Browser.calls).toEqual([]);
  });
});
