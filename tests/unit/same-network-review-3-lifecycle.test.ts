/**
 * Identity A4, GPT review 3's lifecycle items (docs/specs/identity-security-piece3e-same-network-first-phone.md):
 *  1. whether the home port may move is asked inside the listener's serialized open, at the moment it moves;
 *  3. the signing window never outlives the phone's pending expiry;
 *  4. the first-phone count does not read the client-sent `deviceKind`;
 * and the cheap non-blocking items: the periodic reconcile runs in the owner queue, `Expect: 100-continue`
 * is answered only after the gate, and the gate refuses `CDN-Loop` and `True-Client-IP`.
 * Item 2 (a waiting phone keeps the home address open) and the `canApprove` answers run over HTTP in
 * tests/integration/same-network-review-3-lifecycle.test.ts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SameNetworkListener } from '../../src/server/sameNetworkListener.js';
import {
  PhoneSetupStore, PHONE_SETUP_SIGN_WINDOW_MS, PHONE_SETUP_TTL_MS, SAME_NETWORK_REFUSED_PREFIXES, activeOwnerPhones, sameNetworkGate, signDeadline,
} from '../../src/server/phoneSetupRoutes.js';
import { FORWARDING_HEADER_PREFIXES } from '../../src/server/mobileBrowserDevices.js';
import { PENDING_TTL_MS, type DeviceRecord } from '../../src/core/MobileDeviceKeys.js';
import type { NetworkObservation } from '../../src/core/SameNetworkNetwork.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'eth0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } };
const dirs: string[] = [];
const listeners: SameNetworkListener[] = [];
afterAll(async () => {
  for (const l of listeners) await l.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/same-network-review-3-lifecycle.test.ts' });
});

function make(opts: { observe?: () => Promise<NetworkObservation>; gate?: (req: IncomingMessage, res: ServerResponse) => boolean } = {}): SameNetworkListener {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'snr3-'));
  dirs.push(dir);
  const l = new SameNetworkListener({
    stateDir: dir, agentName: 'Porty', machineName: 'box', mainPort: 4040, port: 0,
    app: (_req, res) => { res.end('ok'); }, gate: opts.gate ?? (() => true), bindHost: '127.0.0.1', wsl: false, announce: false, observe: opts.observe ?? (async () => HOME),
  });
  listeners.push(l);
  return l;
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(() => r(undefined)));
  return p;
}
/** A network read the test releases by hand, to hold an open at its first wait. */
function heldObserve() {
  const ctl = { hold: false, release: () => undefined as void, reached: Promise.resolve() as Promise<void>, signal: () => undefined as void };
  const observe = async (): Promise<NetworkObservation> => {
    if (ctl.hold) {
      ctl.signal();
      await new Promise<void>((r) => { ctl.release = () => { ctl.hold = false; r(); }; });
    }
    return HOME;
  };
  const arm = (): void => { ctl.hold = true; ctl.reached = new Promise<void>((r) => { ctl.signal = r; }); };
  return { ctl, observe, arm };
}

describe('item 1: the port moves only if no phone paired while the open waited', () => {
  it('a phone that paired on the stored port during the open is seen at the move: port-fixed, the listener stays', async () => {
    const h = heldObserve();
    const l = make({ observe: h.observe });
    const a = await freePort();
    expect((await l.openForOwner({ port: a })).ok).toBe(true);
    const b = await freePort();
    let phonePaired = false;
    h.arm();
    const moving = l.openForOwner({ port: b, mayMovePort: () => !phonePaired });
    await h.ctl.reached;
    // Asked at the start of the open: no phone yet. A phone redeems on port a while the open waits.
    phonePaired = true;
    h.ctl.release();
    const r = await moving;
    expect(r).toMatchObject({ ok: false, reason: 'port-fixed', port: a });
    expect(l.status().port).toBe(a);
    expect(l.listening()).toBe(true);
    expect(l.host()).toBe(`porty-box.local:${a}`);
  });

  it('with no phone the move goes ahead, and the old port stops taking requests in the same step', async () => {
    const l = make();
    const a = await freePort();
    expect((await l.openForOwner({ port: a })).ok).toBe(true);
    const b = await freePort();
    let askedWhileOldListening: boolean | null = null;
    const r = await l.openForOwner({ port: b, mayMovePort: () => { askedWhileOldListening = l.listening(); return true; } });
    expect(r.ok).toBe(true);
    expect(l.status().port).toBe(b);
    // Asked twice (early and at the move); the last answer was given before the old listener was stopped.
    expect(askedWhileOldListening).toBe(true);
    await expect(new Promise((resolve, reject) => {
      const s = net.connect(a, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve('connected'); });
      s.once('error', reject);
    })).rejects.toThrow();
  });
});

