/**
 * createDeliverMessageHandler — the owner-side receive handler for the §L4
 * deliverMessage command (Multi-Machine Session Pool). Per "Structure > Willpower"
 * this is a single shared factory imported by BOTH the server boot wiring and its
 * tests, so the production handler and the tested handler can never drift.
 *
 * The handler implements the §L4 ACK protocol's receive side:
 *   - stale-ownership fence: if the session has moved (the owner's epoch advanced
 *     past the router's view at dispatch), reject so the router re-resolves.
 *   - durable-receipt-before-processing with idempotent dedupe on messageId: a
 *     redelivered message already recorded is ACKed `duplicate` and NOT re-processed.
 *   - otherwise record the receipt and ACK `queued`.
 *
 * The ACK confirms receipt into the owner's ledger, NOT reply completion — the
 * router advances the platform offset only on this ACK (exactly-once ingress).
 */

import type { MeshCommand, MeshCommandHandler, MeshEnvelope } from './MeshRpc.js';

export interface DeliverMessageHandlerDeps {
  /** The owner's current ownership epoch for a session, or null if no record. */
  ownerEpochOf: (session: string) => number | null;
  /** Durably record a receipt (idempotency key = messageId). Returns true iff FIRST time. */
  recordReceipt: (messageId: string, session: string) => boolean;
  /** Optional synchronous durable admission before the duplicate receipt. A
   * failure propagates without recording receipt; no ACK may invent custody. */
  beforeReceipt?: (command:Extract<MeshCommand,{type:'deliverMessage'}>,sender:string,envelope:MeshEnvelope)=>void;
  /** Optional hand-off to local processing (Track-H staged activation). Dark by default. */
  onAccepted?: (command: Extract<MeshCommand, { type: 'deliverMessage' }>, sender: string, envelope: MeshEnvelope) => void;
  /**
   * Durable Inbound Message Queue §3.4 remote path: re-validate a CARRIED
   * senderEnvelope.userId against THIS machine's users registry before
   * injecting with that frame (per-machine registries can diverge during a
   * deauthorization). Returns false → typed `sender-rejected` NACK: the drain
   * side terminals the entry `sender-deauthorized`; never retried/re-placed;
   * the peer is never marked suspect. Only consulted when the envelope is
   * PRESENT (an old sender never carries one — version skew named).
   */
  validateSender?: (senderEnvelope: { userId?: string | number }, session: string) => boolean;
  /**
   * session-pool-no-silent-drop: refuse what this machine would accept and then drop. The
   * checks come as one object so a refusal can never be set up without the duplicate guard.
   * Absent means it can serve, today's behaviour.
   */
  refusal?: {
    /** Asked before the receipt, so a refused message is never recorded as received. */
    canServe: (command: Extract<MeshCommand, { type: 'deliverMessage' }>) => boolean;
    /**
     * Read-only receipt check. A message taken before this machine lost the ability to serve
     * is a duplicate on retry: refusing it would hand it back and process it twice.
     */
    alreadyReceived: (messageId: string, session: string) => boolean;
    /** A fault here never changes the answer. */
    onCannotServe?: (command: Extract<MeshCommand, { type: 'deliverMessage' }>) => void;
  };
  /**
   * silent-loss-refusal-conservation §2.B — the receiver-side rejection trace.
   * Fired SYNCHRONOUSLY, once, immediately before the `sender-rejected` NACK is
   * returned, so the DECIDING (owner) machine keeps a forensic record of its own
   * refusal (the incident was diagnosed only from the sender's ledger). METADATA
   * ONLY: the raw command/payload is NEVER passed through this seam (round-1
   * security #1). try/catch-wrapped by the handler — a trace fault never changes
   * the NACK. Not fired on a suppression-cache short-circuit (a replay of the
   * SAME rejected messageId) — the trace is written once per rejection, bounded.
   */
  onRejected?: (meta: { reason: 'sender-rejected'; session: string; messageId: string; senderUid?: number }) => void;
}

export type DeliverMessageAck = {
  messageId: string;
  accepted: 'queued' | 'duplicate' | 'stale-ownership' | 'sender-rejected';
};

