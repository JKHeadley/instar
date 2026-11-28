/**
 * Approving a trust raise from the Instar app (docs/specs/app-trust-approval.md), route and verifier
 * layer: the production auth middleware, device authenticator and MobilePairingService, the real
 * permission routes with their single-use challenges, and a real AccountPathService behind the port.
 * Covers Acceptance §1 (route and verifier): a replayed challenge is refused, a machine that is not
 * the serving-lease holder refuses before issuing a challenge, and the local override is refused for
 * a remote device. Also: the bearer can never approve or record an acceptance.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, DEVICE_ALLOWLIST, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { mountMobilePermissionsRoutes, permissionPresenceMessage, buildAction, actionLine, type MobilePermissionsDeps } from '../../src/server/mobilePermissionsRoutes.js';
import { createMobileTrustPort } from '../../src/server/mobileTrustApproval.js';
import { canonicalString, deviceFingerprint, keyHashOf } from '../../src/core/MobileDeviceKeys.js';
import { AccountPathService, proofSubject } from '../../src/core/trustJourney/AccountPathService.js';
import { LocalFileTrustSink, TrustJourneyStore, type TrustChange } from '../../src/core/trustJourney/TrustJourneyStore.js';
import type { TrustAccountPathRuntime } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { proposalHashOf, type OperatorProof } from '../../src/core/TrustRaiseGuard.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { markApproverForTest } from '../../src/server/mobileApprover.js';

const HOST = 'echo.example.dev';
/** A device the Mac app paired on this computer is reached only over loopback at its stored host (#3259 localBindingOk). */
const LOCAL_HOST = '127.0.0.1:4040';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-trust-approval-routes.test.ts' });
});

const change: TrustChange = { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' };
const HASH = proposalHashOf(proofSubject(change));
const DISCLOSURE = 'Let this Mac approve changes to what Scout may do? Approved with Touch ID. The list of paired devices is kept on the agent\'s own computer.';
const DHASH = crypto.createHash('sha256').update(DISCLOSURE).digest('hex');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtrust-'));
  dirs.push(dir);
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, dashboardPin: '424242', mobilePairing: { multiRoute: { enabled: false } } } as never;
  const svc = new MobilePairingService({ config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self' } as MobilePairingDeps);
  services.push(svc);
  const state = { holder: true };
  const applied: OperatorProof[] = [];
  const store = new TrustJourneyStore(new LocalFileTrustSink(path.join(dir, 'tj.jsonl')));
  const service = new AccountPathService({
    store, adapters: {}, ownerPlatformId: () => null, installationId: 'inst', raisesOf: () => ['wider'], summarize: () => ['Change: gmail write'],
    apply: async (_c, p) => { applied.push(p); return { ok: true }; }, cardTtlDays: () => 7, holdsLease: () => state.holder,
  });
  const runtime = { service, holdsLease: () => state.holder } as unknown as TrustAccountPathRuntime;
  const port = createMobileTrustPort(runtime, () => svc, () => 'm_self');
  service.bindDevices(port.devices);
  const deps: MobilePermissionsDeps = {
    pairing: () => svc, config: () => config, stateDir: dir, bearerOk: (req) => req.headers.authorization === 'Bearer tok-1',
    localSlips: () => ({ approvals: { state: 'off', rows: [] }, slips: { state: 'off', mandates: [], invalidIds: [] } }),
    personName: () => null, peerSlips: async () => [], peerFeatures: async () => [], nicknameOf: () => null,
    features: () => ({ state: 'off', list: [] }), featureDefinition: () => null,
    approve: () => ({ status: 500, body: {} }), deny: () => ({ status: 500, body: {} }),
    setFeature: async () => ({ status: 500, body: {} }), requestSecret: () => ({ status: 500, body: {} }), cancelSecret: () => ({ status: 500, body: {} }),
    trust: () => port,
  };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  const router = express.Router();
  mountMobilePermissionsRoutes(router, deps);
  app.use(router);
  const pair = (opts: { local?: boolean; computer?: boolean } = {}) => {
    const dev = makeDevice();
    const presence = makeDevice();
    const host = opts.local ? LOCAL_HOST : HOST;
    const created = svc.devices.createPending({ deviceName: opts.computer ? 'Mac' : 'iPhone', label: null, publicKey: dev.publicKey, host, ...(opts.computer ? { deviceKind: 'computer' as const } : {}) });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    markApproverForTest(svc, created.device.id, presence.publicKey);
    if (opts.local) {
      // As the Mac app's local pairing writes it (mac-app-creates-agent §A): approvedVia local-install with a local binding.
      const file = path.join(dir, 'state', 'mobile-devices.json');
      const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const d of reg.devices) if (d.id === created.device.id) { d.approvedVia = 'local-install'; d.localBinding = { machineId: 'm_self' }; }
      fs.writeFileSync(file, JSON.stringify(reg));
    }
    return { dev, presence, id: created.device.id, fp: deviceFingerprint(dev.publicKey), host };
  };
  return { app, svc, store, service, state, applied, pair, dir, config: config as unknown as Record<string, unknown> & { mobilePairing: Record<string, unknown> } };
}

