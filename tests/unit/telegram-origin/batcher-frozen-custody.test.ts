import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NotificationBatcher } from '../../../src/messaging/NotificationBatcher.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test:batcher-frozen-custody' }); });
const note = (message = 'Frozen message') => ({ tier: 'SUMMARY' as const, category: 'system', message, topicId: 42, timestamp: new Date() });
function create(stateDir?: string) {
  const batcher = new NotificationBatcher({ maxMessagesPerTopicPerHour: 0 });
  if (stateDir) batcher.configureBounds({ stateDir });
  return batcher;
}
describe('batcher pre-dispatch custody', () => {
  it('serializes concurrent flushes so only one sink call sees the queued batch', async () => {
    const batcher = create(); let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await barrier; return { messageId: 1 }; });
    batcher.setSendFunction(send); await batcher.enqueue(note());
    const first = batcher.flush('SUMMARY'), second = batcher.flush('SUMMARY');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    release(); expect(await Promise.all([first, second])).toEqual([1, 0]);
    expect(send).toHaveBeenCalledOnce();
  });
  it('freezes counts before awaiting the sink and keeps new arrivals for a separate batch', async () => {
    const batcher = create(); let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await barrier; return { messageId: 1 }; });
    batcher.setSendFunction(send); await batcher.enqueue(note());
    const first = batcher.flush('SUMMARY'); await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await batcher.enqueue(note()); expect(batcher.getQueueSize().summary).toBe(2);
    release(); expect(await first).toBe(1); expect(batcher.getQueueSize().summary).toBe(1);
    expect(await batcher.flush('SUMMARY')).toBe(1);
    expect(send.mock.calls).toHaveLength(2);
    expect(send.mock.calls.map(call => (call as unknown as [number, string, string])[1])).toEqual(['Frozen message', 'Frozen message']);
    expect((send.mock.calls[0] as unknown as [number, string, string])[2]).not.toBe((send.mock.calls[1] as unknown as [number, string, string])[2]);
  });
  it('restores exact body and logical identity after a crash before the sink returned', async () => {
    const stateDir = temporaryState(); dirs.push(stateDir);
    const first = create(stateDir); let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await barrier; return { messageId: 1 }; });
    first.setSendFunction(send, { supportsLogicalIds: true }); await first.enqueue(note());
    const pending = first.flush('SUMMARY'); await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const original = send.mock.calls[0] as unknown as [number, string, string];
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state/telegram-origin-spool/notification-batcher.json'), 'utf8'));
    expect(state.batches).toEqual([{ logicalSendId: original[2], text: original[1], topicId: 42, tier: 'SUMMARY', attempted: true }]);
    const restored = create(stateDir), replay = vi.fn(async () => ({ messageId: 1 }));
    restored.setSendFunction(replay, { supportsLogicalIds: true });
    expect(await restored.flush('SUMMARY')).toBe(1);
    expect(replay).toHaveBeenCalledWith(...original);
    release(); await pending;
  });
  it('does not retry a pre-return frozen batch with an unsupported sink after restart', async () => {
    const stateDir = temporaryState(); dirs.push(stateDir);
    const first = create(stateDir); let release!: () => void;
    const send = vi.fn(() => new Promise<{ messageId: number }>(resolve => { release = () => resolve({ messageId: 1 }); }));
    first.setSendFunction(send); await first.enqueue(note()); const pending = first.flush('SUMMARY');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const restored = create(stateDir), retry = vi.fn(async () => ({ messageId: 2 })); restored.setSendFunction(retry);
    expect(await restored.flush('SUMMARY')).toBe(0); expect(retry).not.toHaveBeenCalled();
    release(); await pending;
  });
  it('holds before dispatch if durable custody cannot be written', async () => {
    const stateDir = temporaryState(); dirs.push(stateDir);
    const batcher = create(stateDir), send = vi.fn(async () => ({ messageId: 1 })); batcher.setSendFunction(send);
    await batcher.enqueue(note());
    fs.mkdirSync(path.join(stateDir, 'state/telegram-origin-spool'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state/telegram-origin-spool/notification-batcher.json.tmp'));
    expect(await batcher.flush('SUMMARY')).toBe(0); expect(send).not.toHaveBeenCalled();
    expect(batcher.getQueueSize().summary).toBe(1);
  });
});
