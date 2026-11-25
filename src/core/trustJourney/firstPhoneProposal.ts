import { createHash } from 'node:crypto';

interface FirstPhoneProposal {
  ownerId: string;
  ownerGeneration: string;
  accountAcceptanceId: string;
  holderEpoch: string;
  origin: string;
  deviceId: string;
  deviceKeyFingerprint: string;
  deviceKeyHash: string;
  presenceKeyHash: string;
  disclosureHash: string;
  firstAcceptanceKey: string;
  expiresAt: number;
}

/** The server's exact proposal digest. A matching digest alone conveys no authority. */
export function firstPhoneProposalHash(proposal: FirstPhoneProposal): string {
  return createHash('sha256').update(JSON.stringify([
    'instar.first-phone-approver.v1',
    proposal.ownerId,
    proposal.ownerGeneration,
    proposal.accountAcceptanceId,
    proposal.holderEpoch,
    proposal.origin,
    proposal.deviceId,
    proposal.deviceKeyFingerprint,
    proposal.deviceKeyHash,
    proposal.presenceKeyHash,
    proposal.disclosureHash,
    proposal.firstAcceptanceKey,
    proposal.expiresAt,
  ])).digest('hex');
}