type Phone = { dev: ReturnType<typeof makeDevice>; presence: ReturnType<typeof makeDevice>; id: string; fp: string; host: string };
let tick = 0;
function send(app: express.Express, phone: Phone, method: 'GET' | 'POST', p: string, body?: unknown, extra: Record<string, string> = {}) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const sig = phone.dev.sign(canonicalString(phone.id, phone.host, method, p, time, raw));
  let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  r = r.set('Host', phone.host).set('X-Instar-Device', phone.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
  return raw ? r.send(raw.toString()) : r;
}
const line = (kind: string, target: string, extra: Record<string, string>) => {
  const b = buildAction(kind, target, extra);
  if (!b.ok) throw new Error(b.error);
  return actionLine(b.action);
};
async function signedAct(app: express.Express, phone: Phone, issue: Record<string, unknown>, route: string, body: Record<string, unknown>, ln: string, signer = phone.presence, extra: Record<string, string> = {}) {
  const ch = await send(app, phone, 'POST', '/mobile/permissions/challenge', issue);
  expect(ch.status, JSON.stringify(ch.body)).toBe(200);
  const full = { ...body, challenge: ch.body.challenge, presenceSig: signer.sign(permissionPresenceMessage(phone.id, phone.host, ch.body.challenge, ln)) };
  return { res: await send(app, phone, 'POST', route, full, extra), full };
}
async function acceptSelf(c: ReturnType<typeof setup>, phone: Phone, keyPolicy = 'biometryCurrentSet') {
  const ln = line('accept-device', phone.id, { keyFingerprint: phone.fp, disclosureHash: DHASH });
  return signedAct(c.app, phone, { action: 'accept-device', target: phone.id, keyFingerprint: phone.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance', { target: phone.id, keyFingerprint: phone.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy }, ln);
}

describe('mobile trust approval routes', () => {
  it('the routes are on the owner-device allowlist (and not open to browsers)', () => {
    for (const [m, p] of [['GET', '/mobile/trust/requests'], ['POST', '/mobile/trust/requests/tr-0123456789ab-abc123/approve'], ['POST', '/mobile/trust/device-acceptance'], ['POST', '/mobile/trust/device-acceptance/withdraw']] as const) {
      const rule = DEVICE_ALLOWLIST.find((r) => r.method === m && r.re.test(p));
      expect(rule, `${m} ${p}`).toBeTruthy();
      expect(rule!.ownerOnly).toBe(true);
      expect(rule!.browser).toBeUndefined();
    }
  });

  it('first device accepts, a proposal is listed, a presence-signed approval applies it once, and a replayed challenge is refused', async () => {
    const c = setup();
    const mac = c.pair({ local: true, computer: true });
    const acc = await acceptSelf(c, mac);
    expect(acc.res.status, JSON.stringify(acc.res.body)).toBe(200);
    expect(acc.res.body).toMatchObject({ status: 'recorded', via: 'local-install' });
    expect(c.store.deviceAcceptance(mac.id)).toMatchObject({ disclosureHash: DHASH, keyFingerprint: mac.fp, presenceKeyHash: keyHashOf(mac.presence.publicKey), keyPolicy: 'biometryCurrentSet' });
    const p = await c.service.propose(change);
    const requestId = (p as { requestId: string }).requestId;
    const listed = await send(c.app, mac, 'GET', '/mobile/trust/requests');
    expect(listed.status).toBe(200);
    expect(listed.body.requests).toEqual([expect.objectContaining({ requestId, status: 'open', proposalHash: HASH })]);
    expect(listed.body.approvals.thisDevice).toMatchObject({ via: 'local-install' });
    const ln = line('approve-widening', requestId, { proposalHash: HASH });
    const ok = await signedAct(c.app, mac, { action: 'approve-widening', target: requestId, proposalHash: HASH }, `/mobile/trust/requests/${requestId}/approve`, { proposalHash: HASH }, ln);
    expect(ok.res.status, JSON.stringify(ok.res.body)).toBe(200);
    expect(ok.res.body.status).toBe('applied');
    expect(c.applied.map((x) => x.kind)).toEqual(['accepted-device']);
    // The same signed body again: the challenge was single-use.
    const replay = await send(c.app, mac, 'POST', `/mobile/trust/requests/${requestId}/approve`, ok.full);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('challenge-invalid');
    // A fresh challenge for the same request: already approved.
    const again = await signedAct(c.app, mac, { action: 'approve-widening', target: requestId, proposalHash: HASH }, `/mobile/trust/requests/${requestId}/approve`, { proposalHash: HASH }, ln);
    expect(again.res.status).toBe(409);
    expect(again.res.body.error).toBe('already-approved');
    expect(c.applied).toHaveLength(1);
    const after = await send(c.app, mac, 'GET', '/mobile/trust/requests');
    expect(after.body.requests[0]).toMatchObject({ status: 'applied', approvedOn: 'device' });
    expect(after.body.requests[0].disclosure).toContain('not independently verified');
  });

  it('a machine that is not the serving-lease holder refuses before issuing a challenge, and at the approve route', async () => {
    const c = setup();
    const mac = c.pair({ local: true, computer: true });
    expect((await acceptSelf(c, mac)).res.status).toBe(200);
    const requestId = ((await c.service.propose(change)) as { requestId: string }).requestId;
    c.state.holder = false;
    const ch = await send(c.app, mac, 'POST', '/mobile/permissions/challenge', { action: 'approve-widening', target: requestId, proposalHash: HASH });
    expect(ch.status).toBe(409);
    expect(ch.body.error).toBe('not-holder');
    const ap = await send(c.app, mac, 'POST', `/mobile/trust/requests/${requestId}/approve`, { proposalHash: HASH, challenge: 'x'.repeat(43), presenceSig: 'AA' });
    expect(ap.status).toBe(409);
    expect(ap.body.error).toBe('not-holder');
    expect(c.applied).toHaveLength(0);
  });

  it('the bearer token can never approve or record an acceptance', async () => {
    const c = setup();
    const mac = c.pair({ local: true, computer: true });
    expect((await acceptSelf(c, mac)).res.status).toBe(200);
    const requestId = ((await c.service.propose(change)) as { requestId: string }).requestId;
    const bearer = (p: string, body: unknown) => request(c.app).post(p).set('Authorization', 'Bearer tok-1').set('Content-Type', 'application/json').send(JSON.stringify(body));
    expect((await bearer(`/mobile/trust/requests/${requestId}/approve`, { proposalHash: HASH })).status).toBe(403);
    expect((await bearer('/mobile/trust/device-acceptance', { keyFingerprint: mac.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy: 'biometryCurrentSet' })).status).toBe(403);
    expect((await bearer('/mobile/permissions/challenge', { action: 'approve-widening', target: requestId, proposalHash: HASH })).status).toBe(403);
    expect(c.applied).toHaveLength(0);
  });

  it('a later device is accepted only after an accepted device approves it; a disclosure that does not match its hash is refused', async () => {
    const c = setup();
    const mac = c.pair({ local: true, computer: true });
    expect((await acceptSelf(c, mac)).res.status).toBe(200);
    const phone = c.pair();
    // Without an approval: refused.
    const early = await acceptSelf(c, phone, 'userPresence');
    expect(early.res.status).toBe(403);
    expect(early.res.body.error).toBe('approval-needed');
    // The Mac approves the phone (its own presence signature over the phone's id, key and disclosure hash).
    const ln = line('accept-device', phone.id, { keyFingerprint: phone.fp, disclosureHash: DHASH });
    const appr = await signedAct(c.app, mac, { action: 'accept-device', target: phone.id, keyFingerprint: phone.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance', { target: phone.id, keyFingerprint: phone.fp, disclosureHash: DHASH }, ln);
    expect(appr.res.status, JSON.stringify(appr.res.body)).toBe(200);
    expect(appr.res.body.status).toBe('recorded');
    // A tampered disclosure text is refused before anything is consumed.
    const bad = await send(c.app, phone, 'POST', '/mobile/trust/device-acceptance', { keyFingerprint: phone.fp, disclosureHash: DHASH, disclosure: 'something else', keyPolicy: 'userPresence', challenge: 'x'.repeat(43), presenceSig: 'AA' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('disclosure-mismatch');
    const late = await acceptSelf(c, phone, 'userPresence');
    expect(late.res.status, JSON.stringify(late.res.body)).toBe(200);
    expect(late.res.body).toMatchObject({ status: 'recorded', via: 'accept-device' });
  });

  it('the trust switch (not the phone-permissions switch) decides; withdrawing works with it off', async () => {
    const c = setup();
    const mac = c.pair({ local: true, computer: true });
    // Both switches set explicitly (an explicit value wins over the development-agent default, as on the fleet).
    c.config.mobilePairing.permissionActions = { enabled: false };
    c.config.mobilePairing.trustApproval = { enabled: false };
    const off = await send(c.app, mac, 'POST', '/mobile/permissions/challenge', { action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH });
    expect(off.status).toBe(503);
    expect(off.body.error).toBe('trust-approval-off');
    // On, as a new install writes it: approvals from the app work although phone permission changes stay off.
    c.config.mobilePairing.trustApproval = { enabled: true };
    expect((await acceptSelf(c, mac)).res.status).toBe(200);
    // Phone permission changes stay governed by their own switch, still off.
    const permissionKind = await send(c.app, mac, 'POST', '/mobile/permissions/challenge', { action: 'approve-request', target: 'r1', proposalHash: HASH });
    expect(permissionKind.status).toBe(503);
    expect(permissionKind.body.error).toBe('permission-actions-off');
    // Off again: withdrawing still works, because it only narrows.
    c.config.mobilePairing.trustApproval = { enabled: false };
    const w = await send(c.app, mac, 'POST', '/mobile/trust/device-acceptance/withdraw', {});
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.withdrawn).toBe(1);
  });

  it('a new pairing reaches the approving devices as a notice once an acceptance exists', async () => {
    const c = setup();
    const notes: string[] = [];
    const orig = c.service.noteDevicePaired.bind(c.service);
    c.svc.devices.onActivated = (d) => { notes.push(d.id); void orig(d.id); };
    const mac = c.pair({ local: true, computer: true });
    expect(notes).toEqual([mac.id]);
    expect((await acceptSelf(c, mac)).res.status).toBe(200);
    const phone = c.pair();
    expect(notes).toEqual([mac.id, phone.id]);
  });

  it('withdrawing from the device turns its approvals off', async () => {
    const c = setup();
    const mac = c.pair({ local: true, computer: true });
    expect((await acceptSelf(c, mac)).res.status).toBe(200);
    const w = await send(c.app, mac, 'POST', '/mobile/trust/device-acceptance/withdraw', {});
    expect(w.status).toBe(200);
    expect(w.body.withdrawn).toBe(1);
    expect(c.store.deviceAcceptance(mac.id)).toBeNull();
    // The still-paired app retains the request for setup, but withdrawal removes approval authority.
    const proposed = await c.service.propose(change);
    expect(proposed).toMatchObject({ status: 'awaiting-acceptance', via: 'device' });
    const requestId = (proposed as { requestId: string }).requestId;
    const ln = line('approve-widening', requestId, { proposalHash: HASH });
    const refused = await signedAct(c.app, mac, { action: 'approve-widening', target: requestId, proposalHash: HASH }, `/mobile/trust/requests/${requestId}/approve`, { proposalHash: HASH }, ln);
    expect(refused.res.status).toBe(403);
    expect(refused.res.body.error).toBe('acceptance-withdrawn');
    expect(c.applied).toHaveLength(0);
    expect(c.store.request(requestId)?.status).toBe('open');
  });

  it('the local override: refused for a forwarded (remote) request; over loopback an approving device keeps its key (identity piece 3a)', async () => {
    const c = setup();
    const mac = c.pair({ local: true, computer: true });
    expect((await acceptSelf(c, mac)).res.status).toBe(200);
    const old = c.store.deviceAcceptance(mac.id)!;
    const fresh = makeDevice();
    const ln = line('accept-device', mac.id, { keyFingerprint: mac.fp, disclosureHash: DHASH });
    const body = { target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH, disclosure: DISCLOSURE, keyPolicy: 'biometryCurrentSet', override: true, newPresenceKey: fresh.publicKey };
    const remote = await signedAct(c.app, mac, { action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance', body, ln, fresh, { 'X-Forwarded-For': '203.0.113.9' });
    // Refused either at sign-in (#3259: a locally-bound device is only reached over loopback with no
    // forwarding header) or at the override's own local-only check; never accepted.
    expect([401, 403]).toContain(remote.res.status);
    expect(c.svc.devices.get(mac.id)!.presenceKey).toBe(mac.presence.publicKey);
    // A device not paired locally cannot use it either.
    const phone = c.pair();
    const pl = line('accept-device', phone.id, { keyFingerprint: phone.fp, disclosureHash: DHASH });
    const notLocal = await signedAct(c.app, phone, { action: 'accept-device', target: phone.id, keyFingerprint: phone.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance', { ...body, target: phone.id, keyFingerprint: phone.fp, keyPolicy: 'userPresence' }, pl, fresh);
    expect(notLocal.res.status).toBe(403);
    // Loopback, no forwarding header: identity-security piece 3a (mobile-approver-mark §3.5) refuses to replace an
    // approving device's key, which would silently remove its right; the device is removed and set up again instead.
    const local = await signedAct(c.app, mac, { action: 'accept-device', target: mac.id, keyFingerprint: mac.fp, disclosureHash: DHASH }, '/mobile/trust/device-acceptance', body, ln, fresh);
    expect([local.res.status, local.res.body.error]).toEqual([409, 'approver-key-locked']);
    expect(c.svc.devices.get(mac.id)!.presenceKey).toBe(mac.presence.publicKey);
    expect(c.store.deviceAcceptance(mac.id)?.acceptanceId).toBe(old.acceptanceId);
  });
});
