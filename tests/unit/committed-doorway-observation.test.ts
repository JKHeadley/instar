import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { selectDoorwayRetentionReferences, verifyDoorwayRetentionReferences } from '../../src/core/VerifiedDoorwayRetention.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ScheduledDoorwayObservationStore } from '../../src/core/ScheduledDoorwayObservationStore.js';
import { readCommittedDoorwayObservation, scheduledDoorwayObservationDigest } from '../../src/core/CommittedDoorwayObservation.js';

import { readScheduledDoorwayEvidence } from '../../src/core/ScheduledDoorwayRead.js';

const TIME = '2026-11-24T17:00:00.000Z';
let dir: string;
let ledger: JobRunHistory;
let store: ScheduledDoorwayObservationStore;

function stage(lockTrust = 'trusted') {
  const id = ledger.recordStart({
    slug: 'doorway-scan', sessionId: '', trigger: 'scheduled', origin: 'instar', runner: 'script', lockTrust,
  });
  store.startRun(id, ledger.findRun(id)!.startedAt);
  store.startDoor(id, 'alpha', TIME);
  store.stage(id, TIME, [{ doorId: 'alpha', probeStatus: 'ok', observedAt: TIME }]);
  return id;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TIME));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'committed-doorway-'));
  ledger = new JobRunHistory(dir);
  ledger.setMachineId('local-test');
  store = new ScheduledDoorwayObservationStore(dir, 'local-test', ['alpha']);
});

afterEach(() => {
  vi.useRealTimers();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'committed doorway test cleanup' });
});

describe('committed scheduled doorway observation', () => {
  it('keeps a staged run unavailable until the exact attestation is durably recorded', () => {
    const id = stage();
    expect(readCommittedDoorwayObservation(id, 'local-test', ledger, store)).toEqual({
      status: 'unavailable', reason: 'run-unverified',
    });
    const observation = store.readStaged(id)!;
    ledger.recordCompletion({ runId: id, result: 'success', scheduledDoorwayObservationDigest: scheduledDoorwayObservationDigest(observation) });
    const reopened = new JobRunHistory(dir);
    expect(readCommittedDoorwayObservation(id, 'local-test', reopened, store)).toEqual({ status: 'committed', observation });
    expect(readCommittedDoorwayObservation(id, 'other-machine', reopened, store).status).toBe('unavailable');
  });

  it('does not give a legacy success or failed run authority over staged observations', () => {
    const legacy = stage();
    ledger.recordCompletion({ runId: legacy, result: 'success' });
    const failed = stage();
    ledger.recordCompletion({ runId: failed, result: 'timeout' });
    expect(readCommittedDoorwayObservation(legacy, 'local-test', ledger, store).status).toBe('unavailable');
    expect(readCommittedDoorwayObservation(failed, 'local-test', ledger, store).status).toBe('unavailable');
  });

  it('refuses attestation attached to an untrusted script', () => {
    const id = stage('untrusted-no-lockfile');
    expect(() => ledger.recordCompletion({
      runId: id, result: 'success', scheduledDoorwayObservationDigest: scheduledDoorwayObservationDigest(store.readStaged(id)!),
    })).toThrow('Invalid scheduled doorway observation attestation');
    expect(ledger.findRun(id)?.result).toBe('pending');
  });

  it('rejects changed evidence even when the exact run remains successful', () => {
    const id = stage();
    const observation = store.readStaged(id)!;
    ledger.recordCompletion({ runId: id, result: 'success', scheduledDoorwayObservationDigest: scheduledDoorwayObservationDigest(observation) });
    const changed = { ...observation, observations: [{ ...observation.observations[0], probeStatus: 'not-installed' as const }] };
    expect(readCommittedDoorwayObservation(id, 'local-test', ledger, { readStaged: () => changed })).toEqual({
      status: 'unavailable', reason: 'stage-mismatch',
    });
  });
});

