import { approvalEventId, sameProof, sameVersion, type WorkBoardApprovalEvent, type WorkBoardApprovalRequest, type WorkBoardApprovalResult, type WorkBoardWriterProof } from './WorkBoardApprovalWriter.js';
import type { WorkBoardSlipDecision, WorkBoardSlipStore } from './WorkBoardSlipStore.js';

interface WorkBoardSlipApplicationPorts {
  store: Pick<WorkBoardSlipStore, 'claimItem' | 'finishItem' | 'readItemResults'>;
  currentWriter: () => WorkBoardWriterProof | null;
  approve: (request: WorkBoardApprovalRequest) => Promise<WorkBoardApprovalResult>;
  /** Observe existing durable projection for the exact winner. Must not itself apply an event. */
  confirmProjection: (winner: WorkBoardApprovalEvent) => Promise<boolean>;
}

/** Apply only the exact rows already accepted by the current owner authority. */
export async function applyWorkBoardSlip(input: WorkBoardSlipDecision, ports: WorkBoardSlipApplicationPorts) {
  const decision = Object.freeze({ ...input, writer: Object.freeze({ ...input.writer }) });
  const current = () => sameProof(decision.writer, ports.currentWriter());
  if (!current()) return null;
  const receipt = ports.store.readItemResults(decision);
  if (!receipt) return null;
  for (const item of receipt) {
    if (!current()) return null;
    if (item.status !== 'pending') continue;
    const claim = ports.store.claimItem(decision, item.cardId);
    if (!claim) continue;
    if (!current()) return null;
    const result = await ports.approve({
      proof: decision.writer, version: claim.version, source: 'slip', decisionId: decision.decisionId,
    });
    if (!current()) return null;
    if (result.status === 'changed') {
      ports.store.finishItem(decision, item.cardId, claim.id, { status: 'changed' });
    } else if (result.status === 'applied' || result.status === 'already-approved') {
      const winner = result.winner;
      const eventId = winner.eventId;
      const status = result.status;
      const sameDecision = winner.request.source === 'slip' && winner.request.decisionId === decision.decisionId;
      if ((status === 'applied') !== sameDecision
        || !sameProof(decision.writer, winner.request.proof) || !sameVersion(claim.version, winner.request.version)
        || eventId !== approvalEventId(winner.request)) continue;
      if (await ports.confirmProjection(winner)) {
        if (!current()) return null;
        ports.store.finishItem(decision, item.cardId, claim.id, { status, eventId });
      }
    }
    // An uncertain result keeps its claim and remains unresolved on receipt read.
  }
  return current() ? ports.store.readItemResults(decision) : null;
}
