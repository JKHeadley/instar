import fs from 'node:fs';
import { createPhysicalEffectLock } from './PhysicalEffectLock.js';
import { readCommittedDoorwayObservation } from './CommittedDoorwayObservation.js';
import {
  SCHEDULED_DOORWAY_DIAGNOSTIC_LIMIT,
  SCHEDULED_DOORWAY_RETENTION_SCOPE,
  ScheduledDoorwayObservationStore,
  type ScheduledDoorwayRetentionCursor,
  type ScheduledDoorwayRetentionReferences,
} from './ScheduledDoorwayObservationStore.js';
import type { JobRun } from '../scheduler/JobRunHistory.js';

type Snapshot = { complete: boolean; runs: readonly JobRun[] };
type Artifacts = Pick<ScheduledDoorwayObservationStore, 'readStaged' | 'readStartedDoors'>;

function localRuns(machineId: string, ledger: Snapshot): Map<string, JobRun> | null {
  if (!machineId || !ledger.complete) return null;
  const runs = new Map<string, JobRun>();
  for (const run of ledger.runs) {
    if (run.machineId !== machineId || run.slug !== 'doorway-scan' || run.origin !== 'instar'
      || run.runner !== 'script' || run.lockTrust !== 'trusted' || run.result === 'skipped'
      || (!run.packagedDoorwayScan && !run.scheduledDoorwayObservationDigest)) continue;
    if (runs.has(run.runId)) return null;
    runs.set(run.runId, run);
  }
  return runs;
}

function admissionDoors(run: JobRun, machineId: string, store: Artifacts, requireKnownDoors = false): string[] {
  const starts = store.readStartedDoors(run.runId, requireKnownDoors) ?? [];
  const start = Date.parse(run.startedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : Infinity;
  return starts.map(row => {
    const observed = Date.parse(row.doorStartedAt);
    if (row.runId !== run.runId || row.machineId !== machineId || row.startedAt !== run.startedAt
      || !(start <= observed && observed <= end)) throw new Error('retention-admission-mismatch');
    return row.doorId;
  });
}

/**
 * Select a first cursor from intact artifacts before any pruning occurs.
 * Call under writer custody using a complete snapshot and a fixed wall-clock reading.
 */
export function selectDoorwayRetentionReferences(
  machineId: string,
  ledger: Snapshot,
  store: Artifacts,
  nowMs: number,
): ScheduledDoorwayRetentionReferences | null {
  const runs = localRuns(machineId, ledger);
  if (!runs || !Number.isFinite(nowMs)) return null;
  const ordered = [...runs.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const exactLedger = { findRun: (runId: string) => runs.get(runId) ?? null };
  const diagnosticRunIds = ordered.slice(0, SCHEDULED_DOORWAY_DIAGNOSTIC_LIMIT).map(run => run.runId);
  const diagnostics = new Set(diagnosticRunIds);
  const observations = new Map<string, { doorId: string; runId: string; digest: string; observedAt: number }>();
  const admissions = new Map<string, string>();
  let previousStart = Infinity;
  for (const run of ordered) {
    const start = Date.parse(run.startedAt);
    const end = run.result === 'pending' ? nowMs : Date.parse(run.completedAt ?? '');
    if (!(start <= end && end <= nowMs) || !(start < previousStart)
      || (run.result === 'pending' && !diagnostics.has(run.runId))) return null;
    previousStart = start;

    if (run.result === 'success') {
      const committed = readCommittedDoorwayObservation(run.runId, machineId, exactLedger, store);
      const digest = run.scheduledDoorwayObservationDigest;
      if (committed.status !== 'committed' || !digest) return null;
      for (const row of committed.observation.observations) {
        const observedAt = Date.parse(row.observedAt);
        if (!(start <= observedAt && observedAt <= end)) return null;
        const prior = observations.get(row.doorId);
        if (prior?.observedAt === observedAt) return null;
        if (!prior || observedAt > prior.observedAt) {
          observations.set(row.doorId, { doorId: row.doorId, runId: run.runId, digest, observedAt });
        }
      }
    }
    try {
      for (const doorId of admissionDoors(run, machineId, store, true)) {
        if (!admissions.has(doorId)) admissions.set(doorId, run.runId);
      }
    } catch {
      return null;
    }
  }
  return {
    observations: [...observations.values()].map(({ doorId, runId, digest }) => ({ doorId, runId, digest })),
    admissions: [...admissions].map(([doorId, runId]) => ({ doorId, runId })),
    diagnosticRunIds,
  };
}

/** Validate supplied references. The caller still owns custody and coverage. */
export function verifyDoorwayRetentionReferences(
  machineId: string,
  references: ScheduledDoorwayRetentionReferences,
  ledger: Snapshot,
  store: Artifacts,
): boolean {
  const runs = localRuns(machineId, ledger);
  if (!runs) return false;
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
        doors = new Set(admissionDoors(run, machineId, store));
        admissions.set(runId, doors);
      } catch {
        return false;
      }
    }
    if (!doors.has(doorId)) return false;
  }
  return references.diagnosticRunIds.every(runId => runs.has(runId));
}

/** Establish the first advisory cursor under the canonical state's writer lease. */
export async function initializeDoorwayRetentionCursor(options: {
  stateDir: string;
  machineId: string;
  doorIds: readonly string[];
  readSnapshot: () => Snapshot;
  deadlineMs: number;
}): Promise<{ status: 'published' | 'existing'; cursor: ScheduledDoorwayRetentionCursor }
  | { status: 'unavailable'; reason: 'incomplete-evidence' | 'ledger-changed' }> {
  const stateDir = fs.realpathSync(options.stateDir);
  const lease = await createPhysicalEffectLock(stateDir).acquire(SCHEDULED_DOORWAY_RETENTION_SCOPE, options.deadlineMs);
  try {
    lease.assertHeld();
    const nowMs = Date.now();
    const store = new ScheduledDoorwayObservationStore(stateDir, options.machineId, options.doorIds, () => nowMs);
    const existing = store.readRetentionCursor();
    if (existing) return { status: 'existing', cursor: existing };

    const snapshot = options.readSnapshot();
    const references = selectDoorwayRetentionReferences(options.machineId, snapshot, store, nowMs);
    if (!references || !verifyDoorwayRetentionReferences(options.machineId, references, snapshot, store)) {
      return { status: 'unavailable', reason: 'incomplete-evidence' };
    }

    // Until all writers share this scope, a changed ledger invalidates the
    // proposed generation. Even a stable double read grants no cleanup authority.
    const snapshotRows = JSON.stringify(snapshot.runs);
    const latest = options.readSnapshot();
    if (!latest.complete || JSON.stringify(latest.runs) !== snapshotRows) {
      return { status: 'unavailable', reason: 'ledger-changed' };
    }
    const cursor = store.advanceRetentionCursor(null, references, lease);
    return { status: 'published', cursor };
  } finally {
    await lease.release();
  }
}
