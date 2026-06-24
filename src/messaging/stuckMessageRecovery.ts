/**
 * stuckMessageRecovery — the no-LOSS half of exactly-once ingress (spec §8 G3a,
 * "Stuck-`processing` recovery"): an inbound event claimed but never
 * reply_committed (the holder crashed or was fenced mid-turn) is re-run by the
 * CURRENT lease holder from the ledger entry's stored input. The fenced/crashed
 * holder's abandoned output is discarded; the re-run produces the reply that was
 * lost, and the gate's dedup makes a provider redelivery of the same event a
 * no-op.
 *
 * Pure orchestration over injected deps so it is a tested unit (no Telegram /
 * server coupling here). server.ts supplies `reinject` (set the per-topic
 * current-inbound key, then route the stored text exactly as a fresh forward
 * would) and `holdsLease`.
 *
 * Bounded against replay-storms: only entries stuck past `maxProcessingMs` (a
 * turn that genuinely timed out, not one in flight) and only while
 * `attempts < maxReplayAttempts` (a message the agent legitimately never
 * answered is not re-run forever). Lease-gated: a standby never re-injects.
 */

import type { MessageProcessingLedger, SenderEnvelope } from './MessageProcessingLedger.js';
import { computeReplyIdempotencyKey } from './MessageProcessingLedger.js';

export interface StuckRecoveryDeps {
  ledger: MessageProcessingLedger;
  /** Only the awake machine recovers; a standby must not inject. */
  holdsLease: () => boolean;
  /** Current lease fencing epoch, stamped on the re-claim. */
  epoch: number;
  /** A 'processing' entry older than this is a timed-out turn, eligible for re-run. */
  maxProcessingMs: number;
  /** Give up re-running an entry after this many attempts (avoid storms). Default 3. */
  maxReplayAttempts?: number;
  /**
   * Reply-evidence guard (no-DUPLICATE-re-run half): true if the agent already
   * replied to `topic` at/after `sinceISO`. When true, a stuck entry is treated
   * as already-handled — committed, NOT re-injected. Defaults to the ledger's own
   * `hasReplyCommittedForTopicSince`; injectable for tests. This is what stops the
   * 2026-06-07 "re-run an already-answered message every ~10 min" loop, even when
   * the original reply failed to commit its own entry (server flap / dup orphan).
   */
  hasRepliedSince?: (topic: string, sinceISO: string) => boolean;
  /** Re-route the stored input as the holder (set current-inbound key, then inject). */
  reinject: (topicId: string, dedupeKey: string, text: string, sender: SenderEnvelope | null) => void;
  /**
   * Part D, third site (docs/specs/ownership-follows-live-work.md): per-topic
   * ownership check. This re-feed is gated only on `holdsLease()` (machine-level),
   * so a lease-holder that is NOT the topic's owner would re-run a topic it doesn't
   * own (the active-active double-dispatch). When this returns true (a REACHABLE
   * peer owns the topic), SKIP that topic's entry — leaving its stuck messages IN
   * the durable ledger UNTOUCHED (not committed, not abandoned, not re-injected) so
   * the OWNER's own stuck-recovery drains them. The skip is per-TOPIC (the unit of
   * ownership), never per-message. Absent ⇒ today's behavior (no ownership check).
   * Uses the SAME shared reachability helper as the checkAndRecover Part-D gate.
   */
  ownerElsewhereReachable?: (topic: string) => boolean;
  now?: () => number;
  logger?: (msg: string) => void;
}

export interface StuckRecoveryResult {
  recovered: number;
  skipped: number;
  /** Entries recognized as already-answered (reply evidence) and committed, not re-run. */
  alreadyHandled: number;
  /**
   * Entries whose re-run budget was exhausted this pass: terminally marked
   * 'abandoned' (so they stop re-looping every cycle) and surfaced here so the
   * caller emits a "I didn't get to this — resend" loss notice. The abandonment
   * is never silent. Each: the topic it arrived on + its dedupeKey.
   */
  abandoned: Array<{ topic: string; dedupeKey: string }>;
}

/**
 * Re-run inbound events stranded in `processing`. Idempotent-safe to call
 * repeatedly (boot + on a cadence): a re-run re-claims under the current epoch,
 * and the eventual reply commits the entry so it is not re-run again.
 */
