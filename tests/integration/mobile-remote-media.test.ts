/**
 * The owner's phone opens a Slack file held by another machine (docs/specs/mobile-remote-media.md),
 * over two REAL servers on real sockets, with real device signatures, registries, blobs and the
 * production stream. Fake holders appear only where a real server cannot misbehave on demand.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware, bearerMatches } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileMediaRouter } from '../../src/server/mobileMediaRoutes.js';
import { HOLDER_MEDIA_HEADER, buildMediaHolderStream } from '../../src/server/mobileMediaHolderProxy.js';
import { mobileOwnerDeviceAdmission } from '../../src/server/mobileOwnerDeviceAdmission.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { recordPlatformMedia, slackConversationHeldLocally } from '../../src/core/appPlatformMedia.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(async () => {
  ProcessIntegrity.reset();
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-remote-media.test.ts:cleanup' });
});

type Peer = { machineId: string; url: string; kind: string };
const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function machine(id: string, peers: () => Peer[], over: { maxBytes?: number; firstByteMs?: number; idleMs?: number; drainMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mremotemedia-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: id });
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'ann', name: 'Ann Client', channels: [], permissions: ['user'], telegramUserId: 7 }]));
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, slackOwnerUserId: 'U0OWNER1' },
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => id, isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => id, registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger, dispatch: () => null,
  });
  cleanups.push(() => svc.stop());
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.get('/health', (_q, r) => { r.json({ ok: true }); });
  const hops: string[] = [];
  app.use((req, _r, next) => { if (req.path.startsWith('/mobile/media') && req.headers.authorization) hops.push(`${req.method} ${req.url}`); next(); });
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createMobileMediaRouter({
    pairing, service: svc, mediaEnabled: true, machineId: () => id,
    slackHeld: (key) => slackConversationHeldLocally(registry, key),
    ownerAdmission: (req) => mobileOwnerDeviceAdmission(pairing, req),
    bearerOk: (req) => bearerMatches(req, 'tok-1'),
    holderMedia: buildMediaHolderStream({ peers, token: () => 'tok-1', selfMachineId: () => id, firstByteMs: over.firstByteMs ?? 1_500, idleMs: over.idleMs ?? 1_500, drainMs: over.drainMs, maxBytes: over.maxBytes, recheckMs: 0 }),
  }));
  app.use(createMobilePairingRouter(pairing, deps, { config } as never));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  /** A real Slack conversation with a real file in this machine's blob store. */
  const held = async (channel: string, bytes: Buffer, filename = 'photo.jpg') => {
    const key = (registry.resolve(registry.mintForInbound(channel).id!) as unknown as { key: string }).key;
    const file = path.join(dir, `in-${n++}.jpg`);
    fs.writeFileSync(file, bytes);
    const done = await recordPlatformMedia(svc, { conversationKey: key, platformMessageId: `179361530${n}.000000`, filePath: file, declaredKind: 'photo', filename, declaredType: 'image/jpeg', at: new Date().toISOString() });
    if (!done.recorded) throw new Error(`file not recorded: ${JSON.stringify(done)}`);
    return key;
  };
  return { id, app, url, pairing, config, dir, svc, hops, held, registry };
}
type Machine = Awaited<ReturnType<typeof machine>>;

async function fakeHolder(handle: http.RequestListener) {
  let calls = 0;
  const server = http.createServer((q, r) => { calls++; handle(q, r); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));
  return { machineId: 'm_b', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, kind: 'lan', calls: () => calls };
}

async function phone(m: Machine, person?: { userId: string; role: 'msp' | 'owner' }) {
  const dev = makeDevice();
  const c = m.pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) } as never);
  if (!c.ok) throw new Error('setup');
  m.pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { dev, deviceId: c.device.id };
}
type Phone = Awaited<ReturnType<typeof phone>>;
let tick = 0;
const signedHeaders = (p: Phone, route: string) => {
  const time = String(Date.now() + (tick++ % 1000));
  return { Host: HOST, 'X-Instar-Device': p.deviceId, 'X-Instar-Device-Time': time, 'X-Instar-Device-Sig': p.dev.sign(canonicalString(p.deviceId, HOST, 'GET', route, time)) };
};
/** The phone's real request over a real socket: status, headers, bytes, and whether the body completed. */
function phoneGet(m: Machine, p: Phone, route: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; complete: boolean; json: Record<string, unknown> }>((resolve, reject) => {
    const u = new URL(m.url);
    const q = http.request({ host: u.hostname, port: u.port, path: route, method: 'GET', headers: { ...signedHeaders(p, route), ...extra } }, (r) => {
      const chunks: Buffer[] = [];
      let complete = false;
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => { complete = r.complete; });
      r.on('close', () => {
        const body = Buffer.concat(chunks);
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(body.toString('utf8')); } catch { json = {}; }
        resolve({ status: r.statusCode ?? 0, headers: r.headers, body, complete: complete && r.complete, json });
      });
      r.on('error', () => undefined);
    });
    q.on('error', reject);
    q.end();
  });
}

