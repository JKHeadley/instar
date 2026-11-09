/**
 * Approve instead of a code (docs/specs/mobile-pairing-approve.md) through the real HTTP pipeline:
 * the redeem answer per path, the dashboard route, the owner phone's Face ID routes, the status poll,
 * refusals, and the code path still working beside it all.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { pairingApproveLine, pairingApproveMessage } from '../../src/server/mobilePairingApproval.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const HOST = 'echo-approve.example.dev';
const SESSION = 'operator-session-token';
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-pairing-approve.test.ts' });
});

function setup(opts: { telegramOwner?: boolean; approve?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpa-int-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    threadline: { ownerName: 'Justin' },
    mobilePairing: { multiRoute: { enabled: false }, ...(opts.approve === undefined ? {} : { approve: { enabled: opts.approve } }) },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const dms: Array<{ text: string; decline: string; approve?: string }> = [];
  const lease = { held: true };
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), selfMachineId: 'm_self', fetchFn,
    ownerDM: async (text, decline, approve) => { dms.push({ text, decline, approve }); return 7; },
    telegramOwnerPresent: () => opts.telegramOwner === true,
    holdsLease: () => lease.held,
  };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  svc.nativeOn = true;
  const pushes: unknown[] = [];
  svc.push = { notifyHere: (t: unknown) => pushes.push(t) } as unknown as typeof svc.push;
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'echo', undefined, deviceAuthenticator(svc)));
  const poolCtx = { config, resolvePeerUrls: () => [], recordRopeResult: undefined, verifyDashboardOperatorSession: (t: string | undefined) => t === SESSION } as unknown as Parameters<typeof createMobilePairingRouter>[2];
  app.use(createMobilePairingRouter(svc, deps, poolCtx));
  return { app, svc, dms, lease, dir, config, pushes };
}
type Ctx = ReturnType<typeof setup>;

const bearer = (q: request.Test) => q.set('Authorization', 'Bearer tok-1');
const operator = (q: request.Test) => bearer(q).set('X-Instar-Operator-Session', SESSION);
let lastSignTime = 0;
function signed(app: express.Express, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  lastSignTime = Math.max(Date.now(), lastSignTime + 1);
  const time = String(lastSignTime);
  const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
  const r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  r.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? r.send(raw.toString()) : r;
}
async function waiting(ctx: Ctx, extra: Record<string, unknown> = {}) {
  const m = await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({ label: 'mine', ...extra });
  expect(m.status).toBe(200);
  const dev = makeDevice();
  const r = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: dev.publicKey });
  expect(r.status).toBe(200);
  return { dev, deviceId: r.body.deviceId as string, redeem: r };
}
/** An active owner phone with a presence key on file. */
async function ownerPhone(ctx: Ctx, opts: { presence?: boolean } = {}) {
  const p = await waiting(ctx);
  expect(ctx.svc.approvePending(p.deviceId, 'dashboard-pin')).toBe('approved');
  const presence = makeDevice();
  if (opts.presence !== false) expect(ctx.svc.devices.setPresenceKey(p.deviceId, presence.publicKey)).toBe('set');
  return { ...p, presence };
}
async function faceId(ctx: Ctx, phone: Awaited<ReturnType<typeof ownerPhone>>, id: string, action: 'approve' | 'decline', fingerprint: string) {
  const c = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', `/mobile/pairing-requests/${id}/challenge`, { action });
  expect(c.status).toBe(200);
  const presenceSig = phone.presence.sign(pairingApproveMessage(phone.deviceId, HOST, c.body.challenge, pairingApproveLine(action, id, fingerprint)));
  return { challenge: c.body.challenge as string, presenceSig };
}

