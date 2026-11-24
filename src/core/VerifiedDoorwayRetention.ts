import { readCommittedDoorwayObservation } from './CommittedDoorwayObservation.js';
import type { ScheduledDoorwayObservationStore, ScheduledDoorwayRetentionReferences } from './ScheduledDoorwayObservationStore.js';
import type { JobRun } from '../scheduler/JobRunHistory.js';

/**
 * Validate the references supplied by a cursor against one complete local ledger snapshot.
 * The caller owns snapshot custody and selection of every reference readers still need.
 */
export function verifyDoorwayRetentionReferences(
  machineId: string,
  references: ScheduledDoorwayRetentionReferences,
  ledger: { complete: boolean; runs: readonly JobRun[] },
  store: Pick<ScheduledDoorwayObservationStore, 'readStaged' | 'readStartedDoors'>,
): boolean {
  if (!machineId || !ledger.complete) return false;
  const runs = new Map<string, JobRun>();
  for (const run of ledger.runs) {
    if (run.machineId !== machineId || run.slug !== 'doorway-scan' || run.origin !== 'instar'
      || run.runner !== 'script' || run.lockTrust !== 'trusted' || run.result === 'skipped'
      || (!run.packagedDoorwayScan && !run.scheduledDoorwayObservationDigest)) continue;
    if (runs.has(run.runId)) return false;
    runs.set(run.runId, run);
  }
  const exactLedger = { findRun: (runId: string) => runs.get(runId) ?? null };
  const observations = new Map<string, Set<string>>();
  for (const { doorId, runId, digest } of references.observations) {
    if (runs.get(runId)?.scheduledDoorwayObservationDigest !== digest) return false;
    let doors = observations.get(runId);
    if (!doors) {
      const result = readCommittedDoorwayObservation(runId, machineId, exactLedger, store);
      if (result.status !== 'committed') return false;
      doors = new Set(result.observation.observations.map(row => row.doorId));
      observations.set(runId, doors);
    }
    if (!doors.has(doorId)) return false;
  }

  const admissions = new Map<string, Set<string>>();
  for (const { doorId, runId } of references.admissions) {
    const run = runs.get(runId);
    if (!run) return false;
    let doors = admissions.get(runId);
    if (!doors) {
      try {
        const starts = store.readStartedDoors(runId);
        if (!starts?.length) return false;
        const start = Date.parse(run.startedAt);
        const end = run.completedAt ? Date.parse(run.completedAt) : Infinity;
        if (starts.some(row => {
          const observed = Date.parse(row.doorStartedAt);
          return row.runId !== runId || row.machineId !== machineId || row.startedAt !== run.startedAt
            || !(start <= observed && observed <= end);
        })) return false;
        doors = new Set(starts.map(row => row.doorId));
        admissions.set(runId, doors);
      } catch {
        return false;
      }
    }
    if (!doors.has(doorId)) return false;
  }
  return references.diagnosticRunIds.every(runId => runs.has(runId));
}
