/**
 * MachineHeartbeat — per-machine liveness signal for multi-machine
 * project ownership.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § P5 ("Machine ownership for
 * multi-machine coherence").
 *
 * Each machine writes `.instar/machine-health/<machineId>.json` every
 * heartbeat interval (default 30 minutes). The file is GIT-SYNCED, so
 * other machines see fresh heartbeats from any peer that's online.
 *
 * Leader election (claim-ownership) treats a heartbeat older than
 * `staleThresholdMs` (default 48 hours) as evidence that the recorded
 * owner has gone offline and the claim should be allowed to proceed.
 *
 * What this class is NOT responsible for:
 *   - The git-sync that pushes the heartbeat file (handled by the
 *     existing GitSync layer).
 *   - The 60-second wait-for-convergence that the spec requires of
 *     a claimer. That's the caller's responsibility — the heartbeat
 *     just provides the staleness query.
 *
 * File schema:
 *   {
 *     "machineId": "<stable id>",
 *     "hostname": "<os.hostname()>",
 *     "lastHeartbeatAt": "<ISO timestamp>",
 *     "instarVersion": "<package.json version>"
 *   }
 *
 * Corruption tolerance: a malformed heartbeat file is treated as a
 * missing heartbeat (stale by definition). The next write overwrites
 * it with a valid record.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 min
export const DEFAULT_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48h

export interface HeartbeatRecord {
  machineId: string;
  hostname: string;
  lastHeartbeatAt: string;
  instarVersion?: string;
}

export interface MachineHeartbeatConfig {
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
  /** Stable machine id (usually the coordinator's machine id). */
  machineId: string;
  /** Defaults to 30 minutes; tests dial this down. */
  heartbeatIntervalMs?: number;
  /** Defaults to 48h. Tests dial this down. */
  staleThresholdMs?: number;
  /** Optional version string written into the heartbeat record. */
  instarVersion?: string;
  /** Optional clock override (tests). */
  now?: () => Date;
}

export class MachineHeartbeat {
  private stateDir: string;
  private machineId: string;
  private heartbeatIntervalMs: number;
  private staleThresholdMs: number;
  private instarVersion?: string;
  private now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: MachineHeartbeatConfig) {
    this.stateDir = config.stateDir;
    this.machineId = config.machineId;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleThresholdMs = config.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.instarVersion = config.instarVersion;
    this.now = config.now ?? (() => new Date());
  }

  /** Identity of THIS machine (read-only for routes that need it). */
  get id(): string {
    return this.machineId;
  }

  /** Write a heartbeat immediately and start the periodic timer. */
  start(): void {
    this.writeOnce();
    if (this.timer) return;
    this.timer = setInterval(() => this.writeOnce(), this.heartbeatIntervalMs);
    // .unref() so heartbeat does not keep the process alive on shutdown.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the periodic timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Write a single heartbeat. Public so server-startup paths can write
   *  one before the first interval fires. */
  writeOnce(): HeartbeatRecord {
    this.ensureDir();
    const record: HeartbeatRecord = {
      machineId: this.machineId,
      hostname: os.hostname(),
      lastHeartbeatAt: this.now().toISOString(),
      instarVersion: this.instarVersion,
    };
    const tmp = this.recordPath(this.machineId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o644 });
    fs.renameSync(tmp, this.recordPath(this.machineId));
    return record;
  }

  /** Read the heartbeat for any machine. Returns null on missing or malformed. */
  read(machineId: string): HeartbeatRecord | null {
    try {
      const raw = fs.readFileSync(this.recordPath(machineId), 'utf-8');
      const obj = JSON.parse(raw);
      if (typeof obj.machineId !== 'string') return null;
      if (typeof obj.hostname !== 'string') return null;
      if (typeof obj.lastHeartbeatAt !== 'string') return null;
      return obj as HeartbeatRecord;
    } catch {
      return null;
    }
  }

  /**
   * Is the heartbeat for `machineId` stale?
   *
   * Returns true when:
   *   - the heartbeat file is missing
   *   - the heartbeat file is malformed (defense-in-depth)
   *   - `lastHeartbeatAt` is older than `staleThresholdMs` ago
   *
   * Returns false when the heartbeat is within the threshold.
   */
  isStale(machineId: string): boolean {
    const r = this.read(machineId);
    if (!r) return true;
    const t = Date.parse(r.lastHeartbeatAt);
    if (!Number.isFinite(t)) return true;
    return this.now().getTime() - t > this.staleThresholdMs;
  }

  /** List all known heartbeats (one per machine). */
  listAll(): HeartbeatRecord[] {
    this.ensureDir();
    const entries = fs.readdirSync(this.dirPath()).filter((n) => n.endsWith('.json'));
    const out: HeartbeatRecord[] = [];
    for (const name of entries) {
      const r = this.read(name.replace(/\.json$/, ''));
      if (r) out.push(r);
    }
    return out;
  }

  private ensureDir(): void {
    const p = this.dirPath();
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }

  private dirPath(): string {
    return path.join(this.stateDir, 'machine-health');
  }

  private recordPath(machineId: string): string {
    // Sanitize: only [A-Za-z0-9_-] allowed in file names. Anything else
    // gets URL-encoded so a stray slash or `..` can't escape.
    const safe = machineId.replace(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
    return path.join(this.dirPath(), `${safe}.json`);
  }
}
