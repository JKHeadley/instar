/**
 * Identity A4, GPT review 3's lifecycle items over the real HTTP pipeline (real TLS listener, a stand-in
 * phone that pins): the home port does not move under a phone that paired while the move waited; a phone
 * still waiting keeps the home address open; a phone that calls itself a computer still counts as the
 * first phone; and a phone let in at the computer is told `canApprove: false` on every answer.
 * docs/specs/identity-security-piece3e-same-network-first-phone.md.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
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
import { pinnedRequest, signedHeaders } from '../helpers/pinnedPhone.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const PIN = '482915';
const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'wlan0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } };
const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/same-network-review-3-lifecycle.test.ts' });
});

function setup(opts: { telegramOwner?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sn-r3-'));
  dirs.push(dir);
  const config = {
    projectName: 'Wintest', projectDir: dir, stateDir: dir, port: 4321, authToken: 'tok-1', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const dms: string[] = [];
  // The network read can be held by the test, to hold an open at its first wait.
  const net0 = { hold: null as null | { reached: () => void; release: Promise<void> } };
  const deps: MobilePairingDeps = {
    config, stateDir: dir, selfMachineId: 'm_self', holdsLease: () => true,
    telegramOwnerPresent: () => opts.telegramOwner === true,
    ownerDM: async (text: string) => { dms.push(text); return 7; },
  };
  const svc = new MobilePairingService(deps);
  const listener: SameNetworkListener = new SameNetworkListener({
    stateDir: dir, agentName: 'Wintest', machineName: 'DESKTOP-1', mainPort: 4321, app, port: 0, bindHost: '127.0.0.1', wsl: false, announce: false,
    observe: async () => { const h = net0.hold; if (h) { net0.hold = null; h.reached(); await h.release; } return HOME; },
    inUse: () => homeAddressInUse(svc),
    gate: sameNetworkGate({ device: (id) => svc.devices.get(id), deviceRoute: (m, p) => DEVICE_ALLOWLIST.some((r) => r.method === m && r.re.test(p)), ownHost: () => (listener.listening() ? listener.host() : null) }),
  });
  svc.sameNetwork = listener;
  cleanups.push(async () => { await listener.stop(); svc.stop(); });
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'Wintest', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps, { config, resolvePeerUrls: () => [] } as unknown as Parameters<typeof createMobilePairingRouter>[2]));
  /** Hold the next network read; resolves `reached` when an open is waiting there. */
  const holdNetwork = () => {
    let release!: () => void; let reached!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    net0.hold = { reached, release: new Promise<void>((r) => { release = r; }) };
    return { reached: reachedP, release: () => release() };
  };
  return { app, svc, listener, dms, holdNetwork };
}

const bearer = (q: request.Test) => q.set('Authorization', 'Bearer tok-1');
const startSetup = (app: express.Express, body: Record<string, unknown> = { pin: PIN }) => bearer(request(app).post('/mobile/phone-setup')).send(body);
function parseV2(link: string) {
  const q = new URLSearchParams(link.split('#')[1]);
  return { host: q.get('h')!, pin: q.get('k')!, code: q.get('c')! };
}
async function phoneRedeem(port: number, scanned: ReturnType<typeof parseV2>, dev: ReturnType<typeof makeDevice>, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ code: scanned.code, deviceName: 'My iPhone', devicePublicKey: dev.publicKey, pinnedKeyHash: scanned.pin, ...extra });
  return pinnedRequest({ port, pin: scanned.pin, method: 'POST', path: '/mobile/pairing-codes/redeem', body });
}
async function phoneSigned(port: number, scanned: ReturnType<typeof parseV2>, dev: ReturnType<typeof makeDevice>, deviceId: string, method: 'GET' | 'POST', p: string, body?: Record<string, unknown>) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return pinnedRequest({ port, pin: scanned.pin, method, path: p, body: raw, headers: signedHeaders(dev, deviceId, scanned.host, method, p, raw) });
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(() => r(undefined)));
  return p;
}
/** Add a phone at the computer, end to end; returns what the later checks need. */
async function addPhone(ctx: ReturnType<typeof setup>, redeemExtra: Record<string, unknown> = {}) {
  const s = await startSetup(ctx.app);
  expect(s.status).toBe(200);
  const scanned = parseV2(s.body.link);
  const port = Number(scanned.host.split(':')[1]);
  const dev = makeDevice();
  const r = await phoneRedeem(port, scanned, dev, redeemExtra);
  expect(r.status).toBe(200);
  const deviceId = String(r.json.deviceId);
  expect((await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: r.json.number })).status).toBe(200);
  const act = await phoneSigned(port, scanned, dev, deviceId, 'POST', '/mobile/device/activate-at-computer', { pinnedKeyHash: scanned.pin });
  expect(act.status).toBe(200);
  return { scanned, port, dev, deviceId };
}