async function pair(over: Parameters<typeof machine>[2] = {}) {
  let list: Peer[] = [];
  const a = await machine('m_a', () => list, over);
  const b = await machine('m_b', () => [], over);
  list = [{ machineId: 'm_b', url: b.url, kind: 'lan' }];
  return { a, b, set: (p: Peer[]) => { list = p; } };
}
const route = (hash: string, ref: string, m: string) => `/mobile/media/${hash}?ref=${encodeURIComponent(ref)}&machine=${m}`;
const REF = 'slack:_:C0REMOTE1';
const HASH = 'a'.repeat(64);

describe('the owner phone opens a Slack file held by another machine', () => {
  it('streams the exact bytes from the holder, with sanitized headers and no Range', async () => {
    const { a, b } = await pair();
    const bytes = jpeg(3 * 1024 * 1024);
    const key = await b.held('C0BBBBBBB', bytes);
    const p = await phone(a);
    const r = await phoneGet(a, p, route(sha(bytes), key, 'm_b'));
    expect(r.status).toBe(200);
    expect(r.complete).toBe(true);
    expect(sha(r.body)).toBe(sha(bytes));
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['accept-ranges']).toBe('none');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers[HOLDER_MEDIA_HEADER]).toBeUndefined();
    expect(b.hops).toHaveLength(1);
    expect(b.hops[0]).toContain('holderHop=1');
    expect(b.hops[0]).toContain(`ref=${encodeURIComponent(key)}`);
  });

  it('a phone that leaves during the file open gets no read stream, and the file is closed', async () => {
    const { a } = await pair();
    const bytes = jpeg(5_000);
    const key = await a.held('C0GONE111', bytes);
    const p = await phone(a);
    const r = route(sha(bytes), key, 'm_a');
    const u = new URL(a.url);
    const open = fs.promises.open.bind(fs.promises);
    let client: http.ClientRequest | undefined;
    let close: ReturnType<typeof vi.fn> | undefined;
    let read: ReturnType<typeof vi.fn> | undefined;
    const seen = new Promise<void>((done) => {
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof open>) => {
        spy.mockRestore();
        const h = await open(...args);
        const realClose = h.close.bind(h);
        close = vi.fn(async () => { await realClose(); done(); });
        read = vi.fn(h.createReadStream.bind(h));
        Object.assign(h, { close, createReadStream: read });
        client?.destroy();
        await new Promise((go) => setTimeout(go, 100));
        return h;
      }) as never);
    });
    client = http.request({ host: u.hostname, port: u.port, path: r, method: 'GET', headers: signedHeaders(p, r) });
    client.on('error', () => undefined);
    client.end();
    await seen;
    expect(close).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('file requests have their own bucket: they cannot use up the phone\'s chat reads', async () => {
    const { a } = await pair();
    const p = await phone(a);
    const r = route(HASH, 'slack:_:C0NEVERSEEN', 'm_a');
    let limited = 0;
    for (let i = 0; i < 125; i++) if ((await phoneGet(a, p, r)).status === 429) limited++;
    expect(limited).toBe(5);
    expect((await phoneGet(a, p, '/mobile/people')).status).not.toBe(429);
  });

  it('a phone reading slowly on a real socket finishes the file, past the drain limit', async () => {
    const { a, b } = await pair({ drainMs: 100 });
    const bytes = jpeg(6 * 1024 * 1024);
    const key = await b.held('C0SLOW111', bytes);
    const p = await phone(a);
    const r = route(sha(bytes), key, 'm_b');
    const u = new URL(a.url);
    const got = await new Promise<{ status: number; body: Buffer; complete: boolean; ms: number }>((resolve, reject) => {
      const t0 = Date.now();
      http.get({ host: u.hostname, port: u.port, path: r, headers: signedHeaders(p, r) }, (m) => {
        const parts: Buffer[] = [];
        m.pause();
        const pump = setInterval(() => { for (let i = 0; i < 2; i++) { const c = m.read(32 * 1024) ?? m.read(); if (c) parts.push(c as Buffer); } }, 25);
        m.on('readable', () => undefined);
        m.on('close', () => { clearInterval(pump); const c = m.read(); if (c) parts.push(c as Buffer); resolve({ status: m.statusCode ?? 0, body: Buffer.concat(parts), complete: m.complete, ms: Date.now() - t0 }); });
      }).on('error', reject);
    });
    expect(got.status).toBe(200);
    expect(got.complete).toBe(true);
    expect(sha(got.body)).toBe(sha(bytes));
    expect(got.ms).toBeGreaterThan(300); // slower than the limit, or this proved nothing
  }, 30_000);

  it('a phone that stops reading on a real socket gives its slot back while staying connected', async () => {
    const { a, b } = await pair({ drainMs: 100 });
    const bytes = jpeg(24 * 1024 * 1024);
    const key = await b.held('C0STALL11', bytes);
    const small = jpeg(3_000);
    const smallKey = await b.held('C0STALL22', small);
    const p = await phone(a);
    const r = route(sha(bytes), key, 'm_b');
    const u = new URL(a.url);
    const open = () => new Promise<http.ClientRequest>((resolve, reject) => {
      const q = http.get({ host: u.hostname, port: u.port, path: r, headers: signedHeaders(p, r) }, (m) => { m.pause(); resolve(q); });
      q.on('error', () => undefined);
      setTimeout(() => reject(new Error('no answer')), 5_000).unref();
    });
    const stalled = [await open(), await open()];
    await new Promise((go) => setTimeout(go, 600));
    const next = await phoneGet(a, p, route(sha(small), smallKey, 'm_b'));
    expect(next.status).toBe(200);
    expect(sha(next.body)).toBe(sha(small));
    for (const q of stalled) q.destroy();
  }, 30_000);

  it('naming this machine serves locally with Range still honored and no dial', async () => {
    const { a, b } = await pair();
    const bytes = jpeg(5_000);
    const key = await a.held('C0AAAAAAA', bytes);
    const p = await phone(a);
    const whole = await phoneGet(a, p, route(sha(bytes), key, 'm_a'));
    expect(sha(whole.body)).toBe(sha(bytes));
    const part = await phoneGet(a, p, route(sha(bytes), key, 'm_a'), { Range: 'bytes=0-99' });
    expect(part.status).toBe(206);
    expect(part.body).toHaveLength(100);
    const unnamed = await phoneGet(a, p, `/mobile/media/${sha(bytes)}?ref=${encodeURIComponent(key)}`);
    expect(sha(unnamed.body)).toBe(sha(bytes));
    expect(b.hops).toHaveLength(0);
  });

  it('the same hash under another ref or machine opens nothing: the holder checks the exact ref', async () => {
    const { a, b } = await pair();
    const bytes = jpeg(4_000);
    const held = await b.held('C0BBBBBBB', bytes);
    const other = await b.held('C0OTHER11', jpeg(4_000));
    const localOnly = await a.held('C0AAAAAAA', bytes);
    const p = await phone(a);
    expect((await phoneGet(a, p, route(sha(bytes), other, 'm_b'))).status).toBe(404);
    expect((await phoneGet(a, p, route(sha(bytes), 'slack:_:C0NEVERSEEN', 'm_b'))).status).toBe(404);
    // A's own ref for the same bytes is not a ref B holds.
    expect((await phoneGet(a, p, route(sha(bytes), localOnly, 'm_b'))).status).toBe(404);
    expect((await phoneGet(a, p, route(sha(bytes), held, 'm_b'))).status).toBe(200);
    // And a ref of B's is not honored here without the hop.
    expect((await phoneGet(a, p, route(sha(bytes), held, 'm_a'))).status).toBe(404);
  });

  it('an MSP phone, a bearer token and a forged request never dial', async () => {
    const { a, b } = await pair();
    const bytes = jpeg(2_000);
    const key = await b.held('C0BBBBBBB', bytes);
    const owner = await phone(a);
    const r = route(sha(bytes), key, 'm_b');
    const msp = await phone(a, { userId: 'ann', role: 'msp' });
    const refused = await phoneGet(a, msp, r);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('owner-only');
    a.pairing.grants.set('ann', { slack: true }, owner.deviceId);
    expect((await phoneGet(a, msp, r)).status).toBe(403);
    const token = await request(a.app).get(r).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
    expect(token.status).toBe(403);
    const time = String(Date.now());
    const sig = owner.dev.sign(canonicalString(owner.deviceId, HOST, 'GET', route(sha(bytes), key, 'm_a'), time));
    const forged = await request(a.app).get(r).set('Host', HOST).set('X-Instar-Device', owner.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(forged.status).toBe(401);
    expect(b.hops).toHaveLength(0);
  });

  it('a hop cannot go on to a third machine, name another machine, or use a bad bearer', async () => {
    const { a, b } = await pair();
    const bytes = jpeg(2_000);
    const key = await b.held('C0BBBBBBB', bytes);
    const hop = (m: string, bearer = 'tok-1') => request(b.app).get(`${route(sha(bytes), key, m)}&holderHop=1`).set('Authorization', `Bearer ${bearer}`).set('X-Instar-AgentId', 'echo');
    expect((await hop('m_a')).status).toBe(403);
    expect((await hop('m_b', 'wrong')).status).toBe(403);
    expect((await hop('m_b')).status).toBe(200);
    expect((await request(b.app).get(`${route(sha(bytes), 'telegram:12', 'm_b')}&holderHop=1`).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo')).status).toBe(403);
    expect((await hop('m_b').set('Range', 'bytes=0-9')).status).toBe(416);
    expect(a.hops).toHaveLength(0);
  });

  it('a missing or untrusted holder is refused with no request made', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    const fake = await fakeHolder((_q, r) => { r.end('never'); });
    const unknown = await phoneGet(a, p, route(HASH, REF, 'm_nobody'));
    expect(unknown.status).toBe(409);
    expect(unknown.json.error).toBe('wrong-machine');
    set([{ ...fake, url: 'http://203.0.113.9:4042', kind: 'last-known-url' }]);
    const untrusted = await phoneGet(a, p, route(HASH, REF, 'm_b'));
    expect(untrusted.status).toBe(502);
    expect(untrusted.json.error).toBe('holder-untrusted');
    expect(fake.calls()).toBe(0);
  });

  it('a Range request is refused before any dial', async () => {
    const { a, b } = await pair();
    const p = await phone(a);
    const r = await phoneGet(a, p, route(HASH, REF, 'm_b'), { Range: 'bytes=0-99' });
    expect(r.status).toBe(416);
    expect(r.json.error).toBe('range-unsupported');
    expect(r.headers['accept-ranges']).toBe('none');
    expect(b.hops).toHaveLength(0);
  });

  it('a phone revoked during a delayed first byte gets nothing', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    const bytes = jpeg(200);
    let go!: () => void, entered!: () => void;
    const reached = new Promise<void>((r) => { entered = r; });
    const h = await fakeHolder((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length), [HOLDER_MEDIA_HEADER]: '1' });
      res.flushHeaders();
      go = () => res.end(bytes);
      entered();
    });
    set([h]);
    const pending = phoneGet(a, p, route(sha(bytes), REF, 'm_b'));
    await reached;
    a.pairing.devices.revoke(p.deviceId, new Date().toISOString());
    go();
    const r = await pending;
    expect(r.status).toBe(403);
    expect(r.body.includes(bytes)).toBe(false);
  });

  it('a phone revoked midstream is cut off: the response never completes', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    const first = jpeg(300_000);
    const rest = crypto.randomBytes(300_000);
    const whole = Buffer.concat([first, rest]);
    let more!: () => void, entered!: () => void;
    const reached = new Promise<void>((r) => { entered = r; });
    const h = await fakeHolder((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(whole.length), [HOLDER_MEDIA_HEADER]: '1' });
      res.write(first, () => entered());
      more = () => { res.write(rest.subarray(0, 100_000)); setTimeout(() => res.write(rest.subarray(100_000)), 100); };
    });
    set([h]);
    const pending = phoneGet(a, p, route(sha(whole), REF, 'm_b'));
    await reached;
    await new Promise((r) => setTimeout(r, 100));
    a.pairing.devices.revoke(p.deviceId, new Date().toISOString());
    more();
    const r = await pending;
    expect(r.complete).toBe(false);
    expect(r.body.length).toBeLessThan(whole.length);
  });

  it('a phone revoked while the holder has stalled is cut off on the clock, with no more bytes needed', async () => {
    const { a, set } = await pair({ idleMs: 5_000 });
    const p = await phone(a);
    const first = jpeg(300_000);
    let entered!: () => void, closed!: () => void;
    const reached = new Promise<void>((r) => { entered = r; });
    const holderClosed = new Promise<void>((r) => { closed = r; });
    const h = await fakeHolder((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '900000', [HOLDER_MEDIA_HEADER]: '1' });
      res.write(first, () => entered());
      res.on('close', () => closed());
    });
    set([h]);
    const pending = phoneGet(a, p, route(sha(first), REF, 'm_b'));
    await reached;
    await new Promise((r) => setTimeout(r, 100));
    const at = performance.now();
    a.pairing.devices.revoke(p.deviceId, new Date().toISOString());
    const r = await pending;
    await holderClosed;
    expect(performance.now() - at).toBeLessThan(1_000);
    expect(r.complete).toBe(false);
  });

  it('holds to the byte ceiling with and without a declared length', async () => {
    const { a, set } = await pair({ maxBytes: 100_000 });
    const p = await phone(a);
    const big = crypto.randomBytes(300_000);
    const declared = await fakeHolder((_q, res) => { res.writeHead(200, { 'Content-Length': String(big.length), [HOLDER_MEDIA_HEADER]: '1' }); res.end(big); });
    set([declared]);
    const said = await phoneGet(a, p, route(sha(big), REF, 'm_b'));
    expect(said.status).toBe(502);
    expect(said.json.error).toBe('holder-too-large');
    let sent = 0;
    const unknown = await fakeHolder((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', [HOLDER_MEDIA_HEADER]: '1' });
      const pump = () => { if (res.destroyed || sent > 5_000_000) { res.destroy(); return; } sent += 50_000; res.write(crypto.randomBytes(50_000), () => setImmediate(pump)); };
      res.on('close', () => { sent = -1e9; });
      pump();
    });
    set([unknown]);
    const r = await phoneGet(a, p, route(sha(big), REF, 'm_b'));
    expect(r.complete).toBe(false);
    expect(r.body.length).toBeLessThanOrEqual(100_000);
  });

  it('a file that does not match its hash, or comes up short, never completes', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    const bytes = jpeg(5_000);
    const wrong = await fakeHolder((_q, res) => { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length), [HOLDER_MEDIA_HEADER]: '1' }); res.end(bytes); });
    set([wrong]);
    const bad = await phoneGet(a, p, route('b'.repeat(64), REF, 'm_b'));
    expect(bad.status === 502 || bad.complete === false).toBe(true);
    expect(bad.body.includes(bytes)).toBe(false);
    const short = await fakeHolder((_q, res) => { res.writeHead(200, { 'Content-Length': String(bytes.length + 500), [HOLDER_MEDIA_HEADER]: '1' }); res.write(bytes); setTimeout(() => res.destroy(), 20); });
    set([short]);
    const cut = await phoneGet(a, p, route(sha(bytes), REF, 'm_b'));
    expect(cut.status === 502 || cut.complete === false).toBe(true);
  });

  it('refuses a redirect, an older holder, and passes only known refusals', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    let followed = 0;
    const target = await fakeHolder((_q, r) => { followed++; r.end('x'); });
    const redirect = await fakeHolder((_q, r) => { r.writeHead(302, { Location: `${target.url}/stolen` }); r.end(); });
    set([redirect]);
    const moved = await phoneGet(a, p, route(HASH, REF, 'm_b'));
    expect(moved.status).toBe(502);
    expect(moved.json.error).toBe('holder-redirected');
    expect(followed).toBe(0);
    const old = await fakeHolder((_q, r) => { r.writeHead(403, { 'Content-Type': 'application/json' }); r.end('{"error":"operator-device-required"}'); });
    set([old]);
    expect((await phoneGet(a, p, route(HASH, REF, 'm_b'))).json.error).toBe('holder-outdated');
    const noMark = await fakeHolder((_q, r) => { r.writeHead(200, { 'Content-Type': 'image/jpeg' }); r.end('old'); });
    set([noMark]);
    expect((await phoneGet(a, p, route(HASH, REF, 'm_b'))).json.error).toBe('holder-outdated');
    const leaky = await fakeHolder((_q, r) => { r.writeHead(500, { 'Content-Type': 'application/json' }); r.end('{"error":"/Users/x/secret-path"}'); });
    set([leaky]);
    const hidden = await phoneGet(a, p, route(HASH, REF, 'm_b'));
    expect(hidden.json.error).toBe('holder-failed');
    expect(hidden.body.toString()).not.toContain('secret-path');
    const copying = await fakeHolder((_q, r) => { r.writeHead(202, { 'Content-Type': 'application/json' }); r.end('{"state":"fetching","retryAfterMs":3000,"extra":"/Users/x"}'); });
    set([copying]);
    const wait = await phoneGet(a, p, route(HASH, REF, 'm_b'));
    expect(wait.status).toBe(202);
    expect(wait.json).toEqual({ state: 'fetching', retryAfterMs: 3000 });
  });

  it('a hung holder neither blocks the server nor holds a slot past its deadline', async () => {
    const { a, set } = await pair({ firstByteMs: 500, idleMs: 400 });
    const p = await phone(a);
    const hung = await fakeHolder(() => undefined);
    set([hung]);
    const pending = phoneGet(a, p, route(HASH, REF, 'm_b'));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const r = await fetch(`${a.url}/health`);
      expect(r.status).toBe(200);
      times.push(performance.now() - t);
      await new Promise((r2) => setTimeout(r2, 40));
    }
    expect(Math.max(...times)).toBeLessThan(250);
    const r = await pending;
    expect(r.status).toBe(504);
    expect(r.json.error).toBe('holder-timeout');
    const stalled = await fakeHolder((_q, res) => { res.writeHead(200, { 'Content-Length': '1000', [HOLDER_MEDIA_HEADER]: '1' }); res.write(Buffer.alloc(100)); });
    set([stalled]);
    const cut = await phoneGet(a, p, route(HASH, REF, 'm_b'));
    expect(cut.status === 504 || cut.complete === false).toBe(true);
  });

  it('per-holder slots: a third read at one holder waits, and slots come back', async () => {
    const { a, set } = await pair({ firstByteMs: 400 });
    const p = await phone(a);
    const hung = await fakeHolder(() => undefined);
    set([hung]);
    const one = phoneGet(a, p, route(HASH, REF, 'm_b'));
    const two = phoneGet(a, p, route(HASH, REF, 'm_b'));
    await new Promise((r) => setTimeout(r, 80));
    const third = await phoneGet(a, p, route(HASH, REF, 'm_b'));
    expect(third.status).toBe(202);
    expect(third.json).toEqual({ state: 'fetching', retryAfterMs: 5_000 });
    expect(hung.calls()).toBe(2);
    await Promise.all([one, two]);
    expect((await phoneGet(a, p, route(HASH, REF, 'm_b'))).status).toBe(504);
  });

  it('a phone that hangs up stops the holder read', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    let closed!: () => void;
    const holderClosed = new Promise<void>((r) => { closed = r; });
    const h = await fakeHolder((_q, res) => {
      res.writeHead(200, { 'Content-Length': '10000000', [HOLDER_MEDIA_HEADER]: '1' });
      res.write(Buffer.alloc(100_000));
      res.on('close', () => closed());
    });
    set([h]);
    const u = new URL(a.url);
    const r = route(HASH, REF, 'm_b');
    const q = http.request({ host: u.hostname, port: u.port, path: r, method: 'GET', headers: signedHeaders(p, r) });
    q.on('error', () => undefined);
    q.end();
    await new Promise((res) => setTimeout(res, 200));
    q.destroy();
    await holderClosed;
  });

  it('is GET only: nothing is uploaded, sent or recorded on the holder', async () => {
    const { a, b } = await pair();
    const bytes = jpeg(2_000);
    const key = await b.held('C0BBBBBBB', bytes);
    const before = b.svc.store.mediaAttachmentIds(key).length;
    const p = await phone(a);
    await phoneGet(a, p, route(sha(bytes), key, 'm_b'));
    expect(b.hops.every((h) => h.startsWith('GET /mobile/media/'))).toBe(true);
    expect(b.svc.store.mediaAttachmentIds(key)).toHaveLength(before);
    expect(a.svc.store.mediaConversationsFor(sha(bytes))).toEqual([]);
  });
});
