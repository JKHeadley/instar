/**
 * The owner's phone reads a Slack conversation held by another machine
 * (docs/specs/mobile-slack-holder-proxy.md), over two REAL servers on real sockets, with real
 * device signatures, registries and the production holder read. Both machines hold the same
 * negative alias for different Slack channels, so a wrong lookup shows the wrong conversation.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { buildMobileSlackBridge, createMobileSlackRouter, type SlackAdapterLike } from '../../src/server/mobileSlackRoutes.js';
import { buildSlackHolderRead } from '../../src/server/mobileSlackHolderProxy.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const OWNER = 'U0OWNER1';
const SHARED_ALIAS = -7777;
const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(async () => {
  ProcessIntegrity.reset();
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-slack-holder-proxy.test.ts:cleanup' });
});

type Peer = { machineId: string; url: string; kind: string };

async function machine(id: string, channel: string, text: string, peers: () => Peer[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mslackhold-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: id });
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'ann', name: 'Ann Client', channels: [], permissions: ['user'], telegramUserId: 777 }]));
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, slackOwnerUserId: OWNER },
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => id, isRecordingEnabled: () => true });
  // Ids hash the key, so a real collision can't be minted: both machines map one alias to their own channel.
  const minted = registry.mintForInbound(channel).id!;
  const alias = SHARED_ALIAS;
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
  const logPath = path.join(dir, 'slack-messages.jsonl');
  fs.appendFileSync(logPath, `${JSON.stringify({ messageId: '1793615300.000000', channelId: channel, text, fromUser: true, timestamp: new Date(Date.now() - 60_000).toISOString(), platform: 'slack', senderName: 'Sam' })}\n`);
  const posted: string[] = [];
  const dispatched: string[] = [];
  const adapter: SlackAdapterLike = {
    getChannelMessages: () => [], getBotUserId: () => 'UBOT', getLogPath: () => logPath,
    logMessage: (e) => fs.appendFileSync(logPath, `${JSON.stringify({ ...e, timestamp: new Date().toISOString(), platform: 'slack' })}\n`),
    sendToChannel: async (_c, t) => { posted.push(t); return '1793615401.000001'; },
    getSessionForChannel: () => 'sess-slack', isAuthorized: (u) => u === OWNER,
  };
  const real = buildMobileSlackBridge({
    adapter, registry, dispatch: () => async (m) => { dispatched.push(String(m.content)); return 'delivered'; },
    killAllSessions: () => true, sendEscape: () => undefined, holdsLease: () => true,
  });
  const bridge = { ...real, resolve: (n: number) => { const c = real.resolve(n === SHARED_ALIAS ? minted : n); return c ? { ...c, id: n } : c; } };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.get('/health', (_q, r) => { r.json({ ok: true }); });
  let hits = 0;
  app.use((req, _r, next) => { if (req.path.includes('/mobile/chat/slack/') && req.headers.authorization) hits++; next(); });
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createMobileSlackRouter({
    config: config as never, pairing, service: svc, slack: () => bridge, machineId: () => id,
    holderRead: buildSlackHolderRead({ peers, token: () => 'tok-1', selfMachineId: () => id, timeoutMs: 1_500, maxBytes: 200_000 }),
  }));
  app.use(createMobilePairingRouter(pairing, deps, { config } as never));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { id, app, url, alias, pairing, config, dir, posted, dispatched, logPath, hits: () => hits };
}
type Machine = Awaited<ReturnType<typeof machine>>;

async function fakeHolder(handle: http.RequestListener): Promise<Peer & { calls: () => number }> {
  let calls = 0;
  const server = http.createServer((q, r) => { calls++; handle(q, r); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));
  return { machineId: 'm_fake', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, kind: 'lan', calls: () => calls };
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
function signed(m: Machine, p: Phone, method: 'GET' | 'POST', route: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.deviceId, HOST, method, route, time, raw));
  const base = method === 'GET' ? request(m.app).get(route) : request(m.app).post(route);
  const q = base.set('Host', HOST).set('X-Instar-Device', p.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
}

async function pair() {
  let list: Peer[] = [];
  const a = await machine('m_a', 'C0AAAAAAA', 'only on the studio', () => list);
  let listB: Peer[] = [];
  const b = await machine('m_b', 'C0BBBBBBB', 'only on the laptop', () => listB);
  list = [{ machineId: 'm_b', url: b.url, kind: 'lan' }];
  return { a, b, set: (p: Peer[]) => { list = p; }, setB: (p: Peer[]) => { listB = p; } };
}
const read = (alias: number, m: string) => `/mobile/chat/slack/${alias}/messages?machine=${m}`;

describe('owner phone reads a Slack conversation held by another machine', () => {
  it('two machines share the alias: each machine name opens its own conversation, exact id forwarded', async () => {
    const { a, b } = await pair();
    expect(a.alias).toBe(b.alias);
    const p = await phone(a);
    const remote = await signed(a, p, 'GET', read(a.alias, 'm_b'));
    expect(remote.status).toBe(200);
    expect(remote.body.messages.map((x: { text: string }) => x.text)).toEqual(['only on the laptop']);
    expect(remote.body.conversationId).toBe(a.alias);
    expect(remote.body.conversationKey).toContain('C0BBBBBBB');
    expect(remote.body.deviceView).toBeUndefined();
    const local = await signed(a, p, 'GET', read(a.alias, 'm_a'));
    expect(local.body.messages.map((x: { text: string }) => x.text)).toEqual(['only on the studio']);
    expect(a.hits()).toBe(0);
  });

  it('a holder answers in the same row shape a local read gives', async () => {
    const { a, b } = await pair();
    fs.appendFileSync(b.logPath, `${JSON.stringify({ messageId: '1793615310.000000', channelId: 'C0BBBBBBB', text: 'a file [full content saved to /Users/sam/.instar/slack/secret-plan.pdf]', fromUser: true, timestamp: new Date(Date.now() - 30_000).toISOString(), platform: 'slack', senderName: 'Sam' })}\n`);
    const fromA = await signed(a, await phone(a), 'GET', read(a.alias, 'm_b'));
    const direct = await signed(b, await phone(b), 'GET', read(b.alias, 'm_b'));
    expect(fromA.body).toEqual(direct.body);
    expect(fromA.body.messages).toHaveLength(2);
    expect(JSON.stringify(fromA.body)).not.toContain('/Users/sam');
  });

  it('an MSP phone, a bearer token and a forged request never reach the holder', async () => {
    const { a, b } = await pair();
    const owner = await phone(a);
    const route = read(a.alias, 'm_b');
    const msp = await phone(a, { userId: 'ann', role: 'msp' });
    const ungranted = await signed(a, msp, 'GET', route);
    expect(ungranted.status).toBe(403);
    expect(ungranted.body.error).toBe('owner-only');
    // A Slack grant still reads only on the machine that holds the row.
    a.pairing.grants.set('ann', { slack: true }, owner.deviceId);
    const granted = await signed(a, msp, 'GET', route);
    expect(granted.status).toBe(409);
    expect(granted.body.error).toBe('wrong-machine');
    const token = await request(a.app).get(route).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
    expect(token.status).toBe(409);
    // Signed for one machine, sent naming another.
    const time = String(Date.now());
    const sig = owner.dev.sign(canonicalString(owner.deviceId, HOST, 'GET', read(a.alias, 'm_a'), time));
    const forged = await request(a.app).get(route).set('Host', HOST).set('X-Instar-Device', owner.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    expect(forged.status).toBe(401);
    expect(b.hits()).toBe(0);
  });

  it('a holder hop never goes on to a third machine, even when the holder knows that machine', async () => {
    const { a, b, set, setB } = await pair();
    const third = await fakeHolder((_q, r) => { r.end('{}'); });
    setB([{ ...third, machineId: 'm_third' }]);
    set([{ machineId: 'm_third', url: b.url, kind: 'lan' }]);
    const hop = await signed(a, await phone(a), 'GET', read(a.alias, 'm_third'));
    expect(hop.status).toBe(502);
    expect(hop.body.error).toBe('holder-failed');
    expect(b.hits()).toBe(1);
    expect(third.calls()).toBe(0);
  });

  it('an unknown or untrusted holder is refused with no request made', async () => {
    const { a, b, set } = await pair();
    const p = await phone(a);
    const unknown = await signed(a, p, 'GET', read(a.alias, 'm_nobody'));
    expect(unknown.status).toBe(409);
    expect(unknown.body.error).toBe('wrong-machine');
    set([{ machineId: 'm_b', url: 'http://8.8.8.8:4042', kind: 'lan' }]);
    const refused = await signed(a, p, 'GET', read(a.alias, 'm_b'));
    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe('holder-url-refused');
    expect(b.hits()).toBe(0);
  });

  it('a phone revoked while the holder is answering gets nothing', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    let release: () => void = () => undefined;
    const reached = new Promise<void>((go) => {
      void fakeHolder((_q, r) => {
        release = () => { r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ deviceView: true, conversationId: a.alias, messages: [{ text: 'private' }] })); };
        go();
      }).then((h) => set([{ ...h, machineId: 'm_b' }]));
    });
    await new Promise((r) => setTimeout(r, 50));
    const pending = signed(a, p, 'GET', read(a.alias, 'm_b')).then((r) => r);
    await reached;
    a.pairing.devices.revoke(p.deviceId, new Date().toISOString());
    release();
    const r = await pending;
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('private');
  });

  it.each(['ledger', 'key', 'binding', 'named-removed', 'named-demoted', 'pairing-off', 'native-off'])(
    'refuses private content when %s changes during the actual holder wait', async change => {
      const { a, set } = await pair();
      const named = change.startsWith('named-');
      const profiles = [{ id: 'owner', name: 'Justin', orgRole: 'owner', permissions: [], channels: [] }];
      if (named) fs.writeFileSync(path.join(a.dir, 'users.json'), JSON.stringify(profiles));
      const p = await phone(a, named ? { userId: 'owner', role: 'owner' } : undefined);
      let release!: () => void, entered!: () => void;
      const reached = new Promise<void>(r => { entered = r; });
      const holder = await fakeHolder((_req, res) => {
        release = () => res.end(JSON.stringify({ deviceView: true, conversationId: a.alias, messages: [{ text: 'private held bytes' }] }));
        entered();
      });
      set([{ ...holder, machineId: 'm_b' }]);
      const pending = signed(a, p, 'GET', read(a.alias, 'm_b')).then(r => r);
      await reached;
      if (change === 'ledger') {
        a.pairing.keyLedger!.recordRevocation(a.pairing.devices.get(p.deviceId)!, new Date().toISOString());
        expect(a.pairing.devices.get(p.deviceId)!.status).toBe('active');
      }
      if (change === 'key' || change === 'binding') {
        const file = JSON.parse(fs.readFileSync(a.pairing.devices.file, 'utf8'));
        const row = file.devices.find((d: { id: string }) => d.id === p.deviceId);
        if (change === 'key') row.publicKey = makeDevice().publicKey;
        else row.userId = 'another-owner';
        fs.writeFileSync(a.pairing.devices.file, JSON.stringify(file));
      }
      if (change === 'named-removed') fs.writeFileSync(path.join(a.dir, 'users.json'), '[]');
      if (change === 'named-demoted') fs.writeFileSync(path.join(a.dir, 'users.json'),
        JSON.stringify([{ ...profiles[0], name: 'Former owner', orgRole: 'member' }]));
      if (change === 'pairing-off') (a.config.mobilePairing as any).enabled = false;
      if (change === 'native-off') (a.config.mobilePairing as any).native = { enabled: false };
      release();
      const response = await pending;
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain('private held bytes');
    });

  it('refuses a redirect, an oversized body, an old holder and a slow holder; the server stays free', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    const redirect = await fakeHolder((_q, r) => { r.statusCode = 302; r.setHeader('Location', 'http://127.0.0.1:1/steal'); r.end(); });
    set([{ ...redirect, machineId: 'm_b' }]);
    expect((await signed(a, p, 'GET', read(a.alias, 'm_b'))).body.error).toBe('holder-redirected');
    expect(redirect.calls()).toBe(1);
    const big = await fakeHolder((_q, r) => { r.end('x'.repeat(300_000)); });
    set([{ ...big, machineId: 'm_b' }]);
    expect((await signed(a, p, 'GET', read(a.alias, 'm_b'))).body.error).toBe('holder-too-large');
    const old = await fakeHolder((_q, r) => { r.end(JSON.stringify({ conversationId: a.alias, messages: [{ text: '/Users/x/file' }] })); });
    set([{ ...old, machineId: 'm_b' }]);
    expect((await signed(a, p, 'GET', read(a.alias, 'm_b'))).body.error).toBe('holder-outdated');
    const wrongId = await fakeHolder((_q, r) => { r.end(JSON.stringify({ deviceView: true, conversationId: -999, messages: [] })); });
    set([{ ...wrongId, machineId: 'm_b' }]);
    expect((await signed(a, p, 'GET', read(a.alias, 'm_b'))).body.error).toBe('holder-bad-answer');
    const slow = await fakeHolder(() => undefined);
    set([{ ...slow, machineId: 'm_b' }]);
    const started = Date.now();
    const pending = signed(a, p, 'GET', read(a.alias, 'm_b')).then((r) => r);
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await request(a.app).get('/health');
      worst = Math.max(worst, Date.now() - t);
      await new Promise((r) => setTimeout(r, 100));
    }
    const r = await pending;
    expect(r.status).toBe(504);
    expect(r.body.error).toBe('holder-timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(worst).toBeLessThan(500);
  });

  it('a holder refusal passes on only as a known code', async () => {
    const { a, set } = await pair();
    const p = await phone(a);
    const gone = await fakeHolder((_q, r) => { r.statusCode = 404; r.end(JSON.stringify({ error: 'unknown-conversation', path: '/Users/x' })); });
    set([{ ...gone, machineId: 'm_b' }]);
    const r = await signed(a, p, 'GET', read(a.alias, 'm_b'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'unknown-conversation' });
    const odd = await fakeHolder((_q, x) => { x.statusCode = 500; x.end(JSON.stringify({ error: 'boom /Users/x' })); });
    set([{ ...odd, machineId: 'm_b' }]);
    expect((await signed(a, p, 'GET', read(a.alias, 'm_b'))).body.error).toBe('holder-failed');
  });

  it('a send naming another machine is still refused: nothing is proxied, posted or dispatched', async () => {
    const { a, b } = await pair();
    const r = await signed(a, await phone(a), 'POST', `/mobile/chat/slack/${a.alias}`, { machine: 'm_b', text: 'meant for the laptop', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('wrong-machine');
    expect(a.posted.concat(b.posted, a.dispatched, b.dispatched)).toHaveLength(0);
    expect(b.hits()).toBe(0);
  });
});
