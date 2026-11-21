/**
 * Identity A4 over the real HTTP pipeline: "Add your phone" at the computer, the same-network
 * listener (real TLS 1.3 on the agent's own certificate), a stand-in phone that pins the hash it
 * scanned, the number typed at the computer, and the phone's signed activation.
 * docs/specs/identity-security-piece3e-same-network-first-phone.md §6.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, DEVICE_ALLOWLIST, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { SameNetworkListener } from '../../src/server/sameNetworkListener.js';
import { sameNetworkGate, homeAddressInUse } from '../../src/server/phoneSetupRoutes.js';
import type { NetworkObservation } from '../../src/core/SameNetworkNetwork.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { pinnedRequest, signedHeaders, PinMismatchError } from '../helpers/pinnedPhone.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const PIN = '482915';
const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'wlan0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } };
const CAFE: NetworkObservation = { kind: 'observed', network: { iface: 'wlan0', router: '10.0.0.1', address: '10.0.0.7', range: '10.0.0.0/24' } };
const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/same-network-first-phone.test.ts' });
});

function setup(opts: { telegramOwner?: boolean; dir?: string; noPin?: boolean } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sn-int-'));
  if (!opts.dir) dirs.push(dir);
  const config = {
    projectName: 'Wintest', projectDir: dir, stateDir: dir, port: 4321, authToken: 'tok-1', developmentAgent: true,
    ...(opts.noPin ? {} : { dashboardPin: PIN }),
    mobilePairing: { multiRoute: { enabled: false } },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const dms: string[] = [];
  const network = { now: HOME as NetworkObservation };
  const telegram = { owner: opts.telegramOwner === true };
  const deps: MobilePairingDeps = {
    config, stateDir: dir, selfMachineId: 'm_self', holdsLease: () => true,
    telegramOwnerPresent: () => telegram.owner,
    ownerDM: async (text: string) => { dms.push(text); return 7; },
  };
  const svc = new MobilePairingService(deps);
  const listener: SameNetworkListener = new SameNetworkListener({
    stateDir: dir, agentName: 'Wintest', machineName: 'DESKTOP-1', mainPort: 4321, app, port: 0, bindHost: '127.0.0.1', wsl: false, announce: false,
    observe: async () => network.now,
    inUse: () => homeAddressInUse(svc),
    gate: sameNetworkGate({ device: (id) => svc.devices.get(id), deviceRoute: (m, p) => DEVICE_ALLOWLIST.some((r) => r.method === m && r.re.test(p)), ownHost: () => (listener.listening() ? listener.host() : null) }),
  });
  svc.sameNetwork = listener;
  cleanups.push(async () => { await listener.stop(); svc.stop(); });
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'Wintest', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps, { config, resolvePeerUrls: () => [] } as unknown as Parameters<typeof createMobilePairingRouter>[2]));
  app.get('/mobile/conversations', (_req, res) => { res.json({ conversations: [] }); });
  app.get('/sessions', (_req, res) => { res.json([]); });
  return { app, svc, listener, network, telegram, dms, dir, config };
}

const bearer = (q: request.Test) => q.set('Authorization', 'Bearer tok-1');
const startSetup = (app: express.Express, body: Record<string, unknown> = { pin: PIN }) => bearer(request(app).post('/mobile/phone-setup')).send(body);

function parseV2(link: string) {
  const q = new URLSearchParams(link.split('#')[1]);
  return { v: q.get('v'), host: q.get('h')!, pin: q.get('k')!, code: q.get('c')!, hints: (q.get('a') ?? '').split(',').filter(Boolean) };
}

async function phoneRedeem(port: number, scanned: ReturnType<typeof parseV2>, dev: ReturnType<typeof makeDevice>, pinOverride?: string) {
  const body = JSON.stringify({ code: scanned.code, deviceName: 'My iPhone', devicePublicKey: dev.publicKey, pinnedKeyHash: pinOverride ?? scanned.pin });
  return pinnedRequest({ port, pin: scanned.pin, method: 'POST', path: '/mobile/pairing-codes/redeem', body });
}
async function phoneSigned(port: number, scanned: ReturnType<typeof parseV2>, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: Record<string, unknown>) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return pinnedRequest({ port, pin: scanned.pin, method, path: p, body: raw, headers: signedHeaders(dev, deviceId, scanned.host, method, p, raw) });
}

describe('identity A4: the first phone over the same network', () => {
  it('end to end: PIN, QR v2, pinned redeem waits, number at the computer, signed activation lets it in', async () => {
    const ctx = setup();
    // The listener is absent before "Add your phone".
    expect(ctx.listener.listening()).toBe(false);
    const s = await startSetup(ctx.app);
    expect(s.status).toBe(200);
    expect(s.body.linkVersion).toBe(2);
    expect(s.body.approval).toBe('computer');
    const scanned = parseV2(s.body.link);
    expect(scanned.v).toBe('2');
    expect(scanned.host).toMatch(/^wintest-desktop-1\.local:\d+$/);
    expect(scanned.pin).toBe(ctx.listener.spkiHash());
    const port = Number(scanned.host.split(':')[1]);
    expect(ctx.listener.listening()).toBe(true);

    const dev = makeDevice();
    const r = await phoneRedeem(port, scanned, dev);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('pending');
    expect(r.json.approval).toBe('computer');
    expect(String(r.json.number)).toMatch(/^\d{6}$/);
    const deviceId = String(r.json.deviceId);
    const rec = ctx.svc.devices.get(deviceId)!;
    expect(rec.host).toBe(scanned.host);
    expect(rec.addressKind).toBe('same-network');
    expect(ctx.dms).toHaveLength(0); // no Telegram owner: nothing goes to a chat

    // A waiting phone reaches only its setup routes.
    const conv = await phoneSigned(port, scanned, dev, deviceId, 'GET', '/mobile/conversations');
    expect([401, 403, 404]).toContain(conv.status);
    // Before the number: still waiting, and the phone is told its number again.
    const early = await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/device/activate-at-computer', { pinnedKeyHash: scanned.pin });
    expect(early.status).toBe(409);
    expect(early.json.error).toBe('waiting-for-number');
    expect(early.json.number).toBe(r.json.number);
    // The code path is closed for this phone.
    const viaCode = await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/device/confirm', { code: '000000' });
    expect(viaCode.status).toBe(409);
    expect(viaCode.json.error).toBe('confirm-at-computer');

    // The computer names the phone and shows its key.
    const view = await bearer(request(ctx.app).get(`/mobile/phone-setup/${s.body.setupId}`));
    expect(view.body.state).toBe('waiting-number');
    expect(view.body.phone.name).toBe('My iPhone');
    expect(view.body.phone.key).toBe(rec.fingerprint);

    // A wrong number lets nothing in.
    const wrongNumber = String((Number(r.json.number) + 1) % 1_000_000).padStart(6, '0');
    const wrong = await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: wrongNumber });
    expect(wrong.status).toBe(403);
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('pending');

    const right = await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: r.json.number });
    expect(right.status).toBe(200);
    expect(right.body.state).toBe('number-accepted');
    // After the right number the phone is still waiting until it has signed.
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('pending');

    const act = await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/device/activate-at-computer', { pinnedKeyHash: scanned.pin });
    expect(act.status).toBe(200);
    expect(act.json).toEqual({ status: 'active', approvedVia: 'at-computer', canApprove: false });
    const after = ctx.svc.devices.get(deviceId)!;
    expect(after.status).toBe('active');
    expect(after.approvedVia).toBe('at-computer');
    // Now the phone works on its home address.
    const conv2 = await phoneSigned(port, scanned, dev, deviceId, 'GET', '/mobile/conversations');
    expect(conv2.status).toBe(200);
    // The same phone's signature is refused on the main listener.
    const raw = await request(ctx.app).get('/mobile/conversations').set(signedHeaders(dev, deviceId, scanned.host, 'GET', '/mobile/conversations'));
    expect(raw.status).toBe(401);
    // The setup reads done; a second setup is refused: this agent already has a phone.
    expect((await bearer(request(ctx.app).get(`/mobile/phone-setup/${s.body.setupId}`))).body.state).toBe('done');
    const again = await startSetup(ctx.app);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('phone-already-paired');
  });

  it('a phone that pinned another certificate stops before anything is sent; a wrong pinned hash is refused by the agent', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const dev = makeDevice();
    // The phone scanned a different hash (someone else's screen): it refuses to speak.
    await expect(pinnedRequest({ port, pin: 'x'.repeat(43), method: 'POST', path: '/mobile/pairing-codes/redeem', body: '{}' })).rejects.toBeInstanceOf(PinMismatchError);
    // A relay that presents its own certificate makes the phone sign another hash: the agent refuses it, and the code survives.
    const bad = await phoneRedeem(port, scanned, dev, 'y'.repeat(43));
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('not-this-computer');
    const good = await phoneRedeem(port, scanned, dev);
    expect(good.status).toBe(200);
    // A second redeem of one link is refused.
    const second = await phoneRedeem(port, scanned, makeDevice());
    expect(second.status).toBe(403);
  });

  it('the fresh check comes before any code: no PIN, a wrong PIN, no PIN set, or a forwarded request shows nothing', async () => {
    const ctx = setup();
    expect((await startSetup(ctx.app, {})).status).toBe(403);
    expect((await startSetup(ctx.app, { pin: '000000' })).status).toBe(403);
    expect((await bearer(request(ctx.app).post('/mobile/phone-setup')).set('X-Forwarded-For', '203.0.113.9').send({ pin: PIN })).status).toBe(403);
    expect(ctx.listener.listening()).toBe(false);
    const noPin = setup({ noPin: true });
    const r = await startSetup(noPin.app, { pin: PIN });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('pin-required');
    expect(noPin.listener.listening()).toBe(false);
  });

  it('three wrong numbers end the setup and decline the phone; an ended setup lets nothing in', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const dev = makeDevice();
    const r = await phoneRedeem(port, scanned, dev);
    const n = Number(r.json.number);
    for (let i = 1; i <= 3; i++) {
      await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: String((n + i) % 1_000_000).padStart(6, '0') });
    }
    expect(ctx.svc.devices.get(String(r.json.deviceId))!.status).toBe('declined');
    // The setup ended with no phone let in, so the home address closed: nothing is reachable.
    expect(ctx.listener.listening()).toBe(false);
    await expect(phoneSigned(port, scanned, dev, String(r.json.deviceId), 'POST', '/mobile/device/activate-at-computer', { pinnedKeyHash: scanned.pin })).rejects.toThrow();
    expect(ctx.svc.devices.get(String(r.json.deviceId))!.status).not.toBe('active');
  });

  it('a Telegram owner that appears during the setup ends it before the phone is let in', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const dev = makeDevice();
    const r = await phoneRedeem(port, scanned, dev);
    await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: r.json.number });
    ctx.telegram.owner = true;
    const act = await phoneSigned(port, scanned, dev, String(r.json.deviceId), 'POST', '/mobile/device/activate-at-computer', { pinnedKeyHash: scanned.pin });
    expect(act.status).toBe(409);
    expect(act.json.error).toBe('telegram-owner-appeared');
    expect(ctx.svc.devices.get(String(r.json.deviceId))!.status).not.toBe('active');
  });

  it('with a Telegram owner the code still comes from the computer, and the phone confirms through the private chat', async () => {
    const ctx = setup({ telegramOwner: true });
    const s = await startSetup(ctx.app);
    expect(s.status).toBe(200);
    expect(s.body.approval).toBe('telegram');
    const scanned = parseV2(s.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const r = await phoneRedeem(port, scanned, makeDevice());
    expect(r.status).toBe(200);
    expect(r.json.approval).toBe('telegram');
    expect(r.json.number).toBeUndefined();
    expect(ctx.dms).toHaveLength(1);
    // No number is typed at the computer on this path.
    const n = await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: '123456' });
    expect(n.status).toBe(409);
    expect(n.body.error).toBe('confirm-in-telegram');
  });

  it('the listener serves no dashboard, PIN, token or computer-bound route; a same-network code is not redeemable on the main listener', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const ask = (method: 'GET' | 'POST', p: string, headers?: Record<string, string>, body?: string) => pinnedRequest({ port, pin: scanned.pin, method, path: p, headers, body });
    expect((await ask('GET', '/dashboard')).status).toBe(404);
    expect((await ask('POST', '/dashboard/unlock', undefined, JSON.stringify({ pin: PIN }))).status).toBe(404);
    expect((await ask('GET', '/sessions', { Authorization: 'Bearer tok-1' })).status).toBe(404);
    expect((await ask('POST', '/mobile/phone-setup', { Authorization: 'Bearer tok-1' }, JSON.stringify({ pin: PIN }))).status).toBe(404);
    expect((await ask('POST', '/mobile/local-owner-device', undefined, '{}')).status).toBe(404);
    const health = await ask('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ status: 'ok' });
    // On the main listener, the same-network code is the wrong kind of address: refused, and spent.
    const dev = makeDevice();
    const main = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', '127.0.0.1:4321').send({ code: scanned.code, devicePublicKey: dev.publicKey });
    expect(main.status).toBe(403);
  });

  it('review fix: a waiting phone cannot be let in by any approval path but the number (tap, introduction, dashboard, code)', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const dev = makeDevice();
    const r = await phoneRedeem(port, scanned, dev);
    const deviceId = String(r.json.deviceId);
    // The phone is told the only way in.
    expect(r.json.confirmWith).toEqual(['computer']);
    const rec = ctx.svc.devices.get(deviceId)!;
    expect(rec.admission).toBe('at-computer');
    expect(ctx.svc.approvable(rec)).toBe(false);
    // The one approval funnel (owner-phone tap, introducer, dashboard approve) refuses it.
    for (const via of ['owner-phone', 'owner-agent', 'dashboard-pin'] as const) expect(ctx.svc.approvePending(deviceId, via)).toBe('code-only');
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('pending');
    // Even after the setup ends, the record keeps the code path closed.
    await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/cancel`)).send({});
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('declined');
  });

  it('review fix: a phone let in at the computer cannot approve, and knows only its home address', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const dev = makeDevice();
    const r = await phoneRedeem(port, scanned, dev);
    const deviceId = String(r.json.deviceId);
    await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: r.json.number });
    expect((await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/device/activate-at-computer', { pinnedKeyHash: scanned.pin })).status).toBe(200);
    // No presence key, so no Face ID approvals, console tickets or trust acts.
    const pk = await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/device/presence-key', { publicKey: makeDevice().publicKey, proof: 'x' });
    expect(pk.status).toBe(403);
    expect(pk.json.error).toBe('cannot-approve-yet');
    // Owner routes that act as approvals or admin are refused; conversations still work.
    const grant = await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/people/u1/grants', { grant: 'x' });
    expect(grant.status).toBe(403);
    expect(grant.json.error).toBe('cannot-approve-yet');
    const org = await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/org/allow-once', {});
    expect(org.status).toBe(403);
    const removeOther = await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/devices/someone-else/revoke', {});
    expect(removeOther.status).toBe(403);
    expect((await phoneSigned(port, scanned, dev, deviceId, 'GET', '/mobile/conversations')).status).toBe(200);
    const routes = await phoneSigned(port, scanned, dev, deviceId, 'GET', '/mobile/routes');
    expect(routes.status).toBe(200);
    expect(routes.json.routes).toEqual([expect.objectContaining({ kind: 'same-network', origin: `https://${scanned.host}`, pinnedKeyHash: scanned.pin })]);
    // Its notification token (if it had one) is not accepted on the main listener.
    const nt = await request(ctx.app).get('/mobile/attention/x').set('X-Instar-Device', deviceId).set('X-Instar-Notify-Token', 'tok');
    expect(nt.status).toBe(403);
  });

  it('review fix: the redeem on the listener ignores a hostile Host header; cancelling closes an unused home address', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const dev = makeDevice();
    const body = JSON.stringify({ code: scanned.code, deviceName: 'p', devicePublicKey: dev.publicKey, pinnedKeyHash: scanned.pin });
    const r = await pinnedRequest({ port, pin: scanned.pin, method: 'POST', path: '/mobile/pairing-codes/redeem', body, hostHeader: 'pc.tail1234.ts.net' });
    expect(r.status).toBe(200);
    expect(ctx.svc.devices.get(String(r.json.deviceId))!.host).toBe(scanned.host);
    expect(ctx.listener.listening()).toBe(true);
    await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/cancel`)).send({});
    expect(ctx.listener.listening()).toBe(false);
    expect(ctx.listener.status().wanted).toBe(false);
  });

  it('closed on a second network until the owner allows it at the computer; reopens by itself only on an allowed network; survives a restart', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    expect(s.status).toBe(200);
    expect(ctx.listener.listening()).toBe(true);
    ctx.network.now = CAFE;
    await ctx.listener.reconcile();
    expect(ctx.listener.listening()).toBe(false);
    expect(ctx.listener.status().held).toBe('network-not-allowed');
    ctx.network.now = HOME;
    await ctx.listener.reconcile();
    expect(ctx.listener.listening()).toBe(true);
    // Unknown network: closed.
    ctx.network.now = { kind: 'unknown', reason: 'no default route' };
    await ctx.listener.reconcile();
    expect(ctx.listener.listening()).toBe(false);
    // The owner allows the cafe at the computer (PIN), and it opens there.
    ctx.network.now = CAFE;
    const allow = await bearer(request(ctx.app).post('/mobile/same-network/allow-network')).send({ pin: PIN });
    expect(allow.status).toBe(200);
    expect(ctx.listener.listening()).toBe(true);
    const port = ctx.listener.status().port;
    const pin = ctx.listener.spkiHash();
    // A phone pairs and is let in, so the home address is in use.
    const scanned = parseV2((await startSetup(ctx.app)).body.link);
    const dev = makeDevice();
    const r = await phoneRedeem(port!, scanned, dev);
    const setupId = (await bearer(request(ctx.app).get(`/mobile/same-network`))).body;
    expect(setupId.listening).toBe(true);
    const sid = ctx.svc.phoneSetups.byDevice(String(r.json.deviceId))!.id;
    await bearer(request(ctx.app).post(`/mobile/phone-setup/${sid}/number`)).send({ number: r.json.number });
    expect((await phoneSigned(port!, scanned, dev, String(r.json.deviceId), 'POST', '/mobile/device/activate-at-computer', { pinnedKeyHash: scanned.pin })).status).toBe(200);
    await ctx.listener.stop();
    // A restart: a new process reads the state file and its device registry, and reopens on an
    // allowed network with the same port and key, because a phone uses it.
    const again = setup({ dir: ctx.dir });
    await again.listener.start();
    expect(again.listener.listening()).toBe(true);
    expect(again.listener.status().port).toBe(port);
    expect(again.listener.spkiHash()).toBe(pin);
    // Closing removes the address.
    const close = await bearer(request(again.app).post('/mobile/same-network/close')).send({});
    expect(close.status).toBe(200);
    expect(again.listener.listening()).toBe(false);
  });

  it('review fix: after a restart with no setup open and no phone paired on it, the home address closes by itself', async () => {
    const ctx = setup();
    expect((await startSetup(ctx.app)).status).toBe(200);
    expect(ctx.listener.listening()).toBe(true);
    await ctx.listener.stop();
    const again = setup({ dir: ctx.dir });
    await again.listener.start();
    expect(again.listener.listening()).toBe(false);
    expect(again.listener.status().wanted).toBe(false);
  });
});
