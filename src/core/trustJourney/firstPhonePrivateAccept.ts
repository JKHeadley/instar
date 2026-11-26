import { FIRST_APPROVER_SLOT_KEY } from './firstPhoneProposal.js';
export const FIRST_PHONE_PRIVATE_CALLBACK = /^first-phone:[A-Za-z0-9_-]{22,52}$/;

export interface FirstPhonePrivateOffer {
  callbackData: string;
  chatId: string;
  disclosureMessageId: number;
  proposalHash: string;
  accountAcceptanceId: string;
  holderEpoch: string;
  firstAcceptanceKey: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthenticatedPrivateTap {
  callbackData: string;
  senderId: string;
  senderIsBot: boolean;
  chatId: string;
  chatType: string;
  messageId: number;
  receivedAt: number;
}

/** Compare locally authenticated callback evidence with the original offer.
 * This does not mint a nomination or consume a callback.
 */
export function matchesFirstPhonePrivateAccept(
  offer: FirstPhonePrivateOffer,
  tap: AuthenticatedPrivateTap,
  current: { ownerId: string; accountAcceptanceId: string; holderEpoch: string; proposalHash: string; firstAcceptanceKey: string | null },
  now: number,
): boolean {
  return FIRST_PHONE_PRIVATE_CALLBACK.test(offer.callbackData)
    && tap.callbackData === offer.callbackData
    && tap.chatType === 'private' && tap.senderIsBot === false
    && tap.senderId === current.ownerId && tap.chatId === current.ownerId && offer.chatId === tap.chatId
    && Number.isSafeInteger(tap.messageId) && tap.messageId > 0 && tap.messageId === offer.disclosureMessageId
    && /^[a-f0-9]{64}$/.test(offer.proposalHash) && offer.proposalHash === current.proposalHash
    && offer.accountAcceptanceId.length > 0 && offer.accountAcceptanceId === current.accountAcceptanceId
    && offer.holderEpoch === current.holderEpoch
    && FIRST_APPROVER_SLOT_KEY.test(offer.firstAcceptanceKey)
    && offer.firstAcceptanceKey === current.firstAcceptanceKey
    && [now, tap.receivedAt, offer.issuedAt, offer.expiresAt].every(Number.isSafeInteger)
    && offer.issuedAt <= tap.receivedAt && tap.receivedAt <= now && now < offer.expiresAt;
}
