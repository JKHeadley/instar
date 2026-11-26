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

/** Exact first-phone action for the existing permission presence envelope. */
export function firstPhoneEnrollmentLine(
  nominationId: unknown,
  proposalHash: unknown,
  disclosureHash: unknown,
): string | null {
  const digest = /^[a-f0-9]{64}$/;
  if (typeof nominationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nominationId)
    || typeof proposalHash !== 'string' || !digest.test(proposalHash)
    || typeof disclosureHash !== 'string' || !digest.test(disclosureHash)) return null;
  return `first-phone-enrollment-v1 ${nominationId} ${proposalHash} ${disclosureHash}`;
}
