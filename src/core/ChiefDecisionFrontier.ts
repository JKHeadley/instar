/** Identity resolved from authenticated lease history. */
export interface ChiefDecisionPredecessor {
  agent: string;
  store: string;
  stream: string;
  incarnation: string;
  writer: string;
  leaseEpoch: number;
}

/** Supplied only by an authority that authenticated the seal and proved writer exclusion. */
export interface VerifiedChiefDecisionSeal extends ChiefDecisionPredecessor {
  terminalSequence: number;
  digest: string;
  unresolvedOperationId?: string;
}

/** Digest and position computed by the authenticated journal reader over a contiguous prefix. */
export interface ChiefDecisionPrefix {
  stream: string;
  incarnation: string;
  terminalSequence: number;
  digest: string;
}

export type ChiefDecisionFrontierResult = 'current' | 'unavailable' | 'pending';

/** A readable replica alone supplies none of the prerequisites for a current decision. */
export function assessChiefDecisionFrontier(
  predecessor: ChiefDecisionPredecessor | null,
  seal: VerifiedChiefDecisionSeal | null,
  prefix: ChiefDecisionPrefix | null,
): ChiefDecisionFrontierResult {
  if (!predecessor || !seal || !prefix) return 'unavailable';
  if (predecessor.agent !== seal.agent || predecessor.store !== seal.store ||
      predecessor.stream !== seal.stream || predecessor.incarnation !== seal.incarnation ||
      predecessor.writer !== seal.writer || predecessor.leaseEpoch !== seal.leaseEpoch) return 'unavailable';
  if (!Number.isSafeInteger(seal.terminalSequence) || seal.terminalSequence < 0 ||
      !/^[a-f0-9]{64}$/.test(seal.digest) || prefix.stream !== seal.stream ||
      prefix.incarnation !== seal.incarnation || prefix.terminalSequence !== seal.terminalSequence ||
      prefix.digest !== seal.digest) return 'unavailable';
  return seal.unresolvedOperationId === undefined ? 'current' : 'pending';
}
