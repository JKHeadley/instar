import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { NotificationBatcher } from '../../src/messaging/NotificationBatcher.js';
import { wireTelegramSendSide } from '../../src/messaging/telegramSendSideComposition.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { OriginAuthorCall, deterministicAutomationAuthor } from '../../src/messaging/telegram-origin/OriginAutomationAuthor.js';
import { createA2ACheckInScheduler } from '../../src/threadline/A2ACheckInScheduler.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import { OriginBrowserExecutor } from '../../src/messaging/telegram-origin/OriginBrowserExecutor.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { signMessage } from '../../src/core/agentSignatureProvenance.js';
import { originToolGuardDigest } from '../../src/messaging/telegram-origin/OriginToolGuard.js';
import { listenOriginNotices, originCapacityClient } from '../../src/messaging/telegram-origin/OriginNoticeIpc.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.unstubAllGlobals(); });
async function appHarness(extra: Record<string, unknown> = {}, configExtra: Record<string, unknown> = {}) {
  const stateDir = temporaryState(), botToken = `123:${randomUUID()}`;
  let lifecycle: OriginSessionLifecycle | undefined;
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 27, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', network);
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 }, bot: { token: botToken, accountId: 'bot-1', chatId: '-100123' },
    isSessionLive: () => true, attachSessionLifecycle: l => { lifecycle = l; }, display: () => ({}),
    authorize: () => true, diagnoseUnknown: async () => undefined, alertDestinations: () => [],
    getAlertPolicy: () => null, onNoticeState: () => undefined,
  });
  runtimes.push(runtime);
  const sessionToken = await lifecycle!.issue({ sessionId: 'source-session', harnessId: 'codex-cli',
    projectDir: process.cwd(), configuredModel: 'gpt-6-astra' });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ config: { authToken: 'agent-test', stateDir, port: 0, projectName: 'echo',
    messaging: [{ type: 'telegram', enabled: true, config: { token: botToken, chatId: '-100123', lifelineTopicId: 7848 } }], ...configExtra },
    telegramOrigin: runtime, verifyDashboardOperatorSession: (proof: string) => proof === 'operator-test',
    telegram: { sendToTopic: async (topicId: number, text: string) => {
      const response = await telegramFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: topicId, text }),
      });
      const json = await response.json() as { result: { message_id: number } };
      return { messageId: json.result.message_id, timestamp: new Date().toISOString() };
    } }, sessionManager: { clearInjectionTracker: () => undefined }, ...extra,
  } as never));
  return { app, runtime, sessionToken, network, stateDir, botToken };
}
async function browserHarness(extra: Record<string, unknown> = {}) {
  const h = await appHarness(extra), asp = generateIdentityKeyPair();
  const invoke = vi.fn(async () => ({ _: 'updateShortSentMessage', id: 83 }));
  const executor = new OriginBrowserExecutor({ service: h.runtime.service, store: () => h.runtime.store,
    accountId: '7812716706', transport: 'telegram-web', authorize: () => true,
    signBody: (body, topicId, timestamp) => signMessage({ agentId: 'echo', body, topicId, timestamp, privateKey: asp.privateKey }).text,
    driverFactory: async () => ({ canary: async () => ({ transport: 'web-k', accountId: '7812716706', buildId: 'fixture', supported: true }),
      readSnapshot: async () => ({ text: 'fixture', accountId: '7812716706' }), invoke, close: async () => undefined }),
    resolveAgentPublicKey: () => asp.publicKey, clockSkewMs: () => 0, isProfileExclusivelyOwned: () => true });
  h.runtime.browsers.set('operator', { executor, resolvePeer: async () => ({ _: 'inputPeerChannel', channel_id: '123', access_hash: '456' }) });
  const send = (text: string, metadata?: Record<string, unknown>) => request(h.app).post('/telegram/browser/operator/send')
    .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
    .send({ text, destination: { kind: 'channel', id: '123', topicId: 42 }, ...(metadata ? { metadata } : {}) });
  return { ...h, invoke, executor, send };
}
describe('Telegram origin through the complete reply HTTP pipeline', () => {
  it('starts the real adapter network deadline after the HTTP policy and origin claim', async () => {
    let adapter: TelegramAdapter;
    const h = await appHarness({ telegram: { sendToTopic: (...args: Parameters<TelegramAdapter['sendToTopic']>) => adapter.sendToTopic(...args) } });
    adapter = new TelegramAdapter({ token: h.botToken, chatId: '-100123' }, h.stateDir, { suppressLifelineAutoCreate: true });
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const claim = h.runtime.store.claim.bind(h.runtime.store);
    vi.spyOn(h.runtime.store, 'claim').mockImplementation(async input => {
      expect(timeout).not.toHaveBeenCalled();
      return claim(input);
    });
    try {
      const response = await request(h.app).post('/telegram/reply/42')
        .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
        .send({ text: 'The requested delivery report is ready.' });
      expect(response.status).toBe(200);
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(h.network).toHaveBeenCalledOnce();
      expect(h.network.mock.calls[0][1].signal).toBe(deadline.signal);
      expect((await h.runtime.store.listOrigins()).records[0].children[0].state).toBe('accepted');
    } finally { timeout.mockRestore(); await adapter.stop(); }
  });

  it('paces repeated recovery reviews and exposes the durable delay through authenticated audit HTTP', async () => {
    const review = vi.fn(async (_text: string) => ({ pass: true, latencyMs: 1 }));
    const h = await appHarness({ messagingToneGate: { review } });
    h.runtime.service.options.authorize = () => false;
    const sent = await request(h.app).post('/telegram/reply/42')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
      .send({ text: 'The client report is ready for your review.' });
    expect(sent.status).toBe(409); expect(review).toHaveBeenCalledOnce();
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 1, recovered: 0 });
    expect(review).toHaveBeenCalledTimes(2);
    for (let n = 0; n < 12; n++) expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(review).toHaveBeenCalledTimes(2); expect(h.network).not.toHaveBeenCalled();
    const audit = await request(h.app).get('/telegram/origins').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-AgentId', 'echo').set('X-Instar-Operator-Session', 'operator-test');
    expect(audit.status).toBe(200);
    expect(audit.body.records[0].recovery).toMatchObject({ attempts: 1 });
    expect(audit.body.records[0].recovery.nextAttemptAt).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(audit.body.records[0].attempts).toEqual([]);
    // Advance only the real worker scheduler's explicit test clock. Network,
    // policy, original custody and request bytes continue through production.
    let due = audit.body.records[0].recovery.nextAttemptAt;
    const take = h.runtime.store.takeRecoverableAdmissions.bind(h.runtime.store);
    const reserve = h.runtime.store.reserveRecoveryAttempt.bind(h.runtime.store);
    vi.spyOn(h.runtime.store, 'takeRecoverableAdmissions').mockImplementation(input => take({ ...input, now: due }));
    vi.spyOn(h.runtime.store, 'reserveRecoveryAttempt').mockImplementation(input => reserve({ ...input, now: due }));
    h.runtime.service.options.authorize = () => true;
    review.mockImplementation(async () => ({ pass: false, advisory: true, rule: 'B21_USER_TASK_SUBSTITUTION',
      issue: 'Current policy requires a revised response', suggestion: 'Revise', decisionRef: 'current-review', latencyMs: 1 }));
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 1, recovered: 0 });
    expect(review).toHaveBeenCalledTimes(3); expect(h.network).not.toHaveBeenCalled();
    due += 15 * 60_000;
    review.mockImplementation(async () => ({ pass: true, latencyMs: 1 }));
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 1, recovered: 1 });
    expect(review).toHaveBeenCalledTimes(4); expect(h.network).toHaveBeenCalledOnce();
    const delivered = await h.runtime.store.getOperation(audit.body.records[0].operation.operationId);
    expect(delivered?.operation?.state).toBe('accepted');
    expect(delivered?.record.envelopeJson).toBe(audit.body.records[0].record.envelopeJson);
  });

  it('records the fixed AutoUpdater notice through the authenticated apply route without accepting caller author claims', async () => {
    let updater: AutoUpdater;
    const proxy = { applyPendingUpdate: (options: never) => updater.applyPendingUpdate(options), getStatus: () => updater.getStatus() };
    const h = await appHarness({ autoUpdater: proxy });
    const adapter = { sendToTopic: async (topicId: number, text: string) => {
      const response = await telegramFetch(`https://api.telegram.org/bot${h.botToken}/sendMessage`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: topicId, text }) });
      return { messageId: ((await response.json()) as any).result.message_id };
    } };
    const batcher = new NotificationBatcher();
    wireTelegramSendSide({ mode: 'send-only', telegram: adapter as never, notificationBatcher: batcher, originService: h.runtime.service }); batcher.stop();
    updater = new AutoUpdater({ applyUpdate: async () => ({ success: false, previousVersion: '1.0.0', message: 'private provider failure' }) } as never,
      { get: () => 42 } as never, h.stateDir, { notificationTopicId: 42 }, adapter as never);
    (updater as any).pendingUpdate = '1.0.1';
    expect((await request(h.app).post('/updates/apply').send({})).status).toBe(401);
    const response = await request(h.app).post('/updates/apply').set('Authorization', 'Bearer agent-test')
      .send({ metadata: { producerId: 'pretend-author', originAuthor: { model: { value: 'pretend-model' } } } });
    expect(response.status).toBe(200); expect(h.network).toHaveBeenCalledOnce();
    const row = (await h.runtime.store.listOrigins()).records[0];
    expect(JSON.parse(row.record.envelopeJson)).toMatchObject({ producerId: 'auto-updater', producerKind: 'server-automation',
      model: { status: 'not-applicable', value: null }, harness: { status: 'not-applicable', value: null } });
    expect(row.operation?.state).toBe('accepted');
  });

  it('holds changed reminder text for the same durable event after unknown acceptance', async () => {
    const stateDir = temporaryState(), tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const commitment = tracker.record({ type: 'one-time-action', userRequest: 'report back on the benchmark refresh',
      agentResponse: 'I will report the benchmark results.', topicId: 42, verificationMethod: 'manual' });
    await tracker.mutate(commitment.id, current => ({ ...current, checkInAt: new Date(Date.now() - 60_000).toISOString() }));
    const h = await appHarness({ commitmentTracker: tracker }, { commitments: { checkInReminder: { enabled: true, dryRun: false } } });
    h.network.mockRejectedValue(new Error('fixture connection lost after possible acceptance'));
    const pass = () => request(h.app).post('/commitments/check-in-reminder/pass').set('Authorization', 'Bearer agent-test').send({});
    expect((await pass()).body.failed).toBe(1);
    const original = (await h.runtime.store.listOrigins()).records;
    expect(original).toHaveLength(1); expect(original[0].children[0].state).toBe('outcome-unknown');
    await tracker.mutate(commitment.id, current => ({ ...current, userRequest: 'report back on the updated benchmark refresh' }));
    const changed = await pass();
    expect(changed.status).toBe(200); expect(changed.body.failed).toBe(1); expect(changed.body.sent).toBe(0);
    expect(changed.body.errors[0].error).toContain('logical-send-content-conflict');
    expect(tracker.get(commitment.id)?.checkInReminderSentAt).toBeUndefined();
    expect(h.network).toHaveBeenCalledOnce();
    const after = (await h.runtime.store.listOrigins()).records;
    expect(after).toHaveLength(1); expect(after[0].record.originId).toBe(original[0].record.originId);
  });
  it.each(['accepted', 'unknown'] as const)('replays a reminder with %s original acceptance without inventing a successful stamp', async outcome => {
    const stateDir = temporaryState(), tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const commitment = tracker.record({ type: 'one-time-action', userRequest: 'report back on the benchmark refresh',
      agentResponse: 'I will report the benchmark results.', topicId: 42, verificationMethod: 'manual' });
    await tracker.mutate(commitment.id, current => ({ ...current, checkInAt: new Date(Date.now() - 60_000).toISOString() }));
    const h = await appHarness({ commitmentTracker: tracker }, { commitments: { checkInReminder: { enabled: true, dryRun: false } } });
    const originalMutate = tracker.mutate.bind(tracker);
    let loseStamp = true;
    vi.spyOn(tracker, 'mutate').mockImplementation((id, mutation) => originalMutate(id, current => {
      const next = mutation(current);
      if (loseStamp && next.checkInReminderSentAt) { loseStamp = false; throw new Error('fixture lost send-before-stamp write'); }
      return next;
    }));
    if (outcome === 'unknown') h.network.mockRejectedValue(new Error('fixture connection lost after possible acceptance'));
    const pass = () => request(h.app).post('/commitments/check-in-reminder/pass').set('Authorization', 'Bearer agent-test').send({});
    const first = await pass(); expect(first.status).toBe(200);
    expect(first.body.sent).toBe(outcome === 'accepted' ? 1 : 0);
    expect(tracker.get(commitment.id)?.checkInReminderSentAt).toBeUndefined();
    expect(h.network).toHaveBeenCalledOnce();
    const original = (await h.runtime.store.listOrigins()).records;
    expect(original).toHaveLength(1);
    expect(original[0].children[0].state).toBe(outcome === 'accepted' ? 'accepted' : 'outcome-unknown');
    const repeated = await pass(); expect(repeated.status).toBe(200);
    expect(repeated.body.sent).toBe(outcome === 'accepted' ? 1 : 0);
    expect(repeated.body.failed).toBe(outcome === 'accepted' ? 0 : 1);
    expect(!!tracker.get(commitment.id)?.checkInReminderSentAt).toBe(outcome === 'accepted');
    expect(h.network).toHaveBeenCalledOnce();
    const after = (await h.runtime.store.listOrigins()).records;
    expect(after).toHaveLength(1); expect(after[0].record.originId).toBe(original[0].record.originId);
    expect(after[0].children[0].state).toBe(original[0].children[0].state);
  });
  it('delivers an ordinary commitment reminder through the origin-owned reservation once', async () => {
    const stateDir = temporaryState(), tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const commitment = tracker.record({ type: 'one-time-action', userRequest: 'report back on the benchmark refresh',
      agentResponse: 'I will report the benchmark results.', topicId: 42, verificationMethod: 'manual' });
    await tracker.mutate(commitment.id, current => ({ ...current, checkInAt: new Date(Date.now() - 60_000).toISOString() }));
    const h = await appHarness({ commitmentTracker: tracker }, { commitments: { checkInReminder: { enabled: true, dryRun: false } } });
    const pass = () => request(h.app).post('/commitments/check-in-reminder/pass').set('Authorization', 'Bearer agent-test').send({});
    const first = await pass();
    expect(first.status).toBe(200); expect(first.body.sent).toBe(1); expect(first.body.failed).toBe(0);
    expect(h.network).toHaveBeenCalledOnce();
    const origins = (await h.runtime.store.listOrigins()).records;
    expect(origins).toHaveLength(1); expect(origins[0].children[0].state).toBe('accepted');
    expect(tracker.get(commitment.id)?.checkInReminderSentAt).toBeTruthy();
    const repeated = await pass();
    expect(repeated.status).toBe(200); expect(repeated.body.sent).toBe(0);
    expect(repeated.body.skippedByReason['already-reminded']).toBe(1);
    expect(h.network).toHaveBeenCalledOnce();
    expect((await h.runtime.store.listOrigins()).records).toHaveLength(1);
  });
  it('shares deterministic content suppression between browser and Bot sends and makes suppressed operations terminal', async () => {
    const h = await browserHarness(), text = 'The completed review is ready, including the implementation and its verified test results.';
    const first = await h.send(text); expect(first.status).toBe(200); expect(first.body.receipts).toHaveLength(1);
    const browserDuplicate = await h.send(text);
    expect(browserDuplicate.status).toBe(200); expect(browserDuplicate.body.suppressedDuplicate).toBe(true);
    const botDuplicate = await request(h.app).post('/telegram/reply/42').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Origin-Session', h.sessionToken).send({ text });
    expect(botDuplicate.status).toBe(200); expect(botDuplicate.body.suppressedDuplicate).toBe(true);
    expect(h.invoke).toHaveBeenCalledOnce(); expect(h.network).not.toHaveBeenCalled();
    for (const originId of [browserDuplicate.body.originId, botDuplicate.body.originId]) {
      expect((await h.runtime.store.getOrigin(originId))!.operation?.state).toBe('suppressed');
    }
    expect(await h.runtime.store.recoverableAdmissions()).toEqual([]);
  });
  it('keeps a browser in-flight reservation through ambiguous acceptance and never releases another operation reservation', async () => {
    const h = await browserHarness(), text = 'This detailed update must remain reserved while its actual browser acceptance is uncertain.';
    let started!: () => void, fail!: (error: Error) => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    h.invoke.mockImplementation(() => { started(); return new Promise((_resolve, reject) => { fail = reject; }); });
    const sending = h.send(text).then(response => response);
    await began;
    expect((await h.send(text)).body.suppressedDuplicate).toBe(true);
    fail(new Error('fixture transport disconnected after possible acceptance'));
    expect((await sending).status).toBe(409);
    expect((await h.send(text)).body.suppressedDuplicate).toBe(true);
    expect(h.invoke).toHaveBeenCalledOnce();
    const rows = (await h.runtime.store.listOrigins()).records;
    expect(rows.filter(row => row.operation?.state === 'outcome-unknown')).toHaveLength(1);
    expect(rows.filter(row => row.operation?.state === 'suppressed')).toHaveLength(2);
  });
  it('recovers the original queued browser operation under its own reservation after authority returns', async () => {
    const h = await browserHarness(), text = 'The queued browser update should recover once, retaining its original content reservation throughout.';
    h.executor.options.authorize = () => false;
    expect((await h.send(text)).status).toBe(409);
    expect((await h.send(text)).body.suppressedDuplicate).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
    h.executor.options.authorize = () => true;
    expect((await h.runtime.recoverHeld()).recovered).toBe(1);
    expect(h.invoke).toHaveBeenCalledOnce();
    expect((await h.send(text)).body.suppressedDuplicate).toBe(true);
  });
  it('carries the A2A summarizer call author through the private body-bound HTTP credential', async () => {
    const h = await appHarness(); let now = 0;
    h.runtime.service.registerAutomationProducer('a2a-checkin');
    const scheduler = createA2ACheckInScheduler({ listActiveThreads: () => [{ threadId: 'thread-author', peerName: 'Dawn', topicId: 42 }],
      summarize: async (_prompt, call) => { call.options({ model: 'fast' }).onModel!({ model: 'actual-checkin-model', framework: 'codex-cli' }); return 'Dawn says the review is progressing.'; },
      surface: async ({ topicId, body, originAuthor }) => {
        const payload = { text: body };
        const token = h.runtime.service.issueAutomationReply('a2a-checkin', topicId!, payload, originAuthor);
        const reply = await request(h.app).post(`/telegram/reply/${topicId}`).set('Authorization', 'Bearer agent-test')
          .set('X-Instar-Origin-Automation', token).send(payload);
        expect(reply.status).toBe(200);
      }, getHistory: () => 'Dawn: reviewing the patch', now: () => now,
      config: { enabled: true, heartbeatEnabled: true, heartbeatIntervalMs: 1 },
    });
    await scheduler.tick(); now = 2; await scheduler.tick();
    const rows = await h.runtime.store.listOrigins(); expect(rows.records).toHaveLength(1);
    expect(JSON.parse(rows.records[0].record.envelopeJson)).toMatchObject({ producerId: 'a2a-checkin',
      model: { value: 'actual-checkin-model', status: 'configured' }, harness: { value: 'codex-cli', status: 'configured' } });
  });
  it('authenticates native-hook challenges without granting audit scope or synthesizing listener proof', async () => {
    const h = await appHarness();
    h.runtime.observer.bindNative('source-session', 'native-hook-fixture');
    const endpoint = '/telegram/origins/native-hook/challenge';
    const body = { nativeSessionId: 'native-hook-fixture', guardDigest: originToolGuardDigest() };
    expect((await request(h.app).post(endpoint).send(body)).status).toBe(401);
    expect((await request(h.app).post(endpoint).set('Authorization', 'Bearer agent-test').send(body)).status).toBe(403);
    const response = await request(h.app).post(endpoint).set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Origin-Session', h.sessionToken).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ nativeSessionId: 'native-hook-fixture', guardDigest: originToolGuardDigest(),
      sessionIncarnation: h.runtime.sessions.getBinding('source-session')!.sessionIncarnation });
    expect(h.runtime.observer.getNativeHookProof('source-session')).toBeUndefined();
    expect((await request(h.app).get('/telegram/origins').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Origin-Session', h.sessionToken)).status).toBe(403);
    expect(h.network).not.toHaveBeenCalled();
  });
  it('charges a capacity refusal after dispatch, then recovers the same operation within its original bounds', async () => {
    const h = await appHarness();
    const socketPath = path.join(h.runtime.options.storage.stateDir, 'test-capacity.sock');
    const close = await listenOriginNotices(socketPath, h.runtime.notifier, () => [], h.runtime.capacity);
    h.runtime.service.options.capacity = originCapacityClient(socketPath);
    try {
    for (let i = 0; i < 10; i++) expect(await h.runtime.capacity.reserve('bot-1')).not.toBeNull();
    const response = await request(h.app).post('/telegram/reply/42').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Origin-Session', h.sessionToken).send({ text: 'Here is the result you requested.' });
    expect(response.status).toBe(409); expect(h.network).not.toHaveBeenCalled();
    const rows = (await h.runtime.store.listOrigins()).records;
    expect(rows).toHaveLength(1); expect(rows[0].attempts).toHaveLength(1);
    expect(rows[0].attempts[0]).toMatchObject({ phase: 'dispatched', outcome: 'known-failed', reason: 'credential-capacity-unavailable' });
    expect(rows[0].children[0].state).toBe('queued');
    expect(rows[0].operation?.operationId).toEqual(expect.any(String));
    expect(rows[0].operation?.operationId).not.toBe('');
    expect(rows[0].operation?.maxAttempts).toBe(9);
    expect(rows[0].children[0].attempts).toBe(1);
    const retryAt = rows[0].attempts[0].nextAttemptAt!;
    expect(retryAt).toEqual(expect.any(Number));
    expect(retryAt).toBeGreaterThan(rows[0].attempts[0].resolvedAt!);
    await new Promise(resolve => setTimeout(resolve, 1251));
    // Free capacity does not erase the charged failure's existing retry backoff.
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.network).not.toHaveBeenCalled();
    expect(await h.runtime.store.reserveRecoveryAttempt({ operationId: rows[0].operation!.operationId, now: retryAt - 1 })).toBe(false);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 10));
    expect((await h.runtime.recoverHeld()).recovered).toBe(1); expect(h.network).toHaveBeenCalledOnce();
    const recovered = (await h.runtime.store.listOrigins()).records;
    expect(recovered).toHaveLength(1);
    expect(recovered[0].operation?.operationId).toBe(rows[0].operation!.operationId);
    expect(recovered[0].record.originId).toBe(rows[0].record.originId);
    expect(recovered[0].operation?.deadlineAt).toBe(rows[0].operation!.deadlineAt);
    expect(recovered[0].operation?.maxAttempts).toBe(rows[0].operation!.maxAttempts);
    expect(recovered[0].attempts).toHaveLength(2);
    expect(recovered[0].children[0].attempts).toBe(2);
    expect(recovered[0].attempts[0]).toEqual(rows[0].attempts[0]);
    expect(recovered[0].attempts[1]).toMatchObject({ phase: 'dispatched', outcome: 'accepted' });
    expect(recovered[0].children[0].state).toBe('accepted');
    } finally { await close(); }
  // This exercises the real 30-second retry backoff; test:push defaults to 10 seconds.
  }, 45_000);
  it('reuses an actual local review once and never treats caller proxy flags as a prepared-send exemption', async () => {
    const review = vi.fn(async (_text: string) => ({ pass: true, latencyMs: 1 }));
    const h = await appHarness({ messagingToneGate: { review } });
    const send = (text: string, metadata?: Record<string, unknown>) => request(h.app).post('/telegram/reply/42')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken).send({ text, metadata });
    expect((await send('Here is your requested answer.')).status).toBe(200);
    expect(review).toHaveBeenCalledOnce(); expect(h.network).toHaveBeenCalledOnce();
    const bypass = await send('Open http://localhost:4042/private', { isProxy: true });
    expect(bypass.status).toBe(422); expect(bypass.body.blockedBy).toBe('localhost-link-guard');
    expect(h.network).toHaveBeenCalledOnce();
  });
  it('reapplies current policy to an already admitted browser operation before recovery dispatch', async () => {
    const h = await browserHarness();
    const operation = await h.runtime.service.runWithSessionToken(h.sessionToken, async () => h.executor.prepare({
      text: 'Open http://localhost:4042/private', destination: { kind: 'channel', id: '123', topicId: 42 },
      peer: { _: 'inputPeerChannel', channel_id: '123', access_hash: '456' } }));
    await h.runtime.service.admit(operation);
    await expect(h.executor.execute(operation)).rejects.toMatchObject({ reason: 'localhost-link-guard' });
    expect(h.invoke).not.toHaveBeenCalled();
    expect((await h.runtime.store.getOrigin(operation.record.originId))!.attempts).toEqual([]);
  });
  it('applies the real deterministic content gate to browser sends and refuses caller exemptions', async () => {
    const h = await browserHarness();
    const refused = await h.send('Open http://localhost:4042/private');
    expect(refused.status).toBe(422); expect(refused.body.blockedBy).toBe('localhost-link-guard');
    expect(h.invoke).not.toHaveBeenCalled();
    expect((await h.send('Open http://localhost:4042/private', { allowLocalhostLink: true })).status).toBe(400);
    const accepted = await h.send('Here is the completed update.');
    expect(accepted.status).toBe(200); expect(h.invoke).toHaveBeenCalledOnce();
    const row = await h.runtime.store.getOrigin(accepted.body.originId);
    expect(row!.record.envelopeJson).not.toContain('Here is the completed update.');
    const child = await h.runtime.store.getChild(row!.children[0].childId);
    expect(child!.materializations[0].requestJson).toContain('Here is the completed update.');
  });
  it('returns the existing advisory and accepts only its typed, reasoned reaction on browser sends', async () => {
    const review = vi.fn(async (_text: string) => ({ pass: false, advisory: true, rule: 'B21_USER_TASK_SUBSTITUTION',
      issue: 'Fixture advisory', suggestion: 'Review this', decisionRef: 'd-fixture', latencyMs: 1 }));
    const h = await browserHarness({ messagingToneGate: { review } });
    const refused = await h.send('I will handle this for you.');
    expect(refused.status).toBe(422); expect(refused.body.error).toBe('tone-gate-advisory');
    expect(h.invoke).not.toHaveBeenCalled();
    const accepted = await h.send('I will handle this for you.', { toneAdvisoryAck: 'B21_USER_TASK_SUBSTITUTION',
      toneAdvisoryAckReason: 'The operator explicitly requested this action.', toneAdvisoryDecisionRef: 'd-fixture' });
    expect(accepted.status).toBe(200); expect(h.invoke).toHaveBeenCalledOnce();
    expect(review.mock.calls.map(call => call[0])).toEqual(['I will handle this for you.', 'I will handle this for you.']);
  });
  it('rechecks the existing stand-down authority and releases when ownership returns', async () => {
    const ownerOf = vi.fn(() => 'other-machine'), release = vi.fn();
    const h = await browserHarness({ meshSelfId: 'studio', sessionOwnershipRegistry: { ownerOf },
      standDownRegistry: { getByTopic: () => ({ sessionName: 'source', dryRun: false, ownerMachineId: 'other-machine' }),
        isEnforcing: () => true, countRefusedSend: vi.fn(), release } });
    const refused = await h.send('A reply while standing down.');
    expect(refused.status).toBe(409); expect(refused.body.error).toBe('standing-down');
    expect(h.invoke).not.toHaveBeenCalled();
    ownerOf.mockReturnValue('studio');
    expect((await h.send('Ownership has returned.')).status).toBe(200);
    expect(release).toHaveBeenCalled(); expect(h.invoke).toHaveBeenCalledOnce();
  });
  it('holds browser writes when the production policy attachment is absent', async () => {
    const h = await browserHarness(); h.runtime.service.options.sendPolicy = undefined;
    const refused = await h.send('A legitimate reply before policy initialization.');
    expect(refused.status).toBe(409); expect(refused.body.reason).toBe('send-policy-unavailable');
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it('exposes uncertain imported legacy evidence only to the operator without redriving it', async () => {
    const h = await appHarness();
    const queue = PendingRelayStore.open('echo', h.runtime.options.storage.stateDir);
    try { queue.enqueue({ delivery_id: 'old-http-uncertain', topic_id: 42, text: 'Old answer', text_hash: 'fixture', http_code: 0 }); }
    finally { queue.close(); }
    expect(await h.runtime.importLegacyQueue()).toBe(1);
    await request(h.app).get('/telegram/origins').set('Authorization', 'Bearer agent-test').expect(403);
    const audit = await request(h.app).get('/telegram/origins').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Operator-Session', 'operator-test').expect(200);
    expect(audit.body.records[0].operation.state).toBe('outcome-unknown');
    const metrics = await request(h.app).get('/telegram/origins/status?scope=pool').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Operator-Session', 'operator-test').expect(200);
    expect(metrics.body.metrics).toMatchObject({ coverage: 'complete', counts: { 'operation:prepared': 1, 'operation:imported-legacy': 1 } });
    const localStatus = await request(h.app).get('/telegram/origins/status').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Operator-Session', 'operator-test').expect(200);
    expect(localStatus.body.activation).toMatchObject({ complete: false, inventoryComplete: false });
    expect(JSON.parse(audit.body.records[0].record.envelopeJson)).toMatchObject({ producerKind: 'imported-legacy',
      deliveryId: 'old-http-uncertain', machine: { status: 'unknown' }, harness: { status: 'unknown' }, model: { status: 'unknown' } });
    await h.runtime.recoverHeld();
    expect(h.network).not.toHaveBeenCalled();
  });
  it('authors the setup greeting on the server and restricts its destination and producer', async () => {
    const h = await appHarness();
    const body = { agentName: 'Echo', userName: 'Justin', autonomy: 'proactive' };
    await request(h.app).post('/telegram/setup/greeting').send(body).expect(401);
    await request(h.app).post('/telegram/setup/greeting').set('Authorization', 'Bearer agent-test').send({ ...body, text: 'arbitrary bytes', topicId: 99 }).expect(400);
    const reply = await request(h.app).post('/telegram/setup/greeting').set('Authorization', 'Bearer agent-test').send(body).expect(200);
    expect(reply.body.messageId).toBe(27);
    const rows = (await h.runtime.store.listOrigins()).records;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].record.envelopeJson)).toMatchObject({ producerKind: 'server-automation', producerId: 'setup-wizard',
      model: { status: 'not-applicable' }, destination: { topicId: '7848' } });
    expect(JSON.parse(h.network.mock.calls[0][1].body as string).text).toContain('Justin');
    expect(h.network.mock.calls[1][0]).toContain('/pinChatMessage');
    expect(JSON.parse(h.network.mock.calls[1][1].body as string).message_id).toBe(27);
  });
  it('accepts a message-bound internal author grant, rejects replay, and ignores client model fields', async () => {
    const h = await appHarness();
    const authorCall = new OriginAuthorCall();
    authorCall.options({}).onModel!({ model: 'author-selected-model', framework: 'codex-cli' });
    h.runtime.service.registerAutomationProducer('presence-proxy');
    const body = { text: 'An authored update.', metadata: { model: 'forged-model', originMachineName: 'forged-host' } };
    const token = h.runtime.service.issueAutomationReply('presence-proxy', 77, body, authorCall.snapshot());
    const send = (topic = 77, payload = body) => request(h.app).post(`/telegram/reply/${topic}`)
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Automation', token).send(payload);
    expect((await send(78)).status).toBe(409);
    expect((await send(77, { ...body, text: 'Changed content.' })).status).toBe(409);
    expect(h.network).not.toHaveBeenCalled();
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
    expect(h.network).toHaveBeenCalledOnce();
    const page = await h.runtime.store.listOrigins();
    expect(JSON.parse(page.records[0].record.envelopeJson)).toMatchObject({
      originMachineName: 'Mac Studio', producerId: 'presence-proxy', sessionId: null,
      harnessId: 'codex-cli', model: { value: 'author-selected-model', status: 'configured', sourceEventRef: authorCall.callId },
    });
  });
  it('keeps deterministic internal notices distinct from an unbound model', async () => {
    const h = await appHarness();
    h.runtime.service.registerAutomationProducer('fixed-notice');
    const body = { text: 'A fixed notification.' };
    const token = h.runtime.service.issueAutomationReply('fixed-notice', 77, body, deterministicAutomationAuthor());
    const response = await request(h.app).post('/telegram/reply/77').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Origin-Automation', token).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const page = await h.runtime.store.listOrigins();
    expect(JSON.parse(page.records[0].record.envelopeJson).model).toMatchObject({ status: 'not-applicable', reason: 'deterministic-automation' });
  });
  it('binds the submitting session across a different destination topic, then restricts audit to the operator', async () => {
    const h = await appHarness();
    const response = await request(h.app).post('/telegram/reply/77').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Origin-Session', h.sessionToken).send({ text: 'A cross-topic reply.' });
    expect(response.status).toBe(200);
    expect(h.network).toHaveBeenCalledOnce();
    const audit = await request(h.app).get('/telegram/origins').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Operator-Session', 'operator-test');
    expect(audit.status).toBe(200);
    const origin = JSON.parse(audit.body.records[0].record.envelopeJson);
    expect(origin).toMatchObject({ sessionId: 'source-session', harnessName: 'Codex', destination: { topicId: '77' } });
    for (const path of ['/telegram/origins', `/telegram/origins/${origin.originId}`, '/telegram/origins/status']) {
      expect((await request(h.app).get(path).set('Authorization', 'Bearer agent-test')).status).toBe(403);
      expect((await request(h.app).get(path).set('Authorization', `Bearer ${h.sessionToken}`)).status).toBe(401);
    }
  });
  it('refuses missing or spoofed session identity before the Telegram adapter runs', async () => {
    const h = await appHarness();
    const result = await request(h.app).post('/telegram/reply/78').set('Authorization', 'Bearer agent-test')
      .send({ text: 'Spoofed attribution.', metadata: { sessionId: 'source-session', machine: 'studio', model: 'gpt-6-astra' } });
    expect(result.status).toBe(409); expect(result.body.retryable).toBe(false);
    expect(h.network).not.toHaveBeenCalled();
  });
  it('keeps an uncertain accepted send terminal for generic HTTP callers', async () => {
    const h = await appHarness(); h.network.mockRejectedValueOnce(new Error('socket closed after upload'));
    const result = await request(h.app).post('/telegram/reply/79').set('Authorization', 'Bearer agent-test')
      .set('X-Instar-Origin-Session', h.sessionToken).send({ text: 'Do not resend this uncertain operation.' });
    expect(result.status).toBe(409); expect(result.body).toMatchObject({ outcome: 'outcome-unknown', retryable: false });
    expect(h.network).toHaveBeenCalledOnce();
  });
});
