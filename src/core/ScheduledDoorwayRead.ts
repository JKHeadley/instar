import { Cron } from 'croner';
import { readCommittedDoorwayObservation } from './CommittedDoorwayObservation.js';
import { probeStatusToReachable } from './DoorwayRegistryReader.js';
import type { ScheduledDoorwayObservation, ScheduledDoorwayObservationStore, ScheduledDoorwayRetentionCursor } from './ScheduledDoorwayObservationStore.js';
import type { JobRun } from '../scheduler/JobRunHistory.js';

type Outcome = 'observed' | 'pending' | 'failed' | 'timeout' | 'interrupted' | 'unavailable';
type Evidence = { runId: string; startedAt: string; outcome: Outcome };
type HistoricalObservation = ScheduledDoorwayObservation & { runId: string; completedAt: string };
type DoorReading = {
  lastObservation: HistoricalObservation | null;
  latestAttempt: Evidence | null;
  reachable: boolean | null;
  freshness: 'current' | 'stale' | 'disabled' | 'never-observed' | 'unknown';
};

export interface ScheduledDoorwayEvidence {
  machineId: string;
  historyTruncated: boolean;
  ledgerUnavailable?: true;
  latestRun: Evidence | null;
  doors: Record<string, DoorReading>;
}

function instant(value: string | undefined): number {
  if (!value) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

function runOutcome(run: JobRun): Outcome {
  if (run.result === 'pending') return 'pending';
  if (run.error?.startsWith('interrupted:')) return 'interrupted';
  if (run.result === 'timeout' || run.error === 'script-timeout' || run.error === 'packaged-probe-timeout') return 'timeout';
  return run.result === 'success' ? 'unavailable' : 'failed';
}

function freshnessDeadline(
  cadence: { schedule: string; timeoutMs: number },
  completedAt: string,
): number {
  if (!Number.isFinite(cadence.timeoutMs) || cadence.timeoutMs <= 0) return NaN;
  try {
    const cron = new Cron(cadence.schedule, { paused: true });
    const next = cron.nextRun(new Date(completedAt));
    return next ? next.getTime() + cadence.timeoutMs : NaN;
  } catch {
    return NaN;
  }
}

/** Project bounded, machine-local history. This read neither promotes nor prunes artifacts. */
export function readScheduledDoorwayEvidence(options: {
  machineId: string;
  doorIds: readonly string[];
  runs: readonly JobRun[];
  store: Pick<ScheduledDoorwayObservationStore, 'readStaged' | 'readStartedDoors'>;
  cadence: { schedule: string; timeoutMs: number } | null;
  nowMs: number;
  historyTruncated?: boolean;
  retainedHistory?: { cursor: ScheduledDoorwayRetentionCursor; findRun: (id: string) => JobRun | null };
}): ScheduledDoorwayEvidence {
  const { machineId, doorIds, runs, store, cadence, nowMs } = options;
  const local = new Map(runs.filter(run => machineId && run.machineId === machineId
    && run.slug === 'doorway-scan' && run.origin === 'instar' && run.runner === 'script'
    && run.lockTrust === 'trusted' && run.result !== 'skipped'
    && (run.packagedDoorwayScan || run.scheduledDoorwayObservationDigest)).map(run => [run.runId, run]));
  const attempts = new Map<string, Evidence[]>();
  const observations = new Map<string, HistoricalObservation[]>();
  const knownDoors = new Set(doorIds);
  const runEvidence: Evidence[] = [];
  let latestUnreadableAdmission = '';
  let uncertainRunOrder = !Number.isFinite(nowMs);

  for (const run of local.values()) {
    const start = instant(run.startedAt);
    const completion = instant(run.completedAt);
    if (!(start <= nowMs) || (run.result !== 'pending' && !(start <= completion && completion <= nowMs))) {
      uncertainRunOrder = true;
      continue;
    }
    const committed = readCommittedDoorwayObservation(run.runId, machineId, {
      findRun: id => local.get(id) ?? null,
    }, store);
    const evidence: Evidence = {
      runId: run.runId, startedAt: run.startedAt,
      outcome: committed.status === 'committed' ? 'observed' : runOutcome(run),
    };
    runEvidence.push(evidence);

    if (committed.status === 'committed') {
      for (const row of committed.observation.observations) {
        if (!knownDoors.has(row.doorId)) continue;
        append(attempts, row.doorId, evidence);
        append(observations, row.doorId, { ...row, runId: run.runId, completedAt: committed.observation.completedAt });
      }
    } else {
      try {
        const starts = store.readStartedDoors(run.runId) ?? [];
        if (starts.some(door => door.runId !== run.runId || door.machineId !== machineId
          || door.startedAt !== run.startedAt || !(start <= instant(door.doorStartedAt)
          && instant(door.doorStartedAt) <= (run.completedAt ? completion : nowMs)))) {
          throw new Error('scheduled-doorway-admission-ledger-mismatch');
        }
        for (const door of starts) {
          if (knownDoors.has(door.doorId)) append(attempts, door.doorId, evidence);
        }
      } catch {
        // A corrupt admission may belong to any doorway. Newer verified
        // evidence for a doorway can supersede that uncertainty.
        if (run.startedAt > latestUnreadableAdmission) latestUnreadableAdmission = run.startedAt;
      }
    }
  }

  const retained = new Map<string, HistoricalObservation>();
  const history = options.retainedHistory;
  if (options.historyTruncated && history?.cursor.machineId === machineId) {
    const opened = new Map<string, ReturnType<typeof readCommittedDoorwayObservation>>();
    for (const { doorId, runId, digest } of history.cursor.observations) {
      if (!knownDoors.has(doorId) || observations.has(doorId) || local.has(runId)) continue;
      const run = history.findRun(runId);
      if (run?.scheduledDoorwayObservationDigest !== digest) continue;
      const start = instant(run.startedAt);
      const completion = instant(run.completedAt);
      if (!(start <= completion && completion <= nowMs)) continue;
      const result = opened.get(runId) ?? readCommittedDoorwayObservation(runId, machineId, {
        findRun: () => run,
      }, store);
      opened.set(runId, result);
      if (result.status !== 'committed') continue;
      const row = result.observation.observations.find(item => item.doorId === doorId);
      if (row && start <= instant(row.observedAt) && instant(row.observedAt) <= completion) {
        retained.set(doorId, { ...row, runId, completedAt: result.observation.completedAt });
      }
    }
  }

  const latestRun = newest(runEvidence, run => run.startedAt);
  const doors = Object.fromEntries([...knownDoors].map(doorId => {
    const doorAttempts = attempts.get(doorId) ?? [];
    const doorObservations = observations.get(doorId) ?? [];
    const latestAttempt = newest(doorAttempts, attempt => attempt.startedAt);
    const lastObservation = newest(doorObservations, row => row.observedAt);
    let freshness: DoorReading['freshness'];
    if (!cadence) freshness = 'disabled';
    else if ((latestUnreadableAdmission && latestUnreadableAdmission >= (latestAttempt?.startedAt ?? ''))
      || uncertainRunOrder || (runEvidence.length > 0 && !latestRun)
      || (doorAttempts.length > 0 && !latestAttempt)
      || (doorObservations.length > 0 && !lastObservation)) freshness = 'unknown';
    else if (!lastObservation) freshness = latestAttempt || latestRun?.outcome === 'unavailable' || options.historyTruncated
      ? 'unknown' : 'never-observed';
    else if (latestAttempt?.runId !== lastObservation.runId
      || (latestRun?.outcome === 'unavailable' && latestRun.startedAt >= (latestAttempt?.startedAt ?? ''))) freshness = 'unknown';
    else {
      const deadline = freshnessDeadline(cadence, lastObservation.completedAt);
      freshness = !Number.isFinite(deadline) ? 'unknown' : nowMs >= deadline ? 'stale' : 'current';
    }
    const reading: DoorReading = {
      lastObservation: lastObservation ?? retained.get(doorId) ?? null, latestAttempt, freshness,
      reachable: freshness === 'current' && lastObservation ? probeStatusToReachable(lastObservation.probeStatus) : null,
    };
    return [doorId, reading];
  }));
  return { machineId, historyTruncated: options.historyTruncated ?? false, latestRun: uncertainRunOrder ? null : latestRun, doors };
}

function append<T>(index: Map<string, T[]>, doorId: string, row: T): void {
  const rows = index.get(doorId);
  if (rows) rows.push(row);
  else index.set(doorId, [row]);
}

function newest<T>(rows: readonly T[], timestamp: (row: T) => string): T | null {
  const sorted = [...rows].sort((a, b) => timestamp(b).localeCompare(timestamp(a)));
  if (!sorted.length || (sorted.length > 1 && timestamp(sorted[0]) === timestamp(sorted[1]))) return null;
  return sorted[0];
}
