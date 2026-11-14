/**
 * native-conversation-base §3a — Tier 2: the runtime's hand-back carriers and the
 * reply-text route, on a real runtime and origin-store worker behind the HTTP routes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { mountTelegramOriginRoutes } from '../../src/server/telegramOriginRoutes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { HOLD_REASON_LEASE_NOT_HELD } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { HeldForwardDetail } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { OriginPreparedBotOperation } from '../../src/messaging/telegram-origin/TelegramOriginService.js';
import type { TelegramOriginRecord } from '../../src/messaging/telegram-origin/types.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';

const MIN = 60_000, DAY = 24 * 60 * MIN;
const fixtureBotUrl = new URL('/bot123/sendMessage', 'https://api.telegram.org').toString();
let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function harness() {
  const stateDir = temporaryState(), botToken = `123:${randomUUID()}`;
  let live = false;
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 27, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', network);
  const runtime = await TelegramOriginRuntime.open({
    storage: { stateDir, agentId: 'echo', requestTimeoutMs: 5000, stallTimeoutMs: 20_000 }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'author', originMachineName: 'Mac M5' },
    signingKey: { privateKey, keyId: 'author-1', keyEpoch: 1 }, bot: { token: botToken, accountId: 'bot-1', chatId: '-100123' },
    isSessionLive: () => live, display: () => ({}), authorize: () => true, diagnoseUnknown: async () => undefined,
    alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined,
  });
  runtimes.push(runtime);
  runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
  const lines: string[] = [];
  const items: string[] = [];
  runtime.options.injectSessionLine = (_binding, text) => { lines.push(text); return true; };
  runtime.options.raiseHandBackItem = row => { items.push(row.operationId); };
  const svc = runtime.service;
  const seed = svc.runAsAutomation('telegram-server', () => svc.prepareBot({ method: 'sendMessage', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, text: 'seed' } }));
  const session = { ...seed.record, producerKind: 'session', producerId: 'session', sessionId: 'session-1', sessionIncarnation: 'incarnation-1',
    harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
  /** A session reply this machine wrote, forwarded to `holder` and held there for `lease-not-held`. */
  const heldForward = async (detail: Partial<HeldForwardDetail> = {}, ageMs = 2 * MIN): Promise<OriginPreparedBotOperation> => {
    const realNow = svc.options.now;
    svc.options.now = () => Date.now() - ageMs;
    const op = svc.runAsRecordedProducer(session, () => svc.prepareBot({ method: 'sendMessage', accountId: 'bot-1', executionOwnerMachineId: 'holder',
      params: { chat_id: '-100123', message_thread_id: 42, text: 'The authored answer.' } }));
    svc.options.now = realNow;
    await svc.admit(op);
    const full: HeldForwardDetail = { kind: 'forward-to-holder', lastAttempt: 'refused', machineId: 'holder', topicId: 42, chatId: '-100123', text: 'The authored answer.',
      reason: 'x', at: 1, noticeDelivered: false, ladder: { attempts: 3, nextAt: null }, authoredProducerKind: 'session', authoredPreparedAt: op.admission.preparedAt, ...detail };
    expect(await runtime.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: full as unknown as Record<string, unknown> })).toBe(true);
    return op;
  };
  const expire = (op: OriginPreparedBotOperation) => runtime.store.recordOperationState({ operationId: op.record.operationId, state: 'expired', now: op.admission.deadlineAt + 1 });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ state: { getSession: () => undefined }, config: { authToken: 'agent-test', stateDir, port: 0, projectName: 'echo',
    messaging: [{ type: 'telegram', enabled: true, config: { token: botToken, chatId: '-100123', lifelineTopicId: 7848 } }] },
    telegramOrigin: runtime, verifyDashboardOperatorSession: (proof: string) => proof === 'operator-test', sessionManager: { clearInjectionTracker: () => undefined },
  } as never));
  return { runtime, svc, session, lines, items, network, heldForward, expire, app, setLive: (value: boolean) => { live = value; } };
}