describe('what the waiting phone is told', () => {
  it('Telegram path: the message has both buttons, the key and the code; the answer names where the button went', async () => {
    const ctx = setup({ telegramOwner: true });
    const { redeem, deviceId } = await waiting(ctx);
    expect(redeem.body).toMatchObject({ status: 'pending', approval: 'telegram', confirmWith: ['telegram', 'code'] });
    const row = ctx.svc.devices.get(deviceId)!;
    expect(redeem.body.fingerprint).toBe(row.fingerprint);
    expect(redeem.body.expiresAt).toBe(row.expiresAt);
    const nonce = ctx.dms[0]!.decline.slice(5);
    expect(ctx.dms[0]!.approve).toBe(`md:a:${nonce}`);
    expect(ctx.dms[0]!.text).toContain(row.fingerprint);
    expect(ctx.dms[0]!.text).toContain('this key matches the one the app shows');
    expect(ctx.dms[0]!.text).toMatch(/is \d{3} \d{3}\./);
    expect(JSON.stringify(redeem.body)).not.toContain(/is (\d{3} \d{3})\./.exec(ctx.dms[0]!.text)![1]!);
    expect(redeem.body.token).toBeUndefined();
  });

  it('dashboard path: names the dashboard only while the pairing page is open; never the code', async () => {
    const ctx = setup();
    const { redeem, dev, deviceId } = await waiting(ctx);
    // mobile-pairing-introducer §3.4: nobody has the pairing page open yet.
    expect(redeem.body).toMatchObject({ approval: 'dashboard', confirmWith: ['code'], codeAt: 'pairing-page' });
    expect(JSON.stringify(redeem.body)).not.toMatch(/"code":/);
    await operator(request(ctx.app).get('/mobile/pairing-approvals'));
    expect((await signed(ctx.app, dev, deviceId, 'GET', '/mobile/device')).body.confirmWith).toEqual(['dashboard', 'code']);
    expect(ctx.dms).toHaveLength(0);
  });

  it('names an owner phone only when one here can answer, and pushes it once, with nothing in the push', async () => {
    const ctx = setup();
    await ownerPhone(ctx, { presence: false });
    const noKey = await waiting(ctx);
    expect(noKey.redeem.body.confirmWith).toEqual(['code']);
    expect(ctx.pushes).toHaveLength(0);
    ctx.svc.declinePending(noKey.deviceId);

    const ctx2 = setup();
    await ownerPhone(ctx2);
    const w = await waiting(ctx2);
    expect(w.redeem.body.confirmWith).toEqual(['owner-phone', 'code']);
    expect(ctx2.pushes).toEqual([{ kind: 'notice', dedupeKey: `pairing-request:${w.deviceId}` }]);
  });

  it('the status poll is signed as the waiting phone and follows it to the end', async () => {
    const ctx = setup();
    const w = await waiting(ctx);
    expect((await request(ctx.app).get('/mobile/device')).status).toBe(401);
    const s1 = await signed(ctx.app, w.dev, w.deviceId, 'GET', '/mobile/device');
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ status: 'pending', confirmWith: ['code'], fingerprint: ctx.svc.devices.get(w.deviceId)!.fingerprint });
    expect(typeof s1.body.expiresAt).toBe('string');
    await operator(request(ctx.app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).send({});
    const s2 = await signed(ctx.app, w.dev, w.deviceId, 'GET', '/mobile/device');
    expect(s2.body).toMatchObject({ status: 'active', approvedVia: 'dashboard-pin' });
    expect(s2.body.confirmWith).toBeUndefined();
    expect((await signed(ctx.app, w.dev, w.deviceId, 'GET', '/mobile/routes')).status).toBe(200);
  });

  it('a declined phone reads declined', async () => {
    const ctx = setup();
    const w = await waiting(ctx);
    await operator(request(ctx.app).post(`/mobile/pairing-approvals/${w.deviceId}/decline`)).send({});
    expect((await signed(ctx.app, w.dev, w.deviceId, 'GET', '/mobile/device')).body.status).toBe('declined');
  });

  it('the switch off: today\'s message and answers, routes closed, code still works', async () => {
    const ctx = setup({ telegramOwner: true, approve: false });
    const w = await waiting(ctx);
    expect(w.redeem.body.confirmWith).toBeUndefined();
    expect(ctx.dms[0]!.approve).toBeUndefined();
    expect(ctx.dms[0]!.text).toMatch(/^Your code to pair a phone with echo is \d{3} \d{3}\./);
    expect(ctx.svc.approveByNonce(ctx.dms[0]!.decline.slice(5))).toBe('off');
    const code = /is (\d{3}) (\d{3})\./.exec(ctx.dms[0]!.text)!.slice(1).join('');
    expect((await signed(ctx.app, w.dev, w.deviceId, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    const count = ctx.dms.length;
    const m = await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({});
    const dev = makeDevice();
    const send = (key: string) => request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: key });
    expect((await send(dev.publicKey)).status).toBe(200);
    expect((await send(makeDevice().publicKey)).status).toBe(403);
    expect(ctx.dms.length).toBe(count + 1); // the code message only: no two-phones notice
    expect((await signed(ctx.app, w.dev, w.deviceId, 'GET', '/mobile/pairing-requests')).status).toBe(503);
  });
});

