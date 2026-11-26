import { createHash, randomBytes } from 'node:crypto';
import type { FirstPhonePrivateOfferStore, StoredFirstPhoneOffer } from './FirstPhonePrivateOfferStore.js';

import { firstPhoneProposalHash, type FirstPhoneProposal } from './firstPhoneProposal.js';

export interface PreparedFirstPhoneOffer {
  readonly offer: Readonly<Omit<StoredFirstPhoneOffer['offer'], 'disclosureMessageId'>>;
  readonly deviceId: string;
  readonly holderMachineId: string;
  readonly disclosure: string;
  readonly proposal: Readonly<FirstPhoneProposal>;
}

export interface PrivateOfferAcknowledgement {
  readonly chatId: string;
  readonly messageId: number;
}

/** Save only the exact acknowledgement of an offer whose authority is still current.
 * The sender must deliver directly through the scoped bot and confirm the actual returned chat and message.
 */
export async function issueFirstPhonePrivateOffer(
  deps: {
    offers: FirstPhonePrivateOfferStore;
    stillCurrent: (prepared: PreparedFirstPhoneOffer) => boolean;
    sendPrivate: (chatId: string, disclosure: string, callbackData: string) => Promise<PrivateOfferAcknowledgement | null>;
    now: () => number;
  },
  prepared: PreparedFirstPhoneOffer,
): Promise<{ status: 'recorded'; messageId: number } | { status: 'unavailable' }> {
  const exact = Object.freeze({
    ...prepared, offer: Object.freeze({ ...prepared.offer }), proposal: Object.freeze({ ...prepared.proposal }),
  });
  const disclosureBytes = Buffer.from(exact.disclosure, 'utf8');
  if (disclosureBytes.toString('utf8') !== exact.disclosure
    || exact.proposal.disclosureHash !== createHash('sha256').update(disclosureBytes).digest('hex')
    || firstPhoneProposalHash(exact.proposal) !== exact.offer.proposalHash
    || exact.proposal.ownerId !== exact.offer.chatId || exact.proposal.deviceId !== exact.deviceId
    || exact.proposal.accountAcceptanceId !== exact.offer.accountAcceptanceId
    || exact.proposal.holderEpoch !== exact.offer.holderEpoch
    || exact.proposal.firstAcceptanceKey !== exact.offer.firstAcceptanceKey
    || exact.proposal.expiresAt !== exact.offer.expiresAt) return { status: 'unavailable' };
  const eligible = () => {
    const now = deps.now();
    return Number.isSafeInteger(now) && exact.offer.issuedAt <= now && now < exact.offer.expiresAt
      && deps.stillCurrent(exact);
  };
  if (!eligible()) return { status: 'unavailable' };

  const callbackData = `first-phone:${randomBytes(32).toString('base64url')}`;
  const ack = await deps.sendPrivate(exact.offer.chatId, exact.disclosure, callbackData);
  if (!ack || ack.chatId !== exact.offer.chatId || !eligible()) return { status: 'unavailable' };

  return deps.offers.saveAcknowledged(callbackData, {
    offer: { ...exact.offer, disclosureMessageId: ack.messageId },
    deviceId: exact.deviceId,
    holderMachineId: exact.holderMachineId,
  }) ? { status: 'recorded', messageId: ack.messageId } : { status: 'unavailable' };
}
