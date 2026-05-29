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

import type { MeshCommand, MeshCommandHandler } from './MeshRpc.js';

export interface DeliverMessageHandlerDeps {
  /** The owner's current ownership epoch for a session, or null if no record. */
  ownerEpochOf: (session: string) => number | null;
  /** Durably record a receipt (idempotency key = messageId). Returns true iff FIRST time. */
  recordReceipt: (messageId: string, session: string) => boolean;
  /** Optional hand-off to local processing (Track-H staged activation). Dark by default. */
  onAccepted?: (command: Extract<MeshCommand, { type: 'deliverMessage' }>) => void;
}

export type DeliverMessageAck = { messageId: string; accepted: 'queued' | 'duplicate' | 'stale-ownership' };

export function createDeliverMessageHandler(deps: DeliverMessageHandlerDeps): MeshCommandHandler {
  return (command: MeshCommand): DeliverMessageAck => {
    if (command.type !== 'deliverMessage') {
      // Defensive — the dispatcher only routes deliverMessage here, but be total.
      return { messageId: 'unknown', accepted: 'queued' };
    }
    const ownerEpoch = deps.ownerEpochOf(command.session);
    if (ownerEpoch != null && command.ownershipEpoch < ownerEpoch) {
      return { messageId: command.messageId, accepted: 'stale-ownership' };
    }
    const firstSeen = deps.recordReceipt(command.messageId, command.session);
    if (!firstSeen) return { messageId: command.messageId, accepted: 'duplicate' };
    deps.onAccepted?.(command);
    return { messageId: command.messageId, accepted: 'queued' };
  };
}
