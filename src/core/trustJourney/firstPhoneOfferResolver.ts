import { createHash } from 'node:crypto';
import type { CurrentFirstPhoneOffer } from './FirstPhonePrivateAcceptService.js';
import type { StoredFirstPhoneOffer } from './FirstPhonePrivateOfferStore.js';
import { FIRST_PHONE_PRIVATE_CALLBACK } from './firstPhonePrivateAccept.js';
import { firstPhoneProposalHash, type FirstPhoneProposal } from './firstPhoneProposal.js';

interface VerifiedHolder {
  localMachineId: string;
  holderMachineId: string;
  epoch: string;
  expiresAt: number;
}

interface VerifiedDeviceProposal {
  principal: string;
  proposal: Omit<FirstPhoneProposal, 'holderEpoch' | 'expiresAt'>;
}

/** The inputs must use the stored acknowledged disclosure and verified holder and device sources.
 * No callback or locator fields can stand in for any of that evidence.
 */
export function createFirstPhoneOfferResolver(deps: {
  readStoredOffer: (callbackHash: string) => StoredFirstPhoneOffer | null;
  readVerifiedHolder: () => VerifiedHolder | null;
  readVerifiedDeviceProposal: (deviceId: string) => VerifiedDeviceProposal | null;
  now: () => number;
}): (callbackData: string) => CurrentFirstPhoneOffer | null {
  return (callbackData) => {
    if (!FIRST_PHONE_PRIVATE_CALLBACK.test(callbackData)) return null;
    const stored = deps.readStoredOffer(createHash('sha256').update(callbackData).digest('hex'));
    if (!stored) return null;
    const { offer, deviceId } = stored;
    const holder = deps.readVerifiedHolder();
    const now = deps.now();
    if (!holder || !holder.localMachineId || holder.localMachineId !== holder.holderMachineId
      || holder.holderMachineId !== stored.holderMachineId
      || !holder.epoch || holder.epoch !== offer.holderEpoch || !Number.isSafeInteger(holder.expiresAt)
      || !Number.isSafeInteger(now) || now >= holder.expiresAt || !Number.isSafeInteger(offer.expiresAt)
      || now >= offer.expiresAt) return null;

    const current = deps.readVerifiedDeviceProposal(deviceId);
    if (!current?.principal || current.proposal.deviceId !== deviceId || current.proposal.ownerId !== offer.chatId
      || current.proposal.accountAcceptanceId !== offer.accountAcceptanceId
      || current.proposal.firstAcceptanceKey !== offer.firstAcceptanceKey) return null;
    const proposalHash = firstPhoneProposalHash({
      ...current.proposal, holderEpoch: holder.epoch, expiresAt: offer.expiresAt,
    });
    if (proposalHash !== offer.proposalHash) return null;

    return { offer: { ...offer, callbackData }, ownerId: current.proposal.ownerId, principal: current.principal, holderEpoch: holder.epoch, proposalHash };
  };
}