describe('item 3: the signing window never outlives the phone\'s pending expiry', () => {
  function store() {
    const clock = { t: 5_000_000 };
    const s = new PhoneSetupStore(() => clock.t);
    const mk = () => s.create({ code: 'C1', address: 'home', host: 'a-b.local:5000', kind: 'same-network', spkiHash: 'H', approval: 'computer' });
    return { s, clock, mk };
  }

  it('a number typed 20 minutes after the redeem leaves only the 10 minutes the phone still waits', () => {
    const { s, clock, mk } = store();
    const a = mk();
    const n = s.attachPhone(a.id, { id: 'dev-1', deviceName: 'p', fingerprint: 'f', expiresAt: new Date(clock.t + PENDING_TTL_MS).toISOString() }, 'kh')!;
    clock.t += 20 * 60_000;
    expect(s.typeNumber(a.id, n)).toBe('ok');
    const deadline = signDeadline(s.get(a.id)!)!;
    expect(deadline).toBe(5_000_000 + PENDING_TTL_MS - 1);
    expect(deadline).toBeLessThan(clock.t + PHONE_SETUP_SIGN_WINDOW_MS);
    clock.t = deadline;
    expect(s.activation('dev-1').result).toBe('ok');
    // The registry expires the phone at its expiresAt: no signing then.
    clock.t = deadline + 1;
    expect(s.activation('dev-1')).toEqual({ result: 'ended', reason: 'sign-window-passed' });
  });

  it('a number typed early still gets the full 15 minutes (well inside the pending expiry)', () => {
    const { s, clock, mk } = store();
    const a = mk();
    const n = s.attachPhone(a.id, { id: 'dev-1', deviceName: 'p', fingerprint: 'f', expiresAt: new Date(clock.t + PENDING_TTL_MS).toISOString() }, 'kh')!;
    clock.t += 60_000;
    expect(s.typeNumber(a.id, n)).toBe('ok');
    expect(signDeadline(s.get(a.id)!)).toBe(clock.t + PHONE_SETUP_SIGN_WINDOW_MS);
  });

  it('a number typed after the phone\'s pending state lapsed ends the setup', () => {
    const { s, clock, mk } = store();
    const a = mk();
    // A phone whose pending expiry is shorter than the setup's (e.g. a lease move shortened it).
    const n = s.attachPhone(a.id, { id: 'dev-1', deviceName: 'p', fingerprint: 'f', expiresAt: new Date(clock.t + 60_000).toISOString() }, 'kh')!;
    clock.t += 60_000;
    expect(clock.t).toBeLessThan(a.createdAt + PHONE_SETUP_TTL_MS);
    expect(s.typeNumber(a.id, n)).toBe('ended');
    expect(s.get(a.id)?.endedReason).toBe('phone-expired');
  });
});

describe('item 4: the first-phone count does not trust the client-sent deviceKind', () => {
  const row = (over: Partial<DeviceRecord>): DeviceRecord => ({ id: 'x', deviceName: 'p', label: null, pairedAt: '', status: 'active', publicKey: 'k', host: 'h', ...over });
  const svc = (rows: DeviceRecord[]) => ({ devices: { list: () => rows } }) as unknown as Parameters<typeof activeOwnerPhones>[0];

  it('an active owner phone that called itself a computer still counts', () => {
    expect(activeOwnerPhones(svc([row({ deviceKind: 'computer' })]))).toHaveLength(1);
  });
  it('a browser, the app on the agent\'s own computer (server-written fields), a team phone and a waiting phone do not', () => {
    expect(activeOwnerPhones(svc([
      row({ id: 'b', client: 'browser', publicKey: undefined, browserPublicKey: 'bk' }),
      row({ id: 'l', localBinding: { machineId: 'm' }, deviceKind: 'computer', approvedVia: 'local-install' }),
      row({ id: 't', role: 'team' }),
      row({ id: 'w', status: 'pending' }),
    ]))).toHaveLength(0);
  });
});