describe('the dashboard button', () => {
  it('the Bearer token alone is refused; a PIN session approves with no lease', async () => {
    const ctx = setup();
    const w = await waiting(ctx);
    expect((await bearer(request(ctx.app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).send({})).status).toBe(403);
    expect((await signed(ctx.app, w.dev, w.deviceId, 'POST', `/mobile/pairing-approvals/${w.deviceId}/approve`, {})).status).toBe(403);
    ctx.lease.held = false;
    const list = await operator(request(ctx.app).get('/mobile/pairing-approvals'));
    expect(list.body.approvals[0].canApprove).toBe(true);
    const r = await operator(request(ctx.app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'active', deviceId: w.deviceId });
    expect(ctx.svc.devices.get(w.deviceId)!.approvedVia).toBe('dashboard-pin');
  });

  it('repeat and late answers refuse with a plain reason; the code is gone', async () => {
    const ctx = setup();
    const w = await waiting(ctx);
    expect((await operator(request(ctx.app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).send({})).status).toBe(200);
    const again = await operator(request(ctx.app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).send({});
    expect(again.status).toBe(404);
    expect(again.body.detail).toContain('no longer waiting');
    expect((await operator(request(ctx.app).get('/mobile/pairing-approvals'))).body.approvals).toHaveLength(0);
  });

  it('the PIN never approves a phone on an agent with a Telegram owner', async () => {
    const ctx = setup({ telegramOwner: true });
    const w = await waiting(ctx);
    const r = await operator(request(ctx.app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).send({});
    expect(r.status).toBe(404);
    expect(ctx.svc.devices.get(w.deviceId)!.status).toBe('pending');
    expect((await operator(request(ctx.app).get('/mobile/pairing-approvals'))).body.approvals).toEqual([]);
  });

  it('a Telegram owner bound while a dashboard phone waits: the PIN no longer approves it', async () => {
    const ctx = setup();
    const w = await waiting(ctx);
    ctx.svc.deps.telegramOwnerPresent = () => true;
    const r = await operator(request(ctx.app).post(`/mobile/pairing-approvals/${w.deviceId}/approve`)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('approval-moved');
    expect(ctx.svc.devices.get(w.deviceId)!.status).toBe('pending');
  });

  it('two phones waiting: refused until the stranger is declined; each code still works', async () => {
    const ctx = setup();
    const mine = await waiting(ctx);
    const theirs = await waiting(ctx);
    const r = await operator(request(ctx.app).post(`/mobile/pairing-approvals/${mine.deviceId}/approve`)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('another-phone-waiting');
    expect(r.body.detail).toContain('Decline the one that is not yours');
    const rows = (await operator(request(ctx.app).get('/mobile/pairing-approvals'))).body.approvals as Array<{ deviceId: string; code: string }>;
    const code = rows.find((a) => a.deviceId === mine.deviceId)!.code;
    expect((await signed(ctx.app, mine.dev, mine.deviceId, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    expect(ctx.svc.devices.get(theirs.deviceId)!.status).toBe('pending');
  });

  it('a paused agent refuses', async () => {
    const ctx = setup();
    const target = await waiting(ctx);
    const others = [makeDevice(), makeDevice(), makeDevice(), makeDevice()].map((d) => ctx.svc.devices.createPending({ deviceName: null, label: null, publicKey: d.publicKey, host: HOST }));
    let n = 0;
    for (const o of others) if (o.ok) for (let i = 0; i < 3; i++) ctx.svc.devices.applyConfirm(o.device.id, { ok: false, wrongHmac: `w${n++}` });
    const r = await operator(request(ctx.app).post(`/mobile/pairing-approvals/${target.deviceId}/approve`)).send({});
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('pairing-paused');
  });
});

describe('whose phone is this tap for? (spec §4)', () => {
  it('the same link from a second key contests the phone that took it: Approve refused, owner told, code still works', async () => {
    const ctx = setup({ telegramOwner: true });
    const m = await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({});
    const thief = makeDevice();
    const r1 = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'Justin iPhone', devicePublicKey: thief.publicKey });
    expect(r1.status).toBe(200);
    const nonce = ctx.dms[0]!.decline.slice(5);
    const code = /is (\d{3}) (\d{3})\./.exec(ctx.dms[0]!.text)!.slice(1).join('');
    // The owner's own phone opens the same link.
    const r2 = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: makeDevice().publicKey });
    expect(r2.status).toBe(403);
    expect(ctx.dms[ctx.dms.length - 1]!.text).toContain('Two phones tried to use the same pairing link');
    expect(ctx.svc.approveByNonce(nonce)).toBe('contested');
    expect(ctx.svc.devices.get(r1.body.deviceId)!.status).toBe('pending');
    const status = await signed(ctx.app, thief, r1.body.deviceId, 'GET', '/mobile/device');
    expect(status.body.confirmWith).toEqual(['code']);
    expect((await signed(ctx.app, thief, r1.body.deviceId, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  });

  it('the link reused after the first phone was approved: the owner is told to check it; one notice per link', async () => {
    const ctx = setup({ telegramOwner: true });
    const m = await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({});
    const thief = makeDevice();
    const r1 = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'x', devicePublicKey: thief.publicKey });
    expect(ctx.svc.approveByNonce(ctx.dms[0]!.decline.slice(5))).toBe('approved');
    const again = () => request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: makeDevice().publicKey });
    expect((await again()).status).toBe(403);
    const notice = ctx.dms[ctx.dms.length - 1]!.text;
    expect(notice).toContain('the first is now paired');
    expect(notice).toContain(ctx.svc.devices.get(r1.body.deviceId)!.fingerprint!);
    const count = ctx.dms.length;
    await again(); await again();
    expect(ctx.dms.length).toBe(count);
  });

  it('the same key again (an app retry) contests nothing', async () => {
    const ctx = setup({ telegramOwner: true });
    const m = await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({});
    const dev = makeDevice();
    const body = { code: m.body.code, deviceName: 'iPhone', devicePublicKey: dev.publicKey };
    const r1 = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send(body);
    expect((await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send(body)).status).toBe(403);
    expect(ctx.svc.approveByNonce(ctx.dms[0]!.decline.slice(5))).toBe('approved');
    expect(ctx.svc.devices.get(r1.body.deviceId)!.status).toBe('active');
  });

  it('a phone left waiting beside one finished by code cannot then be approved alone; Decline still works', async () => {
    const ctx = setup({ telegramOwner: true });
    const mine = await waiting(ctx);
    const theirs = await waiting(ctx);
    const code = /is (\d{3}) (\d{3})\./.exec(ctx.dms[0]!.text)!.slice(1).join('');
    expect((await signed(ctx.app, mine.dev, mine.deviceId, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    expect(ctx.svc.approveByNonce(ctx.dms[1]!.decline.slice(5))).toBe('contested');
    expect(ctx.svc.declineByNonce(ctx.dms[1]!.decline.slice(5))).toBe('declined');
    expect(ctx.svc.devices.get(theirs.deviceId)!.status).toBe('declined');
  });

  it('declining the stranger leaves my phone approvable', async () => {
    const ctx = setup();
    const mine = await waiting(ctx);
    const theirs = await waiting(ctx);
    expect((await operator(request(ctx.app).post(`/mobile/pairing-approvals/${theirs.deviceId}/decline`)).send({})).status).toBe(200);
    const list = (await operator(request(ctx.app).get('/mobile/pairing-approvals'))).body.approvals;
    expect(list).toHaveLength(1);
    expect(list[0].canApprove).toBe(true);
    expect((await operator(request(ctx.app).post(`/mobile/pairing-approvals/${mine.deviceId}/approve`)).send({})).status).toBe(200);
  });

  it('an MSP\'s phone: today\'s message, no Approve, code only; the owner can still decline it', async () => {
    const ctx = setup({ telegramOwner: true });
    ctx.svc.deps.people = () => ({ getUser: (id: string) => (id === 'sam' ? { id: 'sam', name: 'Sam', role: 'msp' } : null) }) as never;
    const w = await waiting(ctx, { userId: 'sam', role: 'msp' });
    expect(w.redeem.body.confirmWith).toEqual(['code']);
    expect(ctx.dms[0]!.approve).toBeUndefined();
    expect(ctx.dms[0]!.text).toMatch(/^Your code to pair a phone for /);
    expect(ctx.svc.approvePending(w.deviceId, 'owner-phone', { approvedBy: 'x' })).toBe('code-only');
    expect(ctx.svc.declineByNonce(ctx.dms[0]!.decline.slice(5))).toBe('declined');
  });

  it('an approval during the wait for Telegram stands if the message then fails', async () => {
    const ctx = setup({ telegramOwner: true });
    const m = await bearer(request(ctx.app).post('/mobile/pairing-codes')).send({});
    const dev = makeDevice();
    ctx.svc.deps.ownerDM = async () => {
      const row = ctx.svc.devices.list().find((d) => d.status === 'pending')!;
      expect(ctx.svc.approvePending(row.id, 'owner-phone', { approvedBy: 'owner-1' })).toBe('approved');
      return null;
    };
    const r = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('active');
    expect(ctx.svc.devices.get(r.body.deviceId)!.status).toBe('active');
  });
});

describe('an owner phone, with Face ID', () => {
  async function two(ctx: Ctx) {
    const phone = await ownerPhone(ctx);
    const w = await waiting(ctx);
    return { phone, w, fp: ctx.svc.devices.get(w.deviceId)!.fingerprint! };
  }
  const path_ = (id: string, a: string) => `/mobile/pairing-requests/${id}/${a}`;

  it('lists the waiting phone without a code, then approves it', async () => {
    const ctx = setup({ telegramOwner: true });
    const { phone, w, fp } = await two(ctx);
    const list = await signed(ctx.app, phone.dev, phone.deviceId, 'GET', '/mobile/pairing-requests');
    expect(list.status).toBe(200);
    expect(list.body.presenceKey).toBe(true);
    expect(list.body.waiting).toEqual([expect.objectContaining({ deviceId: w.deviceId, client: 'phone', deviceName: 'iPhone', fingerprint: fp, role: 'owner' })]);
    expect(list.body.waiting[0].code).toBeUndefined();
    const dmsBefore = ctx.dms.length;
    const a = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'approve'), await faceId(ctx, phone, w.deviceId, 'approve', fp));
    expect(a.status).toBe(200);
    expect(ctx.svc.devices.get(w.deviceId)).toMatchObject({ status: 'active', approvedVia: 'owner-phone', approvedBy: phone.deviceId });
    expect(ctx.dms[dmsBefore]!.text).toContain('approved a new phone with Face ID');
    expect((await signed(ctx.app, w.dev, w.deviceId, 'GET', '/mobile/device')).body).toMatchObject({ status: 'active', approvedVia: 'owner-phone' });
  });

  it('declines with Face ID', async () => {
    const ctx = setup();
    const { phone, w, fp } = await two(ctx);
    const d = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'decline'), await faceId(ctx, phone, w.deviceId, 'decline', fp));
    expect(d.status).toBe(200);
    expect(ctx.svc.devices.get(w.deviceId)!.status).toBe('declined');
  });

  it('the bearer token, the waiting phone itself and an MSP phone are refused', async () => {
    const ctx = setup();
    const msp = await ownerPhone(ctx);
    ctx.svc.devices.setPerson(msp.deviceId, { userId: 'sam', role: 'msp' });
    ctx.svc.deps.people = () => ({ getUser: (id: string) => (id === 'sam' ? { id: 'sam', name: 'Sam' } : null) }) as never;
    const { phone, w, fp } = await two(ctx);
    const body = await faceId(ctx, phone, w.deviceId, 'approve', fp);
    expect((await bearer(request(ctx.app).get('/mobile/pairing-requests'))).status).toBe(403);
    expect((await bearer(request(ctx.app).post(path_(w.deviceId, 'approve'))).send(body)).status).toBe(403);
    expect((await signed(ctx.app, w.dev, w.deviceId, 'POST', path_(w.deviceId, 'approve'), body)).status).toBe(401); // a pending phone is not on this route's status list
    expect(ctx.svc.devices.get(w.deviceId)!.status).toBe('pending');
    expect((await signed(ctx.app, msp.dev, msp.deviceId, 'POST', path_(w.deviceId, 'challenge'), { action: 'approve' })).status).toBe(403);
  });

  it('no presence key: refused by name, Face ID is required', async () => {
    const ctx = setup();
    const phone = await ownerPhone(ctx, { presence: false });
    const w = await waiting(ctx);
    const c = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'challenge'), { action: 'approve' });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('presence-key-missing');
  });

  it('a device signature alone, a bad presence signature, or a replayed challenge approves nothing', async () => {
    const ctx = setup();
    const { phone, w, fp } = await two(ctx);
    expect((await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'approve'), {})).status).toBe(401);
    const body = await faceId(ctx, phone, w.deviceId, 'approve', fp);
    // Signed by the device key, not the presence key.
    const wrongKey = phone.dev.sign(pairingApproveMessage(phone.deviceId, HOST, body.challenge, pairingApproveLine('approve', w.deviceId, fp)));
    const bad = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'approve'), { challenge: body.challenge, presenceSig: wrongKey });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('presence-invalid');
    // The challenge is gone even though the signature failed.
    const replay = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'approve'), body);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('challenge-invalid');
    expect(ctx.svc.devices.get(w.deviceId)!.status).toBe('pending');
  });

  it('a challenge for one phone, or for Decline, cannot approve another', async () => {
    const ctx = setup();
    const { phone, w, fp } = await two(ctx);
    const declineBody = await faceId(ctx, phone, w.deviceId, 'decline', fp);
    const moved = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'approve'), declineBody);
    expect(moved.status).toBe(401);
    expect(moved.body.error).toBe('challenge-invalid');
    const body = await faceId(ctx, phone, w.deviceId, 'approve', fp);
    const stranger = await waiting(ctx);
    const swapped = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(stranger.deviceId, 'approve'), body);
    expect(swapped.status).toBe(401);
    expect(ctx.svc.devices.get(stranger.deviceId)!.status).toBe('pending');
  });

  it('another owner phone cannot use this phone\'s challenge', async () => {
    const ctx = setup();
    const first = await ownerPhone(ctx);
    const second = await ownerPhone(ctx);
    const w = await waiting(ctx);
    const fp = ctx.svc.devices.get(w.deviceId)!.fingerprint!;
    const body = await faceId(ctx, first, w.deviceId, 'approve', fp);
    const r = await signed(ctx.app, second.dev, second.deviceId, 'POST', path_(w.deviceId, 'approve'), body);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('challenge-invalid');
  });

  it('late and repeated answers refuse with a plain reason', async () => {
    const ctx = setup();
    const { phone, w, fp } = await two(ctx);
    const body = await faceId(ctx, phone, w.deviceId, 'approve', fp);
    expect((await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'approve'), body)).status).toBe(200);
    const again = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'approve'), body);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('pairing-ended');
    expect(again.body.detail).toContain('no longer waiting');
    const c = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'challenge'), { action: 'approve' });
    expect(c.status).toBe(409);
  });

  it('a revoked approver is refused', async () => {
    const ctx = setup();
    const { phone, w, fp } = await two(ctx);
    const body = await faceId(ctx, phone, w.deviceId, 'approve', fp);
    ctx.svc.devices.revoke(phone.deviceId);
    expect((await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(w.deviceId, 'approve'), body)).status).toBe(401);
    expect(ctx.svc.devices.get(w.deviceId)!.status).toBe('pending');
  });

  it('a phone cannot approve across machines: another machine\'s row is not found here', async () => {
    const ctx = setup();
    const phone = await ownerPhone(ctx);
    const id = '00000000-0000-4000-8000-000000000000';
    const c = await signed(ctx.app, phone.dev, phone.deviceId, 'POST', path_(id, 'challenge'), { action: 'approve' });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('pairing-ended');
  });
});

