/**
 * TelegramConfirmationTransport — bridge between MessagingAdapter and
 * the ConfirmationTransport contract Phase 5b.3 expects.
 *
 * The MessagingAdapter contract is push-based: messages arrive via
 * `onMessage(handler)`. The ConfirmationTransport contract is pull-based:
 * `awaitReply({ topicId, timeoutMs })` returns the NEXT reply (or null
 * on timeout). This class turns one into the other with a per-topic
 * waiter queue.
 *
 * Despite the name, this works for any MessagingAdapter implementation
 * — Telegram, Slack, iMessage, whatever — as long as the caller provides
 * a topic-extractor that maps an inbound Message to a topic id. The
 * "Telegram" prefix is historical (Phase 5b is Telegram-only per Justin's
 * 2026-05-15 directive); the implementation is platform-agnostic.
 *
 * Edge cases handled (per spec §"Edge cases"):
 *
 *   - Concurrent confirmations on the same topic: the most recent
 *     awaitReply wins. The prior waiter rejects with a "superseded"
 *     null — caller treats it as a timeout (which is correct: a new
 *     confirmation arrived before the old reply did).
 *   - Replies before any awaitReply has been called: silently dropped.
 *     This prevents stale replies from satisfying future confirmations.
 *   - Timeout: resolves with null, which TelegramConfirmer interprets
 *     as `default-no-reply`.
 */

import type { ConfirmationTransport } from './TelegramConfirmer.js';

// ---------------------------------------------------------------------------
// Minimal adapter surface — we only need send + onMessage from MessagingAdapter
// ---------------------------------------------------------------------------

/**
 * The slice of MessagingAdapter this transport actually uses. Keeping
 * the surface narrow makes unit testing trivial (no need to stub the
 * full MessagingAdapter contract).
 */
export interface MinimalMessagingAdapter {
  send(message: {
    userId: string;
    content: string;
    [key: string]: unknown;
  }): Promise<void | unknown>;
  onMessage(handler: (message: InboundMessage) => Promise<void> | void): void;
}

/**
 * The slice of `Message` (from core/types.ts) we consume. Carrying the
 * full Message type would couple us to Telegram-specific metadata; this
 * narrows the contract.
 */
export interface InboundMessage {
  userId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TelegramConfirmationTransportOptions {
  adapter: MinimalMessagingAdapter;
  /**
   * Extract the topic id from an inbound message. For Telegram, the
   * topic id typically lives in `message.metadata.topicId` or similar.
   * Return null when the message has no topic (in which case the
   * transport ignores the message entirely).
   */
  topicFromInbound: (message: InboundMessage) => string | null;
  /**
   * Build the outbound message shape from a topic id + text. Returns the
   * argument to pass to adapter.send. Telegram's adapter typically needs
   * `userId` (the bot identifier) and a metadata field with the topic id.
   */
  outboundForTopic: (topicId: string, text: string) => {
    userId: string;
    content: string;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: (text: string | null) => void;
  timeoutHandle: NodeJS.Timeout;
}

export class TelegramConfirmationTransport implements ConfirmationTransport {
  private readonly adapter: MinimalMessagingAdapter;
  private readonly topicFromInbound: (message: InboundMessage) => string | null;
  private readonly outboundForTopic: (
    topicId: string,
    text: string,
  ) => { userId: string; content: string; [key: string]: unknown };
  private readonly waiters: Map<string, Waiter> = new Map();

  constructor(options: TelegramConfirmationTransportOptions) {
    this.adapter = options.adapter;
    this.topicFromInbound = options.topicFromInbound;
    this.outboundForTopic = options.outboundForTopic;
    // Wire the push handler exactly once. Subsequent messages route
    // through here for the lifetime of this transport.
    this.adapter.onMessage((message) => this.handleInbound(message));
  }

  async send({ topicId, text }: { topicId: string; text: string }): Promise<void> {
    const outbound = this.outboundForTopic(topicId, text);
    await this.adapter.send(outbound);
  }

  async awaitReply({
    topicId,
    timeoutMs,
  }: {
    topicId: string;
    timeoutMs: number;
  }): Promise<string | null> {
    // If a prior awaitReply is in flight on this topic, it gets superseded.
    // The prior waiter resolves with null so the caller treats it as a
    // timeout — semantically correct because a NEW confirmation has now
    // pre-empted it.
    const existing = this.waiters.get(topicId);
    if (existing) {
      clearTimeout(existing.timeoutHandle);
      existing.resolve(null);
      this.waiters.delete(topicId);
    }

    return new Promise<string | null>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        const waiter = this.waiters.get(topicId);
        // Only consume if WE are still the waiter (defensive against
        // races where the inbound handler resolves first).
        if (waiter && waiter.timeoutHandle === timeoutHandle) {
          this.waiters.delete(topicId);
          resolve(null);
        }
      }, timeoutMs);
      this.waiters.set(topicId, { resolve, timeoutHandle });
    });
  }

  private handleInbound(message: InboundMessage): void {
    const topicId = this.topicFromInbound(message);
    if (topicId === null) return;

    const waiter = this.waiters.get(topicId);
    if (!waiter) return; // No active confirmation for this topic — drop silently.

    clearTimeout(waiter.timeoutHandle);
    this.waiters.delete(topicId);
    waiter.resolve(message.content);
  }

  /**
   * Returns the number of in-flight confirmations awaiting a reply.
   * Useful for observability and tests.
   */
  get pendingCount(): number {
    return this.waiters.size;
  }

  /**
   * Resolve every pending waiter with null. Use during shutdown so
   * lingering confirmation promises don't hold the event loop open.
   */
  shutdown(): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timeoutHandle);
      waiter.resolve(null);
    }
    this.waiters.clear();
  }
}
