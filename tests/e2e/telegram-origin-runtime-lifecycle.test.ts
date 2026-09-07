import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { listenOriginNotices, callOriginNotice } from '../../src/messaging/telegram-origin/OriginNoticeIpc.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import type { OutagePolicyProjection } from '../../src/messaging/telegram-origin/TelegramOriginOutageNotifier.js';
import { RECORDING_OUTAGE_TEXT } from '../../src/messaging/telegram-origin/TelegramOriginOutageNotifier.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import { captureOriginAttachments } from '../../src/messaging/telegram-origin/OriginMultipart.js';
import { NotificationBatcher } from '../../src/messaging/NotificationBatcher.js';
import { originDeliveryConfirmed } from '../../src/messaging/telegram-origin/OriginDeliveryResolution.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';

let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
function allowFixtureSends(runtime: TelegramOriginRuntime): void {
  runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(runtime.options.storage.stateDir, runtime.options.bot.chatId) });
}
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.unstubAllGlobals();
});
async function boot() {
  const token = `123:${randomUUID()}`;
  let lifecycle: OriginSessionLifecycle | undefined;
  const policy: OutagePolicyProjection = { alertDestinationId: 'operator-hub', destination: { accountId: 'bot-1', chatId: '-100123', topicId: '7848' }, authorized: true,
    ownershipValid: true, clientPreferences: 'telegram-managed', optedOut: false,
    observerHealthy: true, observedAt: Date.now(), validUntil: Date.now() + 30_000, version: 'authority-1',
    display: { enabled: true, machine: true, harness: true, model: true } };
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    const params = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 100,
      chat: { id: Number(params.chat_id) }, message_thread_id: Number(params.message_thread_id) } }));
  });
  vi.stubGlobal('fetch', network);
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir: temporaryState(), agentId: 'echo' },
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 }, bot: { token, accountId: 'bot-1' },
    isSessionLive: () => true, attachSessionLifecycle: value => { lifecycle = value; },
    display: () => ({ agent: policy.display }), authorize: () => policy.authorized && policy.ownershipValid,
    diagnoseUnknown: async () => undefined,
    alertDestinations: () => [{ id: 'operator-hub', chatId: '-100123', topicId: '7848' }],
    getAlertPolicy: () => policy, onNoticeState: vi.fn(), workerUrl: worker,
  });
  allowFixtureSends(runtime); runtimes.push(runtime);
  const send = (topic = 42, capability?: object) => telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: '-100123', message_thread_id: topic, text: 'Answer being held' }),
  }, capability);
  return { runtime, policy, network, send, lifecycle: lifecycle! };
}
describe('Telegram origin initialization and outage lifecycle', () => {
  it('never recreates a batch operation after ambiguous network acceptance and batcher restart', async () => {
    const h = await boot();
    h.network.mockRejectedValue(new Error('response connection lost after dispatch'));
    const stateDir = h.runtime.options.storage.stateDir;
    const create = () => {
      const batcher = new NotificationBatcher();
      batcher.configureBounds({ stateDir });
      batcher.setSendFunction(async () => { await h.send(); return { messageId: 0 }; });
      batcher.setOriginDeliveryResolver(id => originDeliveryConfirmed(h.runtime.store, id));
      return batcher;
    };
    let batcher = create();
    await batcher.enqueue({ tier: 'SUMMARY', category: 'system', message: 'Answer being held', topicId: 42, timestamp: new Date() });
    expect(await batcher.flush('SUMMARY')).toBe(0);
    batcher = create();
    expect(await batcher.flush('SUMMARY')).toBe(0);
    expect(await batcher.flush('SUMMARY')).toBe(0);
    expect(h.network).toHaveBeenCalledOnce();
    const page = await h.runtime.store.listOrigins({ topicId: '42' });
    expect(page.records).toHaveLength(1);
    expect(page.records[0].operation?.state).toBe('outcome-unknown');
    expect(batcher.getStats()).toMatchObject({ totalFlushed: 0, originHeldCount: 1 });
  });
  it('reopens a failed spool without replacing healthy canonical custody', async () => {
    const h = await boot(), originalStore = h.runtime.store, originalSpool = h.runtime.spool;
    await originalSpool.close();
    expect(originalSpool.isUnavailable()).toBe(true);
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.runtime.store).toBe(originalStore);
    expect(h.runtime.spool).not.toBe(originalSpool);
    expect(h.runtime.spool.isUnavailable()).toBe(false);
    await originalStore.healthTransaction();
  });

  it('keeps a healthy worker alive while a send awaits its receipt during recovery', async () => {
    const h = await boot();
    const originalStore = h.runtime.store, originalSpool = h.runtime.spool;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const responseReady = new Promise<void>(resolve => { release = resolve; });
    h.network.mockImplementation(async () => {
      entered(); await responseReady;
      // Browser executors retain their original store through network awaits.
      // This equivalent retained-store access must still work after the drain.
      await originalStore.healthTransaction();
      return new Response(JSON.stringify({ ok: true, result: { message_id: 222,
        chat: { id: -100123 }, message_thread_id: 42 } }));
    });
    const sending = h.send();
    try {
      await waiting;
      expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
      expect(h.runtime.store).toBe(originalStore); expect(h.runtime.spool).toBe(originalSpool);
    } finally { release(); }
    const response = await sending;
    expect((await originalStore.getOrigin(response.headers.get('X-Instar-Origin-Id')!))?.operation?.state).toBe('accepted');
    expect(h.network).toHaveBeenCalledOnce();
  });

  it('reaches a deliverable queued operation behind ten unenrolled credential owners', async () => {
    const h = await boot();
    for (let i = 0; i < 11; i++) {
      const operation = h.runtime.service.runAsAutomation('telegram-server', () => h.runtime.service.prepareBot({
        method: 'sendMessage', accountId: i < 10 ? 'unavailable-owner' : 'bot-1',
        params: { chat_id: '-100123', message_thread_id: 42, text: `Fair recovery ${i}` },
      }));
      await h.runtime.service.admit(operation);
    }
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 1, recovered: 1 });
    expect(h.network).toHaveBeenCalledOnce();
    expect(JSON.parse(h.network.mock.calls[0][1].body as string).text).toContain('Fair recovery 10');
  });

  it('uploads a real file only after durable admission and links the companion to its receipt', async () => {
    const h = await boot();
    const file = path.join(h.runtime.options.storage.stateDir, 'report.txt');
    await writeFile(file, 'actual file payload for custody trial');
    const original = await readFile(file);
    const form = new FormData(); form.set('chat_id', '-100123'); form.set('message_thread_id', '42');
    form.set('document', new Blob([original], { type: 'text/plain' }), 'report.txt');
    let observedFile: Buffer | undefined, observedChat: FormDataEntryValue | null = null;
    let observedAudit: Awaited<ReturnType<typeof h.runtime.store.getOperation>>;
    const wireErrors: unknown[] = [];
    h.network.mockImplementation(async (url, init) => {
      try {
      if (url.endsWith('/sendDocument')) {
        const decoded = await new Response(init.body, { headers: init.headers }).formData();
        observedFile = Buffer.from(await (decoded.get('document') as Blob).arrayBuffer());
        observedChat = decoded.get('chat_id');
        observedAudit = await h.runtime.store.getOperation(h.runtime.service.currentOperationIds().at(-1)!);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: url.endsWith('/sendDocument') ? 80 : 81,
        chat: { id: -100123 }, message_thread_id: 42 } }));
      } catch (error) { wireErrors.push(error); throw error; }
    });
    const result = await h.runtime.service.runAsAutomation('telegram-server', () => telegramFetch(
      `https://api.telegram.org/bot${h.runtime.options.bot.token}/sendDocument`, { method: 'POST', body: form }))
      .catch(error => { throw wireErrors[0] ?? error; });
    expect((await result.json() as any).result.message_id).toBe(80);
    expect(observedFile).toEqual(original); expect(observedChat).toBe('-100123');
    expect(observedAudit!.attempts[0].phase).toBe('dispatched');
    expect(JSON.stringify(observedAudit)).not.toContain(original.toString());
    expect(h.network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.network.mock.calls[1][1].body as string).reply_parameters.message_id).toBe(80);
  });
  it('recovers the exact sealed upload after process restart without needing its source file or caller Blob', async () => {
    const h = await boot(); h.policy.display.enabled = false;
    const body = new FormData(); body.set('document', new Blob(['retained upload']), 'retained.txt');
    const attachments = await captureOriginAttachments(body);
    const operation = h.runtime.service.runAsAutomation('telegram-server', () => h.runtime.service.prepareBot({
      method: 'sendDocument', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, document: 'attach://document' }, attachments }));
    await h.runtime.service.admit(operation);
    const sealed = JSON.parse(operation.admission.children[0].materializations[0].requestJson);
    await h.runtime.close();
    const restarted = await TelegramOriginRuntime.open(h.runtime.options); allowFixtureSends(restarted); runtimes.push(restarted);
    h.network.mockImplementation(async (_url, init) => {
      expect(new Headers(init.headers).get('Content-Type')).toBe(`multipart/form-data; boundary=${sealed.multipart.boundary}`);
      const decoded = await new Response(init.body, { headers: init.headers }).formData();
      expect(await (decoded.get('document') as Blob).text()).toBe('retained upload');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 82, chat: { id: -100123 }, message_thread_id: 42 } }));
    });
    expect(await restarted.recoverHeld()).toEqual({ processed: 1, recovered: 1 });
    expect(h.network).toHaveBeenCalledOnce();
    expect((await restarted.store.getOrigin(operation.record.originId))?.operation?.state).toBe('accepted');
  });
  it('executes an attachment and its prepared companion through the same credential boundary', async () => {
    const h = await boot();
    h.network.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true, result: { message_id: url.endsWith('/sendDocument') ? 80 : 81,
        chat: { id: Number(body.chat_id) }, message_thread_id: body.message_thread_id } }));
    });
    const result = await h.runtime.service.runAsAutomation('telegram-server', () => telegramFetch(
      `https://api.telegram.org/bot${h.runtime.options.bot.token}/sendDocument`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123',
          message_thread_id: 42, document: 'a-preexisting-telegram-file-id' }) }));
    expect((await result.json() as any).result.message_id).toBe(80);
    expect(h.network.mock.calls.map(([url]) => new URL(url).pathname.split('/').at(-1))).toEqual(['sendDocument', 'sendMessage']);
    expect(JSON.parse(h.network.mock.calls[1][1].body as string).reply_parameters.message_id).toBe(80);
  });
  it('restarts through a real corrupt-store outage with unavailable notice state and no old permit', async () => {
    const h = await boot();
    const oldGeneration = h.runtime.notifier.getState('operator-hub').generation;
    const database = (await h.runtime.store.diagnostics()).path;
    const options = h.runtime.options;
    await h.runtime.close();
    const intact = await readFile(database);
    await writeFile(database, 'not a SQLite database');
    const restarted = await TelegramOriginRuntime.open(options);
    allowFixtureSends(restarted);
    runtimes.push(restarted);
    const status = await restarted.status();
    expect(status.metrics).toMatchObject({ coverage: 'unknown', stale: true, counts: null });
    expect(status.notices[0]).toMatchObject({ notificationOutcome: 'unavailable', generation: null, notificationAttempted: false });
    await expect(h.send()).rejects.toMatchObject({ reason: 'execution-admission-unavailable' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.network).not.toHaveBeenCalled();
    await writeFile(database, intact);
    expect(await restarted.recoverHeld()).toEqual({ processed: 1, recovered: 1 });
    expect(restarted.notifier.getState('operator-hub').generation).not.toBe(oldGeneration);
    expect(h.network).toHaveBeenCalledOnce();
  });
  it('recovers durable queued work after restart with its original identity, while fencing an uncertain attempt', async () => {
    const h = await boot();
    const prepare = (text: string) => h.runtime.service.runAsAutomation('telegram-server', () =>
      h.runtime.service.prepareBot({ method: 'sendMessage', accountId: 'bot-1',
        params: { chat_id: '-100123', message_thread_id: 42, text } }));
    const queued = prepare('Still queued'), uncertain = prepare('Acceptance unknown');
    await h.runtime.service.admit(queued); await h.runtime.service.admit(uncertain);
    const child = uncertain.admission.children[0];
    const claim = await h.runtime.store.claim({ childId: child.childId,
      materializationId: child.materializations[0].materializationId, ownerBootId: h.runtime.ownerBootId,
      leaseMs: 60_000, now: Date.now() - 30_000 });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('test claim unavailable');
    await h.runtime.store.markDispatched(claim.child);
    await h.runtime.store.reapAbandoned(Date.now() + 31_000);
    const options = h.runtime.options;
    await h.runtime.close();
    h.policy.display.enabled = false;
    const restarted = await TelegramOriginRuntime.open({ ...options,
      identity: { ...options.identity, originMachineName: 'Renamed machine' } });
    allowFixtureSends(restarted);
    runtimes.push(restarted);
    expect(restarted.service.heldStatus()).toEqual([]);
    expect(await restarted.recoverHeld()).toEqual({ processed: 1, recovered: 1 });
    expect(h.network).toHaveBeenCalledOnce();
    expect(JSON.parse(h.network.mock.calls[0][1].body as string).text).toContain('Mac Studio');
    expect((await restarted.store.getOrigin(queued.record.originId))?.operation?.state).toBe('accepted');
    expect((await restarted.store.getOrigin(uncertain.record.originId))?.operation?.state).toBe('outcome-unknown');
    expect(await restarted.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
  });
  it('constructs real worker storage, preclaims a fixed notice, and records ordinary egress', async () => {
    const h = await boot();
    expect(h.lifecycle).toBeDefined();
    expect((await h.runtime.status()).notices[0].notificationOutcome).toBe('reserved');
    expect(h.network).not.toHaveBeenCalled();
    const response = await h.send();
    expect(response.status).toBe(200);
    const origin = await h.runtime.store.getOrigin(response.headers.get('X-Instar-Origin-Id')!);
    expect(origin?.children[0].state).toBe('accepted');
    expect(JSON.parse(origin!.record.envelopeJson).originMachineName).toBe('Mac Studio');
  });
  it('enrolls a live session through the actual launch lifecycle, then revokes preparation', async () => {
    const h = await boot();
    const token = await h.lifecycle.issue({ sessionId: 'live', harnessId: 'codex-cli', projectDir: process.cwd(), configuredModel: 'gpt-6-astra' });
    const response = await h.runtime.service.runWithSessionToken(token, () => h.send());
    const origin = await h.runtime.store.getOrigin(response.headers.get('X-Instar-Origin-Id')!);
    expect(JSON.parse(origin!.record.envelopeJson)).toMatchObject({ sessionId: 'live', harnessName: 'Codex', model: { status: 'configured' } });
    await h.lifecycle.revoke('live');
    await expect(h.runtime.service.runWithSessionToken(token, () => h.send())).rejects.toMatchObject({ reason: 'invalid-origin-token' });
    expect(h.network).toHaveBeenCalledOnce();
  });
  it('holds ordinary messages and sends exactly one pre-recorded hub notice while both recording workers fail', async () => {
    const h = await boot();
    vi.spyOn(h.runtime.store, 'putEvidence').mockRejectedValue(new Error('origin worker unavailable'));
    vi.spyOn(h.runtime.spool, 'putEvidence').mockRejectedValue(new Error('spool worker unavailable'));
    for (const topic of [42, 43, 44]) await expect(h.send(topic)).rejects.toMatchObject({ outcome: 'held' });
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-hub').notificationOutcome).toBe('accepted'));
    expect(h.network).toHaveBeenCalledOnce();
    const sent = JSON.parse(h.network.mock.calls[0][1].body as string);
    expect(sent.message_thread_id).toBe('7848');
    expect(sent.text).toBe(`${RECORDING_OUTAGE_TEXT}\n\nEcho · Mac Studio · automation`);
    expect(h.runtime.notifier.getState('operator-hub')).toMatchObject({ notificationAttempted: true, materializationId: expect.any(String) });
    await h.runtime.confirmRecordingHealthy();
    const counts = (await h.runtime.store.getMetrics()).counts;
    expect(counts['notification:accepted']).toBe(1);
  });
  it('suppresses the old reservation when authority moves to a different operator hub', async () => {
    const h = await boot();
    h.policy.destination.topicId = '9000';
    h.policy.observedAt = Date.now(); h.policy.version = 'authority-2';
    h.runtime.notifier.requestHoldNotice('operator-hub');
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-hub')).toMatchObject({
      notificationOutcome: 'suppressed', reason: 'destination-authority-changed', notificationAttempted: false,
    }));
    expect(h.network).not.toHaveBeenCalled();
  });
  it('uses the presealed hidden variant after a display change without re-recording during outage', async () => {
    const h = await boot(); h.policy.display.enabled = false;
    vi.spyOn(h.runtime.store, 'putEvidence').mockRejectedValue(new Error('unavailable'));
    vi.spyOn(h.runtime.spool, 'putEvidence').mockRejectedValue(new Error('unavailable'));
    await expect(h.send()).rejects.toMatchObject({ outcome: 'held' });
    await vi.waitFor(() => expect(h.network).toHaveBeenCalledOnce());
    expect(JSON.parse(h.network.mock.calls[0][1].body as string).text).toBe(RECORDING_OUTAGE_TEXT);
  });
  it('can notify after both real worker processes have stopped, without querying either for permission', async () => {
    const h = await boot();
    await h.runtime.store.close(); await h.runtime.spool.close();
    await expect(h.send()).rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable' });
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-hub').notificationOutcome).toBe('accepted'));
    expect(h.network).toHaveBeenCalledOnce();
    expect((await h.runtime.status()).metrics).toMatchObject({ coverage: 'unknown', stale: true });
    runtimes.splice(runtimes.indexOf(h.runtime), 1);
    await expect(h.runtime.close()).rejects.toMatchObject({ code: 'origin-store-unavailable' });
  });
  it.each(['optedOut', 'expired', 'revoked', 'unhealthy', 'unknown', 'invalid-time', 'throwing'])('suppresses an outage notice when current policy is %s', async kind => {
    const h = await boot();
    if (['optedOut'].includes(kind)) h.policy[kind as 'optedOut'] = true;
    if (kind === 'unhealthy') h.policy.observerHealthy = false;
    if (kind === 'unknown') (h.policy as any).optedOut = undefined;
    if (kind === 'invalid-time') h.policy.observedAt = Number.NaN;
    if (kind === 'throwing') Object.defineProperty(h.policy, 'optedOut', { get: () => { throw new Error('observer unavailable'); } });
    if (kind === 'expired') h.policy.validUntil = Date.now() - 1;
    if (kind === 'revoked') h.policy.authorized = false;
    h.runtime.notifier.requestHoldNotice('operator-hub');
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-hub').notificationOutcome).toBe('suppressed'));
    expect(h.network).not.toHaveBeenCalled();
    await h.runtime.confirmRecordingHealthy();
    expect((await h.runtime.store.getMetrics()).counts['notification:suppressed']).toBe(1);
  });
  it('rejects counterfeit notice capabilities without allowing ordinary text onto the outage path', async () => {
    const h = await boot();
    await expect(h.send(42, {})).rejects.toMatchObject({ reason: 'invalid-outage-notice-capability' });
    expect(h.network).not.toHaveBeenCalled();
  });
  it('lets a second process request the sole owner notice through bounded local IPC', async () => {
    const h = await boot();
    const socket = path.join(temporaryState(), 'notice.sock');
    const close = await listenOriginNotices(socket, h.runtime.notifier, () => ['operator-hub']);
    try {
      expect((await callOriginNotice(socket, 'operator-hub', 'status')).notificationOutcome).toBe('reserved');
      await expect(callOriginNotice(socket, 'unrelated-recipient', 'request')).rejects.toThrow('invalid IPC response');
      await callOriginNotice(socket, 'operator-hub', 'request');
      await callOriginNotice(socket, 'operator-hub', 'request');
      await vi.waitFor(() => expect(h.network).toHaveBeenCalledOnce());
      await expect(listenOriginNotices(socket, h.runtime.notifier, () => ['operator-hub'])).rejects.toThrow('another owner');
    } finally { await close(); }
  });
  it('retains held bytes and recovers the original identity and display without a new send plan', async () => {
    const h = await boot();
    vi.spyOn(h.runtime.store, 'putEvidence').mockRejectedValue(new Error('recording unavailable'));
    vi.spyOn(h.runtime.spool, 'putEvidence').mockRejectedValue(new Error('recording unavailable'));
    await expect(h.send()).rejects.toMatchObject({ outcome: 'held' });
    const original = h.runtime.service.heldOperations()[0];
    expect(original).toBeDefined();
    expect(h.runtime.service.heldStatus()[0].payloadRetainedInMemory).toBe(true);
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-hub').notificationOutcome).toBe('accepted'));
    h.policy.display.enabled = false;
    // Restore the injected failure: healthy workers are deliberately not
    // replaced simply to make a mocked failed write disappear.
    vi.mocked(h.runtime.store.putEvidence).mockRestore();
    vi.mocked(h.runtime.spool.putEvidence).mockRestore();
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 1, recovered: 1 });
    const audit = await h.runtime.store.getOrigin(original.record.originId);
    expect(audit?.operation?.operationId).toBe(original.record.operationId);
    expect(audit?.children[0].state).toBe('accepted');
    expect(JSON.parse(h.network.mock.calls[1][1].body as string).text).toContain('Echo · Mac Studio · automation');
    expect(h.runtime.service.heldStatus()).toEqual([]);
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.network).toHaveBeenCalledTimes(2);
  });
});
