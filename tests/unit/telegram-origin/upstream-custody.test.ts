import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationBatcher } from '../../../src/messaging/NotificationBatcher.js';
import { TelegramOriginHoldError } from '../../../src/messaging/telegram-origin/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
import { createConversationDelivery } from '../../../src/core/deliverToConversation.js';
import fs from 'node:fs';
import path from 'node:path';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test:origin-upstream-cleanup' }); });
describe('upstream origin custody', () => {
  it('keeps a held digest associated with its original operation through flushes and restart', async () => {
    const stateDir = temporaryState(); dirs.push(stateDir);
    const send = vi.fn(async () => { throw new TelegramOriginHoldError('transport-acceptance-unknown', 'operation-one', 'outcome-unknown'); });
    const create = () => { const batcher = new NotificationBatcher(); batcher.configureBounds({ stateDir }); batcher.setSendFunction(send); return batcher; };
    let batcher = create();
    await batcher.enqueue({ tier: 'SUMMARY', category: 'system', message: 'An actual digest', timestamp: new Date(), topicId: 42 });
    expect(await batcher.flush('SUMMARY')).toBe(0);
    expect(await batcher.flush('SUMMARY')).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.getStats()).toMatchObject({ originHeldCount: 1, totalFlushed: 0, totalSuppressed: 0 });
    expect(fs.readFileSync(path.join(stateDir, 'notification-suppression.json'), 'utf8')).not.toContain('An actual digest');
    batcher = create();
    // Late pool wiring must not duplicate restored holds.
    batcher.configureBounds({ stateDir, ownershipResolver: () => 'owner' });
    expect(await batcher.flush('SUMMARY')).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    const resolve = vi.fn(async (id: string) => id === 'operation-one');
    batcher.setOriginDeliveryResolver(resolve);
    expect(await batcher.flush('SUMMARY')).toBe(1);
    expect(batcher.getStats()).toMatchObject({ originHeldCount: 0, totalFlushed: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('holds an ambiguous failure when an embedder cannot preserve logical send identity', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('sink unavailable')).mockResolvedValue({ messageId: 1 });
    const batcher = new NotificationBatcher(); batcher.setSendFunction(send);
    await batcher.enqueue({ tier: 'SUMMARY', category: 'system', message: 'A digest', timestamp: new Date(), topicId: 42 });
    expect(await batcher.flush('SUMMARY')).toBe(0);
    expect(await batcher.flush('SUMMARY')).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('preserves a typed Telegram hold in the conversation funnel', async () => {
    const held = { delivered: false as const, outcome: 'not-delivered' as const, reason: 'telegram-origin-held' as const,
      originHold: { operationId: 'operation-one', outcome: 'outcome-unknown', reason: 'response-lost' } };
    const deliver = createConversationDelivery({ registry: {} as never, followThrough: () => ({ enabled: false, dryRun: true }), sendTelegram: async () => held });
    expect(await deliver(42, 'A heartbeat')).toEqual(held);
    const throwing = createConversationDelivery({ registry: {} as never, followThrough: () => ({ enabled: false, dryRun: true }),
      sendTelegram: async () => { throw new TelegramOriginHoldError('response-lost', 'operation-one', 'outcome-unknown'); } });
    expect(await throwing(42, 'A heartbeat')).toEqual(held);
  });
});
