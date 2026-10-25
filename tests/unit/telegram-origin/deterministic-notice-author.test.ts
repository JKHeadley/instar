import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationBatcher, type BatcherOrigin } from '../../../src/messaging/NotificationBatcher.js';
import { QuotaNotifier } from '../../../src/monitoring/QuotaNotifier.js';
import { deterministicAutomationAuthor, unknownAutomationAuthor } from '../../../src/messaging/telegram-origin/OriginAutomationAuthor.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test:notice-author' }); });
const quota = (): BatcherOrigin => ({ producerId: 'quota-notifier', author: deterministicAutomationAuthor() });
const note = (origin?: BatcherOrigin, message = 'Quota threshold reached') => ({ tier: 'SUMMARY' as const, category: 'quota', topicId: 42, timestamp: new Date(), message, ...(origin ? { origin } : {}) });

describe('notice author custody', () => {
  it('marks threshold templates deterministic but leaves ad hoc quota prose unknown', async () => {
    const dir = temporaryState(); dirs.push(dir);
    const notifier = new QuotaNotifier(dir), send = vi.fn(async () => undefined);
    notifier.configure(send, 42);
    await notifier.checkAndNotify({ usagePercent: 80, fiveHourPercent: 85 } as never);
    await notifier.sendAlert('A diagnostic model wrote this alert.');
    const calls = send.mock.calls as unknown as [number, string, BatcherOrigin['author']][];
    expect(calls).toHaveLength(3);
    expect(calls.slice(0, 2).map(call => call[2].model.status)).toEqual(['not-applicable', 'not-applicable']);
    expect(calls[2][2].model.status).toBe('unknown');
  });
  it.each(['SUMMARY', 'IMMEDIATE'] as const)('retains explicit quota evidence on the %s lane', async tier => {
    const batcher = new NotificationBatcher(), send = vi.fn(async () => ({ messageId: 1 }));
    batcher.setSendFunction(send); const origin = quota();
    await batcher.enqueue({ ...note(origin), tier });
    origin.author.model = unknownAutomationAuthor().model;
    if (tier === 'SUMMARY') await batcher.flush('SUMMARY');
    const call = send.mock.calls[0] as unknown as [number, string, string | undefined, BatcherOrigin];
    expect(call[3]).toMatchObject({ producerId: 'quota-notifier', author: { model: { status: 'not-applicable' } } });
  });
  it('composes unknown contributors for mixed sources, including deduplicated shapes', async () => {
    for (const sameShape of [false, true]) {
      const batcher = new NotificationBatcher(), send = vi.fn(async () => ({ messageId: 1 }));
      batcher.setSendFunction(send);
      await batcher.enqueue(note(quota()));
      await batcher.enqueue(note(undefined, sameShape ? 'Quota threshold reached' : 'A generated report with different wording'));
      await batcher.flush('SUMMARY');
      const origin = (send.mock.calls[0] as unknown as [number, string, string, BatcherOrigin])[3];
      expect(origin.producerId).toBe('notification-batcher');
      expect(origin.author.model.status).toBe('unknown');
      expect(origin.author.authorContributors?.map(value => value.model.status)).toEqual(['not-applicable', 'unknown']);
    }
  });
  it('keeps generic notifications unbound and does not infer authors from quota category or text', async () => {
    const batcher = new NotificationBatcher(), send = vi.fn(async () => ({ messageId: 1 })); batcher.setSendFunction(send);
    await batcher.enqueue(note()); await batcher.flush('SUMMARY');
    expect(send.mock.calls[0]).toHaveLength(3);
  });
  it('persists author and producer with the exact frozen logical send across restart', async () => {
    const dir = temporaryState(); dirs.push(dir);
    const first = new NotificationBatcher(); first.configureBounds({ stateDir: dir });
    const send = vi.fn(async () => { throw new Error('lost sink return'); });
    first.setSendFunction(send, { supportsLogicalIds: true });
    await first.enqueue(note(quota())); expect(await first.flush('SUMMARY')).toBe(0);
    const recovered = new NotificationBatcher(); recovered.configureBounds({ stateDir: dir });
    const retry = vi.fn(async () => ({ messageId: 1 })); recovered.setSendFunction(retry, { supportsLogicalIds: true });
    expect(await recovered.flush('SUMMARY')).toBe(1);
    expect(retry.mock.calls[0]).toEqual(send.mock.calls[0]);
    expect((retry.mock.calls[0] as unknown as [number, string, string, BatcherOrigin])[3]).toEqual(quota());
  });
  it('copies only typed evidence and cannot pass extra identity fields through the aggregation seam', async () => {
    const batcher = new NotificationBatcher(), send = vi.fn(async () => ({ messageId: 1 })); batcher.setSendFunction(send);
    const origin = quota(); Object.assign(origin.author, { producerId: 'spoofed-session', producerKind: 'session', sessionId: 'another-session' });
    await batcher.enqueue(note(origin)); await batcher.flush('SUMMARY');
    expect((send.mock.calls[0] as unknown as [number, string, string, BatcherOrigin])[3]).toEqual(quota());
  });
  it('rejects malformed trusted author input instead of minting a different retry producer', async () => {
    const batcher = new NotificationBatcher(), send = vi.fn(async () => ({ messageId: 1 })); batcher.setSendFunction(send);
    await expect(batcher.enqueue(note({ producerId: 'caller-choice', author: deterministicAutomationAuthor() } as never))).rejects.toThrow('invalid-batcher-origin');
    expect(send).not.toHaveBeenCalled();
  });
});
