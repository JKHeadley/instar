import { createHash } from 'node:crypto';
import type { JobRun } from '../scheduler/JobRunHistory.js';
import type { ScheduledDoorwayObservationStore, StagedDoorwayObservation } from './ScheduledDoorwayObservationStore.js';

/** Canonical digest of validated staged observation evidence, independent of JSON key order. */
export function scheduledDoorwayObservationDigest(staged: StagedDoorwayObservation): string {
  const canonical = JSON.stringify([
    staged.schemaVersion, staged.runId, staged.machineId, staged.startedAt, staged.completedAt,
    staged.observations.map(({ doorId, probeStatus, observedAt }) => [doorId, probeStatus, observedAt]),
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export type CommittedDoorwayObservation =
  | { status: 'committed'; observation: StagedDoorwayObservation }
  | { status: 'unavailable'; reason: 'run-unverified' | 'stage-unavailable' | 'stage-mismatch' };

/** Read the exact run selected by the scheduler. A staged artifact alone carries no authority. */
export function readCommittedDoorwayObservation(
  runId: string,
  localMachineId: string,
  ledger: { findRun: (id: string) => JobRun | null },
  store: Pick<ScheduledDoorwayObservationStore, 'readStaged'>,
): CommittedDoorwayObservation {
  const run = ledger.findRun(runId);
  if (!localMachineId || !run || run.runId !== runId || run.slug !== 'doorway-scan'
    || run.machineId !== localMachineId || run.origin !== 'instar' || run.runner !== 'script'
    || run.lockTrust !== 'trusted' || run.result !== 'success' || !run.completedAt
    || !run.scheduledDoorwayObservationDigest) return { status: 'unavailable', reason: 'run-unverified' };

  let stage: StagedDoorwayObservation | null;
  try {
    stage = store.readStaged(runId);
  } catch {
    return { status: 'unavailable', reason: 'stage-unavailable' };
  }
  if (!stage) return { status: 'unavailable', reason: 'stage-unavailable' };
  if (stage.runId !== runId || stage.machineId !== localMachineId || stage.startedAt !== run.startedAt
    || !(Date.parse(stage.completedAt) <= Date.parse(run.completedAt))
    || run.scheduledDoorwayObservationDigest !== scheduledDoorwayObservationDigest(stage)) {
    return { status: 'unavailable', reason: 'stage-mismatch' };
  }
  return { status: 'committed', observation: stage };
}
