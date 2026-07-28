/**
 * ingressDedup — the exactly-once ingress decision (spec §8 G3a), extracted from
 * the route so the gate logic is a tested unit (both sides of the boundary) and
 * routes.ts stays thin.
 *
 * The inbound forward path asks `decideIngress` whether to ACT on an inbound
 * event or DROP it as a duplicate; the outbound reply path calls
 * `commitInboundReply` when a reply actually goes out. Together they give the
 * no-duplicate-reply half of G3a:
 *   - A `dedupeKey` already reply_committed/cursor_advanced → DROP (the user was
 *     already answered; this is a provider redelivery or a handoff-window replay).
 *   - A `dedupeKey` still `processing` and NOT stuck → DROP (already in flight on
 *     this machine — a rapid Telegram retry).
 *   - A `processing` entry past `maxProcessingMs` (the old holder was fenced
 *     mid-turn) → re-claim and PROCESS from the new holder.
 *   - A fresh / `received` entry → claim (beginProcessing under the lease epoch)
 *     and PROCESS.
 *
 * The no-LOSS half (replay an un-committed entry after a crash) is a separate
 * step; this module never advances anything past the durable ledger, so it is
 * safe on its own — worst case it drops nothing it shouldn't (the gate only ever
 * drops an event the ledger shows was already handled or is actively in flight).
 */

import {
  MessageProcessingLedger,
  computeReplyIdempotencyKey,
  type SenderEnvelope,
} from './MessageProcessingLedger.js';

/** Stable provider-level identity for an inbound event (spec §2 contract item 4). */
export function dedupeKeyFor(platform: string, topicId: number | string, eventId: number | string): string {
  return `${platform}:${topicId}:${eventId}`;
}

export type IngressAction = 'process' | 'drop';

export interface IngressDecision {
  action: IngressAction;
  /** Why — for the route log + observability. */
  reason: 'first-seen' | 'reclaimed-stuck' | 'already-replied' | 'in-flight';
}

export interface DecideIngressOpts {
  platform: string;
  topic?: string | null;
  /** The raw inbound text/context, stored so a future replay can re-run it. */
  input?: string;
  /** Inbound sender, stored so a stuck re-run replays as the real user (not "Unknown"). */
  sender?: SenderEnvelope | null;
  /** The lease fencing epoch this machine holds (0 if no lease). */
  epoch: number;
  /** A 'processing' entry older than this was abandoned by a fenced holder. */
  maxProcessingMs: number;
  now?: () => number;
}

/**
 * Decide whether to act on an inbound event, recording its lifecycle in the
 * ledger. Returns `process` (the caller routes the message) or `drop` (a
 * duplicate / in-flight event the caller must NOT route).
 */
export function decideIngress(
  ledger: MessageProcessingLedger,
  dedupeKey: string,
  opts: DecideIngressOpts,
): IngressDecision {
  const now = opts.now ?? Date.now;
  // Idempotent insert — firstSeen tells us if this is a brand-new event.
  ledger.record(dedupeKey, { platform: opts.platform, topic: opts.topic ?? null, input: opts.input, sender: opts.sender ?? null });

  const entry = ledger.get(dedupeKey);
  // Defensive: record() just inserted-or-found it, so entry is non-null.
  if (!entry) {
    return { action: 'process', reason: 'first-seen' };
  }

  if (entry.state === 'reply_committed' || entry.state === 'cursor_advanced') {
    return { action: 'drop', reason: 'already-replied' };
  }

  // A terminally REJECTED row (the owner re-validated the sender and refused —
  // silent-loss-refusal-conservation §2.C) is terminal: a redelivered rejected
  // update_id is DROPPED here, never re-routed. Without this a redelivery would
  // fall to the 'received' branch, beginProcessing would flip it back to
  // 'processing', and stuck-recovery would eventually markAbandoned it → the
  // generic "I didn't get to N message(s)" notice on top of the §C notice.
  if (entry.state === 'rejected') {
    return { action: 'drop', reason: 'already-replied' };
  }

  if (entry.state === 'processing') {
    // Stuck (old holder fenced mid-turn) → the new holder re-claims it.
    const startedMs = entry.processingStartedAt ? Date.parse(entry.processingStartedAt) : NaN;
    const stuck = !Number.isNaN(startedMs) && now() - startedMs > opts.maxProcessingMs;
    if (stuck) {
      ledger.beginProcessing(dedupeKey, opts.epoch);
      return { action: 'process', reason: 'reclaimed-stuck' };
    }
    // Actively in flight on this machine — a rapid redelivery. Drop.
    return { action: 'drop', reason: 'in-flight' };
  }

  // 'received' (fresh, or a replay that never reached processing) → claim it.
  ledger.beginProcessing(dedupeKey, opts.epoch);
  return { action: 'process', reason: 'first-seen' };
}

/**
 * Commit that a reply for the given inbound event was sent (outbound path).
 * Idempotent — committing twice is a no-op. Advances the cursor on commit.
 */
export function commitInboundReply(
  ledger: MessageProcessingLedger,
  dedupeKey: string,
  epoch: number,
  replyIndex = 0,
): void {
  ledger.commitReply(dedupeKey, computeReplyIdempotencyKey(dedupeKey, replyIndex), epoch);
  ledger.advanceCursor(dedupeKey);
}
