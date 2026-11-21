/**
 * held-and-startup-parked-send-release — Tier 2: a real runtime and origin-store worker behind the
 * real HTTP routes. A reply parked while the server was starting is sent once recovery runs; a
 * stale one is retired and handed back; a direct lease hold past the bound is retired at the send
 * site; the retire route answers by id with an audit row.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { mountTelegramOriginRoutes } from '../../src/server/telegramOriginRoutes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { HOLD_REASON_LEASE_NOT_HELD } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import type { TelegramOriginRecord } from '../../src/messaging/telegram-origin/types.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';

const MIN = 60_000;
const BEACON = (s: number) => JSON.stringify({ error: 'starting', status: 'starting', message: `The server is starting. Retry after ${s} s.`, retryAfterSeconds: s,
  bootReadiness: { state: 'starting', startedAt: new Date().toISOString(), elapsedMs: 40_000, readyAt: null, earlyListen: { at: new Date().toISOString(), host: '0.0.0.0' },
    phase: 'messaging', subsystems: { config: 'ready', 'instance-lock': 'ready', 'multi-machine': 'ready', scheduler: 'ready', messaging: 'pending', sessions: 'not-started', http: 'not-started' },
    lastBootMs: 60_000, retryAfterSeconds: s } });
let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const queues: PendingRelayStore[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => {
  for (const q of queues.splice(0)) q.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function harness() {
  const stateDir = temporaryState(), botToken = `123:${randomUUID()}`;
  let live = false;
  const sent: string[] = [];
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 27 + sent.length, chat: { id: -100123 }, message_thread_id: body.message_thread_id, date: Math.floor(Date.now() / 1000) } }));
  });
  vi.stubGlobal('fetch', network);
  const runtime = await TelegramOriginRuntime.open({
    storage: { stateDir, agentId: 'echo', requestTimeoutMs: 5000, stallTimeoutMs: 20_000 }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'author', originMachineName: 'Mac Studio' },
    signingKey: { privateKey, keyId: 'author-1', keyEpoch: 1 }, bot: { token: botToken, accountId: '123', chatId: '-100123' },
    isSessionLive: () => live, display: () => ({}), authorize: () => true, diagnoseUnknown: async () => undefined,
    alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined,
  });
  runtimes.push(runtime);
  runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
  runtime.service.options.reviewLegacyRecovery = async () => true;
  const lines: string[] = [];
  const items: Array<{ topicId: string | null; count: number; operationIds: string[]; uncertain: boolean }> = [];
  const retired: string[] = [];
  runtime.options.injectSessionLine = (_binding, text) => { lines.push(text); return true; };
  runtime.options.raiseRetirementItem = input => { items.push({ topicId: input.topicId, count: input.count, operationIds: input.operationIds, uncertain: input.uncertain }); };
  runtime.options.onRetired = ({ operationId }) => { retired.push(operationId); };
  const queue = PendingRelayStore.open('echo', stateDir); queues.push(queue);
  const svc = runtime.service;
  const seed = svc.runAsAutomation('telegram-server', () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'seed' } }));
  const session = { ...seed.record, producerKind: 'session', producerId: 'session', sessionId: 'session-1', sessionIncarnation: 'incarnation-1',
    harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
  /** A session reply this machine wrote for itself, held durably for `lease-not-held` (direct path). */
  const directHold = async (text: string, ageMs: number) => {
    const realNow = svc.options.now;
    svc.options.now = () => Date.now() - ageMs;
    const op = svc.runAsRecordedProducer(session, () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text } }));
    svc.options.now = realNow;
    await svc.admit(op);
    expect(await runtime.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD })).toBe(true);
    return op;
  };
  const parked = (deliveryId: string, text: string, ageMs: number) => queue.enqueue({ delivery_id: deliveryId, topic_id: 42, text_hash: `h-${deliveryId}`, text,
    http_code: 503, error_body: BEACON(5), attempted_at: new Date(Date.now() - ageMs).toISOString() });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ state: { getSession: () => undefined }, config: { authToken: 'agent-test', stateDir, port: 0, projectName: 'echo',
    messaging: [{ type: 'telegram', enabled: true, config: { token: botToken, chatId: '-100123', lifelineTopicId: 7848 } }] },
    telegramOrigin: runtime, verifyDashboardOperatorSession: (proof: string) => proof === 'operator-test', sessionManager: { clearInjectionTracker: () => undefined },
  } as never));
  return { runtime, svc, network, sent, lines, items, retired, queue, directHold, parked, app, setLive: (v: boolean) => { live = v; } };
}
const auth = { Authorization: 'Bearer agent-test' };

