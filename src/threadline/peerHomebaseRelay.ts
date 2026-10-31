/**
 * peerHomebaseRelay — the server posts a peer's user-meant message into the peer's own topic.
 *
 * Spec: docs/specs/peer-conversation-homebase-topic.md §2.6 (operator rule, 2026-10-31:
 * "the whole point of the agent specific topic is that all messages from an agent that are
 * intended for the user show up in that topic").
 *
 * Before this, a peer message on a conversation with no topic link reached a session, and that
 * session picked a Telegram topic for the user by itself. On 2026-10-31 a peer's first message
 * landed in an unrelated topic ("B2Lead Invoices") although the peer's own topic existed a
 * minute later. Routing a user-meant message is now the server's job, structurally:
 *
 *   - the conversation was bound by the OPERATOR → the relay stays out (existing routing
 *     delivers to that topic);
 *   - the peer has a homebase → a user-visible message is posted there, with notification;
 *     an agent-internal one is not posted (housekeeping keeps its existing routing);
 *   - no homebase → the relay stays out; the existing hub routing is unchanged.
 *
 * "User-visible" is the existing SalienceGate's verdict, unchanged — this module adds no
 * classifier. It is a delivery step, not a gate: it never blocks, delays or drops the message
 * on its way to a session, and every failure is logged and returned, never thrown.
 */

import type { SalienceGate } from './SalienceGate.js';
import type { PeerUserTopicResolver } from './peerHomebase.js';

export interface PeerHomebaseRelayDeps {
  resolve: PeerUserTopicResolver;
  salienceGate: Pick<SalienceGate, 'evaluate'>;
  /** Posts WITH notification (the operator rule: a request that needs him must buzz). */
  sendToTopic: (topicId: number, text: string) => Promise<unknown>;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface RelayInboundInput {
  threadId: string;
  /** Every identity known for the sender (fingerprint first, then name). */
  peers: Array<string | undefined | null>;
  senderName: string;
  text: string;
}

export type RelayInboundResult =
  | { posted: true; topicId: number }
  | { posted: false; reason: 'no-homebase' | 'operator-bound' | 'agent-internal' | 'rate-limited' | 'empty' | 'send-failed'; topicId?: number };

/** A Telegram post carries at most this much of the body; the full text stays in the thread history. */
export const RELAY_BODY_CAP = 1500;
const PER_THREAD_MS = 60_000;
const PER_TOPIC_LIMIT = 3;
const PER_TOPIC_WINDOW_MS = 60_000;
const MAX_TRACKED_THREADS = 4096;

export class PeerHomebaseRelay {
  private readonly d: PeerHomebaseRelayDeps;
  private readonly now: () => number;
  /** Threads that already had a message posted — the SalienceGate's first-reply input. In memory. */
  private readonly seenThreads = new Map<string, number>();
  private readonly byTopic = new Map<number, number[]>();

  constructor(deps: PeerHomebaseRelayDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Is this conversation's user-meant traffic the relay's job? Cheap, no side effects. */
  destination(threadId: string, peers: Array<string | undefined | null>): { topicId: number | null; via: 'operator-binding' | 'homebase' | 'existing' } {
    return this.d.resolve({ threadId, peers });
  }

  async relayInbound(input: RelayInboundInput): Promise<RelayInboundResult> {
    try {
      const dest = this.d.resolve({ threadId: input.threadId, peers: input.peers });
      if (dest.via === 'operator-binding') return { posted: false, reason: 'operator-bound', topicId: dest.topicId ?? undefined };
      if (dest.via !== 'homebase' || typeof dest.topicId !== 'number') return { posted: false, reason: 'no-homebase' };
      const topicId = dest.topicId;
      const body = (input.text ?? '').trim();
      if (!body) return { posted: false, reason: 'empty', topicId };

      const isFirstReply = !this.seenThreads.has(input.threadId);
      const verdict = await this.d.salienceGate.evaluate({
        replyBody: body,
        history: [],
        isFirstReply,
        remoteAgent: input.senderName,
      });
      if (verdict.verdict !== 'user-visible') return { posted: false, reason: 'agent-internal', topicId };

      const now = this.now();
      const last = this.seenThreads.get(input.threadId);
      const recent = (this.byTopic.get(topicId) ?? []).filter((t) => now - t < PER_TOPIC_WINDOW_MS);
      this.byTopic.set(topicId, recent);
      if ((last !== undefined && now - last < PER_THREAD_MS) || recent.length >= PER_TOPIC_LIMIT) {
        this.d.log?.(`[homebase-relay] rate-limited post for thread ${input.threadId.slice(0, 8)} → topic ${topicId}`);
        return { posted: false, reason: 'rate-limited', topicId };
      }

      const text = formatRelayPost(input.senderName, body);
      try {
        await this.d.sendToTopic(topicId, text);
      } catch (err) {
        this.d.log?.(`[homebase-relay] post to topic ${topicId} failed: ${err instanceof Error ? err.message : String(err)}`);
        return { posted: false, reason: 'send-failed', topicId };
      }
      this.seenThreads.set(input.threadId, now);
      if (this.seenThreads.size > MAX_TRACKED_THREADS) {
        const first = this.seenThreads.keys().next().value;
        if (first !== undefined) this.seenThreads.delete(first);
      }
      recent.push(now);
      this.d.log?.(`[homebase-relay] ${input.senderName}'s message on thread ${input.threadId.slice(0, 8)} posted to its topic ${topicId}`);
      return { posted: true, topicId };
    } catch (err) {
      this.d.log?.(`[homebase-relay] skipped: ${err instanceof Error ? err.message : String(err)}`);
      return { posted: false, reason: 'send-failed' };
    }
  }
}

/** The Telegram text: who wrote it, and the body (capped). Never raw JSON. */
export function formatRelayPost(senderName: string, body: string): string {
  let t = body;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      const parsed = JSON.parse(t) as Record<string, unknown> | null;
      const extracted = parsed && (parsed.text ?? parsed.content ?? parsed.body ?? parsed.message);
      t = typeof extracted === 'string' && extracted.trim() ? extracted.trim() : '(structured message)';
    } catch {
      /* not JSON after all — keep the text */
    }
  }
  const capped = t.length > RELAY_BODY_CAP ? `${t.slice(0, RELAY_BODY_CAP)}… [truncated]` : t; // bounded-input-reviewed: a Telegram display preview for a human, never a model prompt; the cut is disclosed inline and the full text stays in the thread history
  const name = (senderName ?? '').trim() || 'A peer agent';
  return `💬 Message from ${name}:\n\n${capped}`;
}
