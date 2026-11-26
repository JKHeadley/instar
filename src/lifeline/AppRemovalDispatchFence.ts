import { decideAppRemovalFleetRead } from '../core/AppRemovalFleetReadAuthority.js';

type FleetReadEvidence = Parameters<typeof decideAppRemovalFleetRead>[0];
type ServingIdentity = Pick<NonNullable<FleetReadEvidence['serving']>,
  'machineId' | 'instanceId' | 'generation' | 'listener'>;

interface IsolatedWorker extends ServingIdentity {
  compartment: 'protected' | 'legacy';
}

interface DispatchEvidence {
  read: FleetReadEvidence;
  // Produced by the supervisor after establishing listener and storage isolation.
  worker: IsolatedWorker;
}

/**
 * Unmounted dispatch boundary. Read the supervisor's current evidence in the
 * same turn that dispatch starts. A caller must repeat this check for each
 * protected emission and stop the stream when its worker identity changes.
 */
export function dispatchAppRemovalRead<T>(
  conversationKey: string,
  readCurrentEvidence: () => DispatchEvidence | null,
  dispatch: (worker: Readonly<IsolatedWorker>) => T,
  expectedWorker?: Readonly<IsolatedWorker>,
): { kind: 'dispatched'; result: T } | { kind: 'unavailable' } {
  const evidence = readCurrentEvidence();
  if (!evidence || evidence.read.conversationKey !== conversationKey) return { kind: 'unavailable' };
  const { read, worker } = evidence;
  const decision = decideAppRemovalFleetRead(read);
  if (decision.kind === 'unavailable' || decision.kind !== worker.compartment
    || !worker.machineId || !worker.instanceId || !worker.listener
    || !Number.isSafeInteger(worker.generation) || worker.generation < 1
    || (decision.kind === 'protected' && !sameWorker(worker, decision.serving))
    || (expectedWorker && (worker.compartment !== expectedWorker.compartment || !sameWorker(worker, expectedWorker)))) return { kind: 'unavailable' };

  return { kind: 'dispatched', result: dispatch(Object.freeze({ ...worker })) };
}

function sameWorker(first: ServingIdentity, second: ServingIdentity): boolean {
  return first.machineId === second.machineId && first.instanceId === second.instanceId
    && first.generation === second.generation && first.listener === second.listener;
}
