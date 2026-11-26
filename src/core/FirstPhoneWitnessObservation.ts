import type { PublicationScope } from './FencedPublicationStore.js';
import { createFirstPhoneGitCandidateReader } from './FirstPhoneGitCandidateReader.js';
import type { PinnedGitDestination } from './OrderedPublicationGitRead.js';
import { createOrderedWitnessObserver } from './OrderedWitnessObserver.js';
import type { OrderedWitnessSnapshotStore } from './OrderedWitnessSnapshotStore.js';
import { SafeGitExecutor } from './SafeGitExecutor.js';

/** One staging-only cycle for a receiver-provisioned, isolated witness mirror. */
export function createFirstPhoneWitnessObservation(deps: {
  enabled?: boolean;
  target: PinnedGitDestination & { scope: PublicationScope & { namespace: 'machine-key-history' } };
  mirror: string;
  store: Pick<OrderedWitnessSnapshotStore, 'stageCandidate'>;
}): () => ReturnType<ReturnType<typeof createOrderedWitnessObserver>> {
  if (deps.enabled !== true) return () => 'pending';
  const target = { ...deps.target, scope: { ...deps.target.scope } };
  const mirror = deps.mirror;
  const observe = createOrderedWitnessObserver({
    enabled: true, target, store: deps.store,
    readCandidateAtCommit: createFirstPhoneGitCandidateReader(mirror),
  });

  return () => {
    try {
      // No destination refspec, so the fetch imports objects without advancing a local authority ref.
      SafeGitExecutor.execSync(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
        '--', target.repository, target.ref], {
        cwd: mirror, operation: 'first-phone-witness:refresh-configured-mirror',
        timeout: 5000, maxBuffer: 64 * 1024, env: { GIT_TERMINAL_PROMPT: '0' },
      });
    } catch {
      return 'pending'; // A failed refresh cannot be replaced with stale local evidence.
    }
    return observe(target.scope);
  };
}
