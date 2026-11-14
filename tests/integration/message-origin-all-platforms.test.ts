/**
 * message-origin-all-platforms over the real HTTP pipeline, through the production device
 * authenticator (`authMiddleware` + `deviceAuthenticator`):
 * - app history: a recorded agent reply returns the exact `origin` row; an unrecorded reply this
 *   machine wrote reads `false`; one another machine wrote reads `null` (`other-machine`); the
 *   agent's display bits ride every row.
 * - Slack history: an agent row whose send is in the origin ledger carries it; a bot row the
 *   ledger cannot account for is `null`, never `false`.
 * - Telegram history (createRoutes): a device read joins the origin store by message id; a plain
 *   Bearer read is unchanged; `includeOrigin=1` (the pool fan-out) joins too.
 * - Slack reply route (createRoutes): the session's evidence and footer reach the adapter inside
 *   the send scope, and an unwritable origin record answers 503 notSent.
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
import { MobilePairingService, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobilePairingRouter } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { buildMobileSlackBridge, createMobileSlackRouter, type SlackAdapterLike } from '../../src/server/mobileSlackRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SlackOriginLedger, SlackOriginRecordingError } from '../../src/messaging/slack/SlackOriginLedger.js';
import { originEvidenceFromLaunchRecord } from '../../src/messaging/messageOrigin.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const OWNER = 'U0OWNER1';
const ALL_ON = { enabled: true, machine: true, harness: true, model: true };
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/message-origin-all-platforms.test.ts' });
});

const launch = (machineId = 'm1') => originEvidenceFromLaunchRecord({ machineId, machineName: 'Mac Studio', sessionId: 's', framework: 'claude-code', model: 'claude-opus-5-5', at: 1 });

type MountCtx = { pairing: MobilePairingService; dir: string; svc: AppConversationService; registry: ConversationRegistry; config: Record<string, unknown> };
async function pairedApp(mount: (app: express.Express, ctx: MountCtx) => void, mountAfterPairing?: (app: express.Express, ctx: MountCtx) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morigin-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, slackOwnerUserId: OWNER }, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger: pairing.keyLedger, dispatch: () => null,
  });
  cleanups.push(() => svc.stop());
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  mount(app, { pairing, dir, svc, registry, config });
  app.use(createMobilePairingRouter(pairing, deps, { config } as never));
  // A full createRoutes app answers every path it does not know; it goes after the pairing router.
  mountAfterPairing?.(app, { pairing, dir, svc, registry, config });
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  let tick = 0;
  const signed = (method: 'GET' | 'POST', p: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(Date.now() + (tick++ % 1000));
    const sig = dev.sign(canonicalString(c.device.id, HOST, method, p, time, raw));
    const base = method === 'GET' ? request(app).get(p) : request(app).post(p);
    const q = base.set('X-Instar-Device', c.device.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
  };
  expect((await signed('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  return { app, dir, svc, registry, signed };
}

describe('app conversation history carries origin on agent rows', () => {
  it('recorded, not recorded by this machine, and written by another machine', async () => {
    let display = { ...ALL_ON };
    const env = await pairedApp((app, x) => {
      app.use(createMobileConversationRouter({ config: x.config as never, pairing: x.pairing, service: x.svc, machineId: () => 'm1', originDisplay: () => display }));
    });
    const created = await env.signed('POST', '/mobile/conversations', { title: 'Plans', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    const key = created.body.conversationKey as string;
    const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
    env.svc.store.append({ eventId: 'ev-1', kind: 'message', conversationKey: key, messageId: 'am-1', role: 'agent', text: 'recorded', at: at(1), machineId: 'm1', agentOrigin: launch() } as never);
    env.svc.store.append({ eventId: 'ev-2', kind: 'message', conversationKey: key, messageId: 'am-2', role: 'agent', text: 'before this change', at: at(2), machineId: 'm1' } as never);
    env.svc.store.append({ eventId: 'ev-3', kind: 'message', conversationKey: key, messageId: 'am-3', role: 'agent', text: 'other machine', at: at(3), machineId: 'm2' } as never);
    const hist = await env.signed('GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.status).toBe(200);
    const rows = hist.body.messages as Array<{ text: string; origin?: unknown }>;
    expect(rows.find((r) => r.text === 'recorded')!.origin).toEqual({
      recorded: true,
      machine: { value: 'Mac Studio', status: 'observed' },
      harness: { value: 'Claude Code', id: 'claude-code', status: 'configured' },
      model: { value: 'claude-opus-5-5', status: 'configured' },
      display: ALL_ON,
    });
    expect(rows.find((r) => r.text === 'before this change')!.origin).toMatchObject({ recorded: false, reason: 'not-recorded' });
    expect(rows.find((r) => r.text === 'other machine')!.origin).toMatchObject({ recorded: null, reason: 'other-machine' });
    // The agent's display setting rides the rows; recording is unchanged.
    display = { ...ALL_ON, model: false };
    const again = await env.signed('GET', `/mobile/chat/app/${key}/messages`);
    expect((again.body.messages as Array<{ text: string; origin: { display: unknown; recorded: unknown } }>).find((r) => r.text === 'recorded')!.origin)
      .toMatchObject({ recorded: true, display: { ...ALL_ON, model: false } });
  });
});

describe('Slack history carries origin on agent rows', () => {
  it('a ledger-recorded send is found; an unaccounted bot row is null, never false', async () => {
    let ledger!: SlackOriginLedger;
    let channelId = 0;
    let logPath = '';
    const env = await pairedApp((app, x) => {
      ledger = new SlackOriginLedger({ file: path.join(x.dir, 'state', 'slack-origins.jsonl'), machine: () => ({ id: 'm1', name: 'Mac Studio' }) });
      logPath = path.join(x.dir, 'slack-messages.jsonl');
      channelId = x.registry.mintForInbound('C0123ABC').id!;
      const adapter: SlackAdapterLike = {
        getChannelMessages: () => [], getBotUserId: () => 'UBOT', getLogPath: () => logPath,
        logMessage: (e) => fs.appendFileSync(logPath, `${JSON.stringify({ ...e, timestamp: new Date().toISOString(), platform: 'slack' })}\n`),
        sendToChannel: async () => '1.0', getSessionForChannel: () => null, isAuthorized: (u) => u === OWNER,
        originLedger: ledger,
      };
      const bridge = buildMobileSlackBridge({ adapter, registry: x.registry, dispatch: () => null, killAllSessions: () => false, sendEscape: () => undefined, holdsLease: () => true });
      app.use(createMobileSlackRouter({ config: x.config as never, pairing: x.pairing, service: x.svc, slack: () => bridge, machineId: () => 'm1', originDisplay: () => ALL_ON }));
    });
    const tsRecorded = (Date.now() / 1000).toFixed(6);
    const intent = SlackOriginLedger.runInScope({ evidence: launch(), channel: 'C0123ABC', threadTs: null }, () => ledger.beginIntent('chat.postMessage', 'C0123ABC', null));
    ledger.completeReceipt(intent, tsRecorded);
    fs.appendFileSync(logPath, `${JSON.stringify({ messageId: tsRecorded, channelId: 'C0123ABC', text: 'Reply from the agent', fromUser: false, timestamp: new Date().toISOString(), platform: 'slack' })}\n`);
    const tsOld = '1000000.000100';
    fs.appendFileSync(logPath, `${JSON.stringify({ messageId: tsOld, channelId: 'C0123ABC', text: 'An old bot line', fromUser: false, timestamp: new Date(1_000_000_000).toISOString(), platform: 'slack' })}\n`);
    const hist = await env.signed('GET', `/mobile/chat/slack/${channelId}/messages?machine=m1`);
    expect(hist.status).toBe(200);
    const rows = hist.body.messages as Array<{ text: string; role: string; origin?: { recorded: unknown; reason?: string; harness?: unknown } }>;
    expect(rows.find((r) => r.text === 'Reply from the agent')!.origin).toMatchObject({ recorded: true, harness: { value: 'Claude Code', status: 'configured' } });
    expect(rows.find((r) => r.text === 'An old bot line')!.origin).toMatchObject({ recorded: null, reason: 'not-retained' });
  });
});

function routesApp(over: Partial<Record<string, unknown>>, nestedBehindAuth = false) {
  const telegram = {
    getTopicHistory: () => [
      { topicId: 12, messageId: 501, text: 'agent reply', timestamp: '2026-11-03T10:00:00.000Z', fromUser: false },
      { topicId: 12, messageId: 502, text: 'agent reply on another machine', timestamp: '2026-11-03T10:01:00.000Z', fromUser: false },
      { topicId: 12, messageId: 503, text: 'user line', timestamp: '2026-11-03T10:02:00.000Z', fromUser: true },
    ],
    getTopicHistoryBefore: () => [],
  };
  const observed = (value: string) => ({ value, status: 'observed', sourceEventRef: 'x', observedAt: 1, reason: null });
  const lookups: unknown[] = [];
  const telegramOrigin = {
    attachSendPolicy: () => undefined,
    options: { bot: { chatId: '-100123' }, identity: { originMachineId: 'm1', originMachineName: 'Mac Studio' } },
    store: { lookupOriginEvidence: async (input: unknown) => { lookups.push(input); return { results: [{ messageId: '501', state: 'found', producer: {
      producerKind: 'session', originMachineId: 'm1', originMachineName: 'Mac Studio', harnessName: 'Codex',
      machine: observed('Mac Studio'), harness: observed('codex-cli'), model: observed('gpt-6-astra') } }] }; } },
  };
  const ctx = {
    config: { projectName: 'echo', projectDir: '/tmp', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'morigin-r-')), port: 0, authToken: 'tok-1', sessions: {}, scheduler: {}, messaging: [{ type: 'telegram', enabled: true, config: { chatId: '-100123' } }] },
    startTime: new Date(), scheduler: null,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], listSessions: () => [] },
    telegram, telegramOrigin, ...over,
  } as unknown as RouteContext;
  dirs.push((ctx.config as { stateDir: string }).stateDir);
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  // Nested behind the paired app's authenticator, a second one would refuse the same signed request as a replay.
  if (!nestedBehindAuth) a.use(authMiddleware(() => 'tok-1', 'echo'));
  a.use(createRoutes(ctx));
  return { a, lookups };
}

describe('Telegram history joins the origin store', () => {
  it('a device read gets origin on agent rows; a plain Bearer read is unchanged; includeOrigin=1 joins', async () => {
    let routes!: ReturnType<typeof routesApp>;
    const env = await pairedApp(() => undefined, (app, x) => {
      void x; routes = routesApp({}, true);
      app.use(routes.a);
    });
    const dev = await env.signed('GET', '/telegram/topics/12/messages');
    expect(dev.status).toBe(200);
    const rows = dev.body.messages as Array<{ text: string; origin?: { recorded: unknown; reason?: string; harness?: unknown } }>;
    expect(rows.find((r) => r.text === 'agent reply')!.origin).toMatchObject({ recorded: true, harness: { value: 'Codex', id: 'codex-cli', status: 'observed' } });
    expect(rows.find((r) => r.text === 'agent reply on another machine')!.origin).toMatchObject({ recorded: null, reason: 'not-found' });
    expect(rows.find((r) => r.text === 'user line')!.origin).toBeUndefined();
    expect(routes.lookups[0]).toEqual({ transport: 'bot-api', chatId: '-100123', messageIds: ['501', '502'] });

    const plain = await request(env.app).get('/telegram/topics/12/messages').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
    expect((plain.body.messages as Array<{ origin?: unknown }>).every((r) => r.origin === undefined)).toBe(true);
    const asked = await request(env.app).get('/telegram/topics/12/messages?includeOrigin=1').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
    expect((asked.body.messages as Array<{ text: string; origin?: { recorded: unknown } }>).find((r) => r.text === 'agent reply')!.origin).toMatchObject({ recorded: true });
  });
});

describe('the Slack reply route records origin in the send path', () => {
  it('passes the footer and runs the send inside the origin scope; an unwritable record answers 503 notSent', async () => {
    const seen: Array<{ text: string; footer?: string }> = [];
    let fail = false;
    const slack = {
      sendToChannel: async (_ch: string, text: string, o?: { originFooter?: string }) => {
        if (fail) throw new SlackOriginRecordingError('EACCES');
        seen.push({ text, footer: o?.originFooter });
        return '1793615401.000001';
      },
      logMessage: () => undefined, resolveRoutingKey: (c: string) => c, getSessionForChannel: () => null,
    };
    const { a } = routesApp({ slack, telegram: null, telegramOrigin: null });
    const ok = await request(a).post('/slack/reply/C0123ABC').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo').send({ text: 'Here is the plan for Saturday.' });
    expect(ok.status).toBe(200);
    expect(seen[0].text).toBe('Here is the plan for Saturday.');
    // No bind token, no credential and (in this fixture) no machine identity: every field is
    // unknown, so the footer names only the agent and never prints the word "unknown"
    // (operator report 2026-11-12). It used to read "_echo · unknown machine · unknown harness · unknown model_".
    expect(seen[0].footer).toBe('_echo_');
    fail = true;
    const refused = await request(a).post('/slack/reply/C0123ABC').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo').send({ text: 'A second message for Saturday.' });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: 'origin-recording-unavailable', notSent: true });
  });
});