/** Bounded per-(session,messageId) rejection suppression (§2.B): a peer replaying
 *  ONE rejected messageId at high rate must not force an unbounded `readFileSync`
 *  per replay on the event loop. Serves the cached NACK verdict without re-reading
 *  the registry. Bounded (1024-cap prune, the QueueDrainLoop.refusalCache pattern +
 *  a 10-min TTL) so a flood of DISTINCT ids can't trade a read-DoS for a memory-DoS
 *  — the durable ledger already retains per-messageId state, so eviction only loses
 *  the cheap short-circuit, never correctness. */
const REJECTION_SUPPRESSION_TTL_MS = 10 * 60 * 1000;
const REJECTION_SUPPRESSION_CAP = 1024;

export function createDeliverMessageHandler(deps: DeliverMessageHandlerDeps): MeshCommandHandler {
  const rejectionCache = new Map<string, number>(); // key → firstRejectedAtMs

  function pruneRejectionCache(nowMs: number): void {
    for (const [k, ts] of rejectionCache) {
      if (nowMs - ts > REJECTION_SUPPRESSION_TTL_MS) rejectionCache.delete(k);
    }
    if (rejectionCache.size > REJECTION_SUPPRESSION_CAP) {
      // Oldest-first prune (Map preserves insertion order) down to the cap.
      const excess = rejectionCache.size - REJECTION_SUPPRESSION_CAP;
      let removed = 0;
      for (const k of rejectionCache.keys()) {
        rejectionCache.delete(k);
        if (++removed >= excess) break;
      }
    }
  }

  return (command: MeshCommand, sender: string, meshEnvelope: MeshEnvelope): DeliverMessageAck => {
    if (command.type !== 'deliverMessage') {
      // Defensive — the dispatcher only routes deliverMessage here, but be total.
      return { messageId: 'unknown', accepted: 'queued' };
    }
    const ownerEpoch = deps.ownerEpochOf(command.session);
    if (ownerEpoch != null && command.ownershipEpoch < ownerEpoch) {
      return { messageId: command.messageId, accepted: 'stale-ownership' };
    }
    // §3.4 sender re-validation — BEFORE the receipt: a rejected sender's
    // message must never be recorded as received (recording first would dedupe
    // the redelivery's NACK into a 'duplicate' ack).
    const envelope = (command as { senderEnvelope?: { userId?: string | number } }).senderEnvelope;
    if (envelope && deps.validateSender) {
      const suppressKey = `${command.session}\u0000${command.messageId}`;
      const nowMs = Date.now();
      const cachedAt = rejectionCache.get(suppressKey);
      if (cachedAt !== undefined && nowMs - cachedAt <= REJECTION_SUPPRESSION_TTL_MS) {
        // §2.B short-circuit — serve the cached NACK WITHOUT re-reading the
        // registry (and without re-firing the trace: bounded to once per reject).
        return { messageId: command.messageId, accepted: 'sender-rejected' };
      }
      if (!deps.validateSender(envelope, command.session)) {
        rejectionCache.set(suppressKey, nowMs);
        pruneRejectionCache(nowMs);
        // §2.B receiver-side trace — metadata-only, synchronous, before the NACK.
        try {
          const rawUid = envelope.userId;
          const senderUid = typeof rawUid === 'number' ? rawUid : Number(rawUid);
          deps.onRejected?.({
            reason: 'sender-rejected',
            session: command.session,
            messageId: command.messageId,
            senderUid: Number.isFinite(senderUid) ? senderUid : undefined,
          });
        } catch { /* trace fault never changes the NACK */ }
        return { messageId: command.messageId, accepted: 'sender-rejected' };
      }
    }
    // Answered as stale ownership on purpose: every router, on any build, already takes that
    // as "this message is still yours" and re-places it or keeps it. A new ack value would
    // need every peer upgraded first, and an older peer would read it as nothing.
    if (deps.refusal && !deps.refusal.canServe(command)) {
      if (deps.refusal.alreadyReceived(command.messageId, command.session)) {
        return { messageId: command.messageId, accepted: 'duplicate' };
      }
      try { deps.refusal.onCannotServe?.(command); } catch { /* a trace fault never changes the answer */ }
      return { messageId: command.messageId, accepted: 'stale-ownership' };
    }
    deps.beforeReceipt?.(command,sender,meshEnvelope);
    const firstSeen = deps.recordReceipt(command.messageId, command.session);
    if (!firstSeen) return { messageId: command.messageId, accepted: 'duplicate' };
    deps.onAccepted?.(command, sender, meshEnvelope);
    return { messageId: command.messageId, accepted: 'queued' };
  };
}
