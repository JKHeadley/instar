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
 * "Meant for the user" is decided PER MESSAGE by the PeerUserMeantJudge (§2.7), when one is
 * wired and `threadline.peerHomebase.perMessageClassification` is not false; no verdict posts.
 * With the switch off (or no judge) it is the SalienceGate's verdict, whose production fallback
 * marks only the first message of a conversation (§2.6). It is a delivery step, not a gate: it
 * never blocks, delays or drops the message on its way to a session, and every failure is
 * logged and returned, never thrown.
 */

import type { SalienceGate } from './SalienceGate.js';
import type { PeerUserTopicResolver } from './peerHomebase.js';
import type { PeerUserMeantJudge } from './PeerUserMeantJudge.js';

export interface PeerHomebaseRelayDeps {
  resolve: PeerUserTopicResolver;
  salienceGate: Pick<SalienceGate, 'evaluate'>;
  /** §2.7 per-message judge. Absent, or its switch off ⇒ the SalienceGate (first-only) rule. */
  userMeantJudge?: (Pick<PeerUserMeantJudge, 'judge' | 'enabled'> & Partial<Pick<PeerUserMeantJudge, 'budgetAvailable'>>) | null;
  /** Posts WITH notification (the operator rule: a request that needs him must buzz). */
  sendToTopic: (topicId: number, text: string) => Promise<unknown>;
  log?: (msg: string) => void;
  now?: () => number;
  /** Test seam for the bounded retry timer (default: an unref'd setTimeout). */
  schedule?: (fn: () => void, ms: number) => void;
}

export interface RelayInboundInput {
  threadId: string;
  /** Every identity known for the sender (fingerprint first, then name). */
  peers: Array<string | undefined | null>;
  senderName: string;
  text: string;
  /** The wire type when the transport carries one (protocol types are never posted). */
  messageType?: string | null;
}

export type RelayInboundResult =
  | { posted: true; topicId: number }
  | { posted: false; reason: 'no-homebase' | 'operator-bound' | 'agent-internal' | 'rate-limited' | 'empty' | 'send-failed'; topicId?: number; retryScheduled?: true };

/** A Telegram post carries at most this much of the body; the full text stays in the thread history. */
export const RELAY_BODY_CAP = 1500;
const PER_THREAD_MS = 60_000;
const PER_TOPIC_LIMIT = 3;
const PER_TOPIC_WINDOW_MS = 60_000;
const MAX_TRACKED_THREADS = 4096;
/** §2.7: a judged user-meant post held by a brake or a failed send is retried at most this often. */
const MAX_RETRIES = 2;
const MAX_PENDING_RETRIES = 50;
const SEND_RETRY_MS = 30_000;

export class PeerHomebaseRelay {
  private readonly d: PeerHomebaseRelayDeps;
  private readonly now: () => number;
  /** Threads that already had a message posted — the SalienceGate's first-reply input (first-only mode). In memory. */
  private readonly seenThreads = new Map<string, number>();
  private readonly byTopic = new Map<number, number[]>();
  /** Threads whose messages the relay judges per message (§2.7). In memory. */
  private readonly ownedThreads = new Map<string, number>();
  private pendingRetries = 0;

  constructor(deps: PeerHomebaseRelayDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Is this conversation's user-meant traffic the relay's job? Cheap, no side effects. */
  destination(threadId: string, peers: Array<string | undefined | null>): { topicId: number | null; via: 'operator-binding' | 'homebase' | 'existing' } {
    return this.d.resolve({ threadId, peers });
  }

  /**
   * §2.7: does the server itself post every user-meant message of this thread? True once the relay
   * has taken a message of the thread under per-message judging (homebase destination, judge on).
   * The spawn prompt reads this, so "do not repost" is said only where the relay actually owns it.
   */
  postsUserMeantFor(threadId: string): boolean {
    return this.ownedThreads.has(threadId) && !!this.d.userMeantJudge && this.safeEnabled();
  }

  private safeEnabled(): boolean {
    try { return this.d.userMeantJudge?.enabled() === true; } catch { return false; /* @silent-fallback-ok — no judge claim */ }
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
      const judge = this.d.userMeantJudge && this.safeEnabled() ? this.d.userMeantJudge : null;
      let judged = false;
      if (judge) {
        const peer = input.peers.find((p): p is string => typeof p === 'string' && p.length > 0) ?? '';
        // Synchronously, before any await: the spawn that follows this ingest reads it. Only
        // when the judge's budget can take this peer — otherwise the first-only rule applies
        // and the session must stay the relay of later messages.
        let budgetOk = true;
        try { budgetOk = judge.budgetAvailable ? judge.budgetAvailable(peer, input.senderName) : true; } catch { budgetOk = false; /* @silent-fallback-ok — no ownership claim */ }
        this.ownedThreads.delete(input.threadId);
        if (budgetOk) {
          this.ownedThreads.set(input.threadId, this.now());
          if (this.ownedThreads.size > MAX_TRACKED_THREADS) this.ownedThreads.delete(this.ownedThreads.keys().next().value as string);
        }
        // §2.7: every message is judged; no verdict resolves to user-meant (post).
        const v = await judge.judge({ threadId: input.threadId, peer, senderName: input.senderName, text: body, messageType: input.messageType });
        if (v.firstOnly) this.ownedThreads.delete(input.threadId);
        if (!v.firstOnly) {
          if (!v.userMeant) return { posted: false, reason: 'agent-internal', topicId };
          judged = true;
        }
      }
      if (!judged) {
        // First-only rule (§2.6): switch off, no judge, or the judge's own budget is spent.
        const verdict = await this.d.salienceGate.evaluate({
          replyBody: body,
          history: [],
          isFirstReply,
          remoteAgent: input.senderName,
        });
        if (verdict.verdict !== 'user-visible') return { posted: false, reason: 'agent-internal', topicId };
      }
      return await this.post(input.threadId, topicId, input.senderName, body, judged, 0, input.peers);
    } catch (err) {
      this.d.log?.(`[homebase-relay] skipped: ${err instanceof Error ? err.message : String(err)}`);
      return { posted: false, reason: 'send-failed' };
    }
  }