describe('the code path is intact', () => {
  it('Telegram: typing the code activates as telegram-dm, and leaves Approve with nothing to do', async () => {
    const ctx = setup({ telegramOwner: true });
    const w = await waiting(ctx);
    const code = /is (\d{3}) (\d{3})\./.exec(ctx.dms[0]!.text)!.slice(1).join('');
    expect((await signed(ctx.app, w.dev, w.deviceId, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    expect(ctx.svc.approveByNonce(ctx.dms[0]!.decline.slice(5))).toBe('ended');
  });
  it('a shipped app on its code screen, after Approve: typing the code from the message finishes it', async () => {
    const ctx = setup({ telegramOwner: true });
    const w = await waiting(ctx);
    expect(ctx.svc.approveByNonce(ctx.dms[0]!.decline.slice(5))).toBe('approved');
    const code = /is (\d{3}) (\d{3})\./.exec(ctx.dms[0]!.text)!.slice(1).join('');
    expect((await signed(ctx.app, w.dev, w.deviceId, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  });
  it('a lease move ends a Telegram-path phone: Approve finds nothing, status reads expired', async () => {
    const ctx = setup({ telegramOwner: true });
    const w = await waiting(ctx);
    ctx.lease.held = false;
    ctx.svc.leaseTick();
    expect(ctx.svc.approveByNonce(ctx.dms[0]!.decline.slice(5))).toBe('ended');
    expect((await signed(ctx.app, w.dev, w.deviceId, 'GET', '/mobile/device')).body.status).toBe('expired');
  });
});
