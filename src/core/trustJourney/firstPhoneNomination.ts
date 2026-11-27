export interface FirstPhoneNomination {
  ownerId: string;
  ownerGeneration: string;
  holderEpoch: string;
  accountAcceptanceId: string;
  issuedAt: number;
  chatId: string;
  topicId: number;
  challenge: string;
  proposalHash: string;
  expiresAt: number;
}

export interface AuthenticatedNominationConfirmation {
  senderId: string;
  chatId: string;
  topicId: number;
  messageId: number;
  challenge: string;
  proposalHash: string;
  receivedAt: number;
  forwarded: boolean;
}

interface ActiveApprovalAccount {
  ownerId: string;
  ownerGeneration: string;
  acceptanceId: string;
  acceptedAt: number;
  approvedProposalHash: string;
  approvedAt: number;
}

/** Compares independently resolved evidence in a synthetic fixture. Live ingress,
 * account acceptance, and durable one-use consumption belong to the holder.
 */
export function matchesFirstPhoneNomination(
  nomination: FirstPhoneNomination,
  confirmation: AuthenticatedNominationConfirmation,
  account: ActiveApprovalAccount | null,
  currentHolderEpoch: string,
  now: number,
): boolean {
  return account !== null && account.acceptanceId.length > 0 && account.acceptanceId === nomination.accountAcceptanceId
    && Number.isSafeInteger(account.acceptedAt) && account.acceptedAt > 0
    && Number.isSafeInteger(nomination.issuedAt) && account.acceptedAt < nomination.issuedAt
    && Number.isSafeInteger(now) && Number.isSafeInteger(nomination.expiresAt) && now < nomination.expiresAt
    && Number.isSafeInteger(confirmation.receivedAt) && nomination.issuedAt <= confirmation.receivedAt
    && confirmation.receivedAt <= now && confirmation.forwarded === false
    && Number.isSafeInteger(confirmation.messageId) && confirmation.messageId > 0
    && nomination.ownerId === account.ownerId && nomination.ownerGeneration === account.ownerGeneration
    && account.approvedProposalHash === nomination.proposalHash
    && Number.isSafeInteger(account.approvedAt) && account.approvedAt >= nomination.issuedAt && account.approvedAt <= now
    && nomination.holderEpoch === currentHolderEpoch
    && confirmation.senderId === nomination.ownerId && confirmation.chatId === nomination.chatId
    && confirmation.topicId === nomination.topicId
    && /^[a-f0-9]{64}$/.test(nomination.proposalHash) && confirmation.proposalHash === nomination.proposalHash
    && nomination.challenge.length > 0 && confirmation.challenge === nomination.challenge;
}