export function recoverStuckMessages(deps: StuckRecoveryDeps): StuckRecoveryResult {
  const maxAttempts = deps.maxReplayAttempts ?? 3;
  if (!deps.holdsLease()) return { recovered: 0, skipped: 0, alreadyHandled: 0, abandoned: [] };

  const repliedSince =
    deps.hasRepliedSince ?? ((topic, sinceISO) => deps.ledger.hasReplyCommittedForTopicSince(topic, sinceISO));

  const stuck = deps.ledger.reclaimStuck(deps.maxProcessingMs, deps.now ? deps.now() : undefined);
  let recovered = 0;
  let skipped = 0;
  let alreadyHandled = 0;
  const abandoned: Array<{ topic: string; dedupeKey: string }> = [];
  for (const entry of stuck) {
    if (!entry.inputSnapshot || !entry.topic) {
      skipped++;
      continue;
    }
    // Part D, third site: if a REACHABLE peer owns this topic, this machine must
    // NOT re-feed it (it doesn't own the topic) — leave the entry UNTOUCHED in the
    // durable ledger so the owner's own stuck-recovery drains it. reclaimStuck() is
    // a read-only SELECT, so a `continue` here genuinely leaves the row in
    // 'processing' (no beginProcessing, no commit, no markAbandoned). Skipped per
    // TOPIC (the unit of ownership), never per-message. A throwing helper resolves
    // to the SAFE side (not-owned-elsewhere → proceed as today) inside the wiring.
    if (deps.ownerElsewhereReachable?.(entry.topic)) {
      deps.logger?.(`stuck-recovery: ${entry.dedupeKey} skipped — topic ${entry.topic} owned by a reachable peer (owner drains it)`);
      skipped++;
      continue;
    }
    // Reply-evidence guard: if the agent already answered this topic since the
    // stuck entry arrived, the entry is a duplicate/superseded inbound that was
    // effectively handled (its own reply just failed to commit — server flap, or
    // a same-topic dup orphaned by the current-inbound overwrite). Commit it so
    // it leaves 'processing' for good; do NOT re-inject (that is the replay loop).
    if (repliedSince(entry.topic, entry.receivedAt)) {
      deps.ledger.commitReply(entry.dedupeKey, computeReplyIdempotencyKey(entry.dedupeKey, 0), deps.epoch);
      deps.ledger.advanceCursor(entry.dedupeKey);
      deps.logger?.(`stuck-recovery: ${entry.dedupeKey} already answered on its topic since receipt — committing, not re-running`);
      alreadyHandled++;
      continue;
    }
    if (entry.attempts >= maxAttempts) {
      // Re-run budget exhausted (a message that legitimately never got a reply,
      // or a persistently failing turn). TERMINALLY abandon it: marking it out of
      // 'processing' stops reclaimStuck re-selecting it every cycle (the give-up
      // log-loop that fired every ~10 min) AND surfaces it so the caller emits a
      // "I didn't get to this — resend" notice — the abandonment is never silent
      // (the 2026-06-15 wedge-recovery-drops-messages gap). markAbandoned leaves
      // reply_committed_at NULL, so it never masquerades as a real reply.
      deps.ledger.markAbandoned(entry.dedupeKey, deps.epoch);
      deps.logger?.(`stuck-recovery: abandoned ${entry.dedupeKey} after ${entry.attempts} attempts (loss notice surfaced)`);
      abandoned.push({ topic: entry.topic, dedupeKey: entry.dedupeKey });
      skipped++;
      continue;
    }
    // Re-claim under the current epoch (bumps attempts) and re-route the turn,
    // preserving the real sender so the replay is not "from Unknown".
    deps.ledger.beginProcessing(entry.dedupeKey, deps.epoch);
    deps.reinject(entry.topic, entry.dedupeKey, entry.inputSnapshot, entry.senderEnvelope);
    deps.logger?.(`stuck-recovery: re-ran ${entry.dedupeKey} (attempt ${entry.attempts + 1})`);
    recovered++;
  }
  return { recovered, skipped, alreadyHandled, abandoned };
}
