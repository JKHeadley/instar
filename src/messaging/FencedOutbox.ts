/**
 * FencedOutbox — fencing-token-gated outbound reply path (spec §8 G3a).
 *
 * "No duplicate replies" is enforced here STRUCTURALLY, not by assuming a single
 * consumer. A reply is sent only while this machine holds the lease at the epoch
 * the reply was stamped under; a fenced (stale-epoch) machine's in-flight reply
 * is SUPPRESSED at the send path. The reply is committed to the message ledger
 * with a deterministic idempotency key (hash(dedupeKey + replyIndex)) so any
 * machine re-running the same event reproduces it identically — and the ledger
 * recognizes an already-committed reply and refuses to re-send.
 *
 * On a channel with native outbound dedup the idempotency key makes a re-send a
 * no-op; on a channel without it (Telegram), the dual-medium reply_committed
 * marker (propagated by the sync layer) is what prevents a failover re-send.
 */

import { MessageProcessingLedger, computeReplyIdempotencyKey } from './MessageProcessingLedger.js';

export interface FencedOutboxDeps {
  ledger: MessageProcessingLedger;
  /** The current effective fencing epoch. */
  currentEpoch: () => number;
  /** Whether this machine structurally holds the lease right now. */
  holdsLease: () => boolean;
  logger?: (msg: string) => void;
}

export interface SendOutcome {
  sent: boolean;
  suppressed: boolean;
  reason: 'sent' | 'already-replied' | 'fenced-no-lease' | 'fenced-stale-epoch' | 'send-failed';
  idempotencyKey: string;
}

export class FencedOutbox {
  private readonly d: FencedOutboxDeps;

  constructor(deps: FencedOutboxDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[outbox] ${m}`);
  }

  /**
   * Send a reply for `dedupeKey`, stamped under `stampedEpoch` (the epoch the
   * turn began processing under). Returns the outcome. The actual platform send
   * is `sendFn`; it is invoked ONLY after the fencing checks pass.
   */
  async send(
    dedupeKey: string,
    replyIndex: number,
    stampedEpoch: number,
    sendFn: () => Promise<void>,
  ): Promise<SendOutcome> {
    const idempotencyKey = computeReplyIdempotencyKey(dedupeKey, replyIndex);

    // Idempotency: if a reply was already committed (locally or via a remote
    // dual-medium marker), do not send again.
    if (this.d.ledger.isActedOn(dedupeKey)) {
      this.log(`already replied to ${dedupeKey} — suppressing`);
      return { sent: false, suppressed: true, reason: 'already-replied', idempotencyKey };
    }

    // Fencing: only the current lease holder, at the stamped epoch, may send.
    if (!this.d.holdsLease()) {
      this.log(`fenced (no lease) — suppressing reply to ${dedupeKey}`);
      return { sent: false, suppressed: true, reason: 'fenced-no-lease', idempotencyKey };
    }
    const epoch = this.d.currentEpoch();
    if (epoch !== stampedEpoch) {
      this.log(`fenced (stale epoch ${stampedEpoch} != current ${epoch}) — suppressing reply to ${dedupeKey}`);
      return { sent: false, suppressed: true, reason: 'fenced-stale-epoch', idempotencyKey };
    }

    try {
      await sendFn();
    } catch (err) {
      this.log(`send failed for ${dedupeKey}: ${err instanceof Error ? err.message : String(err)}`);
      return { sent: false, suppressed: false, reason: 'send-failed', idempotencyKey };
    }

    // Commit the reply marker (durable, synchronous) BEFORE advancing the cursor.
    this.d.ledger.commitReply(dedupeKey, idempotencyKey, stampedEpoch);
    return { sent: true, suppressed: false, reason: 'sent', idempotencyKey };
  }
}