describe('the periodic reconcile runs in the owner queue', () => {
  it('a tick asked while an open waits runs after it, never in the middle', async () => {
    const h = heldObserve();
    const l = make({ observe: h.observe });
    const order: string[] = [];
    const real = l.reconcile.bind(l);
    (l as unknown as { reconcile: (c?: boolean) => Promise<void> }).reconcile = async (c?: boolean) => { order.push(c ? 'tick' : 'open'); return real(c); };
    h.arm();
    const opening = l.openForOwner();
    await h.ctl.reached;
    (l as unknown as { tick: () => void }).tick();
    (l as unknown as { tick: () => void }).tick(); // at most one waits
    h.ctl.release();
    expect((await opening).ok).toBe(true);
    await l.close();
    expect(order[0]).toBe('open');
    expect(order.filter((x) => x === 'tick')).toHaveLength(1);
  });
});

describe('Expect: 100-continue is answered only after the gate', () => {
  it('a refused request gets its 404 with no interim 100 Continue', async () => {
    const l = make({ gate: (_req, res) => { res.statusCode = 404; res.end('{"error":"not-found"}'); return false; } });
    expect((await l.openForOwner()).ok).toBe(true);
    const port = l.status().port!;
    const got = await new Promise<{ status: number; continued: boolean }>((resolve, reject) => {
      let continued = false;
      const req = https.request({ host: '127.0.0.1', port, method: 'POST', path: '/mobile/pairing-codes/redeem', rejectUnauthorized: false, headers: { Expect: '100-continue', 'Content-Type': 'application/json', 'Content-Length': '2' } });
      req.on('continue', () => { continued = true; req.end('{}'); });
      req.on('response', (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, continued })); });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(got.status).toBe(404);
    expect(got.continued).toBe(false);
  });

  it('a request the gate lets through gets its 100 Continue, then the app answers', async () => {
    const l = make();
    expect((await l.openForOwner()).ok).toBe(true);
    const port = l.status().port!;
    const got = await new Promise<{ status: number; continued: boolean }>((resolve, reject) => {
      let continued = false;
      const req = https.request({ host: '127.0.0.1', port, method: 'POST', path: '/x', rejectUnauthorized: false, headers: { Expect: '100-continue', 'Content-Length': '2' } });
      req.on('continue', () => { continued = true; req.end('{}'); });
      req.on('response', (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, continued })); });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(got).toEqual({ status: 200, continued: true });
  });
});

describe('the gate refuses every forwarding header the browser-device check knows', () => {
  const gate = sameNetworkGate({ device: () => null, deviceRoute: () => true, ownHost: () => 'a.local:1' });
  const run = (headers: Record<string, string>) => {
    const req = { method: 'POST', url: '/mobile/pairing-codes/redeem', headers } as unknown as IncomingMessage;
    const res = { statusCode: 0, setHeader: () => undefined, end: () => undefined } as unknown as ServerResponse;
    return { passed: gate(req, res), status: (res as { statusCode: number }).statusCode };
  };
  it('covers every prefix of the browser-device forwarding list', () => {
    for (const p of FORWARDING_HEADER_PREFIXES) expect(SAME_NETWORK_REFUSED_PREFIXES.some((q) => p.startsWith(q)), p).toBe(true);
    for (const p of FORWARDING_HEADER_PREFIXES) expect(run({ [p.endsWith('-') ? `${p}x` : p]: '1' }).status, p).toBe(404);
  });
  it('CDN-Loop and True-Client-IP are refused; a plain redeem passes', () => {
    expect(run({}).passed).toBe(true);
    expect(run({ 'cdn-loop': 'cloudflare' })).toEqual({ passed: false, status: 404 });
    expect(run({ 'true-client-ip': '1.2.3.4' })).toEqual({ passed: false, status: 404 });
  });
});
