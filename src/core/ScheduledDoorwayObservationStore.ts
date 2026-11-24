import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROBE_STATUS_ENUM, type ProbeStatus } from './DoorwayRegistryReader.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const RUN_ID = /^doorway-scan-[a-z0-9]{1,24}-[a-z0-9]{1,24}$/;
const ID = /^[A-Za-z0-9._/:-]{1,80}$/;
const MACHINE = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_DOORS = 200;
const MAX_ARTIFACT_BYTES = 64 * 1024;

type AttemptedProbeStatus = Exclude<ProbeStatus, `not-probed-${string}`>;
export interface ScheduledDoorwayRun {
  schemaVersion: 1;
  runId: string;
  machineId: string;
  startedAt: string;
}
export interface ScheduledDoorwayStart extends ScheduledDoorwayRun {
  doorId: string;
  doorStartedAt: string;
}
export interface ScheduledDoorwayObservation {
  doorId: string;
  probeStatus: AttemptedProbeStatus;
  observedAt: string;
}
export interface StagedDoorwayObservation extends ScheduledDoorwayRun {
  completedAt: string;
  observations: ScheduledDoorwayObservation[];
}

function invalid(reason: string): never {
  throw new Error(`scheduled-doorway-observation-${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid('time-invalid');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid('time-invalid');
  return time;
}

function ensureDirectory(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!fs.lstatSync(dir).isDirectory()) invalid('directory-invalid');
}

function syncDirectory(dir: string): void {
  // Windows does not support opening a directory for fsync. A missing link
  // after a crash leaves the run unavailable and does not promote later data.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Publish an fsynced, complete record with exclusive final-name semantics. */
function writeNewRecord(file: string, value: object): void {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_ARTIFACT_BYTES) invalid('artifact-oversize');
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Unlike rename, link refuses to replace an existing name atomically.
    fs.linkSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    SafeFsExecutor.safeUnlinkSync(temporary, { operation: 'scheduled doorway observation temporary cleanup' });
  }
}

function readRecord(file: string): unknown {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    const entry = fs.lstatSync(file);
    if (!stat.isFile() || !entry.isFile() || entry.ino !== stat.ino || entry.dev !== stat.dev
      || stat.size > MAX_ARTIFACT_BYTES) invalid('artifact-invalid');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count !== stat.size) invalid('artifact-changed');
    const parsed: unknown = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!isRecord(parsed)) invalid('artifact-invalid');
    return parsed;
  } finally {
    fs.closeSync(fd);
  }
}

/** Run-specific staging only. The caller owns the verified job ledger and writer fence. */
export class ScheduledDoorwayObservationStore {
  private readonly root: string;
  private readonly doorIds: ReadonlySet<string>;

  constructor(
    private readonly stateDir: string,
    private readonly machineId: string,
    knownDoorIds: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    if (!MACHINE.test(machineId)) invalid('machine-invalid');
    if (knownDoorIds.length > MAX_DOORS || knownDoorIds.some(id => !ID.test(id))) invalid('door-list-invalid');
    this.root = path.join(stateDir, 'state', 'doorway-scan-scheduled-runs');
    this.doorIds = new Set(knownDoorIds);
  }

  startRun(runId: string, startedAt: string): void {
    const directory = this.runDirectory(runId);
    this.checkOrder(startedAt, startedAt);
    if (!fs.lstatSync(this.stateDir).isDirectory()) invalid('directory-invalid');
    ensureDirectory(path.dirname(this.root));
    ensureDirectory(this.root);
    ensureDirectory(directory);
    writeNewRecord(path.join(directory, 'run.json'), { schemaVersion: 1, runId, machineId: this.machineId, startedAt });
    syncDirectory(path.dirname(this.root));
    syncDirectory(this.root);
    syncDirectory(this.stateDir);
  }

  /** Record probe admission. This does not establish that the provider answered. */
  startDoor(runId: string, doorId: string, doorStartedAt: string): void {
    const run = this.requiredRun(runId);
    if (this.readRunArtifact(runId, 'staged.json') !== null) invalid('already-staged');
    this.checkOrder(run.startedAt, doorStartedAt);
    this.requireDoor(doorId);
    writeNewRecord(path.join(this.runDirectory(runId), this.doorFile(doorId)), { ...run, doorId, doorStartedAt });
  }

  startedDoors(runId: string): ScheduledDoorwayStart[] {
    return this.readStartedDoors(runId) ?? invalid('run-mismatch');
  }

  /** A run that never opened its store has no admissions. Corruption still throws. */
  readStartedDoors(runId: string): ScheduledDoorwayStart[] | null {
    const run = this.readRun(runId);
    if (!run) return null;
    const started: ScheduledDoorwayStart[] = [];
    for (const doorId of this.doorIds) {
      const raw = this.readRunArtifact(runId, this.doorFile(doorId));
      if (raw === null) continue;
      if (!isRecord(raw) || raw.doorId !== doorId || raw.startedAt !== run.startedAt
        || raw.runId !== runId || raw.machineId !== this.machineId || raw.schemaVersion !== 1
        || typeof raw.doorStartedAt !== 'string') invalid('door-start-mismatch');
      this.checkOrder(run.startedAt, raw.doorStartedAt);
      started.push({ ...run, doorId, doorStartedAt: raw.doorStartedAt });
    }
    return started;
  }

  stage(runId: string, completedAt: string, observations: readonly ScheduledDoorwayObservation[]): void {
    const evidence = this.validateStage(runId, completedAt, observations);
    writeNewRecord(path.join(this.runDirectory(runId), 'staged.json'), evidence);
  }

  /** The exact ID comes from scheduler history. This does not select or promote "latest". */
  readStaged(runId: string): StagedDoorwayObservation | null {
    const raw = this.readRunArtifact(runId, 'staged.json');
    if (raw === null) return null;
    const run = this.requiredRun(runId);
    if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.runId !== run.runId
      || raw.machineId !== run.machineId || raw.startedAt !== run.startedAt
      || typeof raw.completedAt !== 'string') invalid('stage-mismatch');
    return this.validateStage(runId, raw.completedAt, raw.observations);
  }

  private validateStage(runId: string, completedAt: string, input: unknown): StagedDoorwayObservation {
    const run = this.requiredRun(runId);
    const completion = this.checkOrder(run.startedAt, completedAt);
    const started = new Map(this.startedDoors(runId).map(door => [door.doorId, door]));
    if (!Array.isArray(input) || input.length !== started.size || !input.length) invalid('observations-incomplete');

    const observations = input.map(row => {
      if (!isRecord(row) || typeof row.doorId !== 'string' || typeof row.probeStatus !== 'string'
        || typeof row.observedAt !== 'string') invalid('observation-invalid');
      const door = started.get(row.doorId);
      if (!door) invalid('unstarted-or-duplicate-door');
      if (!PROBE_STATUS_ENUM.includes(row.probeStatus as ProbeStatus) || row.probeStatus.startsWith('not-probed-')) {
        invalid('outcome-invalid');
      }
      if (this.checkOrder(door.doorStartedAt, row.observedAt) > completion) invalid('time-order');
      started.delete(row.doorId);
      return { doorId: row.doorId, probeStatus: row.probeStatus as AttemptedProbeStatus, observedAt: row.observedAt };
    });
    return { ...run, completedAt, observations };
  }

  private requiredRun(runId: string): ScheduledDoorwayRun {
    return this.readRun(runId) ?? invalid('run-mismatch');
  }

  private readRun(runId: string): ScheduledDoorwayRun | null {
    const run = this.readRunArtifact(runId, 'run.json');
    if (run === null) return null;
    if (!isRecord(run) || run.schemaVersion !== 1 || run.runId !== runId || run.machineId !== this.machineId
      || typeof run.startedAt !== 'string') invalid('run-mismatch');
    this.checkOrder(run.startedAt, run.startedAt);
    return { schemaVersion: 1, runId, machineId: this.machineId, startedAt: run.startedAt };
  }

  private readRunArtifact(runId: string, filename: string): unknown {
    const directory = this.runDirectory(runId);
    try {
      for (const dir of [this.stateDir, path.dirname(this.root), this.root, directory]) {
        if (!fs.lstatSync(dir).isDirectory()) invalid('directory-invalid');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return readRecord(path.join(directory, filename));
  }

  private runDirectory(runId: string): string {
    if (!RUN_ID.test(runId)) invalid('run-id-invalid');
    return path.join(this.root, runId);
  }

  private doorFile(doorId: string): string {
    return `door-${Buffer.from(doorId).toString('hex')}.json`;
  }

  private requireDoor(doorId: string): void {
    if (!this.doorIds.has(doorId)) invalid('door-unknown');
  }

  private checkOrder(start: string, end: string): number {
    const from = timestamp(start);
    const to = timestamp(end);
    const now = this.now();
    if (!Number.isFinite(now) || from > to || to > now) invalid('time-order');
    return to;
  }
}