describe('the forward-expiry carrier (§3a item 8)', () => {
  it('holder unreachable until the deadline: with no session the row is not marked reported and the line arrives when a session starts; definite, cause deadline', async () => {
    const h = await harness();
    const op = await h.heldForward();
    await h.expire(op);
    await h.runtime.refreshHeldForward({ force: true });
    expect(h.lines).toEqual([]);
    expect(h.items).toEqual([op.record.operationId]);
    expect((await h.runtime.store.listHeldOperations({ holdReason: HOLD_REASON_LEASE_NOT_HELD })).map(r => r.operationId)).toEqual([op.record.operationId]);
    await h.runtime.refreshHeldForward({ force: true });
    expect(h.items).toHaveLength(1); // the hub item is raised once
    h.setLive(true);
    await h.runtime.refreshHeldForward({ force: true });
    expect(h.lines).toEqual([expect.stringMatching(new RegExp(`^Your reply \`${op.record.operationId}\`, written 2 minutes ago, was not delivered \\(it passed its delivery deadline\\) and will not be retried\\. Its text is at`))]);
    expect(await h.runtime.store.listHeldOperations({ holdReason: HOLD_REASON_LEASE_NOT_HELD })).toEqual([]);
    await h.runtime.refreshHeldForward({ force: true });
    expect(h.lines).toHaveLength(1);
    expect(h.network).not.toHaveBeenCalled();
    expect(await h.runtime.heldReplyCounters()).toMatchObject({ definiteNoSession: 1, neverHandedBack: 0 });
  });
  it('the same with lastAttempt outcome-unknown: the uncertain line, never "send it again"', async () => {
    const h = await harness(); h.setLive(true);
    const op = await h.heldForward({ lastAttempt: 'outcome-unknown' });
    await h.expire(op);
    await h.runtime.refreshHeldForward({ force: true });
    expect(h.lines).toEqual([expect.stringContaining('could not be confirmed. It may have arrived. Do not send it again unless the user says it is missing.')]);
    expect(h.lines[0]).not.toMatch(/Send it again if it is still needed/);
  });
  it('an expired forward with no later session is marked reported at the purge horizon and counted neverHandedBack', async () => {
    const h = await harness();
    const op = await h.heldForward({}, 8 * DAY);
    await h.expire(op);
    await h.runtime.refreshHeldForward({ force: true });
    expect(h.lines).toEqual([]);
    expect(await h.runtime.store.listHeldOperations({ holdReason: HOLD_REASON_LEASE_NOT_HELD })).toEqual([]);
    expect(await h.runtime.heldReplyCounters()).toMatchObject({ neverHandedBack: 1 });
    expect(h.items).toEqual([op.record.operationId]);
  });
});

describe('the owner verdict (§3a item 7)', () => {
  it('one definite line with the owner\'s cause in the same pass, one hub item, and the expiry pass adds nothing', async () => {
    const h = await harness(); h.setLive(true);
    const op = await h.heldForward();
    expect(await h.runtime.store.mergeHoldDetail({ operationId: op.record.operationId, patch: { ownerVerdict: { outcome: 'not-delivered', failure: 'never-left', at: Date.now(), machineId: 'holder' } } })).toBe(true);
    const [row] = await h.runtime.store.listHeldOperations({ holdReason: HOLD_REASON_LEASE_NOT_HELD });
    await h.runtime.handOwnerVerdict(row, { failure: 'never-left' });
    await h.runtime.handOwnerVerdict(row, { failure: 'never-left' });
    expect(h.lines).toEqual([expect.stringContaining('was not delivered (it could not be sent before its attempts ran out) and will not be retried')]);
    expect(h.items).toEqual([op.record.operationId]);
    // Ended, not held: out of the health summary and the due ladder.
    await h.runtime.refreshHeldForward({ force: true });
    expect(h.runtime.heldForwardHealth().count).toBe(0);
    await h.expire(op);
    await h.runtime.refreshHeldForward({ force: true });
    expect(h.lines).toHaveLength(1); expect(h.items).toHaveLength(1);
  });
  it('a settled reasonless ending gets its own line once and one per-topic record-only item with a count', async () => {
    const h = await harness(); h.setLive(true);
    const synced: Array<Map<string, number>> = [];
    h.runtime.options.syncUnresolvedTopics = counts => { synced.push(new Map(counts)); };
    const op = await h.heldForward();
    expect(await h.runtime.store.mergeHoldDetail({ operationId: op.record.operationId, patch: { ownerUnstated: { at: Date.now(), attempts: 2, settled: true, machineId: 'holder' } } })).toBe(true);
    const [row] = await h.runtime.store.listHeldOperations({ holdReason: HOLD_REASON_LEASE_NOT_HELD });
    await h.runtime.handOwnerUnstated(row);
    expect(h.lines).toEqual([`Reply \`${op.record.operationId}\` was ended by the machine that sends to Telegram, which runs an older version and gave no reason. The user may already have this text. Check the conversation before repeating it.`]);
    expect(synced.at(-1)).toEqual(new Map([['42', 1]]));
    expect(await h.runtime.heldReplyCounters()).toMatchObject({ ownerUnstated: 1 });
  });
});

