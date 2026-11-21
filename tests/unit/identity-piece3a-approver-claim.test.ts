/**
 * identity-security piece 3a §3, §5, §6, §7 through the real device routes: a lone agent's first approver by the
 * private-chat code, the record it writes, who may approve afterwards, kept devices, and removing an approver.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, deviceAuthenticator, createMobilePairingRouter, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { mayApprove, markApproverForTest, migrateApprovers, resetApproverStateCacheForTests, tightenApproverCutoff } from '../../src/server/mobileApprover.js';
import { keyHashOf } from '../../src/core/MobileDeviceKeys.js';
import { resetApproverClaimForTests } from '../../src/server/mobileApproverClaim.js';
import { resetApproverRevokeForTests, takeApproverRevokeTap } from '../../src/server/mobileApproverRevoke.js';
import { resetApproverGrantForTests } from '../../src/server/mobileApproverGrant.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { wireOwnerRecordStore, resetOwnerRecordWiringForTests, ownerRecordRouteDeps } from '../../src/core/ownerRecordWiring.js';
import { OWNER_RECORD_LOCAL_KEY_FILE } from '../../src/core/ownerRecordLocalKey.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/identity-piece3a-approver-claim.test.ts' });
  resetOwnerRecordWiringForTests(); resetApproverClaimForTests(); resetApproverRevokeForTests(); resetApproverGrantForTests(); resetApproverStateCacheForTests();
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3a-claim-'));
  dirs.push(dir);
  const config = { projectName: 'echo', stateDir: dir, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as never;
  const dms: Array<{ text: string; decline: string; approve?: string }> = [];
  const deps = { config, stateDir: dir, holdsLease: () => true, selfMachineId: 'm_self', telegramOwnerPresent: () => true,
    ownerDM: async (text: string, decline: string, approve?: string) => { dms.push({ text, decline, approve }); return 1; } } as unknown as MobilePairingDeps;
  const svc = new MobilePairingService(deps);
  services.push(svc);
  wireOwnerRecordStore(config, new MachineIdentityManager(dir)); // a lone agent: no machine identity
  migrateApprovers(svc, { now: Date.now(), earliestPeerMigration: null, allPeersAnswered: false, singleMachine: true });
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps));
  const pair = () => {
    const dev = makeDevice(); const presence = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
    if (!created.ok) throw new Error('setup');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    return { dev, presence, id: created.device.id };
  };
  return { app, svc, dms, pair, dir };
}
type Phone = ReturnType<ReturnType<typeof setup>['pair']>;
let tick = 0;
function post(app: express.Express, p: Phone, url: string, body: unknown) {
  const time = String(Date.now() + (tick++ % 1000));
  const raw = Buffer.from(JSON.stringify(body));
  return request(app).post(url).set('Content-Type', 'application/json').set('Host', HOST)
    .set('X-Instar-Device', p.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', p.dev.sign(canonicalString(p.id, HOST, 'POST', url, time, raw)))
    .send(raw.toString());
}
const claim = (app: express.Express, p: Phone) => post(app, p, '/mobile/approver/first', { presenceKey: p.presence.publicKey, presenceProof: p.presence.sign(presenceEnrollMessage(p.id, HOST, p.presence.publicKey)) });
const codeIn = (text: string) => /type this code on it: ([A-Z]+-\d{4})/.exec(text)![1]!;

async function becomeFirst(c: ReturnType<typeof setup>, p: Phone) {
  const r = await claim(c.app, p);
  expect(r.body, JSON.stringify(r.body)).toMatchObject({ eligible: true });
  const conf = await post(c.app, p, '/mobile/approver/first/confirm', { code: codeIn(c.dms.at(-1)!.text) });
  expect(conf.status, JSON.stringify(conf.body)).toBe(200);
  const done = await post(c.app, p, '/mobile/approver/first/sign', { entry: conf.body.entry, sig: p.presence.sign(conf.body.sign) });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return conf.body;
}

describe('the first approver on a lone agent (§3)', () => {
  it('a device with a presence key but no mark cannot approve; the code makes it the record\'s first owner key', async () => {
    const c = setup();
    const p = c.pair();
    c.svc.devices.setPresenceKey(p.id, p.presence.publicKey); // what any program could do before this piece
    expect(mayApprove(c.svc, p.id)).toBe(false);
    expect(fs.existsSync(path.join(c.dir, OWNER_RECORD_LOCAL_KEY_FILE))).toBe(false);
    const conf = await becomeFirst(c, p);
    expect(c.dms[0]!.text).toContain('Never type it into a Windows PC');
    expect(conf.entry.signer).toMatchObject({ type: 'owner-key' });
    expect(fs.existsSync(path.join(c.dir, OWNER_RECORD_LOCAL_KEY_FILE))).toBe(true); // created only after the code
    expect(ownerRecordRouteDeps()!.store.state()!.everEnrolled).toBe(true);
    expect(mayApprove(c.svc, p.id)).toBe(true);
  });

  it('refuses a wrong code three times, a changed entry, and a second claim once an approver exists', async () => {
    const c = setup();
    const p = c.pair();
    expect((await claim(c.app, p)).body.eligible).toBe(true);
    expect((await post(c.app, p, '/mobile/approver/first/confirm', { code: 'KITE-0000' })).status).toBe(422);
    expect((await post(c.app, p, '/mobile/approver/first/confirm', { code: 'KITE-0001' })).status).toBe(422);
    expect((await post(c.app, p, '/mobile/approver/first/confirm', { code: 'KITE-0002' })).status).toBe(429);
    // start again (claims per day: this is the second)
    expect((await claim(c.app, p)).body.eligible).toBe(true);
    const conf = await post(c.app, p, '/mobile/approver/first/confirm', { code: codeIn(c.dms.at(-1)!.text) });
    const changed = { ...conf.body.entry, body: { ...conf.body.entry.body, label: 'Evil' } };
    expect((await post(c.app, p, '/mobile/approver/first/sign', { entry: changed, sig: p.presence.sign(conf.body.sign) })).body.error).toBe('entry-changed');
    expect((await post(c.app, p, '/mobile/approver/first/sign', { entry: conf.body.entry, sig: makeDevice().sign(conf.body.sign) })).status).toBe(409); // a bad approval signature is not a refused device signature
    expect((await post(c.app, p, '/mobile/approver/first/sign', { entry: conf.body.entry, sig: p.presence.sign(conf.body.sign) })).status).toBe(200);
    const q = c.pair();
    expect((await claim(c.app, q)).body).toMatchObject({ eligible: false, reason: 'approver-exists' });
  });

  it('refuses while another owner device that cannot approve is paired, naming it', async () => {
    const c = setup();
    const p = c.pair();
    const other = c.pair();
    expect((await claim(c.app, p)).body).toMatchObject({ eligible: false, reason: 'other-devices', devices: [other.id] });
    expect(c.dms).toHaveLength(0);
  });
});

describe('kept devices and removal (§5, §6)', () => {
  it('a kept device approves; the presence-key route refuses an unmarked device and stores nothing', async () => {
    const c = setup();
    const kept = c.pair();
    markApproverForTest(c.svc, kept.id, kept.presence.publicKey);
    expect(mayApprove(c.svc, kept.id)).toBe(true);
    const fresh = c.pair();
    const r = await post(c.app, fresh, '/mobile/device/presence-key', { publicKey: fresh.presence.publicKey, proof: fresh.presence.sign(presenceEnrollMessage(fresh.id, HOST, fresh.presence.publicKey)) });
    expect([r.status, r.body.error]).toEqual([403, 'approver-required']);
    expect(mayApprove(c.svc, fresh.id)).toBe(false);
  });

  it('the token alone cannot remove an approving device: 202, and only the owner\'s tap removes it; the last owner key is refused', async () => {
    const c = setup();
    const first = c.pair();
    await becomeFirst(c, first);
    // the record's only owner key
    const last = await request(c.app).post(`/mobile/devices/${first.id}/revoke`).set('Authorization', 'Bearer tok-1').set('Host', HOST).send({});
    expect([last.status, last.body.error]).toEqual([409, 'last-approver']);
    const kept = c.pair();
    markApproverForTest(c.svc, kept.id, kept.presence.publicKey);
    const r = await request(c.app).post(`/mobile/devices/${kept.id}/revoke`).set('Authorization', 'Bearer tok-1').set('Host', HOST).send({});
    expect([r.status, r.body.pending]).toEqual([202, 'pending-owner-confirm']);
    expect(mayApprove(c.svc, kept.id)).toBe(true); // keeps the right until the owner taps
    expect(c.dms.at(-1)!.approve).toMatch(/^md:a:[0-9a-f]{24}$/);
  });
});

describe('giving the right to another device (§4)', () => {
  it('an approver signs the new device in; a kept device cannot; then removing one waits for the owner\'s tap', async () => {
    const c = setup();
    const first = c.pair();
    await becomeFirst(c, first);
    const second = c.pair();
    const ask = await post(c.app, second, '/mobile/approver/request', { presenceKey: second.presence.publicKey, presenceProof: second.presence.sign(presenceEnrollMessage(second.id, HOST, second.presence.publicKey)) });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const kept = c.pair();
    markApproverForTest(c.svc, kept.id, kept.presence.publicKey);
    expect((await post(c.app, kept, '/mobile/approver/grant/draft', { requestId: ask.body.requestId })).body.error).toBe('approver-required');
    expect(ask.body.matchCode).toMatch(/^\d{6}$/);
    // never listed: the approver sees only a count, and picks the request by the code on the device in hand
    const listing = await request(c.app).get('/mobile/approver/requests').set('Host', HOST);
    void listing;
    expect((await post(c.app, first, '/mobile/approver/grant/draft', { requestId: ask.body.requestId })).status).toBe(404); // not looked up yet
    expect((await post(c.app, first, '/mobile/approver/lookup', { matchCode: '000000' === ask.body.matchCode ? '111111' : '000000' })).status).toBe(404);
    const found = await post(c.app, first, '/mobile/approver/lookup', { matchCode: ask.body.matchCode });
    expect(found.body).toMatchObject({ requestId: ask.body.requestId, deviceId: second.id });
    expect(found.body.sentence).toContain('Never for a Windows PC');
    const draft = await post(c.app, first, '/mobile/approver/grant/draft', { requestId: ask.body.requestId });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    // signed by the wrong key: the record refuses it
    expect((await post(c.app, first, '/mobile/approver/grant/sign', { requestId: ask.body.requestId, entry: draft.body.entry, sig: second.presence.sign(draft.body.sign) })).body.error).toBe('record-refused');
    const ok = await post(c.app, first, '/mobile/approver/grant/sign', { requestId: ask.body.requestId, entry: draft.body.entry, sig: first.presence.sign(draft.body.sign) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(mayApprove(c.svc, second.id)).toBe(true);
    // two owner keys now: removing the first asks the owner, and the tap removes it
    const r = await request(c.app).post(`/mobile/devices/${first.id}/revoke`).set('Authorization', 'Bearer tok-1').set('Host', HOST).send({});
    expect(r.status).toBe(202);
    const nonce = c.dms.at(-1)!.approve!.slice('md:a:'.length);
    expect(takeApproverRevokeTap(c.svc, nonce, true, (id) => c.svc.devices.revoke(id, new Date().toISOString())).done).toBe(true);
    // the removed phone pairs again and tries to register the same key: retired, refused
    const back = c.pair();
    const rb = await post(c.app, { ...back, presence: first.presence }, '/mobile/device/presence-key', { publicKey: first.presence.publicKey, proof: first.presence.sign(presenceEnrollMessage(back.id, HOST, first.presence.publicKey)) });
    expect([rb.status, rb.body.error]).toEqual([403, 'approver-required']);
    expect(mayApprove(c.svc, first.id)).toBe(false);
    // the first key is still in the record but its device is gone, so the second is now the last live one
    const last = await request(c.app).post(`/mobile/devices/${second.id}/revoke`).set('Authorization', 'Bearer tok-1').set('Host', HOST).send({});
    expect([last.status, last.body.error]).toEqual([409, 'last-approver']);
    // the approver signs the record's revocation of the first key
    const firstKeyId = (await import('../../src/core/ownerApprover.js')).ownerKeyIdFor(first.presence.publicKey);
    const rd = await post(c.app, second, '/mobile/approver/revoke/draft', { keyId: firstKeyId });
    expect(rd.status, JSON.stringify(rd.body)).toBe(200);
    const rs = await post(c.app, second, '/mobile/approver/revoke/sign', { keyId: firstKeyId, entry: rd.body.entry, sig: second.presence.sign(rd.body.sign) });
    expect(rs.status, JSON.stringify(rs.body)).toBe(200);
    expect(ownerRecordRouteDeps()!.store.state()!.keys.some((k) => k.keyId === firstKeyId)).toBe(false);
    // and the last live owner key can't be revoked by its own signature either
    const selfId = (await import('../../src/core/ownerApprover.js')).ownerKeyIdFor(second.presence.publicKey);
    expect((await post(c.app, second, '/mobile/approver/revoke/draft', { keyId: selfId })).body.error).toBe('last-approver');
  });
});

describe('kept devices across machines (§5, mobile-approver-mark §3.6)', () => {
  it('an earlier upgrade on another machine moves the cutoff back and drops devices set up after it; it never adds', async () => {
    const c = setup();
    const a = c.pair();
    c.svc.devices.setPresenceKey(a.id, a.presence.publicKey);
    await new Promise((r) => setTimeout(r, 5));
    const earliest = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const b = c.pair();
    c.svc.devices.setPresenceKey(b.id, b.presence.publicKey);
    const later = new Date(Date.now() + 60_000).toISOString();
    fs.writeFileSync(path.join(c.dir, 'state', 'mobile-approver-state.json'), JSON.stringify({ migration: { at: later, cutoff: later, cutoffConfirmed: false,
      kept: [a, b].map((p) => ({ deviceId: p.id, presenceKeyHash: keyHashOf(p.presence.publicKey) })) } }));
    resetApproverStateCacheForTests();
    expect(mayApprove(c.svc, b.id)).toBe(true);
    expect(tightenApproverCutoff(c.svc, earliest, false).dropped).toEqual([b.id]);
    expect(mayApprove(c.svc, a.id)).toBe(true);
    expect(mayApprove(c.svc, b.id)).toBe(false);
    expect(tightenApproverCutoff(c.svc, later, true).dropped).toEqual([]); // a later time never widens it
    expect(mayApprove(c.svc, b.id)).toBe(false);
  });
});

describe('the review fixes', () => {
  it('a computer paired before the update (no approval key) is vouched for and does not block the first claim', async () => {
    const c = setup();
    const oldMac = c.pair();
    SafeFsExecutor.safeRmSync(path.join(c.dir, 'state', 'mobile-approver-state.json'), { force: true, operation: 'tests/unit/identity-piece3a-approver-claim.test.ts:reset-migration' });
    resetApproverStateCacheForTests();
    await new Promise((r) => setTimeout(r, 5));
    migrateApprovers(c.svc, { now: Date.now(), earliestPeerMigration: null, allPeersAnswered: false, singleMachine: true });
    const phone = c.pair();
    expect((await claim(c.app, phone)).body.eligible).toBe(true);
    void oldMac;
  });

  it('an owner key in the record registers on a second device id (the same phone on another machine)', async () => {
    const c = setup();
    const first = c.pair();
    await becomeFirst(c, first);
    // the same phone, paired again under another device id, with the same approval key
    const again = c.pair();
    const sameKey = { ...again, presence: first.presence };
    c.svc.devices.revoke(first.id, new Date().toISOString()); // only one device here may hold a key
    const r = await post(c.app, sameKey, '/mobile/device/presence-key', { publicKey: first.presence.publicKey, proof: first.presence.sign(presenceEnrollMessage(again.id, HOST, first.presence.publicKey)) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(mayApprove(c.svc, again.id)).toBe(true);
  });
});

describe('removal takes effect safely (round 2)', () => {
  it('two removals asked one after the other leave one device that approves', async () => {
    const c = setup();
    const a = c.pair();
    await becomeFirst(c, a);
    const b = c.pair();
    const ask = await post(c.app, b, '/mobile/approver/request', { presenceKey: b.presence.publicKey, presenceProof: b.presence.sign(presenceEnrollMessage(b.id, HOST, b.presence.publicKey)) });
    await post(c.app, a, '/mobile/approver/lookup', { matchCode: ask.body.matchCode });
    const d = await post(c.app, a, '/mobile/approver/grant/draft', { requestId: ask.body.requestId });
    expect((await post(c.app, a, '/mobile/approver/grant/sign', { requestId: ask.body.requestId, entry: d.body.entry, sig: a.presence.sign(d.body.sign) })).status).toBe(200);
    for (const p of [a, b]) expect((await request(c.app).post(`/mobile/devices/${p.id}/revoke`).set('Authorization', 'Bearer tok-1').set('Host', HOST).send({})).status).toBe(202);
    const nonces = c.dms.filter((m) => m.approve).slice(-2).map((m) => m.approve!.slice(5));
    const revoke = (id: string) => c.svc.devices.revoke(id, new Date().toISOString());
    expect(takeApproverRevokeTap(c.svc, nonces[0]!, true, revoke).done).toBe(true);
    const second = takeApproverRevokeTap(c.svc, nonces[1]!, true, revoke);
    expect(second.done).toBe(false);
    expect(second.text).toContain('only device');
    expect(mayApprove(c.svc, b.id)).toBe(true);
  });

  it('two approvers signing each other\'s revocation: the second is refused when it takes effect', async () => {
    const c = setup();
    const a = c.pair();
    await becomeFirst(c, a);
    const b = c.pair();
    const ask = await post(c.app, b, '/mobile/approver/request', { presenceKey: b.presence.publicKey, presenceProof: b.presence.sign(presenceEnrollMessage(b.id, HOST, b.presence.publicKey)) });
    await post(c.app, a, '/mobile/approver/lookup', { matchCode: ask.body.matchCode });
    const d = await post(c.app, a, '/mobile/approver/grant/draft', { requestId: ask.body.requestId });
    await post(c.app, a, '/mobile/approver/grant/sign', { requestId: ask.body.requestId, entry: d.body.entry, sig: a.presence.sign(d.body.sign) });
    const { ownerKeyIdFor } = await import('../../src/core/ownerApprover.js');
    const ka = ownerKeyIdFor(a.presence.publicKey), kb = ownerKeyIdFor(b.presence.publicKey);
    const da = await post(c.app, a, '/mobile/approver/revoke/draft', { keyId: kb });
    const db = await post(c.app, b, '/mobile/approver/revoke/draft', { keyId: ka });
    expect([da.status, db.status]).toEqual([200, 200]);
    expect((await post(c.app, a, '/mobile/approver/revoke/sign', { keyId: kb, entry: da.body.entry, sig: a.presence.sign(da.body.sign) })).status).toBe(200);
    const late = await post(c.app, b, '/mobile/approver/revoke/sign', { keyId: ka, entry: db.body.entry, sig: b.presence.sign(db.body.sign) });
    expect(late.status).not.toBe(200);
    expect(mayApprove(c.svc, a.id)).toBe(true);
  });
});

describe('the approvers list the apps read (mobile-approver-mark §3.10)', () => {
  function get(app: express.Express, p: Phone, url: string) {
    const time = String(Date.now() + (tick++ % 1000));
    return request(app).get(url).set('Host', HOST).set('X-Instar-Device', p.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', p.dev.sign(canonicalString(p.id, HOST, 'GET', url, time, undefined)));
  }
  it('says the claim is open before any approver, then lists the approver and closes it', async () => {
    const c = setup();
    const p = c.pair();
    const before = await get(c.app, p, '/mobile/approvers');
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body).toMatchObject({ feature: 1, self: { mayApprove: false }, holders: [], opening: { state: 'open', route: 'private-chat' } });
    await becomeFirst(c, p);
    const after = await get(c.app, p, '/mobile/approvers');
    expect(after.body).toMatchObject({ self: { mayApprove: true }, opening: { state: 'closed', reason: 'approver-exists' } });
    expect(after.body.holders).toEqual([expect.objectContaining({ deviceId: p.id, via: 'record', self: true })]);
    const q = c.pair();
    const ask = await post(c.app, q, '/mobile/approver/request', { presenceKey: q.presence.publicKey, presenceProof: q.presence.sign(presenceEnrollMessage(q.id, HOST, q.presence.publicKey)) });
    const mine = await get(c.app, q, '/mobile/approvers');
    expect(mine.body.self.request).toEqual({ requestId: ask.body.requestId, matchCode: ask.body.matchCode });
    expect((await get(c.app, p, '/mobile/approvers')).body.self.request).toBeUndefined(); // codes only to the asking device
  });
});
