/**
 * The seam between a conversation's history and its files, on two REAL servers: the phone holds
 * only the negative alias and the machine, and the file's ref must come from the holder's history
 * answer. Both machines use one alias for different channels, so a wrong lookup shows it.
 * With SEAM_CAPTURE set it also writes what the phone received, for the app's replay test.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware, bearerMatches } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { buildMobileSlackBridge, createMobileSlackRouter, type SlackAdapterLike } from '../../src/server/mobileSlackRoutes.js';
import { buildSlackHolderRead } from '../../src/server/mobileSlackHolderProxy.js';
import { createMobileMediaRouter } from '../../src/server/mobileMediaRoutes.js';
import { buildMediaHolderStream } from '../../src/server/mobileMediaHolderProxy.js';
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
const OWNER = 'U0OWNER1';
const ALIAS = -7777;
const TS = '1793615300.000000';
const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(async () => {
  ProcessIntegrity.reset();
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-remote-media-graph-seam.test.ts:cleanup' });
});
type Peer = { machineId: string; url: string; kind: string };
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function machine(id: string, routingKey: string, channel: string, peers: () => Peer[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mseam-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: id });
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'ann', name: 'Ann Client', channels: [], permissions: ['user'], telegramUserId: 777 }]));
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, slackOwnerUserId: OWNER }, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => id, isRecordingEnabled: () => true });
  const minted = registry.mintForInbound(routingKey).id!;
  const key = (registry.resolve(minted) as unknown as { key: string }).key;
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
  const threadTs = routingKey.includes(':') ? routingKey.split(':').pop() : undefined;
  fs.appendFileSync(logPath, `${JSON.stringify({ messageId: TS, channelId: channel, ...(threadTs ? { threadTs } : {}), text: `file on ${id}`, fromUser: true, senderName: 'Ann', senderId: OWNER, timestamp: new Date(Date.now() - 60_000).toISOString(), platform: 'slack' })}\n`);
  const adapter: SlackAdapterLike = {
    getChannelMessages: () => [], getBotUserId: () => 'UBOT', getLogPath: () => logPath, logMessage: () => undefined,
    sendToChannel: async () => '1793615401.000001', getSessionForChannel: () => 'sess-slack', isAuthorized: (u) => u === OWNER,
  };
  const real = buildMobileSlackBridge({ adapter, registry, dispatch: () => async () => 'delivered', killAllSessions: () => true, sendEscape: () => undefined, holdsLease: () => true });
  const bridge = { ...real, resolve: (n: number) => { const c = real.resolve(n === ALIAS ? minted : n); return c ? { ...c, id: n } : c; } };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const hops: string[] = [];
  app.use((req, _r, next) => { if (req.headers.authorization) hops.push(`${req.method} ${req.url}`); next(); });
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createMobileSlackRouter({
    config: config as never, pairing, service: svc, slack: () => bridge, machineId: () => id,
    holderRead: buildSlackHolderRead({ peers, token: () => 'tok-1', selfMachineId: () => id, timeoutMs: 1_500, maxBytes: 200_000 }),
  }));
  app.use(createMobileMediaRouter({
    pairing, service: svc, mediaEnabled: true, machineId: () => id,
    slackHeld: (k) => slackConversationHeldLocally(registry, k),
    ownerAdmission: (req) => mobileOwnerDeviceAdmission(pairing, req),
    bearerOk: (req) => bearerMatches(req, 'tok-1'),
    holderMedia: buildMediaHolderStream({ peers, token: () => 'tok-1', selfMachineId: () => id, firstByteMs: 1_500, idleMs: 1_500 }),
  }));
  app.use(createMobilePairingRouter(pairing, deps, { config } as never));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const held = async (bytes: Buffer) => {
    const file = path.join(dir, 'in.jpg');
    fs.writeFileSync(file, bytes);
    const done = await recordPlatformMedia(svc, { conversationKey: key, platformMessageId: TS, filePath: file, declaredKind: 'photo', filename: 'photo.jpg', declaredType: 'image/jpeg' } as never);
    if (!done.recorded) throw new Error(`file not recorded: ${JSON.stringify(done)}`);
  };
  return { id, url, key, pairing, hops, held };
}
type Machine = Awaited<ReturnType<typeof machine>>;
type Phone = { dev: ReturnType<typeof makeDevice>; deviceId: string };
function phone(m: Machine): Phone {
  const dev = makeDevice();
  const c = m.pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST } as never);
  if (!c.ok) throw new Error('setup');
  m.pairing.devices.applyConfirm(c.device.id, { ok: true });
  return { dev, deviceId: c.device.id };
}
let tick = 0;
function get(m: Machine, p: Phone, route: string) {
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.deviceId, HOST, 'GET', route, time, undefined));
  return new Promise<{ status: number; body: Buffer; json: Record<string, unknown> }>((resolve, reject) => {
    const u = new URL(m.url);
    http.get({ host: u.hostname, port: u.port, path: route, headers: { Host: HOST, 'X-Instar-Device': p.deviceId, 'X-Instar-Device-Time': time, 'X-Instar-Device-Sig': sig } }, (r) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => {
        const body = Buffer.concat(parts);
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(body.toString('utf8')); } catch { json = {}; }
        resolve({ status: r.statusCode ?? 0, body, json });
      });
    }).on('error', reject);
  });
}
const media = (hash: string, ref: string) => `/mobile/media/${hash}?ref=${encodeURIComponent(ref)}&machine=m_b`;
const history = `/mobile/chat/slack/${ALIAS}/messages?machine=m_b&limit=100`;

async function setup(routingKey: string, channel: string) {
  let list: Peer[] = [];
  const a = await machine('m_a', 'C0NEAR111', 'C0NEAR111', () => list);
  const b = await machine('m_b', routingKey, channel, () => []);
  list = [{ machineId: 'm_b', url: b.url, kind: 'lan' }];
  const bytes = process.env.SEAM_JPEG ? fs.readFileSync(process.env.SEAM_JPEG) : Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(4_000)]);
  await b.held(bytes);
  return { a, b, bytes, p: phone(a) };
}

describe('alias and machine lead to the holder\'s real ref', () => {
  it('history through the holder gives the canonical ref, and that ref opens the file', async () => {
    const { a, b, bytes, p } = await setup('C0HOLDER1', 'C0HOLDER1');
    const h = await get(a, p, history);
    expect(h.status).toBe(200);
    expect(h.json.conversationId).toBe(ALIAS);
    expect(h.json.conversationKey).toBe(b.key);
    expect(h.json.conversationKey).not.toBe(a.key);
    const row = (h.json.messages as Array<{ attachments?: Array<{ sha256: string }> }>).find((m) => m.attachments?.length);
    expect(row?.attachments?.[0]?.sha256).toBe(sha(bytes));
    const r = await get(a, p, media(sha(bytes), String(h.json.conversationKey)));
    expect(r.status).toBe(200);
    expect(sha(r.body)).toBe(sha(bytes));
    expect(b.hops.some((x) => x.includes(`ref=${encodeURIComponent(b.key)}`))).toBe(true);
    if (process.env.SEAM_CAPTURE) {
      fs.writeFileSync(process.env.SEAM_CAPTURE, JSON.stringify({ captured: 'two real servers', history: h.json, sha256: sha(bytes), bytesBase64: bytes.toString('base64'), holderHops: b.hops }, null, 1));
    }
  });

  it('a thread row gets its own thread ref', async () => {
    const { a, b, bytes, p } = await setup('C0HOLDER2:1793615000.000100', 'C0HOLDER2');
    const h = await get(a, p, history);
    expect(h.json.conversationKey).toBe(b.key);
    expect(String(h.json.conversationKey)).toContain('1793615000.000100');
    expect((await get(a, p, media(sha(bytes), b.key))).status).toBe(200);
  });

  it('a ref made from the alias, the title or the near machine opens nothing', async () => {
    const { a, bytes, p } = await setup('C0HOLDER3', 'C0HOLDER3');
    for (const ref of [`slack:${ALIAS}`, `slack:_:${ALIAS}`, 'slack:_:Mock Slack thread', a.key]) {
      expect((await get(a, p, media(sha(bytes), ref))).status, ref).toBe(404);
    }
    expect((await get(a, p, media(sha(bytes), String(ALIAS)))).status).toBe(404);
  });
});
