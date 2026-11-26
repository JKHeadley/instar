import type { PublicationScope } from './FencedPublicationStore.js';
import { createOrderedGitTipReader, type PinnedGitDestination } from './OrderedPublicationGitRead.js';
import type { OrderedWitnessSnapshotStore } from './OrderedWitnessSnapshotStore.js';

/** Observation has custody authority only. The accepted-floor API is deliberately absent. */
export function createOrderedWitnessObserver(deps: {
  enabled?: boolean;
  target: PinnedGitDestination;
  store: Pick<OrderedWitnessSnapshotStore, 'stageCandidate'>;
  /** Read and validate the exact candidate payload and key from the immutable Git object. */
  readCandidateAtCommit(commit: string): { operation: string; payload: Buffer } | null;
}): (scope: PublicationScope) => 'staged' | 'existing' | 'conflict' | 'pending' {
  if (deps.enabled !== true) return () => 'pending';
  const readTip = createOrderedGitTipReader(deps.target);
  return scope => {
    const commit = readTip(scope);
    if (!commit) return 'pending';
    const candidate = deps.readCandidateAtCommit(commit);
    if (!candidate || readTip(scope) !== commit) return 'pending';
    return deps.store.stageCandidate(scope, commit, candidate.operation, candidate.payload);
  };
}
