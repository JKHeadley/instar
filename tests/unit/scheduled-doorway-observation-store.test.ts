import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  ScheduledDoorwayObservationStore,
  SCHEDULED_DOORWAY_RETENTION_SCOPE,
  type ScheduledDoorwayObservation,
} from '../../src/core/ScheduledDoorwayObservationStore.js';

const A = 'doorway-scan-abc-0';
const B = 'doorway-scan-def-1';
const MACHINE = 'machine-a';
const ALPHA = 'alpha';
const BETA = 'beta/v2';
const START = '2026-11-24T17:00:00.000Z';
const DOOR_START = '2026-11-24T17:00:01.000Z';
const OBSERVED = '2026-11-24T17:00:02.000Z';
const DONE = '2026-11-24T17:00:03.000Z';
const FUTURE = '2026-11-24T17:01:00.000Z';

const observation = (doorId = ALPHA): ScheduledDoorwayObservation => ({ doorId, probeStatus: 'ok', observedAt: OBSERVED });

describe('ScheduledDoorwayObservationStore', () => {
  let dir: string;
  let store: ScheduledDoorwayObservationStore;

  const open = (machineId = MACHINE) => new ScheduledDoorwayObservationStore(dir, machineId, [ALPHA, BETA], () => Date.parse(DONE));
  const artifact = (runId: string, file = 'staged.json') => path.join(dir, 'state', 'doorway-scan-scheduled-runs', runId, file);
  function admit(runId: string, doorId = ALPHA): void {
    store.startRun(runId, START);
    store.startDoor(runId, doorId, DOOR_START);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-doorway-store-'));
    store = open();
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'scheduled doorway store test cleanup' });
  });

  it('persists the exact retention references and refuses a stale generation', () => {
    const lease = { scope: SCHEDULED_DOORWAY_RETENTION_SCOPE, assertHeld: vi.fn() };
    const references = {
      observations: [{ doorId: ALPHA, runId: A, digest: `sha256:${'a'.repeat(64)}` }],
      admissions: [{ doorId: ALPHA, runId: B }],
      diagnosticRunIds: [A, B],
    };
    expect(store.readRetentionCursor()).toBeNull();
    const first = store.advanceRetentionCursor(null, references, lease);
    expect(first).toEqual({ schemaVersion: 1, machineId: MACHINE, generation: 1, ...references });
    expect(open().readRetentionCursor()).toEqual(first);
    expect(() => open().advanceRetentionCursor(null, references, lease)).toThrow('retention-generation-changed');
    expect(open().advanceRetentionCursor(1, references, lease).generation).toBe(2);
    expect(lease.assertHeld).toHaveBeenCalled();
    expect(() => open('wrong-machine').readRetentionCursor()).toThrow('retention-cursor-invalid');
  });

  it('refuses corrupt references and an invalid lease before changing the cursor', () => {
    const lease = { scope: SCHEDULED_DOORWAY_RETENTION_SCOPE, assertHeld: vi.fn() };
    const references = { observations: [], admissions: [], diagnosticRunIds: [A] };
    const first = store.advanceRetentionCursor(null, references, lease);
    expect(() => store.advanceRetentionCursor(1, references, { ...lease, scope: 'wrong-scope' })).toThrow('retention-lease-scope');
    lease.assertHeld.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('lost lease'); });
    expect(() => store.advanceRetentionCursor(1, references, lease)).toThrow('lost lease');
    expect(() => store.advanceRetentionCursor(1, {
      ...references, diagnosticRunIds: ['../manual-scan'],
    }, lease)).toThrow('retention-reference-invalid');
    expect(open().readRetentionCursor()).toEqual(first);

    const cursor = path.join(dir, 'state', 'doorway-scan-scheduled-runs', 'retention-cursor.json');
    fs.writeFileSync(cursor, '{broken');
    expect(() => open().readRetentionCursor()).toThrow();
    expect(() => open().advanceRetentionCursor(1, references, lease)).toThrow();
    expect(fs.readFileSync(cursor, 'utf8')).toBe('{broken');
  });

  it('reads exact staged evidence after reopen without modifying the pending legacy baseline', () => {
    fs.mkdirSync(path.join(dir, 'state'));
    const manualPath = path.join(dir, 'state', 'doorway-scan.json');
    const manual = '{"lastDeliveryFailedAt":"2026-11-24T16:58:00.000Z","surfacedBaseline":{"at":"2026-11-24T16:57:00.000Z","doorways":[{"id":"alpha","reachable":true}]}}\n';
    fs.writeFileSync(manualPath, manual);

    admit(A, BETA);
    store.stage(A, DONE, [observation(BETA)]);

    expect(open().readStaged(A)).toEqual({
      schemaVersion: 1, runId: A, machineId: MACHINE, startedAt: START, completedAt: DONE, observations: [observation(BETA)],
    });
    expect(fs.readFileSync(manualPath, 'utf8')).toBe(manual);
  });

  it('retains an earlier exact result while a later run is interrupted after one door starts', () => {
    admit(A);
    store.stage(A, DONE, [observation()]);
    const original = fs.readFileSync(artifact(A));

    admit(B);
    expect(open().startedDoors(B)).toEqual([
      { schemaVersion: 1, runId: B, machineId: MACHINE, startedAt: START, doorId: ALPHA, doorStartedAt: DOOR_START },
    ]);
    expect(open().readStaged(B)).toBeNull();
    expect(open().readStaged(A)?.observations).toEqual([observation()]);
    expect(fs.readFileSync(artifact(A))).toEqual(original);
  });

  it('does not overwrite a run, door start, or staged result', () => {
    admit(A);
    expect(() => store.startRun(A, DOOR_START)).toThrow('EEXIST');
    expect(() => store.startDoor(A, ALPHA, OBSERVED)).toThrow('EEXIST');
    expect(store.startedDoors(A)[0].doorStartedAt).toBe(DOOR_START);
    store.stage(A, DONE, [observation()]);
    expect(() => store.stage(A, DONE, [{ ...observation(), probeStatus: 'timeout' }])).toThrow('EEXIST');
    expect(() => store.startDoor(A, BETA, OBSERVED)).toThrow('already-staged');
    expect(open().readStaged(A)?.observations).toEqual([observation()]);
  });

  it('rejects transplanted evidence and an independently supplied foreign machine identity', () => {
    admit(A);
    store.stage(A, DONE, [observation()]);
    expect(() => open('machine-b').readStaged(A)).toThrow('run-mismatch');

    admit(B);
    fs.copyFileSync(artifact(A), artifact(B));
    expect(() => open().readStaged(B)).toThrow('stage-mismatch');
  });

  it('requires an admitted exact run and a known door before recording probe starts', () => {
    expect(() => store.startRun('../doorway-scan-abc-0', START)).toThrow('run-id-invalid');
    expect(() => store.startDoor(A, ALPHA, DOOR_START)).toThrow('run-mismatch');
    store.startRun(A, START);
    expect(() => store.startDoor(A, 'unknown-door', DOOR_START)).toThrow('door-unknown');
    expect(store.startedDoors(A)).toEqual([]);
  });

  it('rejects unknown or skipped outcomes, unstarted and duplicate doors, and a partial stage', () => {
    admit(A);
    expect(() => store.stage(A, DONE, [observation(BETA)])).toThrow('unstarted-or-duplicate-door');
    expect(() => store.stage(A, DONE, [
      { ...observation(), probeStatus: 'fabricated' as ScheduledDoorwayObservation['probeStatus'] },
    ])).toThrow('outcome-invalid');
    expect(() => store.stage(A, DONE, [
      { ...observation(), probeStatus: 'not-probed-this-run' as ScheduledDoorwayObservation['probeStatus'] },
    ])).toThrow('outcome-invalid');
    store.startDoor(A, BETA, DOOR_START);
    expect(() => store.stage(A, DONE, [observation()])).toThrow('observations-incomplete');
    expect(() => store.stage(A, DONE, [observation(), observation()])).toThrow('unstarted-or-duplicate-door');
    expect(store.readStaged(A)).toBeNull();
  });

  it('requires finite ordered UTC times, including after readback', () => {
    expect(() => store.startRun(A, '2026-02-30T17:00:00.000Z')).toThrow('time-invalid');
    expect(() => store.startRun(A, FUTURE)).toThrow('time-order');
    store.startRun(A, DOOR_START);
    expect(() => store.startDoor(A, ALPHA, START)).toThrow('time-order');
    store.startDoor(A, ALPHA, DOOR_START);
    expect(() => store.stage(A, DONE, [{ ...observation(), observedAt: START }])).toThrow('time-order');
    expect(() => store.stage(A, DOOR_START, [observation()])).toThrow('time-order');
    store.stage(A, DONE, [observation()]);
    const raw = store.readStaged(A);
    fs.writeFileSync(artifact(A), JSON.stringify({ ...raw, completedAt: FUTURE }));
    expect(() => open().readStaged(A)).toThrow('time-order');
  });

  it('does not follow a substituted staged artifact symlink', () => {
    admit(A);
    admit(B);
    store.stage(A, DONE, [observation()]);
    fs.symlinkSync(artifact(A), artifact(B), 'file');
    expect(() => open().readStaged(B)).toThrow();
  });
});