describe('a reply parked while the server was starting', () => {
  it('fresh: one recovery pass sends it exactly once, and a second pass sends nothing more', async () => {
    const h = await harness();
    h.parked(randomUUID(), 'Written during the restart.', 2 * MIN);
    await h.runtime.recoverHeld();
    await h.runtime.recoverHeld();
    expect(h.sent.filter(t => t.includes('Written during the restart.'))).toHaveLength(1);
    expect(h.items).toEqual([]); expect(h.retired).toEqual([]);
  });
  it('the same text already accepted in the topic since it was parked: the replay is suppressed, not sent twice', async () => {
    const h = await harness();
    h.parked(randomUUID(), 'The same answer, resent by hand after the restart note said to retry.', 3 * MIN);
    const byHand = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 90, chat: { id: -100123 }, message_thread_id: 42 } }), { status: 200 }));
    await h.svc.runAsAutomation('telegram-server', () => h.svc.sendBot({ method: 'sendMessage', accountId: '123',
      params: { chat_id: '-100123', message_thread_id: 42, text: 'The same answer, resent by hand after the restart note said to retry.' } }, byHand as never));
    expect(byHand).toHaveBeenCalledOnce();
    expect(h.sent).toHaveLength(0);
    await h.runtime.recoverHeld();
    await h.runtime.recoverHeld();
    expect(h.sent).toHaveLength(0);
  });
  it('stale: never sent; retired with an audit row and, with no author to tell, one hub item for the conversation', async () => {
    const h = await harness();
    const deliveryId = randomUUID();
    h.parked(deliveryId, 'Written before a long outage.', 45 * MIN);
    await h.runtime.recoverHeld();
    expect(h.sent).toEqual([]);
    const operationId = `legacy:${deliveryId}`;
    expect([...new Set(h.retired)]).toEqual([operationId]);
    expect(await h.runtime.store.getRetirement(operationId)).toMatchObject({ reason: 'stale-hold-handed-back', cause: 'parked-at-startup' });
    expect(h.items).toEqual([{ topicId: '42', count: 1, operationIds: [operationId], uncertain: false }]);
    expect((await h.runtime.store.getRetirement(operationId))?.reportOutcome).toBe('attention-item');
    // The outcome route answers for the imported id (legacy: ids are addressable) and says it is safe to resend.
    const outcome = await request(h.app).get(`/telegram/origins/operations/${operationId}/outcome`).set(auth);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ outcome: 'not-delivered', safeToResend: true, reason: 'stale-hold-handed-back' });
    await h.runtime.recoverHeld();
    expect(h.items).toHaveLength(1);
  });
});

