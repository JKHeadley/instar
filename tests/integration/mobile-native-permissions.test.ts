/**
 * HTTP pipeline for the phone's native Permission slips and What I'm allowed to do
 * (docs/specs/mobile-native-permissions.md) through the production authMiddleware +
 * deviceAuthenticator + the real MobilePairingService: an owner phone and the bearer read both lists;
 * an MSP phone is refused. The writes need an owner phone, a configured PIN, local TLS or loopback,
 * the enrolled presence key, a single-use challenge bound to device, Host and the exact action, and
 * the presence signature: replayed, expired, wrong-action, wrong-target, wrong-reason, wrong-value,
 * wrong-device, console-ticket-signed, bearer and MSP attempts are refused and audited, and only a
 * proven action reaches the injected console path (the e2e drives the real one).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobilePermissionsRoutes, permissionPresenceMessage, actionLine, consentDisclosure, type MobilePermissionsDeps, type ActionResult } from '../../src/server/mobilePermissionsRoutes.js';
import { presenceMessage } from '../../src/server/mobileConsoleTicket.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeatureEvidenceLog, setFeatureEvidenceLog } from '../../src/monitoring/FeatureEvidenceLog.js';

const HOST = 'echo.example.dev';
const HASH = 'b'.repeat(64);
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  vi.useRealTimers();
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-permissions.test.ts' });
});

const relay = { id: 'threadline-relay', name: 'Agent network', consentTier: 'network', switchable: true, fullDescription: 'Joins the agent network.', dataImplications: [{ dataType: 'messages', description: 'Messages to other agents', destination: 'relay.example' }], reversibilityNote: 'Turn it off any time.' };
const backup = { id: 'git-backup', name: 'Git backup', consentTier: 'local', switchable: true, oneLiner: 'Back up to git.' };

function setup(cfg: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnperm-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242', mobilePairing: { multiRoute: { enabled: false } }, ...cfg } as never;
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(svc);
  const calls: Array<[string, ...unknown[]]> = [];
  // A switch can be made to wait here (as behind another switch on the same feature).
  const hold: { wait: Promise<void> | null } = { wait: null };
  const deps: MobilePermissionsDeps = {
    pairing: () => svc,
    config: () => config,
    stateDir: dir,
    bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    localSlips: () => ({
      approvals: { state: 'ok', rows: [{ id: 'authreq-1', createdByAgent: 'echo', createdAt: new Date().toISOString(), requestExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), headline: 'Let Sam deploy to production for 1 hour.', reason: 'release', heldOnThisMachine: true, proposalHash: HASH, recipientKnown: true }] },
      slips: { state: 'ok', mandates: [], invalidIds: [] },
    }),
    personName: () => 'Sam',
    peerSlips: async () => [],
    peerFeatures: async () => [],
    nicknameOf: () => null,
    features: () => ({ state: 'ok', list: [{ definition: relay, state: { discoveryState: 'disabled' }, effective: { status: 'off' } }, { definition: backup, state: { discoveryState: 'enabled' }, effective: { status: 'on' } }] }),
    featureDefinition: (id) => (id === relay.id ? relay : id === backup.id ? backup : null),
    approve: (id, hash, deviceId): ActionResult => { calls.push(['approve', id, hash, deviceId]); return { status: 201, body: { approved: true } }; },
    deny: (id, reason, deviceId): ActionResult => { calls.push(['deny', id, reason, deviceId]); return { status: 200, body: { denied: true } }; },
    requestSecret: (label, note, topicId): ActionResult => { calls.push(['ask', label, note, topicId]); return { status: 201, body: { ok: true, key: 'abcdef0123456789', expiresAt: new Date().toISOString() } }; },
    cancelSecret: (key): ActionResult => { calls.push(['cancel', key]); return key === 'ffffffffffffffff' ? { status: 404, body: { error: 'request-gone' } } : { status: 200, body: { ok: true } }; },
    setFeature: async (_req, id, to, deviceId, still) => {
      if (hold.wait) await hold.wait;
      const refusal = still();
      calls.push(['feature', id, to, deviceId, refusal]);
      return refusal ? { status: 503, body: { error: refusal } } : { status: 200, body: { success: true, viaOperatorSwitch: true } };
    },
  };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  // A request marked as arriving from the LAN (not loopback, not TLS): the transport rule's other side.
  app.use((req, _res, next) => { if (req.headers['x-test-lan']) Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.20', configurable: true }); next(); });
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobilePermissionsRoutes(router, deps);
  app.use(router);
  const pair = (person?: { userId: string; role: 'msp' }, withPresence = true) => {
    const dev = makeDevice();
    const presence = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    if (withPresence) svc.devices.setPresenceKey(created.device.id, presence.publicKey);
    return { dev, presence, id: created.device.id };
  };
  return { app, svc, calls, pair, dir, config, hold };
}

type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string };
let tick = 0;
function send(app: express.Express, phone: Phone, method: 'GET' | 'POST', p: string, body?: unknown, extra: Record<string, string> = {}) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const sig = phone.dev.sign(canonicalString(phone.id, HOST, method, p, time, raw));
  let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  r = r.set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
  return raw ? r.send(raw.toString()) : r;
}
async function challenge(app: express.Express, phone: Phone, body: Record<string, unknown>) {
  const r = await send(app, phone, 'POST', '/mobile/permissions/challenge', body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.challenge as string;
}
const sig = (phone: Phone, c: string, line: string) => phone.presence.sign(permissionPresenceMessage(phone.id, HOST, c, line));
const auditRows = (dir: string) => fs.readFileSync(path.join(dir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('reads', () => {
  it('an owner phone reads both lists, with what it can do', async () => {
    const c = setup();
    const owner = c.pair();
    const slips = await send(c.app, owner, 'GET', '/mobile/permissions/slips');
    expect(slips.status).toBe(200);
    expect(slips.headers['cache-control']).toBe('no-store');
    expect(slips.body.actions).toEqual({ state: 'available', reason: null, presenceKey: true });
    expect(slips.body.approvals.rows[0]).toMatchObject({ id: 'authreq-1', here: true, proposalHash: HASH });
    const feats = await send(c.app, owner, 'GET', '/mobile/permissions/features');
    expect(feats.status).toBe(200);
    expect(feats.body.features.map((f: { id: string }) => f.id)).toEqual(['threadline-relay', 'git-backup']);
    expect(feats.body.features[0].consent.disclosureHash).toBe(consentDisclosure(relay)!.disclosureHash);
  });
  it('the bearer reads (console-only actions); an MSP phone is refused', async () => {
    const c = setup();
    const r = await request(c.app).get('/mobile/permissions/slips').set('Authorization', 'Bearer tok-1');
    expect(r.status).toBe(200);
    expect(r.body.actions).toMatchObject({ state: 'console-only', reason: 'bearer' });
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    for (const p of ['/mobile/permissions/slips', '/mobile/permissions/features']) {
      const m = await send(c.app, msp, 'GET', p);
      expect(m.status, p).toBe(403);
      expect(m.body.error).toBe('owner-phone-required');
    }
  });
  it('actions say why a phone is read-only', async () => {
    // Mobile pairing itself is dev-gated, so the writes' own switch is turned off explicitly here.
    const off = setup({ mobilePairing: { multiRoute: { enabled: false }, permissionActions: { enabled: false } } });
    expect((await send(off.app, off.pair(), 'GET', '/mobile/permissions/slips')).body.actions.reason).toBe('off');
    const noPin = setup({ dashboardPin: undefined });
    expect((await send(noPin.app, noPin.pair(), 'GET', '/mobile/permissions/slips')).body.actions.reason).toBe('no-pin');
    const lan = setup();
    expect((await send(lan.app, lan.pair(), 'GET', '/mobile/permissions/slips', undefined, { 'x-test-lan': '1' })).body.actions.reason).toBe('transport');
    const noTicket = setup({ mobilePairing: { multiRoute: { enabled: false }, consoleTicket: { enabled: false } } });
    expect((await send(noTicket.app, noTicket.pair(undefined, false), 'GET', '/mobile/permissions/slips')).body.actions).toMatchObject({ state: 'console-only', reason: 'enrol-off', presenceKey: false });
  });
});

describe('writes: a proven action reaches the console path', () => {
  it('approve, decline and switch with a fresh proof each', async () => {
    const c = setup();
    const p = c.pair();
    setFeatureEvidenceLog(new FeatureEvidenceLog({ projectDir: c.dir, machine: 'm1', instarVersion: '0.0.0' }));
    let ch = await challenge(c.app, p, { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    let r = await send(c.app, p, 'POST', '/mobile/permissions/requests/authreq-1/approve', { proposalHash: HASH, challenge: ch, presenceSig: sig(p, ch, `approve-request authreq-1 ${HASH}`) });
    expect(r.status).toBe(201);
    const reason = 'Not this week.';
    ch = await challenge(c.app, p, { action: 'decline-request', target: 'authreq-1', reason });
    r = await send(c.app, p, 'POST', '/mobile/permissions/requests/authreq-1/decline', { reason, challenge: ch, presenceSig: sig(p, ch, actionLine({ kind: 'decline-request', target: 'authreq-1', reason })) });
    expect(r.status).toBe(200);
    const dh = consentDisclosure(relay)!.disclosureHash;
    ch = await challenge(c.app, p, { action: 'set-feature', target: 'threadline-relay', value: 'enabled', disclosureHash: dh });
    r = await send(c.app, p, 'POST', '/mobile/permissions/features/threadline-relay', { to: 'enabled', disclosureHash: dh, challenge: ch, presenceSig: sig(p, ch, `set-feature threadline-relay enabled ${dh}`) });
    expect(r.status).toBe(200);
    ch = await challenge(c.app, p, { action: 'set-feature', target: 'git-backup', value: 'disabled' });
    r = await send(c.app, p, 'POST', '/mobile/permissions/features/git-backup', { to: 'disabled', challenge: ch, presenceSig: sig(p, ch, 'set-feature git-backup disabled none') });
    expect(r.status).toBe(200);
    expect(c.calls).toEqual([
      ['approve', 'authreq-1', HASH, p.id], ['deny', 'authreq-1', reason, p.id],
      ['feature', 'threadline-relay', 'enabled', p.id, null], ['feature', 'git-backup', 'disabled', p.id, null],
    ]);
    const rows = auditRows(c.dir).filter((x) => x.event !== 'challenge');
    expect(rows.map((x) => x.event)).toEqual(['approved', 'declined', 'feature-set', 'feature-set']);
    expect(JSON.stringify(rows)).not.toContain(reason); // the decline text is never in the audit
    // One ladder row per action that went through, carrying the action kind and nothing it acted on.
    const evidence = fs.readFileSync(path.join(c.dir, 'logs/feature-evidence.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    setFeatureEvidenceLog(null);
    expect(evidence.map(x => [x.featureId, x.kind, x.reason])).toEqual([
      ['mobilePairing.permissionActions', 'fired', 'approved'], ['mobilePairing.permissionActions', 'fired', 'declined'],
      ['mobilePairing.permissionActions', 'fired', 'feature-set'], ['mobilePairing.permissionActions', 'fired', 'feature-set'],
    ]);
    expect(JSON.stringify(evidence)).not.toContain('authreq-1');
  });
});

describe('writes: refusals', () => {
  async function attempt(c: ReturnType<typeof setup>, signer: Phone, poster: Phone, opts: { issue?: Record<string, unknown>; line?: string; route?: string; body?: Record<string, unknown> } = {}) {
    const issue = opts.issue ?? { action: 'approve-request', target: 'authreq-1', proposalHash: HASH };
    const ch = await challenge(c.app, poster, issue);
    const line = opts.line ?? `approve-request authreq-1 ${HASH}`;
    return send(c.app, poster, 'POST', opts.route ?? '/mobile/permissions/requests/authreq-1/approve', { proposalHash: HASH, ...opts.body, challenge: ch, presenceSig: sig(signer, ch, line) });
  }
  it('replayed: the same challenge and signature work once', async () => {
    const c = setup();
    const p = c.pair();
    const ch = await challenge(c.app, p, { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    const body = { proposalHash: HASH, challenge: ch, presenceSig: sig(p, ch, `approve-request authreq-1 ${HASH}`) };
    expect((await send(c.app, p, 'POST', '/mobile/permissions/requests/authreq-1/approve', body)).status).toBe(201);
    const again = await send(c.app, p, 'POST', '/mobile/permissions/requests/authreq-1/approve', body);
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('challenge-invalid');
    expect(c.calls).toHaveLength(1);
  });
  it('expired: a challenge older than a minute is refused', async () => {
    const c = setup();
    const p = c.pair();
    const ch = await challenge(c.app, p, { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
    try {
      // The device signature uses the shifted clock too, so only the challenge is stale.
      const r = await send(c.app, p, 'POST', '/mobile/permissions/requests/authreq-1/approve', { proposalHash: HASH, challenge: ch, presenceSig: sig(p, ch, `approve-request authreq-1 ${HASH}`) });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('challenge-invalid');
    } finally { vi.restoreAllMocks(); }
    expect(c.calls).toHaveLength(0);
  });
  it('wrong action, target, proposal, reason or value: refused, nothing runs', async () => {
    const c = setup();
    const p = c.pair();
    const cases: Array<{ issue?: Record<string, unknown>; line?: string; route?: string; body?: Record<string, unknown> }> = [
      // A challenge for approving, used to decline.
      { route: '/mobile/permissions/requests/authreq-1/decline', body: { reason: 'x' }, line: actionLine({ kind: 'decline-request', target: 'authreq-1', reason: 'x' }) },
      // A challenge for one request, used on another.
      { route: '/mobile/permissions/requests/authreq-2/approve', line: `approve-request authreq-2 ${HASH}` },
      // The signature names another proposal than the body.
      { line: `approve-request authreq-1 ${'c'.repeat(64)}` },
      // A decline whose reason differs from the one challenged.
      { issue: { action: 'decline-request', target: 'authreq-1', reason: 'first' }, route: '/mobile/permissions/requests/authreq-1/decline', body: { reason: 'second' }, line: actionLine({ kind: 'decline-request', target: 'authreq-1', reason: 'second' }) },
      // A switch challenged for off, posted as on.
      { issue: { action: 'set-feature', target: 'git-backup', value: 'disabled' }, route: '/mobile/permissions/features/git-backup', body: { to: 'enabled' }, line: 'set-feature git-backup enabled none' },
    ];
    for (const k of cases) {
      const r = await attempt(c, p, p, k);
      expect(r.status, JSON.stringify(k)).toBe(401);
    }
    expect(c.calls).toHaveLength(0);
  });
  it('wrong device: another phone\'s presence key, or the right phone with another\'s challenge', async () => {
    const c = setup();
    const p = c.pair(), q = c.pair();
    const r = await attempt(c, q, p);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('presence-invalid');
    const ch = await challenge(c.app, q, { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    const s = await send(c.app, p, 'POST', '/mobile/permissions/requests/authreq-1/approve', { proposalHash: HASH, challenge: ch, presenceSig: sig(p, ch, `approve-request authreq-1 ${HASH}`) });
    expect(s.status).toBe(401);
    expect(s.body.error).toBe('challenge-invalid');
    expect(c.calls).toHaveLength(0);
  });
  it('a console-ticket signature never approves', async () => {
    const c = setup();
    const p = c.pair();
    const ch = await challenge(c.app, p, { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    const r = await send(c.app, p, 'POST', '/mobile/permissions/requests/authreq-1/approve', { proposalHash: HASH, challenge: ch, presenceSig: p.presence.sign(presenceMessage(p.id, HOST, ch)) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('presence-invalid');
  });
  it('a changed consent disclosure is refused before anything changes', async () => {
    const c = setup();
    const p = c.pair();
    const stale = 'd'.repeat(64);
    const r = await attempt(c, p, p, { issue: { action: 'set-feature', target: 'threadline-relay', value: 'enabled', disclosureHash: stale }, route: '/mobile/permissions/features/threadline-relay', body: { to: 'enabled', disclosureHash: stale }, line: `set-feature threadline-relay enabled ${stale}` });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('disclosure-changed');
    // Turning a consent-tier switch on with no disclosure at all is refused the same way.
    const n = await attempt(c, p, p, { issue: { action: 'set-feature', target: 'threadline-relay', value: 'enabled' }, route: '/mobile/permissions/features/threadline-relay', body: { to: 'enabled' }, line: 'set-feature threadline-relay enabled none' });
    expect(n.status).toBe(409);
    expect(c.calls).toHaveLength(0);
  });
  it('the gate: bearer, MSP, no presence key, no PIN, LAN, feature off', async () => {
    const c = setup();
    const b = await request(c.app).post('/mobile/permissions/challenge').set('Authorization', 'Bearer tok-1').send({ action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    expect(b.status).toBe(403);
    expect(b.body.error).toBe('device-signature-required');
    const b2 = await request(c.app).post('/mobile/permissions/requests/authreq-1/approve').set('Authorization', 'Bearer tok-1').send({ proposalHash: HASH });
    expect(b2.status).toBe(403);
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    expect((await send(c.app, msp, 'POST', '/mobile/permissions/challenge', { action: 'approve-request', target: 'authreq-1', proposalHash: HASH })).status).toBe(403);
    const bare = c.pair(undefined, false);
    const m = await send(c.app, bare, 'POST', '/mobile/permissions/challenge', { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    expect([m.status, m.body.error]).toEqual([409, 'presence-key-missing']);
    const lan = await send(c.app, c.pair(), 'POST', '/mobile/permissions/challenge', { action: 'approve-request', target: 'authreq-1', proposalHash: HASH }, { 'x-test-lan': '1' });
    expect([lan.status, lan.body.error]).toEqual([403, 'secure-transport-required']);
    const noPin = setup({ dashboardPin: undefined });
    const np = await send(noPin.app, noPin.pair(), 'POST', '/mobile/permissions/challenge', { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    expect([np.status, np.body.error]).toEqual([503, 'console-pin-not-set']);
    const fleet = setup({ mobilePairing: { multiRoute: { enabled: false }, permissionActions: { enabled: false } } });
    const f = await send(fleet.app, fleet.pair(), 'POST', '/mobile/permissions/challenge', { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    expect([f.status, f.body.error]).toEqual([503, 'permission-actions-off']);
    expect(c.calls).toHaveLength(0);
    // Every route refusal left a row (the bearer's with no device id).
    const rows = auditRows(c.dir).filter((x) => x.event === 'refused');
    expect(rows.map((x) => x.reason)).toEqual(expect.arrayContaining(['device-signature-required', 'presence-key-missing', 'secure-transport-required']));
    expect(rows.find((x) => x.reason === 'device-signature-required').deviceId).toBeNull();
  });
  it('a phone removed after its challenge cannot use it; the feature switched off stops a queued switch', async () => {
    const c = setup();
    const p = c.pair();
    const ch = await challenge(c.app, p, { action: 'approve-request', target: 'authreq-1', proposalHash: HASH });
    c.svc.devices.revoke(p.id, new Date().toISOString());
    const r = await send(c.app, p, 'POST', '/mobile/permissions/requests/authreq-1/approve', { proposalHash: HASH, challenge: ch, presenceSig: sig(p, ch, `approve-request authreq-1 ${HASH}`) });
    expect(r.status).toBe(401); // the device authenticator refuses a revoked phone outright
    expect(c.calls).toHaveLength(0);
    // A switch that waits sees the live state when it runs: the feature switched off while it waited.
    const q = c.pair();
    const ch2 = await challenge(c.app, q, { action: 'set-feature', target: 'git-backup', value: 'disabled' });
    let release!: () => void;
    c.hold.wait = new Promise<void>((r) => { release = r; });
    const pending = send(c.app, q, 'POST', '/mobile/permissions/features/git-backup', { to: 'disabled', challenge: ch2, presenceSig: sig(q, ch2, 'set-feature git-backup disabled none') }).then((x) => x);
    await new Promise((r) => setTimeout(r, 50));
    (c.config as { mobilePairing: Record<string, unknown> }).mobilePairing.permissionActions = { enabled: false };
    release();
    const done = await pending;
    expect(done.status).toBe(503);
    expect(c.calls.at(-1)).toEqual(['feature', 'git-backup', 'disabled', q.id, 'permission-actions-off']);
  });
});

describe('asking for a key and cancelling a request (docs/specs/mobile-native-secrets-writes.md)', () => {
  const KEY = 'abcdef0123456789';
  const ask = { action: 'request-secret', target: 'new', label: 'OpenAI key', note: 'For the bot', topicId: 12 };
  const askBody = { label: ask.label, note: ask.note, topicId: ask.topicId };
  const askLine = actionLine({ kind: 'request-secret', target: 'new', label: ask.label, note: ask.note, topicId: 12 });
  const cancelLine = actionLine({ kind: 'cancel-secret', target: KEY });
  const cancelPath = `/mobile/secrets/requests/${KEY}/cancel`;

  it('an owner phone asks with a fresh proof; the action runs once, audited without the label or note', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await challenge(c.app, owner, ask);
    const r = await send(c.app, owner, 'POST', '/mobile/secrets/requests', { ...askBody, challenge: ch, presenceSig: sig(owner, ch, askLine) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(c.calls).toEqual([['ask', 'OpenAI key', 'For the bot', 12]]);
    const rows = auditRows(c.dir);
    expect(rows.map((x) => x.event)).toEqual(['challenge', 'secret-requested']);
    expect(rows[1]).toMatchObject({ action: 'request-secret', target: 'new', requestKey: 'abcdef0123456789' });
    expect(JSON.stringify(rows)).not.toContain('OpenAI key');
    expect(JSON.stringify(rows)).not.toContain('For the bot');
    // Single use.
    const again = await send(c.app, owner, 'POST', '/mobile/secrets/requests', { ...askBody, challenge: ch, presenceSig: sig(owner, ch, askLine) });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('challenge-invalid');
    expect(c.calls).toHaveLength(1);
  });

  it('a proof for one request does not cover a changed label, note or conversation', async () => {
    const c = setup();
    const owner = c.pair();
    for (const changed of [{ label: 'Stripe key' }, { note: 'Other' }, { topicId: 13 }]) {
      const ch = await challenge(c.app, owner, ask);
      const r = await send(c.app, owner, 'POST', '/mobile/secrets/requests', { ...askBody, ...changed, challenge: ch, presenceSig: sig(owner, ch, askLine) });
      expect(r.status, JSON.stringify(changed)).toBe(401);
    }
    expect(c.calls).toEqual([]);
  });

  it('a cancel proof covers exactly its key, and a bad signature runs nothing', async () => {
    const c = setup();
    const owner = c.pair();
    const ch = await challenge(c.app, owner, { action: 'cancel-secret', target: KEY });
    const other = 'bbbbbbbbbbbbbbbb';
    const wrong = await send(c.app, owner, 'POST', `/mobile/secrets/requests/${other}/cancel`, { challenge: ch, presenceSig: sig(owner, ch, cancelLine) });
    expect(wrong.status).toBe(401);
    const ch2 = await challenge(c.app, owner, { action: 'cancel-secret', target: KEY });
    const bad = await send(c.app, owner, 'POST', cancelPath, { challenge: ch2, presenceSig: sig(owner, ch2, askLine) });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('presence-invalid');
    expect(c.calls).toEqual([]);
    const ch3 = await challenge(c.app, owner, { action: 'cancel-secret', target: KEY });
    const ok = await send(c.app, owner, 'POST', cancelPath, { challenge: ch3, presenceSig: sig(owner, ch3, cancelLine) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(c.calls).toEqual([['cancel', KEY]]);
    expect(auditRows(c.dir).some((x) => x.event === 'secret-cancelled' && x.target === KEY)).toBe(true);
  });

  it('a refused action is audited as refused and its code reaches the phone', async () => {
    const c = setup();
    const owner = c.pair();
    const gone = 'ffffffffffffffff';
    const ch = await challenge(c.app, owner, { action: 'cancel-secret', target: gone });
    const r = await send(c.app, owner, 'POST', `/mobile/secrets/requests/${gone}/cancel`, { challenge: ch, presenceSig: sig(owner, ch, actionLine({ kind: 'cancel-secret', target: gone })) });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('request-gone');
    expect(auditRows(c.dir).at(-1)).toMatchObject({ event: 'refused', target: gone });
  });

  it('a pasted key is refused at the challenge, before any Face ID prompt', async () => {
    const c = setup();
    const owner = c.pair();
    const r = await send(c.app, owner, 'POST', '/mobile/permissions/challenge', { ...ask, label: '0123456789abcdef0123' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('looks-like-a-secret');
  });

  it('the bearer, an MSP phone, a phone with no key, a revoked phone, and the switch off all stop it', async () => {
    const c = setup();
    const bearer = await request(c.app).post('/mobile/secrets/requests').set('Authorization', 'Bearer tok-1').send(askBody);
    expect(bearer.status).toBe(403);
    expect(bearer.body.error).toBe('device-signature-required');
    const msp = c.pair({ userId: 'justin', role: 'msp' });
    expect((await send(c.app, msp, 'POST', '/mobile/secrets/requests', askBody)).status).toBe(403);
    expect((await send(c.app, msp, 'POST', cancelPath, {})).status).toBe(403);
    const noKey = c.pair(undefined, false);
    const nk = await send(c.app, noKey, 'POST', '/mobile/secrets/requests', askBody);
    expect(nk.status).toBe(409);
    expect(nk.body.error).toBe('presence-key-missing');
    const gone = c.pair();
    c.svc.devices.revoke(gone.id, new Date().toISOString());
    expect((await send(c.app, gone, 'POST', '/mobile/secrets/requests', askBody)).status).toBe(401);
    const off = setup({ mobilePairing: { multiRoute: { enabled: false }, permissionActions: { enabled: false } } });
    const phone = off.pair();
    const o = await send(off.app, phone, 'POST', '/mobile/secrets/requests', askBody);
    expect(o.status).toBe(503);
    expect(o.body.error).toBe('permission-actions-off');
    expect(c.calls.concat(off.calls)).toEqual([]);
  });

  it('a token pasted into a cancel path never reaches the audit file', async () => {
    const c = setup();
    const token = 'c'.repeat(64);
    const r = await request(c.app).post(`/mobile/secrets/requests/${token}/cancel`).set('Authorization', 'Bearer tok-1').send({});
    expect(r.status).toBe(403);
    expect(fs.readFileSync(path.join(c.dir, 'state', 'mobile-permission-actions.jsonl'), 'utf8')).not.toContain(token);
  });

  it('a malformed cancel key never reaches the route', async () => {
    const c = setup();
    const owner = c.pair();
    const r = await send(c.app, owner, 'POST', `/mobile/secrets/requests/${'a'.repeat(64)}/cancel`, {});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('device-not-allowed');
  });
});
