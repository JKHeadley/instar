import type { Receipt } from './accountPath.js';
import type { FirstPhonePrivateStartStore } from './FirstPhonePrivateStartStore.js';
import { issueFirstPhonePrivateOffer, type PreparedFirstPhoneOffer } from './firstPhoneOfferIssuance.js';

interface StartAuthority {
  ownerAccountId: string;
  localMachineId: string;
  holderMachineId: string;
  epoch: string;
  expiresAt: number;
}

type IssueDependencies = Parameters<typeof issueFirstPhonePrivateOffer>[0];

/** Compose authenticated direct-poll evidence with the current local holder's proposal. */
export function createFirstPhoneStartHandler(deps: IssueDependencies & {
  starts: FirstPhonePrivateStartStore;
  readAuthority: () => StartAuthority | null;
  readPreparedOffer: (proposalHash: string) => PreparedFirstPhoneOffer | null;
}): (receipt: Omit<Receipt, 'receivedBy'>) => Promise<void> {
  function readLocalAuthority(): StartAuthority | null {
    const authority = deps.readAuthority();
    const now = deps.now();
    if (!authority?.ownerAccountId || !authority.localMachineId || !authority.epoch
      || authority.localMachineId !== authority.holderMachineId || !Number.isSafeInteger(authority.expiresAt)
      || !Number.isSafeInteger(now) || now >= authority.expiresAt) return null;
    return { ...authority };
  }

  return async receipt => {
    const authority = readLocalAuthority();
    if (!authority) return;
    const proposalHash = deps.starts.claim(
      { ...receipt, receivedBy: authority.localMachineId },
      authority.ownerAccountId, authority.epoch, deps.now(),
    );
    if (!proposalHash) return;
    const prepared = deps.readPreparedOffer(proposalHash);
    if (!prepared || prepared.offer.proposalHash !== proposalHash
      || prepared.offer.chatId !== authority.ownerAccountId || prepared.offer.holderEpoch !== authority.epoch
      || prepared.holderMachineId !== authority.holderMachineId) return;

    await issueFirstPhonePrivateOffer({
      offers: deps.offers,
      now: deps.now,
      sendPrivate: deps.sendPrivate,
      stillCurrent: exact => {
        if (!deps.stillCurrent(exact)) return false;
        const current = readLocalAuthority();
        return !!current && current.ownerAccountId === authority.ownerAccountId
          && current.holderMachineId === authority.holderMachineId && current.epoch === authority.epoch;
      },
    }, prepared);
  };
}