describe('GPT review 3: the home address lifecycle', () => {
  it('item 1: a phone that pairs on the stored port while a port move waits its turn keeps the port (409 port-fixed)', async () => {
    const ctx = setup();
    const a = await startSetup(ctx.app);
    expect(a.status).toBe(200);
    const scanned = parseV2(a.body.link);
    const oldPort = Number(scanned.host.split(':')[1]);
    // A second setup asks for another port; its open waits at the network read (no phone yet).
    const held = ctx.holdNetwork();
    const newPort = await freePort();
    const b = startSetup(ctx.app, { pin: PIN, port: newPort }).then((x) => x);
    await held.reached;
    // Meanwhile the first setup's phone redeems on the stored port.
    const r = await phoneRedeem(oldPort, scanned, makeDevice());
    expect(r.status).toBe(200);
    expect(ctx.svc.devices.get(String(r.json.deviceId))!.status).toBe('pending');
    held.release();
    const moved = await b;
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ error: 'port-fixed', port: oldPort });
    // The waiting phone's address still answers.
    expect(ctx.listener.listening()).toBe(true);
    expect(ctx.listener.host()).toBe(scanned.host);
    expect(ctx.svc.devices.get(String(r.json.deviceId))!.host).toBe(ctx.listener.host());
  });

  it('item 2: cancelling a later setup does not close the home address under a phone still waiting in the Telegram chat', async () => {
    const ctx = setup({ telegramOwner: true });
    const a = await startSetup(ctx.app);
    expect(a.body.approval).toBe('telegram');
    const scanned = parseV2(a.body.link);
    const port = Number(scanned.host.split(':')[1]);
    const r = await phoneRedeem(port, scanned, makeDevice());
    expect(r.status).toBe(200);
    expect(ctx.dms).toHaveLength(1);
    // The first setup is with the chat now; a second setup starts and is cancelled.
    const b = await startSetup(ctx.app);
    expect(b.status).toBe(200);
    const cancelled = await bearer(request(ctx.app).post(`/mobile/phone-setup/${b.body.setupId}/cancel`)).send({});
    expect(cancelled.status).toBe(200);
    expect(ctx.svc.devices.get(String(r.json.deviceId))!.status).toBe('pending');
    expect(ctx.listener.listening()).toBe(true);
    expect(ctx.listener.status().wanted).toBe(true);
  });

  it('item 4: a phone that told the agent it is a computer is still the first phone; a second setup is refused', async () => {
    const ctx = setup();
    const p = await addPhone(ctx, { deviceKind: 'computer' });
    expect(ctx.svc.devices.get(p.deviceId)!.deviceKind).toBe('computer');
    const again = await startSetup(ctx.app);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('phone-already-paired');
  });

  it('review 4, L2: a setup started while a cancel\'s close waited keeps the home address open', async () => {
    const ctx = setup();
    const a = await startSetup(ctx.app);
    expect(a.status).toBe(200);
    // Setup B's open waits at the network read; meanwhile setup A is cancelled (its close queues behind B's open).
    const held = ctx.holdNetwork();
    const b = startSetup(ctx.app).then((x) => x);
    await held.reached;
    const cancel = bearer(request(ctx.app).post(`/mobile/phone-setup/${a.body.setupId}/cancel`)).send({}).then((x) => x);
    // Give the cancel time to reach the listener's queue before B's open finishes.
    await new Promise((r) => setTimeout(r, 100));
    held.release();
    const [rb, rc] = await Promise.all([b, cancel]);
    expect(rb.status).toBe(200);
    expect(rc.status).toBe(200);
    // B's QR is live: its address still answers.
    expect(ctx.listener.listening()).toBe(true);
    expect(ctx.listener.status().wanted).toBe(true);
    const scanned = parseV2(rb.body.link);
    const r = await phoneRedeem(Number(scanned.host.split(':')[1]), scanned, makeDevice());
    expect(r.status).toBe(200);
  });

  it('review 4, L3: a number typed for a phone the registry already expired (a lease move) ends the setup', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const r = await phoneRedeem(Number(scanned.host.split(':')[1]), scanned, makeDevice());
    expect(r.status).toBe(200);
    ctx.svc.devices.expireAllPending();
    const typed = await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: r.json.number });
    expect(typed.status).toBe(409);
    expect(typed.body).toMatchObject({ error: 'setup-ended', reason: 'phone-expired' });
  });

  it('review 5: a setup whose signing window passed unpolled declines its phone, so a retry may move the port', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const oldPort = Number(scanned.host.split(':')[1]);
    const r = await phoneRedeem(oldPort, scanned, makeDevice());
    expect(r.status).toBe(200);
    const deviceId = String(r.json.deviceId);
    expect((await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: r.json.number })).status).toBe(200);
    // The phone lost the Wi-Fi after the number; its signing window passes without it asking again.
    ctx.svc.phoneSetups.get(String(s.body.setupId))!.expiresAt = Date.now() - 1;
    // The owner tries again on another port at once (before any 15-second use check): the lapsed setup's
    // phone is declined first, so it no longer holds the old port.
    const newPort = await freePort();
    const again = await startSetup(ctx.app, { pin: PIN, port: newPort });
    expect(again.status).toBe(200);
    expect(ctx.listener.status().port).toBe(newPort);
    expect(ctx.svc.devices.get(deviceId)!.status).toBe('declined');
  });

  it('review 5: the listener\'s use check notices a lapsed signing window and declines the phone in that step', async () => {
    const ctx = setup();
    const s = await startSetup(ctx.app);
    const scanned = parseV2(s.body.link);
    const r = await phoneRedeem(Number(scanned.host.split(':')[1]), scanned, makeDevice());
    expect(r.status).toBe(200);
    expect((await bearer(request(ctx.app).post(`/mobile/phone-setup/${s.body.setupId}/number`)).send({ number: r.json.number })).status).toBe(200);
    ctx.svc.phoneSetups.get(String(s.body.setupId))!.expiresAt = Date.now() - 1;
    expect(homeAddressInUse(ctx.svc)).toBe(false);
    expect(ctx.svc.devices.get(String(r.json.deviceId))!.status).toBe('declined');
  });

  it('a phone let in at the computer is told canApprove: false on an activation retry and on its status', async () => {
    const ctx = setup();
    const p = await addPhone(ctx);
    const retry = await phoneSigned(p.port, p.scanned, p.dev, p.deviceId, 'POST', '/mobile/device/activate-at-computer', { pinnedKeyHash: p.scanned.pin });
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual({ status: 'active', approvedVia: 'at-computer', canApprove: false });
    const status = await phoneSigned(p.port, p.scanned, p.dev, p.deviceId, 'GET', '/mobile/device');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ status: 'active', approvedVia: 'at-computer', canApprove: false });
  });
});