describe('the reply-text route (§3a item 6)', () => {
  it('answers the authored text of a reply this machine wrote, to the API token only', async () => {
    const h = await harness();
    const op = await h.heldForward();
    const ok = await request(h.app).get(`/telegram/origins/operations/${op.record.operationId}/text`).set('Authorization', 'Bearer agent-test');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ operationId: op.record.operationId, source: 'hold-detail', text: 'The authored answer.' });
    expect((await request(h.app).get('/telegram/origins/operations/no-such-operation/text').set('Authorization', 'Bearer agent-test')).status).toBe(404);
    expect((await request(h.app).get('/telegram/origins/operations/bad/text').set('Authorization', 'Bearer agent-test')).status).toBe(400);
    // A row whose detail was cleared still answers from the sealed policy input.
    expect(await h.runtime.store.recordForwardedOutcomeUnknown({ operationId: op.record.operationId, deliveryMachineId: 'holder' })).toBe(true);
    const sealed = await request(h.app).get(`/telegram/origins/operations/${op.record.operationId}/text`).set('Authorization', 'Bearer agent-test');
    expect(sealed.body).toMatchObject({ source: 'sealed-policy-input', text: 'The authored answer.' });
  });
  it('refuses a device token outright, and a caller not authorized for the conversation gets unknown-operation', async () => {
    const h = await harness();
    const op = await h.heldForward();
    const device = express(); device.use(express.json());
    device.use((req, _res, next) => { Object.assign(req, { instarPrincipal: { kind: 'device', deviceId: 'phone-1' }, instarDevicePerson: { personKey: 'p', role: 'owner' } }); next(); });
    const router = express.Router();
    mountTelegramOriginRoutes(router, { runtime: () => h.runtime, verifyOperator: () => false, mayReadConversation: () => true });
    device.use(router);
    const refused = await request(device).get(`/telegram/origins/operations/${op.record.operationId}/text`);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain('The authored answer.');
    const outsider = express(); outsider.use(express.json());
    const closed = express.Router();
    mountTelegramOriginRoutes(closed, { runtime: () => h.runtime, verifyOperator: () => false, mayReadConversation: (_req, ref) => ref !== 'telegram:42' });
    outsider.use(closed);
    const hidden = await request(outsider).get(`/telegram/origins/operations/${op.record.operationId}/text`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: 'unknown-operation', operationId: op.record.operationId });
  });
  it('an operation written by another machine reads as unknown here', async () => {
    const h = await harness();
    const automation = h.svc.runAsAutomation('telegram-server', () => h.svc.prepareBot({ method: 'sendMessage', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, text: 'Automation.' } }));
    await h.svc.admit(automation);
    expect((await request(h.app).get(`/telegram/origins/operations/${automation.record.operationId}/text`).set('Authorization', 'Bearer agent-test')).status).toBe(404);
  });
});

describe('the scan carrier for this machine\'s own sends (§3a item 8)', () => {
  it('Telegram refused it: one definite line naming the cause; the topic notice stays the scan\'s', async () => {
    const h = await harness(); h.setLive(true);
    const held = vi.fn(async () => undefined);
    h.runtime.options.onSessionDeliveryHeld = held;
    h.network.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }), { status: 400 }));
    // The stubbed network answers every request; the URL is the fixture bot's send method.
    const transport = (async (req: { body: string }) => fetch(fixtureBotUrl, { method: 'POST', body: req.body })) as never;
    await expect(h.svc.runAsRecordedProducer(h.session, () => h.svc.sendBot({ method: 'sendMessage', accountId: 'bot-1',
      params: { chat_id: '-100123', message_thread_id: 42, text: 'Refused text.' } }, transport))).rejects.toMatchObject({ outcome: 'known-failed' });
    const failed = (await h.runtime.store.listOrigins()).records.find(r => r.operation?.state === 'known-failed');
    const op = { record: { operationId: failed!.operation!.operationId } };
    await (h.runtime as unknown as { reportSessionDeliveryExceptions: () => Promise<void> }).reportSessionDeliveryExceptions();
    expect(held).toHaveBeenCalledWith(expect.objectContaining({ operationId: op.record.operationId, source: 'scan' }));
    expect(h.lines).toEqual([expect.stringContaining(`Your reply \`${op.record.operationId}\``)]);
    expect(h.lines[0]).toContain('was not delivered (Telegram refused it) and will not be retried');
  });
});
