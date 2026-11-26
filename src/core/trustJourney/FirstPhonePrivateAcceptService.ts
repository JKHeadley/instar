import type { AuthenticatedPrivateTap, FirstPhonePrivateOffer } from './firstPhonePrivateAccept.js';
import type { FirstPhonePrivateNominationStore } from './FirstPhonePrivateNominationStore.js';
import type { TrustJourneyStore } from './TrustJourneyStore.js';

export interface CurrentFirstPhoneOffer {
  offer: FirstPhonePrivateOffer;
  ownerId: string;
  principal: string;
  holderEpoch: string;
  /** Recomputed from the current verified owner, policy and paired device. */
  proposalHash: string;
}

/** Converts a verified adapter receipt into a nomination, never a device acceptance.
 * The resolver must return null unless the stored offer and current holder are independently verified.
 */
export class FirstPhonePrivateAcceptService {
  constructor(private readonly deps: {
    trust: TrustJourneyStore;
    nominations: FirstPhonePrivateNominationStore;
    resolveCurrentOffer: (callbackData: string) => CurrentFirstPhoneOffer | null;
    now: () => number;
  }) {}

  record(receiptId: string, tap: AuthenticatedPrivateTap): ReturnType<FirstPhonePrivateNominationStore['record']> {
    const current = this.deps.resolveCurrentOffer(tap.callbackData);
    if (!current || this.deps.trust.unreadable > 0 || this.deps.trust.currentDeviceAcceptances().length > 0) {
      return { status: 'refused' };
    }
    const acceptance = this.deps.trust.acceptance(current.principal, 'telegram');
    if (!acceptance || acceptance.accountId !== current.ownerId
      || !(Date.parse(acceptance.acceptedAt) < current.offer.issuedAt)) return { status: 'refused' };

    return this.deps.nominations.record(receiptId, current.offer, tap, {
      ownerId: current.ownerId,
      accountAcceptanceId: acceptance.acceptanceId,
      holderEpoch: current.holderEpoch,
      proposalHash: current.proposalHash,
      firstAcceptanceKey: this.deps.trust.firstDeviceAcceptanceKey(),
    }, this.deps.now());
  }
}