describe('scheduled doorway evidence reconciliation', () => {
  function committed() {
    const runId = stage();
    ledger.recordCompletion({
      runId, result: 'success', scheduledDoorwayObservationDigest: scheduledDoorwayObservationDigest(store.readStaged(runId)!),
    });
    return runId;
  }

  function newer(result?: 'failure' | 'skipped', error?: string, startedDoor = false) {
    const runId = ledger.recordStart({
      slug: 'doorway-scan', sessionId: '', trigger: 'scheduled', origin: 'instar', runner: 'script',
      lockTrust: 'trusted', packagedDoorwayScan: true,
    });
    if (startedDoor) {
      const startedAt = ledger.findRun(runId)!.startedAt;
      store.startRun(runId, startedAt);
      store.startDoor(runId, 'alpha', startedAt);
    }
    if (result) ledger.recordCompletion({ runId, result, error });
    return runId;
  }

  const cadence = { schedule: '* * * * *', timeoutMs: 5000 };
  const read = (nowMs = Date.now(), schedule: typeof cadence | null = cadence, reverse = false) => {
    const runs = new JobRunHistory(dir).query({ slug: 'doorway-scan' }).runs;
    return readScheduledDoorwayEvidence({
      machineId: 'local-test', doorIds: ['alpha'], runs: reverse ? runs.reverse() : runs, store,
      cadence: schedule, nowMs,
    });
  };

  it('verifies exact cursor references and rejects missing or untrusted evidence', () => {
    const runId = committed();
    vi.setSystemTime(Date.parse(TIME) + 1000);
    const pending = newer(undefined, undefined, true);
    const snapshot = { complete: true, runs: ledger.query({ slug: 'doorway-scan' }).runs };
    const references = {
      observations: [{ doorId: 'alpha', runId, digest: scheduledDoorwayObservationDigest(store.readStaged(runId)!) }],
      admissions: [{ doorId: 'alpha', runId: pending }],
      diagnosticRunIds: [runId, pending],
    };
    const verify = (value = references, data = snapshot) => verifyDoorwayRetentionReferences('local-test', value, data, store);
    expect(verify()).toBe(true);
    expect(verify(references, { ...snapshot, complete: false })).toBe(false);
    expect(verify({ ...references, observations: [{ ...references.observations[0], doorId: 'beta' }] })).toBe(false);
    expect(verify({ ...references, observations: [{ ...references.observations[0], digest: 'wrong' }] })).toBe(false);
    expect(verify({ ...references, admissions: [{ doorId: 'alpha', runId: 'missing' }] })).toBe(false);
    expect(verify(references, { ...snapshot, runs: snapshot.runs.map(run => ({ ...run, machineId: 'foreign' })) })).toBe(false);
  });

  it('selects an older observation outside the diagnostic window and the latest admission', () => {
    const source = committed();
    for (let offset = 1; offset <= 17; offset += 1) {
      vi.setSystemTime(Date.parse(TIME) + offset * 1000);
      newer('failure');
    }
    vi.setSystemTime(Date.parse(TIME) + 18000);
    const pending = newer(undefined, undefined, true);
    const snapshot = { complete: true, runs: ledger.query({ slug: 'doorway-scan' }).runs };
    const select = (now = Date.now()) => selectDoorwayRetentionReferences('local-test', snapshot, store, now);
    const references = select();
    expect(references).toMatchObject({
      observations: [{ doorId: 'alpha', runId: source }],
      admissions: [{ doorId: 'alpha', runId: pending }],
    });
    expect(references?.diagnosticRunIds).toHaveLength(16);
    expect(references?.diagnosticRunIds).not.toContain(source);
    expect(references && verifyDoorwayRetentionReferences('local-test', references, snapshot, store)).toBe(true);
    expect(select(Date.now() - 1)).toBeNull();

    const oldPending = { ...snapshot.runs[0], runId: 'doorway-scan-old-1', startedAt: '2026-11-24T16:59:59.000Z' };
    expect(selectDoorwayRetentionReferences('local-test', {
      complete: true, runs: [...snapshot.runs, oldPending],
    }, store, Date.now())).toBeNull();
  });

  it('refuses the initial cursor when an admission directory lost its run record', () => {
    const runId = newer('failure', undefined, true);
    const runRecord = path.join(dir, 'state', 'doorway-scan-scheduled-runs', runId, 'run.json');
    SafeFsExecutor.safeUnlinkSync(runRecord, { operation: 'simulate lost doorway run record' });
    const snapshot = { complete: true, runs: ledger.query({ slug: 'doorway-scan' }).runs };
    expect(selectDoorwayRetentionReferences('local-test', snapshot, store, Date.now())).toBeNull();
  });

  it('refuses the initial cursor when an attested observation cannot be reopened', () => {
    committed();
    const snapshot = { complete: true, runs: ledger.query({ slug: 'doorway-scan' }).runs };
    expect(selectDoorwayRetentionReferences('local-test', snapshot, {
      readStaged: () => null,
      readStartedDoors: id => store.readStartedDoors(id),
    }, Date.now())).toBeNull();
  });

  it('retains a past observation and exposes a newer interrupted admission after restart', () => {
    const prior = committed();
    vi.setSystemTime(Date.parse(TIME) + 1000);
    const failed = newer('failure', 'interrupted: the server stopped before this script finished', true);
    expect(read()).toMatchObject({
      latestRun: { runId: failed, outcome: 'interrupted' },
      doors: { alpha: {
        lastObservation: { runId: prior, observedAt: TIME },
        latestAttempt: { runId: failed, outcome: 'interrupted' },
        freshness: 'unknown', reachable: null,
      } },
    });
  });

  it('keeps pre-admission failure job-scoped and ignores later skips', () => {
    const prior = committed();
    vi.setSystemTime(Date.parse(TIME) + 1000);
    const failed = newer('failure', 'packaged-probe-timeout');
    vi.setSystemTime(Date.parse(TIME) + 2000);
    newer('skipped');
    expect(read()).toMatchObject({
      latestRun: { runId: failed, outcome: 'timeout' },
      doors: { alpha: { latestAttempt: { runId: prior }, freshness: 'current', reachable: true } },
    });
  });

  it('withholds current evidence when a newer admission is corrupt', () => {
    const prior = committed();
    vi.setSystemTime(Date.parse(TIME) + 1000);
    const failed = newer('failure', undefined, true);
    const admission = path.join(dir, 'state', 'doorway-scan-scheduled-runs', failed, 'run.json');
    fs.writeFileSync(admission, '{bad');
    expect(read()).toMatchObject({
      latestRun: { runId: failed, outcome: 'failed' },
      doors: { alpha: { lastObservation: { runId: prior }, freshness: 'unknown', reachable: null } },
    });
  });

  it('uses the next occurrence plus timeout and recalculates after cadence changes', () => {
    committed();
    expect(read(Date.parse(TIME) + 64999).doors.alpha.freshness).toBe('current');
    expect(read(Date.parse(TIME) + 65000).doors.alpha).toMatchObject({ freshness: 'stale', reachable: null });
    expect(read(Date.parse(TIME) + 65000, { ...cadence, schedule: '*/5 * * * *' }).doors.alpha.freshness).toBe('current');
    expect(read(Date.now(), null).doors.alpha).toMatchObject({ freshness: 'disabled', reachable: null });
  });

  it('bounds local history without allowing legacy or peer rows to displace it', () => {
    const prior = committed();
    vi.setSystemTime(Date.parse(TIME) + 1000);
    newer('skipped');
    ledger.setMachineId('remote');
    newer('failure');
    ledger.setMachineId('local-test');
    expect(ledger.readPackagedDoorwayRuns('local-test', 1)).toMatchObject({
      runs: [{ runId: prior }], truncated: false,
    });
    newer('failure');
    newer('failure');
    const bounded = ledger.readPackagedDoorwayRuns('local-test', 1);
    expect(bounded).toEqual({ status: 'available', runs: [], truncated: true });
    if (bounded.status !== 'available') throw new Error('expected readable ledger');
    const evidence = readScheduledDoorwayEvidence({
      ...bounded, historyTruncated: bounded.truncated,
      machineId: 'local-test', doorIds: ['alpha'], store, cadence, nowMs: Date.now(),
    });
    expect(evidence.doors.alpha.freshness).toBe('unknown');
  });

  it('distinguishes an unreadable job ledger from an empty local history', () => {
    expect(ledger.readPackagedDoorwayRuns('local-test', 16)).toEqual({
      status: 'available', runs: [], truncated: false,
    });
    fs.mkdirSync(path.join(dir, 'ledger', 'job-runs.jsonl'));
    expect(ledger.readPackagedDoorwayRuns('local-test', 16)).toEqual({ status: 'unavailable' });
  });

  it('leaves conflicting same-time runs and future evidence unknown in either input order', () => {
    committed();
    newer('failure', undefined, true);
    const tied = { complete: true, runs: ledger.query({ slug: 'doorway-scan' }).runs };
    expect(selectDoorwayRetentionReferences('local-test', tied, store, Date.now())).toBeNull();
    expect(read().doors.alpha).toMatchObject({ freshness: 'unknown', reachable: null });
    expect(read(Date.now(), cadence, true)).toEqual(read());
    expect(read(Date.now() - 1)).toMatchObject({
      latestRun: null, doors: { alpha: { freshness: 'unknown', reachable: null } },
    });
  });
});
