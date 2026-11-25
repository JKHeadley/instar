import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createPhysicalEffectLock, type PhysicalEffectLease } from './PhysicalEffectLock.js';
import { readCommittedDoorwayObservation } from './CommittedDoorwayObservation.js';
import {
  SCHEDULED_DOORWAY_DIAGNOSTIC_LIMIT,
  SCHEDULED_DOORWAY_RETENTION_SCOPE,
  ScheduledDoorwayObservationStore,
  type ScheduledDoorwayLedgerCoverage,
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

/** Stable evidence for a covered ledger prefix, independent of JSONL compaction order. */
export function fingerprintDoorwayLedger(machineId: string, ledger: Snapshot, through?: string): ScheduledDoorwayLedgerCoverage | null {
  const runs = localRuns(machineId, ledger);
  if (!runs) return null;
  const ordered = [...runs.values()].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
  const boundary = through ?? ordered.at(-1)?.startedAt ?? null;
  const hash = createHash('sha256');
  const pending: Array<{ runId: string; startedAt: string }> = [];
  let terminalCount = 0;
  for (const run of ordered) {
    const started = Date.parse(run.startedAt);
    if (!Number.isFinite(started) || new Date(started).toISOString() !== run.startedAt) return null;
    if (boundary !== null && run.startedAt > boundary) continue;
    if (run.result === 'pending') {
      pending.push({ runId: run.runId, startedAt: run.startedAt });
      continue;
    }
    hash.update(JSON.stringify([
      run.runId, run.machineId, run.startedAt, run.result, run.completedAt,
      run.packagedDoorwayScan, run.scheduledDoorwayObservationDigest,
    ]) + '\n');
    terminalCount++;
  }
  return { boundary, terminalCount, pending, digest: `sha256:${hash.digest('hex')}` };
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

function selectNextDoorwayRetentionReferences(
  machineId: string,
  snapshot: Snapshot,
  store: Artifacts,
  nowMs: number,
  previous: ScheduledDoorwayRetentionCursor | null,
): ScheduledDoorwayRetentionReferences | null {
  if (previous?.schemaVersion !== 2 || previous.coverage.boundary === null) {
    return selectDoorwayRetentionReferences(machineId, snapshot, store, nowMs);
  }
  const runs = localRuns(machineId, snapshot);
  if (!runs) return null;
  const { boundary, pending, digest, terminalCount } = previous.coverage;
  const pendingIds = new Set(pending.map(row => row.runId));
  if (pending.some(row => runs.get(row.runId)?.startedAt !== row.startedAt)) return null;
  const covered = fingerprintDoorwayLedger(machineId, {
    complete: true, runs: [...runs.values()].filter(run => !pendingIds.has(run.runId)),
  }, boundary);
  if (!covered || covered.digest !== digest || covered.terminalCount !== terminalCount || covered.pending.length) return null;

  const retained = new Set([
    ...previous.observations.map(row => row.runId),
    ...previous.admissions.map(row => row.runId),
  ]);
  const ordered = [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (ordered.some((run, index) => run.startedAt === ordered[index - 1]?.startedAt
    || (run.result === 'pending' && index >= SCHEDULED_DOORWAY_DIAGNOSTIC_LIMIT))) return null;
  const candidates = ordered.filter(run =>
    run.startedAt > boundary || pendingIds.has(run.runId) || retained.has(run.runId));
  const references = selectDoorwayRetentionReferences(machineId, { complete: true, runs: candidates }, store, nowMs);
  if (!references) return null;
  return {
    ...references,
    diagnosticRunIds: ordered.slice(0, SCHEDULED_DOORWAY_DIAGNOSTIC_LIMIT).map(run => run.runId),
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

/** Run an artifact writer under the same canonical lock as cursor publication. */
export async function withDoorwayRetentionWriter<T>(
  stateDir: string,
  deadlineMs: number,
  write: (stateDir: string, lease: PhysicalEffectLease) => Promise<T>,
): Promise<T> {
  const canonical = fs.realpathSync(stateDir);
  const lease = await createPhysicalEffectLock(canonical).acquire(SCHEDULED_DOORWAY_RETENTION_SCOPE, deadlineMs);
  try {
    lease.assertHeld();
    return await write(canonical, lease);
  } finally {
    await lease.release();
  }
}

type PublicationOptions = {
  stateDir: string;
  machineId: string;
  doorIds: readonly string[];
  readSnapshot: () => Snapshot;
  flushLedger: () => void;
};
type PublicationResult = { status: 'published' | 'existing'; cursor: ScheduledDoorwayRetentionCursor }
  | { status: 'unavailable'; reason: 'incomplete-evidence' | 'ledger-changed' | 'generation-changed' };

/** Establish the first advisory cursor under the canonical state's writer lease. */
export async function initializeDoorwayRetentionCursor(
  options: PublicationOptions & { deadlineMs: number },
): Promise<PublicationResult> {
  return withDoorwayRetentionWriter(options.stateDir, options.deadlineMs, async (stateDir, lease) =>
    publishInitialDoorwayRetentionCursor({ ...options, stateDir }, lease));
}

/** Publish the first generation under an existing writer lease. */
export function publishInitialDoorwayRetentionCursor(
  options: PublicationOptions,
  lease: Pick<PhysicalEffectLease, 'scope' | 'assertHeld'>,
): PublicationResult {
  return publishDoorwayRetentionCursor(options, lease);
}

/** Advance an advisory cursor while the complete historical artifacts are still present. */
export async function updateDoorwayRetentionCursor(
  options: PublicationOptions & { deadlineMs: number; expectedGeneration: number },
): Promise<PublicationResult> {
  return withDoorwayRetentionWriter(options.stateDir, options.deadlineMs, async (stateDir, lease) =>
    publishDoorwayRetentionCursor({ ...options, stateDir }, lease, options.expectedGeneration));
}

/**
 * The scheduler may use the current generation while it owns the writer lease.
 * Every publication still requires the full historical artifact set.
 */
export function publishDoorwayRetentionCursor(
  options: PublicationOptions,
  lease: Pick<PhysicalEffectLease, 'scope' | 'assertHeld'>,
  expectedGeneration?: number | 'current',
): PublicationResult {
  if (lease.scope !== SCHEDULED_DOORWAY_RETENTION_SCOPE) throw new Error('doorway retention writer scope mismatch');
  lease.assertHeld();
  const nowMs = Date.now();
  const store = new ScheduledDoorwayObservationStore(options.stateDir, options.machineId, options.doorIds, () => nowMs);
  const existing = store.readRetentionCursor();
  if (expectedGeneration === undefined) {
    if (existing) return { status: 'existing', cursor: existing };
  } else if (expectedGeneration !== 'current' && existing?.generation !== expectedGeneration) {
    return { status: 'unavailable', reason: 'generation-changed' };
  }

  const catalogDigest = `sha256:${createHash('sha256').update(JSON.stringify([...new Set(options.doorIds)].sort())).digest('hex')}`;
  if (existing?.schemaVersion === 2 && existing.coverage.catalogDigest !== catalogDigest) {
    return { status: 'unavailable', reason: 'incomplete-evidence' };
  }
  const snapshot = options.readSnapshot();
  const references = selectNextDoorwayRetentionReferences(options.machineId, snapshot, store, nowMs, existing);
  if (!references || !verifyDoorwayRetentionReferences(options.machineId, references, snapshot, store)
    || (existing && !verifyDoorwayRetentionReferences(options.machineId, existing, snapshot, store))) {
    return { status: 'unavailable', reason: 'incomplete-evidence' };
  }

  const fingerprint = fingerprintDoorwayLedger(options.machineId, snapshot);
  if (!fingerprint) return { status: 'unavailable', reason: 'incomplete-evidence' };
  options.flushLedger();
  const latest = options.readSnapshot();
  if (JSON.stringify(fingerprintDoorwayLedger(options.machineId, latest)) !== JSON.stringify(fingerprint)) {
    return { status: 'unavailable', reason: 'ledger-changed' };
  }
  const cursor = store.advanceRetentionCursor(existing?.generation ?? null, references, lease, { ...fingerprint, catalogDigest });
  return { status: 'published', cursor };
}
