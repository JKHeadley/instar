import { deterministicAutomationAuthor } from '../../src/messaging/telegram-origin/OriginAutomationAuthor.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { NotificationBatcher } from '../../src/messaging/NotificationBatcher.js';
import { wireTelegramSendSide } from '../../src/messaging/telegramSendSideComposition.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('production batcher logical custody across restart', () => {
  it('replays the committed receipt after the sink lost its return without a second network send', async () => {
    const stateDir = temporaryState();
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const options = { storage: { stateDir, agentId: 'echo' }, workerUrl: worker,
      identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'source', originMachineName: 'Source' },
      signingKey: { privateKey, keyId: 'source:0', keyEpoch: 0 }, bot: { accountId: '123' },
      display: () => ({ agent: { enabled: false } }), authorize: () => true, diagnoseUnknown: async () => undefined,
      alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined };
    let runtime = await TelegramOriginRuntime.open(options);
    cleanups.push(() => runtime.close());
    const wire = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {
      message_id: 12, chat: { id: -100123 }, message_thread_id: 42,
    } })));
    let loseReturn = true;
    const create = () => {
      runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }) });
      const batcher = new NotificationBatcher(); batcher.configureBounds({ stateDir });
      wireTelegramSendSide({ mode: 'send-only', notificationBatcher: batcher, originService: runtime.service,
        telegram: { sendToTopic: async (topicId: number, text: string) => {
          const response = await runtime.service.sendBot({ method: 'sendMessage', accountId: '123',
            params: { chat_id: '-100123', message_thread_id: topicId, text } }, wire);
          if (loseReturn) { loseReturn = false; throw new Error('sink return lost after committed receipt'); }
          return { messageId: ((await response.json()) as { result: { message_id: number } }).result.message_id };
        } } as never });
      batcher.stop(); return batcher;
    };
    let batcher = create();
    await batcher.enqueue({ tier: 'SUMMARY', category: 'system', topicId: 42, message: 'One durable digest', timestamp: new Date(), origin: { producerId: 'quota-notifier', author: deterministicAutomationAuthor() } });
    expect(await batcher.flush('SUMMARY')).toBe(0); expect(wire).toHaveBeenCalledOnce();
    const original = (await runtime.store.listOrigins()).records[0]; expect(original.operation?.state).toBe('accepted');
    expect(JSON.parse(original.record.envelopeJson)).toMatchObject({ producerId: 'quota-notifier', model: { status: 'not-applicable' }, harness: { status: 'not-applicable' } });
    await runtime.close(); runtime = await TelegramOriginRuntime.open(options); batcher = create();
    expect(await batcher.flush('SUMMARY')).toBe(1); expect(wire).toHaveBeenCalledOnce();
    const recovered = await runtime.store.listOrigins();
    expect(recovered.records).toHaveLength(1); expect(recovered.records[0].record.originId).toBe(original.record.originId);
    expect(batcher.getQueueSize()).toEqual({ summary: 0, digest: 0 });
  });
});
