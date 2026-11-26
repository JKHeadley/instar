import { parse } from 'node:path';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import type { PublicationScope } from './FencedPublicationStore.js';
import { createOrderedFloorReader } from './OrderedPublicationWitness.js';

type FloorReaderDependencies = Parameters<typeof createOrderedFloorReader>[0];

export interface PinnedGitDestination {
  repository: string;
  ref: string;
  scope: PublicationScope;
  /** Stable name shared with the witness for this configured repository. */
  audience: string;
}

function validRef(ref: string): boolean {
  return /^refs\/heads\/[a-zA-Z0-9_/-]+$/.test(ref) &&
    ref.split('/').every(part => part.length > 0);
}

/** Read a receiver-pinned ref without consulting a checkout or its remote-tracking refs. */
export function createOrderedGitFloorReader(
  target: PinnedGitDestination,
  witness: Pick<FloorReaderDependencies, 'pins' | 'currentWitness' | 'readWitness'>,
): ReturnType<typeof createOrderedFloorReader> {
  return createOrderedFloorReader({
    ...witness,
    destination: JSON.stringify([target.audience, target.ref]),
    readGitTip: createOrderedGitTipReader(target),
  });
}

export function createOrderedGitTipReader(target: PinnedGitDestination): (scope: PublicationScope) => string | null {
  const { repository, ref, audience } = target;
  const { agentId, namespace } = target.scope;
  if (!validRef(ref) || !audience || !/^(https:\/\/|ssh:\/\/|\/)/.test(repository)) {
    throw new Error('Invalid ordered publication Git destination');
  }

  return scope => {
    if (scope.agentId !== agentId || scope.namespace !== namespace) return null;
    try {
      const output = SafeGitExecutor.readSync(['ls-remote', '--refs', '--exit-code', '--', repository, ref], {
        operation: 'ordered-publication:read-pinned-ref',
        encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
        cwd: parse(process.cwd()).root,
        env: {
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lines = output.trimEnd().split('\n');
      if (lines.length !== 1) return null;
      const [oid, returnedRef, extra] = lines[0].split('\t');
      return returnedRef === ref && extra === undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)
        ? oid : null;
    } catch {
      return null; // Missing or unreachable authoritative refs cannot confirm a local floor.
    }
  };
}
