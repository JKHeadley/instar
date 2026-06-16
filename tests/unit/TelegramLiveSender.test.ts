import { describe, it, expect, vi } from 'vitest';
import { TelegramLiveSender, type TelegramHistoryEntry } from '../../src/core/TelegramLiveSender.js';

const noSleep = async () => {};

describe('TelegramLiveSender', () => {
  it('send posts as the demo identity and returns the messageId as a string', async () => {
    const postAsDemoUser = vi.fn(async (_t: number, _x: string) => ({ messageId: 5001 }));
    const s = new TelegramLiveSender({ postAsDemoUser, getHistory: () => [], sleep: noSleep });
    const res = await s.send('13481', 'hello');
    expect(res.messageId).toBe('5001');
    expect(postAsDemoUser).toHaveBeenCalledWith(13481, 'hello');
  });

  it('send throws on a non-numeric topic id (never silently mis-routes)', async () => {
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 1 }), getHistory: () => [], sleep: noSleep });
    await expect(s.send('not-a-topic', 'x')).rejects.toThrow(/not a numeric topic id/);
  });

  it('send throws (never fabricates) when no messageId is returned', async () => {
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: NaN }), getHistory: () => [], sleep: noSleep });
    await expect(s.send('1', 'x')).rejects.toThrow(/no messageId/);
  });

  it('awaitReply returns the earliest AGENT reply after the prompt (skips inbound + earlier)', async () => {
    const history: TelegramHistoryEntry[] = [
      { messageId: 100, text: 'old agent msg', fromUser: false },
      { messageId: 200, text: 'the demo prompt', fromUser: true },
      { messageId: 201, text: 'AGENT REPLY', fromUser: false },
      { messageId: 202, text: 'later agent', fromUser: false },
    ];
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 200 }), getHistory: () => history, sleep: noSleep });
    const reply = await s.awaitReply('13481', { timeoutMs: 1000, afterMessageId: '200' });
    expect(reply!.text).toBe('AGENT REPLY');
    expect(reply!.messageId).toBe('201');
  });

  it('awaitReply ignores an inbound user message after the prompt', async () => {
    const history: TelegramHistoryEntry[] = [{ messageId: 250, text: 'another user', fromUser: true }];
    let nowVal = 0;
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 200 }), getHistory: () => history, sleep: noSleep, pollIntervalMs: 1, now: () => (nowVal += 600) });
    const reply = await s.awaitReply('1', { timeoutMs: 1000, afterMessageId: '200' });
    expect(reply).toBeNull();
  });

  it('awaitReply polls until the agent reply lands', async () => {
    let calls = 0;
    const getHistory = () => {
      calls++;
      return calls < 3
        ? [{ messageId: 200, text: 'prompt', fromUser: true }]
        : [{ messageId: 200, text: 'prompt', fromUser: true }, { messageId: 300, text: 'finally', fromUser: false }];
    };
    let nowVal = 0;
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 200 }), getHistory, sleep: noSleep, pollIntervalMs: 1, now: () => (nowVal += 100) });
    const reply = await s.awaitReply('1', { timeoutMs: 100000, afterMessageId: '200' });
    expect(reply!.text).toBe('finally');
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('awaitReply returns null on timeout', async () => {
    let nowVal = 0;
    const s = new TelegramLiveSender({ postAsDemoUser: async () => ({ messageId: 1 }), getHistory: () => [], sleep: noSleep, pollIntervalMs: 1, now: () => (nowVal += 600) });
    const reply = await s.awaitReply('1', { timeoutMs: 1000, afterMessageId: '1' });
    expect(reply).toBeNull();
  });

  it('supports an async getHistory', async () => {
    const s = new TelegramLiveSender({
      postAsDemoUser: async () => ({ messageId: 1 }),
      getHistory: async () => [{ messageId: 2, text: 'reply', fromUser: false }],
      sleep: noSleep,
    });
    const reply = await s.awaitReply('1', { timeoutMs: 1000, afterMessageId: '1' });
    expect(reply!.text).toBe('reply');
  });
});
