import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_PEER_DEADLINE_MS, withConversationPeerDeadline } from '../../src/server/conversationPeerDeadline.js';

afterEach(() => vi.useRealTimers());

describe('conversation peer deadline', () => {
  it('returns a fast peer and clears the timer', async () => {
    vi.useFakeTimers();
    await expect(withConversationPeerDeadline(async () => 'rows')).resolves.toBe('rows');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts the shared read, even if the signed transport has not settled', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const read = withConversationPeerDeadline((current, remainingMs) => {
      signal = current;
      expect(remainingMs()).toBeLessThanOrEqual(CONVERSATION_PEER_DEADLINE_MS);
      return new Promise(() => {});
    });
    const assertion = expect(read).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(CONVERSATION_PEER_DEADLINE_MS);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
});
