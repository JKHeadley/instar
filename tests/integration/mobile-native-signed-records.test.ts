/**
 * Signed records over the real HTTP pipeline (docs/specs/mobile-native-conversations.md §4.6,
 * §4.9, increment 2): a phone paired through the device confirm route (ledger row first), a
 * native message whose history and sync reads return `originVerified: "verified"` and whose
 * session tag carries "📱 signed"; a tampered stored text that reads "failed"; a redacted message
 * that reads "redacted" with no copy of the removed token anywhere on disk; a Telegram send from
 * the app whose Telegram history row, read by the device, joins to the store and reads "verified"
 * (and is still returned from the store after the Telegram row rotates away); and a revocation
 * written ledger-first that leaves earlier messages verified.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import type { AppDispatchInput } from '../../src/core/appInboundDispatch.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOPIC = 77;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-signed-records.test.ts' });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msigned-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' } };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const dispatched: AppDispatchInput[] = [];
  const svc: AppConversationService = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger,
    dispatch: () => async (input) => { dispatched.push(input); svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  // Telegram stand-in: topic history rows the inbound core writes, read back by the history route.
  const tgRows: Array<Record<string, unknown>> = [];
  const ingestRefusals: number[] = []; // push a status to make the next inbound-core call an early refusal
  const telegram = {
    getOwnerUserId: () => 4242,
    getAllTopicMappings: () => [{ topicId: TOPIC, topicName: 'Lifeline' }],
    getTopicHistory: (id: number, limit: number) => tgRows.filter((r) => r.topicId === id).slice(-limit),
    sendToTopic: async () => undefined,
  };
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1',
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: createConversationBindAuth(dir), appConversations: svc, telegram,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1' }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  // The inbound core stand-in (installed after createRoutes, which installs the real one): it
  // writes the Telegram history row with the eventId the route hands it, as logInboundMessage does.
  ctx.mobileInbound = {
    ingest: async (req: { body: Record<string, unknown> }, res: { status(c: number): { json(b: unknown): unknown } }, trust: { deviceId: string; eventId: string }) => {
      const refuse = ingestRefusals.shift();
      if (refuse) { res.status(refuse).json({ ok: false, reason: 'server-boot-incomplete' }); return; }
      tgRows.push({ messageId: req.body.messageId, topicId: req.body.topicId, text: req.body.text, fromUser: true, timestamp: req.body.timestamp, sessionName: null, via: 'mobile-device', deviceId: trust.deviceId, eventId: trust.eventId });
      res.status(200).json({ ok: true });
    },
  };

  // Pair through the device confirm route, so the activation is written ledger-first.
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { app, dir, svc, dev, deviceId: c.device.id, dispatched, tgRows, ingestRefusals, pairing, keyLedger };
  const confirmed = await signed(e, 'POST', '/mobile/device/confirm', { code });
  expect(confirmed.body.status).toBe('active');
  return e;
}

type Env = Awaited<ReturnType<typeof setup>>;
let tick = 0;
function signed(e: Pick<Env, 'app' | 'dev' | 'deviceId'>, method: 'GET' | 'POST', p: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, raw));
  const base = method === 'GET' ? request(e.app).get(p) : request(e.app).post(p);
  const q = base.set('X-Instar-Device', e.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
}
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

describe('signed records — native conversations', () => {
  it('the activation was written ledger-first, with the approval method and time the registry records', async () => {
    const e = await setup();
    const rows = e.keyLedger.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'activation', deviceId: e.deviceId, approvedVia: 'telegram-dm', activatedAt: e.pairing.devices.get(e.deviceId)!.approvedAt });
  });

  it('a native message reads "verified" in history and sync, and the session tag is signed', async () => {
    const e = await setup();
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    const sent = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'What is on for Saturday?', requestId: rid() });
    expect(sent.status).toBe(200);
    expect(e.dispatched[0]!.originVerdict).toBe('verified');
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.messages[0]).toMatchObject({ role: 'operator', text: 'What is on for Saturday?', originVerified: 'verified' });
    const sync = await signed(e, 'GET', `/mobile/chat/app/${key}/events`);
    const msg = sync.body.events.find((x: { kind: string }) => x.kind === 'message');
    expect(msg.originVerified).toBe('verified');
    expect(msg.origin).toBeUndefined(); // the raw signature material is not echoed to the phone
    // The stored record carries this machine's receipt.
    const stored = e.svc.store.getEvent(key, sent.body.eventId as string) as { receipt?: { machineId: string } };
    expect(stored.receipt?.machineId).toBe(loadMachineSigner(e.dir)!.machineId());
  });

  it('a tampered stored text reads "failed"', async () => {
    const e = await setup();
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'Transfer the files on Monday', requestId: rid() });
    const file = allFiles(path.join(e.dir, 'app-conversations')).find((f) => f.endsWith('.jsonl') && fs.readFileSync(f, 'utf8').includes('Transfer the files'))!;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Transfer the files on Monday', 'Delete the files on Monday'));
    e.svc.store.rebuildIndex();
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.messages[0]).toMatchObject({ text: 'Delete the files on Monday', originVerified: 'failed' });
  });

  it('a removed token reads "redacted" and the token is stored nowhere on disk', async () => {
    const e = await setup();
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    const token = `tlinv1:${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(12).toString('base64url')}`;
    const sent = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: `please pair with ${token} today`, requestId: rid() });
    expect(sent.body.redacted).toBe(true);
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.messages[0]).toMatchObject({ text: 'please pair with [pairing invite removed] today', originVerified: 'redacted' });
    for (const f of allFiles(e.dir)) expect(fs.readFileSync(f).includes(Buffer.from(token)), f).toBe(false);
  });

  it('a revocation is written ledger-first and earlier messages stay verified', async () => {
    const e = await setup();
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'before the revocation', requestId: rid() });
    await new Promise((r) => setTimeout(r, 5));
    const rev = await request(e.app).post(`/mobile/devices/${e.deviceId}/revoke`).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo').send({});
    expect(rev.body.revoked).toBe(true);
    const revRow = e.keyLedger.rows().find((r) => r.type === 'revocation')!;
    expect(revRow.revokedAt).toBe(e.pairing.devices.get(e.deviceId)!.revokedAt);
    const hist = await request(e.app).get(`/mobile/chat/app/${key}/messages`).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
    expect(hist.body.messages[0].originVerified).toBe('verified');
  });
});

describe('signed records — the Telegram history join', () => {
  it('a Telegram history read by the device returns originVerified for an app-sent message', async () => {
    const e = await setup();
    e.tgRows.push({ messageId: 1, topicId: TOPIC, text: 'typed in Telegram', fromUser: true, timestamp: new Date(Date.now() - 1000).toISOString(), sessionName: null });
    const sent = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'from the app into Telegram', requestId: rid() });
    expect(sent.status).toBe(200);
    expect(sent.body.outcome).toBe('delivered');
    // The Telegram row carries the store's eventId; the store holds the signed copy and its delivery.
    const appRow = e.tgRows.find((r) => r.text === 'from the app into Telegram')!;
    expect(e.svc.store.getEvent(`telegram:${TOPIC}`, appRow.eventId as string)).toMatchObject({ kind: 'message', role: 'operator' });
    const hist = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(hist.status).toBe(200);
    const byText = Object.fromEntries(hist.body.messages.map((m: { text: string; originVerified: string }) => [m.text, m.originVerified]));
    expect(byText).toEqual({ 'typed in Telegram': 'none', 'from the app into Telegram': 'verified' });
    // Only native conversations are listed as app rows.
    expect((await signed(e, 'GET', '/mobile/conversations')).body.conversations.filter((c: { platform: string }) => c.platform === 'app')).toHaveLength(0);

    // A row whose store event is missing reads unknown.
    e.tgRows.push({ messageId: 3, topicId: TOPIC, text: 'old app row', fromUser: true, timestamp: new Date().toISOString(), sessionName: null, via: 'mobile-device', eventId: 'mobile:x:y' });
    const hist2 = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(hist2.body.messages.find((m: { text: string }) => m.text === 'old app row').originVerified).toBe('unknown');

    // After the Telegram rows rotate away, the app-sent message is still returned from the store.
    e.tgRows.length = 0;
    const hist3 = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(hist3.body.messages).toHaveLength(1);
    expect(hist3.body.messages[0]).toMatchObject({ text: 'from the app into Telegram', fromStore: true, originVerified: 'verified' });

    // A Bearer read (the agent) is unchanged: no join.
    e.tgRows.push({ messageId: 4, topicId: TOPIC, text: 'x', fromUser: true, timestamp: new Date().toISOString(), sessionName: null });
    const b = await request(e.app).get(`/telegram/topics/${TOPIC}/messages`).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
    expect(b.body.messages[0].originVerified).toBeUndefined();
  });

  it('a refused send is not shown as history, and a retry with the same request id but other text is its own record', async () => {
    const e = await setup();
    const requestId = rid();
    e.ingestRefusals.push(503);
    const first = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'the first wording', requestId });
    expect(first.status).toBe(503);
    // Refused before reaching the agent: kept in the store, but not shown as Telegram history.
    expect((await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`)).body.messages).toHaveLength(0);
    // The request id was released; a retry with different text is stored as a different message.
    const second = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'the second wording', requestId });
    expect(second.status).toBe(200);
    const hist = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(hist.body.messages.map((m: { text: string; originVerified: string }) => [m.text, m.originVerified])).toEqual([['the second wording', 'verified']]);
    // A Telegram row whose text differs from the stored copy gets no verdict.
    const row = e.tgRows[0]!;
    e.tgRows[0] = { ...row, text: 'edited elsewhere' };
    const hist2 = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(hist2.body.messages.find((m: { text: string }) => m.text === 'edited elsewhere').originVerified).toBe('unknown');
  });

  it('refuses a non-canonical topic id in the signed path when the signed copy is kept', async () => {
    const e = await setup();
    expect((await signed(e, 'POST', `/mobile/chat/0${TOPIC}`, { text: 'hi', requestId: rid() })).status).toBe(400);
  });
});
