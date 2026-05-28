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

import type { MessageProcessingLedger } from './MessageProcessingLedger.js';

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
  /** Re-route the stored input as the holder (set current-inbound key, then inject). */
  reinject: (topicId: string, dedupeKey: string, text: string) => void;
  now?: () => number;
  logger?: (msg: string) => void;
}

export interface StuckRecoveryResult {
  recovered: number;
  skipped: number;
}

/**
 * Re-run inbound events stranded in `processing`. Idempotent-safe to call
 * repeatedly (boot + on a cadence): a re-run re-claims under the current epoch,
 * and the eventual reply commits the entry so it is not re-run again.
 */
export function recoverStuckMessages(deps: StuckRecoveryDeps): StuckRecoveryResult {
  const maxAttempts = deps.maxReplayAttempts ?? 3;
  if (!deps.holdsLease()) return { recovered: 0, skipped: 0 };

  const stuck = deps.ledger.reclaimStuck(deps.maxProcessingMs, deps.now ? deps.now() : undefined);
  let recovered = 0;
  let skipped = 0;
  for (const entry of stuck) {
    if (!entry.inputSnapshot || !entry.topic) {
      skipped++;
      continue;
    }
    if (entry.attempts >= maxAttempts) {
      // Re-run budget exhausted — leave it (a message that legitimately never
      // got a reply, or a persistently failing turn) rather than loop forever.
      deps.logger?.(`stuck-recovery: giving up on ${entry.dedupeKey} after ${entry.attempts} attempts`);
      skipped++;
      continue;
    }
    // Re-claim under the current epoch (bumps attempts) and re-route the turn.
    deps.ledger.beginProcessing(entry.dedupeKey, deps.epoch);
    deps.reinject(entry.topic, entry.dedupeKey, entry.inputSnapshot);
    deps.logger?.(`stuck-recovery: re-ran ${entry.dedupeKey} (attempt ${entry.attempts + 1})`);
    recovered++;
  }
  return { recovered, skipped };
}