  /**
   * Post one message, under the brakes. A JUDGED user-meant message held by the per-topic brake
   * or a send failure is retried (bounded) so the homebase still gets it; the caller's hub
   * fallback runs meanwhile.
   */
  private async post(threadId: string, topicId: number, senderName: string, body: string, judged: boolean, attempt: number, peers: Array<string | undefined | null> = []): Promise<RelayInboundResult> {
    const now = this.now();
    const last = this.seenThreads.get(threadId);
    const recent = (this.byTopic.get(topicId) ?? []).filter((t) => now - t < PER_TOPIC_WINDOW_MS);
    this.byTopic.set(topicId, recent);
    // The per-thread minute applies only to the first-only rule: under per-message judging a
    // second user-meant message inside a minute is still meant for the user. The per-topic
    // bound stays as the flood brake.
    const threadBrake = !judged && last !== undefined && now - last < PER_THREAD_MS;
    if (threadBrake || recent.length >= PER_TOPIC_LIMIT) {
      this.d.log?.(`[homebase-relay] rate-limited post for thread ${threadId.slice(0, 8)} → topic ${topicId}`);
      const retry = judged && !threadBrake ? this.scheduleRetry(threadId, topicId, senderName, body, attempt, peers, Math.max(1000, PER_TOPIC_WINDOW_MS - (now - (recent[0] ?? now)) + 1000)) : false;
      return { posted: false, reason: 'rate-limited', topicId, ...(retry ? { retryScheduled: true } : {}) };
    }

    const text = formatRelayPost(senderName, body);
    try {
      await this.d.sendToTopic(topicId, text);
    } catch (err) {
      this.d.log?.(`[homebase-relay] post to topic ${topicId} failed: ${err instanceof Error ? err.message : String(err)}`);
      const retry = judged ? this.scheduleRetry(threadId, topicId, senderName, body, attempt, peers, SEND_RETRY_MS) : false;
      return { posted: false, reason: 'send-failed', topicId, ...(retry ? { retryScheduled: true } : {}) };
    }
    this.seenThreads.set(threadId, now);
    if (this.seenThreads.size > MAX_TRACKED_THREADS) {
      const first = this.seenThreads.keys().next().value;
      if (first !== undefined) this.seenThreads.delete(first);
    }
    recent.push(now);
    this.d.log?.(`[homebase-relay] ${senderName}'s message on thread ${threadId.slice(0, 8)} posted to its topic ${topicId}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
    return { posted: true, topicId };
  }

  private scheduleRetry(threadId: string, topicId: number, senderName: string, body: string, attempt: number, peers: Array<string | undefined | null>, delayMs: number): boolean {
    if (attempt >= MAX_RETRIES || this.pendingRetries >= MAX_PENDING_RETRIES) {
      this.d.log?.(`[homebase-relay] gave up posting thread ${threadId.slice(0, 8)} → topic ${topicId} (it stays in the hub)`);
      return false;
    }
    this.pendingRetries++;
    const run = () => {
      this.pendingRetries--;
      // Re-check at fire time: the operator may have bound the conversation, the switch may be
      // off, or the homebase may have moved, inside the wait.
      try {
        const dest = this.d.resolve({ threadId, peers });
        if (dest.via !== 'homebase' || dest.topicId !== topicId || !this.safeEnabled()) {
          this.d.log?.(`[homebase-relay] dropped a retry for thread ${threadId.slice(0, 8)}: its destination changed`);
          return;
        }
      } catch {
        return; // @silent-fallback-ok — an unreadable destination makes no late post
      }
      void this.post(threadId, topicId, senderName, body, true, attempt + 1, peers).catch(() => { /* @silent-fallback-ok — post() reports its own outcome */ });
    };
    try {
      (this.d.schedule ?? defaultSchedule)(run, delayMs);
      return true;
    } catch {
      this.pendingRetries--;
      return false; // @silent-fallback-ok — no retry; the hub fallback already ran
    }
  }
}

function defaultSchedule(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
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
