/**
 * Unit tests for TelegramConfirmationTransport (Phase 5b.5.b).
 *
 * Covers the push→pull bridging: send delegation, awaitReply with
 * timeout, inbound matching by topic id, supersession on overlapping
 * confirmations, drop-on-no-waiter, and shutdown.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TelegramConfirmationTransport,
  type MinimalMessagingAdapter,
  type InboundMessage,
} from '../../../../src/providers/uxConfirm/TelegramConfirmationTransport.js';

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

class FakeAdapter implements MinimalMessagingAdapter {
  private handler: ((m: InboundMessage) => Promise<void> | void) | null = null;
  public sent: Array<{ userId: string; content: string; [k: string]: unknown }> = [];

  async send(message: { userId: string; content: string; [k: string]: unknown }): Promise<void> {
    this.sent.push(message);
  }

  onMessage(handler: (m: InboundMessage) => Promise<void> | void): void {
    this.handler = handler;
  }

  /** Test helper: pretend a user sent a reply. */
  emit(message: InboundMessage): void {
    this.handler?.(message);
  }
}

function makeTransport(adapter: FakeAdapter): TelegramConfirmationTransport {
  return new TelegramConfirmationTransport({
    adapter,
    topicFromInbound: (m) => (m.metadata?.['topicId'] as string | undefined) ?? null,
    outboundForTopic: (topicId, text) => ({
      userId: 'bot',
      content: text,
      metadata: { topicId },
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramConfirmationTransport — send', () => {
  it('delegates to adapter.send with the topic-shaped outbound', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);
    await transport.send({ topicId: '9984', text: 'hello' });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.content).toBe('hello');
    expect(adapter.sent[0]!['metadata']).toEqual({ topicId: '9984' });
  });
});

describe('TelegramConfirmationTransport — awaitReply', () => {
  it('resolves with reply text when a matching inbound arrives', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);

    const promise = transport.awaitReply({ topicId: '9984', timeoutMs: 5000 });
    expect(transport.pendingCount).toBe(1);

    adapter.emit({ userId: 'justin', content: 'ok', metadata: { topicId: '9984' } });

    const reply = await promise;
    expect(reply).toBe('ok');
    expect(transport.pendingCount).toBe(0);
  });

  it('ignores inbound messages for a different topic', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);

    const promise = transport.awaitReply({ topicId: '9984', timeoutMs: 100 });
    adapter.emit({ userId: 'justin', content: 'wrong topic', metadata: { topicId: '1234' } });

    const reply = await promise;
    expect(reply).toBeNull();  // hit the timeout
  });

  it('ignores inbound messages without a topic id', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);

    const promise = transport.awaitReply({ topicId: '9984', timeoutMs: 100 });
    adapter.emit({ userId: 'justin', content: 'no topic at all' });

    const reply = await promise;
    expect(reply).toBeNull();
  });

  it('resolves with null on timeout', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);

    const reply = await transport.awaitReply({ topicId: '9984', timeoutMs: 50 });
    expect(reply).toBeNull();
    expect(transport.pendingCount).toBe(0);
  });

  it('drops inbound messages silently when no waiter exists', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);

    // Emit without anyone waiting.
    adapter.emit({ userId: 'justin', content: 'early reply', metadata: { topicId: '9984' } });
    expect(transport.pendingCount).toBe(0);

    // Now wait — should NOT get the dropped message.
    const reply = await transport.awaitReply({ topicId: '9984', timeoutMs: 50 });
    expect(reply).toBeNull();
  });
});

describe('TelegramConfirmationTransport — supersession', () => {
  it('a new awaitReply supersedes a prior pending one (prior gets null)', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);

    const promise1 = transport.awaitReply({ topicId: '9984', timeoutMs: 5000 });
    const promise2 = transport.awaitReply({ topicId: '9984', timeoutMs: 5000 });

    // Reply arrives — the SECOND waiter should get it.
    adapter.emit({ userId: 'justin', content: 'second wins', metadata: { topicId: '9984' } });

    const r1 = await promise1;
    const r2 = await promise2;
    expect(r1).toBeNull();
    expect(r2).toBe('second wins');
  });

  it('separate topics do NOT supersede each other', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);

    const promise1 = transport.awaitReply({ topicId: 'topic-a', timeoutMs: 5000 });
    const promise2 = transport.awaitReply({ topicId: 'topic-b', timeoutMs: 5000 });

    adapter.emit({ userId: 'justin', content: 'reply-a', metadata: { topicId: 'topic-a' } });
    adapter.emit({ userId: 'justin', content: 'reply-b', metadata: { topicId: 'topic-b' } });

    const [r1, r2] = await Promise.all([promise1, promise2]);
    expect(r1).toBe('reply-a');
    expect(r2).toBe('reply-b');
  });
});

describe('TelegramConfirmationTransport — shutdown', () => {
  it('resolves every pending waiter with null', async () => {
    const adapter = new FakeAdapter();
    const transport = makeTransport(adapter);

    const promise1 = transport.awaitReply({ topicId: 'a', timeoutMs: 60_000 });
    const promise2 = transport.awaitReply({ topicId: 'b', timeoutMs: 60_000 });
    expect(transport.pendingCount).toBe(2);

    transport.shutdown();

    const [r1, r2] = await Promise.all([promise1, promise2]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(transport.pendingCount).toBe(0);
  });
});
