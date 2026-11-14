/**
 * Pinned messages over the real HTTP pipeline (docs/specs/conversation-pinned-messages.md): real
 * device authentication and allowlist, a real app conversation store, a real conversation registry,
 * a stub Slack adapter and a stub Telegram bridge (nothing reaches Telegram or Slack). App, Telegram
 * and Slack pins; idempotent retries; the mirror outcomes; the Bearer token reads but never writes;
 * pins ride on the history reads; the switch; and a pin made in Telegram is recorded once.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { buildMobileSlackBridge, createMobileSlackRouter, type SlackAdapterLike } from '../../src/server/mobileSlackRoutes.js';
import { createMobilePinRouter, recordTelegramPin, TELEGRAM_PIN_REFUSED, TELEGRAM_PIN_UNAVAILABLE, SLACK_PIN_UNAVAILABLE } from '../../src/server/mobilePinRoutes.js';
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
const KEY = '33333333-3333-4333-8333-333333333333';
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/conversation-pins.test.ts' });
});

async function setup(opts: { pinsOff?: boolean; serving?: boolean; telegramRefuses?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpins-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, slackOwnerUserId: OWNER, ...(opts.pinsOff ? { native: { pins: { enabled: false } } } : {}) },
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const channelId = registry.mintForInbound('C0123ABC').id!;
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger, dispatch: () => null,
  });
  cleanups.push(() => svc.stop());
  // An app conversation with two messages.
  svc.store.append({ eventId: 'c1', kind: 'created', conversationKey: KEY, at: '2026-11-09T09:00:00.000Z', machineId: 'm1', title: 'Plans' });
  svc.store.append({ eventId: 'e1', kind: 'message', conversationKey: KEY, at: '2026-11-09T09:01:00.000Z', machineId: 'm1', messageId: 'msg-1', role: 'agent', text: 'The plan is ready' });

  // Slack: a stub adapter that records pin calls.
  const logPath = path.join(dir, 'slack-messages.jsonl');
  fs.writeFileSync(logPath, `${JSON.stringify({ messageId: '1793600000.000100', channelId: 'C0123ABC', text: 'slack text here', fromUser: true, timestamp: '2026-11-09T09:00:00.000Z', platform: 'slack' })}\n`);
  const slackPins: string[] = [];
  const adapter: SlackAdapterLike = {
    getChannelMessages: () => [], getBotUserId: () => 'UBOT', getLogPath: () => logPath, logMessage: () => undefined,
    sendToChannel: async () => '1793615401.000001', getSessionForChannel: () => null, isAuthorized: (u) => u === OWNER,
    pinMessage: async (ch, ts) => { slackPins.push(`pin ${ch} ${ts}`); },
    unpinMessage: async (ch, ts) => { slackPins.push(`unpin ${ch} ${ts}`); },
  };
  const bridge = buildMobileSlackBridge({ adapter, registry, dispatch: () => null, killAllSessions: () => true, sendEscape: () => undefined, holdsLease: () => true });

  // Telegram: a stub bridge that records pin calls.
  const tgPins: string[] = [];
  const telegram = {
    exists: (t: number) => t === 42,
    serving: () => opts.serving ?? true,
    textOf: (_t: number, id: string) => (id === '9001' ? 'telegram text' : null),
    pin: async (t: number, id: number, pinned: boolean) => { if (opts.telegramRefuses) throw new Error('Bad Request: not enough rights'); tgPins.push(`${pinned ? 'pin' : 'unpin'} ${t} ${id}`); },
  };

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createMobilePinRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1', telegram: () => telegram, slack: () => bridge }));
  app.use(createMobileSlackRouter({ config: config as never, pairing, service: svc, slack: () => bridge, machineId: () => 'm1' }));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1' }));
  app.use(createMobilePairingRouter(pairing, deps, { config } as never));

  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { app, dir, svc, dev, deviceId: c.device.id, channelId, slackPins, tgPins, config };
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
const bearer = (e: Env, method: 'get' | 'post', p: string) => request(e.app)[method](p).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');

describe('pins in an app conversation', () => {
  it('pins, lists newest first, rides on the history read, and unpins', async () => {
    const e = await setup();
    const r = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-1', pinned: true, requestId: rid() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, pinned: true, changed: true, mirror: 'not-applicable' });
    expect(r.body.pins).toEqual([expect.objectContaining({ messageId: 'msg-1', preview: 'The plan is ready', pinnedBy: { name: expect.any(String), role: 'owner' }, source: 'app' })]);
    const list = await signed(e, 'GET', `/mobile/chat/app/${KEY}/pins`);
    expect(list.body.pins.map((p: { messageId: string }) => p.messageId)).toEqual(['msg-1']);
    const hist = await signed(e, 'GET', `/mobile/chat/app/${KEY}/messages`);
    expect(hist.body.pins.map((p: { messageId: string }) => p.messageId)).toEqual(['msg-1']);
    // The events feed carries the pin event, so a polling client sees it.
    const ev = await signed(e, 'GET', `/mobile/chat/app/${KEY}/events`);
    expect(ev.body.events.some((x: { kind: string }) => x.kind === 'pin')).toBe(true);
    const un = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-1', pinned: false, requestId: rid() });
    expect(un.body).toMatchObject({ ok: true, pinned: false, changed: true, pins: [] });
  });

  it('a retry is answered from the record and never pins twice; the same id for another pin is a conflict', async () => {
    const e = await setup();
    const requestId = rid();
    const a = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-1', pinned: true, requestId });
    const b = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-1', pinned: true, requestId });
    expect([a.body.changed, b.body.changed, b.body.pinned]).toEqual([true, false, true]);
    const c = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-1', pinned: false, requestId });
    expect([c.status, c.body.error]).toEqual([409, 'payload-conflict']);
  });

  it('refuses a message from nowhere, bad bodies, and an unknown conversation', async () => {
    const e = await setup();
    const none = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-404', pinned: true, requestId: rid() });
    expect([none.status, none.body.error]).toEqual([404, 'unknown-message']);
    const bad = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-1', pinned: 'yes', requestId: rid() });
    expect(bad.status).toBe(400);
    const badId = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg 1', pinned: true, requestId: rid() });
    expect(badId.body.error).toBe('bad-message-id');
    const other = await signed(e, 'POST', '/mobile/chat/app/44444444-4444-4444-8444-444444444444/pins', { messageId: 'msg-1', pinned: true, requestId: rid() });
    expect(other.status).toBe(404);
  });

  it('the agent token reads pins but never writes them', async () => {
    const e = await setup();
    await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-1', pinned: true, requestId: rid() });
    const read = await bearer(e, 'get', `/mobile/chat/app/${KEY}/pins`);
    expect(read.body.pins).toHaveLength(1);
    const write = await bearer(e, 'post', `/mobile/chat/app/${KEY}/pins`).send({ messageId: 'msg-1', pinned: false, requestId: rid() });
    expect([write.status, write.body.error]).toEqual([403, 'operator-device-required']);
  });

  it('switched off: the routes answer pins-off and history carries no pins', async () => {
    const e = await setup({ pinsOff: true });
    const r = await signed(e, 'POST', `/mobile/chat/app/${KEY}/pins`, { messageId: 'msg-1', pinned: true, requestId: rid() });
    expect([r.status, r.body.error]).toEqual([503, 'pins-off']);
    const hist = await signed(e, 'GET', `/mobile/chat/app/${KEY}/messages`);
    expect(hist.body.pins).toBeUndefined();
  });
});

describe('pins in a Telegram topic', () => {
  it('pins in Telegram too for a real message id, and only in the app for one typed in the app', async () => {
    const e = await setup();
    const r = await signed(e, 'POST', '/mobile/chat/42/pins', { messageId: '9001', pinned: true, requestId: rid() });
    expect(r.body).toMatchObject({ ok: true, changed: true, mirror: 'done' });
    expect(r.body.pins[0]).toMatchObject({ messageId: '9001', preview: 'telegram text' });
    expect(e.tgPins).toEqual(['pin 42 9001']);
    const stand = await signed(e, 'POST', '/mobile/chat/42/pins', { messageId: String(2 ** 52 + 7), pinned: true, requestId: rid() });
    expect(stand.body).toMatchObject({ mirror: 'unavailable', mirrorDetail: TELEGRAM_PIN_UNAVAILABLE });
    const un = await signed(e, 'POST', '/mobile/chat/42/pins', { messageId: '9001', pinned: false, requestId: rid() });
    expect(un.body.mirror).toBe('done');
    expect(e.tgPins).toEqual(['pin 42 9001', 'unpin 42 9001']);
    const list = await bearer(e, 'get', '/mobile/chat/42/pins');
    expect(list.body.pins.map((p: { messageId: string }) => p.messageId)).toEqual([String(2 ** 52 + 7)]);
  });

  it('a refusal in Telegram keeps the pin and says so; another machine is not serving; an unknown topic is 404', async () => {
    const e = await setup({ telegramRefuses: true });
    const r = await signed(e, 'POST', '/mobile/chat/42/pins', { messageId: '9001', pinned: true, requestId: rid() });
    expect(r.body).toMatchObject({ ok: true, pinned: true, mirror: 'failed', mirrorDetail: TELEGRAM_PIN_REFUSED });
    const standby = await setup({ serving: false });
    const s = await signed(standby, 'POST', '/mobile/chat/42/pins', { messageId: '9001', pinned: true, requestId: rid() });
    expect([s.status, s.body.error]).toEqual([409, 'not-serving']);
    const u = await signed(e, 'POST', '/mobile/chat/43/pins', { messageId: '9001', pinned: true, requestId: rid() });
    expect(u.status).toBe(404);
  });

  it('a pin made in Telegram is recorded once and shows in the list', async () => {
    const e = await setup();
    const p = { topicId: 42, messageId: 9002, serviceMessageId: 9003, byName: 'Justin', atMs: Date.now() };
    expect(recordTelegramPin({ config: e.config as never, service: e.svc }, p)).toBe('recorded');
    expect(recordTelegramPin({ config: e.config as never, service: e.svc }, p)).toBe('unchanged');
    const list = await signed(e, 'GET', '/mobile/chat/42/pins');
    expect(list.body.pins).toEqual([expect.objectContaining({ messageId: '9002', source: 'telegram', pinnedBy: { name: 'Justin', role: 'telegram' } })]);
  });
});

describe('pins in a Slack conversation', () => {
  it('pins in Slack for a real ts, builds the preview at read time, and refuses another machine', async () => {
    const e = await setup();
    const p = `/mobile/chat/slack/${e.channelId}/pins`;
    const r = await signed(e, 'POST', p, { messageId: '1793600000.000100', pinned: true, requestId: rid(), machine: 'm1' });
    expect(r.body).toMatchObject({ ok: true, changed: true, mirror: 'done' });
    expect(r.body.pins[0]).toMatchObject({ messageId: '1793600000.000100', preview: 'slack text here' });
    expect(e.slackPins).toEqual(['pin C0123ABC 1793600000.000100']);
    // Slack text is never stored in the pin event.
    const stored = e.svc.store.listPins('slack:_:C0123ABC');
    expect(stored.length === 0 || stored.every((x) => x.preview === null)).toBe(true);
    const app = await signed(e, 'POST', p, { messageId: 'app-msg-1', pinned: true, requestId: rid(), machine: 'm1' });
    expect(app.body).toMatchObject({ mirror: 'unavailable', mirrorDetail: SLACK_PIN_UNAVAILABLE });
    const wrong = await signed(e, 'POST', p, { messageId: '1793600000.000100', pinned: false, requestId: rid(), machine: 'm2' });
    expect([wrong.status, wrong.body.error]).toEqual([409, 'wrong-machine']);
    const hist = await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages?machine=m1`);
    expect(hist.body.pins.map((x: { messageId: string }) => x.messageId)).toEqual(['app-msg-1', '1793600000.000100']);
    const list = await signed(e, 'GET', `${p}?machine=m1`);
    expect(list.body.pins[1]).toMatchObject({ preview: 'slack text here' });
  });
});
