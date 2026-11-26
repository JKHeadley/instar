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

/** Activation identity read under the shared writer's current-generation lock. */
export interface ChiefDecisionActivation {
  generation: number;
  manifestDigest: string;
  successorWriter: string;
  successorEpoch: number;
  successorIncarnation: string;
}

/** The authority authenticates and captures these inputs together under the writer lock. */
export interface ChiefDecisionSnapshot<Union> {
  activation: ChiefDecisionActivation;
  predecessor: ChiefDecisionPredecessor;
  seal: VerifiedChiefDecisionSeal;
  prefix: ChiefDecisionPrefix;
  union: Union;
}

export type ChiefDecisionPreparation<T> =
  | { status: 'unavailable' | 'pending' | 'stale' }
  | { status: 'prepared'; value: T };

/** Called inside the authority's lock. Prepared output has no append authority or durability. */
export function prepareChiefDecision<Union, T>(
  current: ChiefDecisionActivation | null,
  snapshot: ChiefDecisionSnapshot<Union> | null,
  prepare: (union: Union) => T | null,
): ChiefDecisionPreparation<T> {
  if (!current || !snapshot) return { status: 'unavailable' };
  const { activation, predecessor, seal, prefix } = snapshot;
  if (!Number.isSafeInteger(current.generation) || current.generation < 1 ||
      !/^[a-f0-9]{64}$/.test(current.manifestDigest) ||
      current.generation !== activation.generation || current.manifestDigest !== activation.manifestDigest ||
      current.successorWriter !== activation.successorWriter || current.successorEpoch !== activation.successorEpoch ||
      current.successorIncarnation !== activation.successorIncarnation ||
      !Number.isSafeInteger(current.successorEpoch) || current.successorEpoch <= predecessor.leaseEpoch ||
      current.successorIncarnation === predecessor.incarnation) return { status: 'unavailable' };

  const frontier = assessChiefDecisionFrontier(predecessor, seal, prefix);
  if (frontier !== 'current') return { status: frontier };
  const value = prepare(snapshot.union);
  return value === null ? { status: 'stale' } : { status: 'prepared', value };
}