describe('a direct reply held because this machine did not hold the lease', () => {
  it('fresh: released and sent once the lease is back', async () => {
    const h = await harness();
    await h.directHold('A fresh held answer.', 3 * MIN);
    await h.runtime.recoverHeld();
    expect(h.sent).toEqual([expect.stringContaining('A fresh held answer.')]);
  });
  it('stale: retired at the send site, never sent; the live author gets one line, not a hub item', async () => {
    const h = await harness(); h.setLive(true);
    const op = await h.directHold('An answer from forty minutes ago.', 40 * MIN);
    await h.runtime.recoverHeld();
    expect(h.sent).toEqual([]);
    expect([...new Set(h.retired)]).toEqual([op.record.operationId]);
    expect(h.lines).toEqual([expect.stringMatching(new RegExp(`^Your reply \`${op.record.operationId}\`, written 40 minutes ago, was not sent: it waited longer than 30 minutes \\(this machine was not the one sending to Telegram\\)`))]);
    expect(h.items).toEqual([]);
    await h.runtime.recoverHeld();
    expect(h.lines).toHaveLength(1); expect(h.sent).toEqual([]);
  });
  it('a machine that never regains the lease still hands a stale hold back at the bound, and keeps a fresh one held', async () => {
    const h = await harness(); h.setLive(true);
    h.runtime.options.holdsLease = () => false;
    const stale = await h.directHold('Held on a standby for an hour.', 60 * MIN);
    const fresh = await h.directHold('Held on a standby for a few minutes.', 4 * MIN);
    await h.runtime.recoverHeld();
    expect(h.sent).toEqual([]);
    expect([...new Set(h.retired)]).toEqual([stale.record.operationId]);
    expect((await h.runtime.store.getOperation(fresh.record.operationId))?.operation?.state).toBe('held');
    expect(h.lines).toEqual([expect.stringContaining(`Your reply \`${stale.record.operationId}\``)]);
  });
  it('re-admitted on one pass, aged past the bound before the next: still retired at the send site', async () => {
    const h = await harness();
    const op = await h.directHold('Re-admitted, then stuck.', 10 * MIN);
    expect(await h.runtime.store.readmitLeaseHold({ operationId: op.record.operationId })).toBe(true);
    // Age the reply past the bound without a held reason on the row: only the durable marker remains.
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 25 * MIN);
    try { await h.runtime.recoverHeld(); } finally { vi.restoreAllMocks(); vi.stubGlobal('fetch', h.network); }
    expect(h.sent).toEqual([]);
    expect([...new Set(h.retired)]).toEqual([op.record.operationId]);
  });
});

describe('POST /telegram/origins/operations/:id/retire', () => {
  it('retires a held reply with an audit row naming the actor; refuses a fresh reply, an unknown id, a long note, a repeat', async () => {
    const h = await harness();
    const held = await h.directHold('Hold this one.', 5 * MIN);
    const id = held.record.operationId;
    const ok = await request(h.app).post(`/telegram/origins/operations/${id}/retire`).set(auth).send({ note: 'operator: superseded by a newer message' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ retired: true, operationId: id, actor: 'api-token', outcome: { outcome: 'not-delivered', safeToResend: false, reason: 'retired-by-operator' } });
    expect(await h.runtime.store.getRetirement(id)).toMatchObject({ actor: 'api-token', note: 'operator: superseded by a newer message', priorHoldReason: 'lease-not-held' });
    expect([...new Set(h.retired)]).toEqual([id]);
    const again = await request(h.app).post(`/telegram/origins/operations/${id}/retire`).set(auth).send({});
    expect(again.status).toBe(409); expect(again.body.refusal).toBe('already-retired');
    await h.runtime.recoverHeld();
    expect(h.sent).toEqual([]);
    const fresh = h.svc.runAsAutomation('telegram-server', () => h.svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Fresh.' } }));
    await h.svc.admit(fresh);
    const notHeld = await request(h.app).post(`/telegram/origins/operations/${fresh.record.operationId}/retire`).set(auth).send({});
    expect(notHeld.status).toBe(409); expect(notHeld.body.refusal).toBe('not-held');
    const unknown = await request(h.app).post('/telegram/origins/operations/legacy:00000000-0000-0000-0000-000000000000/retire').set(auth).send({});
    expect(unknown.status).toBe(404);
    const long = await request(h.app).post(`/telegram/origins/operations/${fresh.record.operationId}/retire`).set(auth).send({ note: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    const badId = await request(h.app).post('/telegram/origins/operations/bad%20id/retire').set(auth).send({});
    expect(badId.status).toBe(400);
  });
  it('refuses a device token outright', async () => {
    const h = await harness();
    const held = await h.directHold('Device cannot stop this.', 5 * MIN);
    const device = express(); device.use(express.json());
    device.use((req, _res, next) => { Object.assign(req, { instarPrincipal: { kind: 'device', deviceId: 'phone-1' }, instarDevicePerson: { personKey: 'p', role: 'owner' } }); next(); });
    const router = express.Router();
    mountTelegramOriginRoutes(router, { runtime: () => h.runtime, verifyOperator: () => false, mayReadConversation: () => true });
    device.use(router);
    const refused = await request(device).post(`/telegram/origins/operations/${held.record.operationId}/retire`).send({});
    expect(refused.status).toBe(403);
    expect(await h.runtime.store.getRetirement(held.record.operationId)).toBeNull();
  });
});
