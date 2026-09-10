import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationBatcher } from '../../src/messaging/NotificationBatcher.js';
import { wireTelegramSendSide } from '../../src/messaging/telegramSendSideComposition.js';
import { sendDeterministicTelegramNotice, sendUnknownProducerTelegramNotice, withUnknownProducerOrigin } from '../../src/messaging/telegram-origin/OriginDeterministicSend.js';
import { QuotaNotifier } from '../../src/monitoring/QuotaNotifier.js';
import { OriginAuthorCall } from '../../src/messaging/telegram-origin/OriginAutomationAuthor.js';
import { compileOriginWorker, compileOriginConfigWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let worker: URL, configWorker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); configWorker = await compileOriginConfigWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
async function boot(mode: 'send-only' | 'server-polling') {
  const root = await mkdtemp('/tmp/origin-fixed-notices-'), stateDir = path.join(root, '.instar');
  cleanups.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:fixed-notice-origin' }); });
  await mkdir(path.join(stateDir, 'state'), { recursive: true });
  const telegramConfig = { token: '123:fixture-notices', chatId: '-100123', messageOrigin: { display: { enabled: false } } };
  const config = { projectDir: root, stateDir, projectName: 'echo', port: 0,
    messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
  const runtimeBoot = await bootTelegramOrigin({ config: config as never, token: telegramConfig.token, noticeOwner: true,
    workerUrl: worker, configWorkerUrl: configWorker, holdsLease: () => true,
    diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
  cleanups.push(() => runtimeBoot.close());
  const runtime = runtimeBoot.runtime;
  runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }) });
  let seq = 0;
  const wire = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++seq, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', wire);
  const adapter = new TelegramAdapter(telegramConfig as never, stateDir);
  const batcher = new NotificationBatcher(); batcher.configureBounds({ stateDir });
  wireTelegramSendSide({ mode, telegram: adapter, notificationBatcher: batcher, originService: runtime.service }); batcher.stop();
  await waitForOriginDisplayReady(runtime, { chatId: '-100123', topicId: '42' });
  return { runtime, adapter, batcher, stateDir, wire };
}

describe('production fixed notice identity composition', () => {
  it.each(['send-only', 'server-polling'] as const)('binds the actual adapter in %s mode and isolates fixed, copied and generic authors', async mode => {
    const h = await boot(mode);
    h.runtime.service.registerAutomationProducer('outer-llm');
    const author = new OriginAuthorCall(); author.options({}).onModel!({ model: 'outer-model', framework: 'codex-cli' });
    await h.runtime.service.runAsAuthoredAutomation('outer-llm', author.snapshot(), () =>
      sendDeterministicTelegramNotice(h.adapter, 'session-monitor', 42, 'The session has stopped. Send a new message to continue.'));
    await sendUnknownProducerTelegramNotice(h.adapter, 'auto-dispatcher', 43, 'Applied a dispatch: generated improvement title.');
    await withUnknownProducerOrigin(h.runtime.service, 'growth-digest', () => h.adapter.sendToTopic(44, 'Growth finding: generated milestone description.'));
    await h.adapter.sendToTopic(45, 'An unbound caller sends its ordinary report.');
    const rows = (await h.runtime.store.listOrigins()).records;
    expect(rows).toHaveLength(4); expect(h.wire).toHaveBeenCalledTimes(4);
    const byProducer = (id: string) => rows.map(row => JSON.parse(row.record.envelopeJson)).find(record => record.producerId === id);
    expect(byProducer('session-monitor')).toMatchObject({ sessionId: null, producerKind: 'server-automation',
      model: { status: 'not-applicable', value: null }, harness: { status: 'not-applicable', value: null } });
    for (const id of ['auto-dispatcher', 'growth-digest', 'telegram-server']) expect(byProducer(id).model.status).toBe('unknown');
    expect(rows.every(row => row.operation?.state === 'accepted')).toBe(true);
    const other = { sendToTopic: vi.fn(async () => undefined) };
    await expect(sendDeterministicTelegramNotice(other, 'session-monitor', 42, 'Unbound fixed sender')).rejects.toMatchObject({ reason: 'deterministic-producer-transport-unbound' });
    expect(other.sendToTopic).not.toHaveBeenCalled();
  });
  it('retains threshold author across a real delayed batch and leaves a following ad hoc alert unknown', async () => {
    const h = await boot('send-only'), notifier = new QuotaNotifier(h.stateDir);
    notifier.configure(async (topicId, text, author) => h.batcher.enqueue({ tier: 'SUMMARY', category: 'quota', topicId,
      message: text, timestamp: new Date(), origin: author ? { producerId: 'quota-notifier', author } : undefined }), 42);
    await notifier.checkAndNotify({ usagePercent: 80 } as never);
    expect(h.wire).not.toHaveBeenCalled();
    expect(await h.batcher.flush('SUMMARY')).toBe(1);
    await notifier.sendAlert('A model supplied this troubleshooting explanation.');
    expect(await h.batcher.flush('SUMMARY')).toBe(1);
    const rows = (await h.runtime.store.listOrigins()).records;
    expect(rows).toHaveLength(2);
    expect(rows.every(row => JSON.parse(row.record.envelopeJson).producerId === 'quota-notifier')).toBe(true);
    expect(rows.map(row => JSON.parse(row.record.envelopeJson).model.status).sort()).toEqual(['not-applicable', 'unknown']);
  });
});
