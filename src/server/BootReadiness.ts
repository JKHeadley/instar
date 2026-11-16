/**
 * BootReadiness — what a starting server says while it is not ready yet, and the
 * `bootReadiness` field it keeps on `/health` once it is.
 *
 * Earned 2026-11-16 (M5 Pro): a restart's new process took 2m43s to open its port.
 * Peers got 403 (shutting down) and then ECONNREFUSED, and could not tell a slow
 * boot from a dead machine. The boot beacon (BootHealthBeacon) now opens the port at
 * the start of boot on the same host the real server binds, and answers with this
 * typed state; the real server's `/health` carries the same field with
 * `state: "ready"`.
 *
 * The readiness name other code reads is `bootReadiness.state` on `GET /health`:
 *   - "starting": answered by the boot beacon. Every route, `/health` included, is a
 *     503 with `Retry-After`, `x-instar-boot-state: starting` and this snapshot. The
 *     supervisor reads that header as "alive, still booting" (no restart, not up).
 *   - "ready": answered by the real server (`/health` 200 carries the field).
 * So a 200 from `/health` still means "serving" for every existing caller, and a
 * caller that wants the detail (a post-restart proof, a peer) reads the field.
 *
 * Process-wide by design (like featureEvidence): the beacon, the boot sequence in
 * commands/server.ts and the `/health` route all reach the same instance without
 * threading it through dozens of constructors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readLastRestartRequest, type RestartRequestRecord } from '../core/restartRequestAttribution.js';

export type BootReadinessState = 'starting' | 'ready';
export type BootSubsystemState = 'pending' | 'ready' | 'not-started';

/**
 * Subsystems the boot reports, in boot order. Code-defined names only: these appear
 * on an unauthenticated route, so no free text from config or peers goes here.
 */
export const BOOT_SUBSYSTEMS = ['config', 'instance-lock', 'multi-machine', 'scheduler', 'messaging', 'sessions', 'http'] as const;
export type BootSubsystem = typeof BOOT_SUBSYSTEMS[number];

/** Header on every boot-beacon answer, so a client can tell "still booting" from any other 503 without reading the body. */
export const BOOT_STATE_HEADER = 'x-instar-boot-state';

/**
 * True when a peer's answer is the boot beacon's "starting" 503. A caller that reads any
 * 503 as "feature off there" must check this first: a booting peer is temporarily
 * unavailable (retry), not off.
 */
export function isPeerBooting(res: { status: number; headers?: { get(name: string): string | null } | null }): boolean {
  return res.status === 503 && res.headers?.get(BOOT_STATE_HEADER) === 'starting';
}

/** Retry-After bounds (seconds). */
export const MIN_RETRY_AFTER_S = 2;
export const MAX_RETRY_AFTER_S = 30;
/** Used when there is no record of a previous boot's length. */
export const DEFAULT_RETRY_AFTER_S = 10;

export interface BootReadinessSnapshot {
  state: BootReadinessState;
  startedAt: string;
  /** Milliseconds since the process started booting (while starting) or the boot's length (once ready). */
  elapsedMs: number;
  readyAt: string | null;
  /** When the boot beacon opened the port, and on which host. null: the beacon did not run. */
  earlyListen: { at: string; host: string } | null;
  /** Seconds a caller should wait before retrying. Present only while starting. */
  retryAfterSeconds?: number;
  /** The last subsystem that became ready (while starting). */
  phase: BootSubsystem | null;
  subsystems: Record<BootSubsystem, BootSubsystemState>;
  /** The previous boot's length, which the retry estimate is based on. */
  lastBootMs: number | null;
  /** The restart request that ended the previous process (authenticated callers only). */
  previousRestart?: Pick<RestartRequestRecord, 'at' | 'requestedBy' | 'attributed' | 'reason' | 'targetVersion'> | null;
}

interface PersistedBoot { v: 1; bootMs: number; readyAt: string }

const fileFor = (stateDir: string) => path.join(stateDir, 'state', 'boot-readiness.json');

export class BootReadinessTracker {
  private startedAtMs: number;
  private readyAtMs: number | null = null;
  private earlyListen: { atMs: number; host: string } | null = null;
  private lastSubsystem: BootSubsystem | null = null;
  private readonly marks = new Map<BootSubsystem, BootSubsystemState>();
  private lastBootMs: number | null = null;
  private previousRestart: RestartRequestRecord | null = null;
  private stateDir: string | null = null;

  /** `startedAtMs` defaults to when this process started, so the boot length includes module loading. */
  constructor(private readonly now: () => number = Date.now, startedAtMs?: number) {
    this.startedAtMs = startedAtMs ?? Math.round(this.now() - process.uptime() * 1000);
    for (const s of BOOT_SUBSYSTEMS) this.marks.set(s, 'pending');
  }

  /** Bind to the agent's state dir: reads the previous boot's length and the restart that ended it. */
  init(stateDir: string): void {
    this.stateDir = stateDir;
    try {
      const parsed = JSON.parse(fs.readFileSync(fileFor(stateDir), 'utf8')) as Partial<PersistedBoot>;
      if (parsed?.v === 1 && typeof parsed.bootMs === 'number' && Number.isFinite(parsed.bootMs) && parsed.bootMs > 0) {
        this.lastBootMs = parsed.bootMs;
      }
    } catch { /* @silent-fallback-ok — first boot, or unreadable: the default retry applies */ }
    this.previousRestart = readLastRestartRequest(stateDir);
  }

  markListeningEarly(host: string): void {
    if (!this.earlyListen) this.earlyListen = { atMs: this.now(), host };
  }

  mark(subsystem: BootSubsystem): void {
    if (this.readyAtMs !== null) return;
    this.marks.set(subsystem, 'ready');
    this.lastSubsystem = subsystem;
  }

  /** The real server is listening. Idempotent; persists the boot's length for the next estimate. */
  markReady(): void {
    if (this.readyAtMs !== null) return;
    this.marks.set('http', 'ready');
    this.readyAtMs = this.now();
    for (const [k, v] of this.marks) if (v === 'pending') this.marks.set(k, 'not-started');
    if (this.stateDir) {
      try {
        const file = fileFor(this.stateDir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const body: PersistedBoot = { v: 1, bootMs: this.readyAtMs - this.startedAtMs, readyAt: new Date(this.readyAtMs).toISOString() };
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(body));
        fs.renameSync(tmp, file);
      } catch { /* @silent-fallback-ok — the next boot uses the default retry estimate */ }
    }
  }

  get state(): BootReadinessState {
    return this.readyAtMs === null ? 'starting' : 'ready';
  }

  /** Seconds until this boot is likely done, from the previous boot's length; bounded. */
  retryAfterSeconds(): number {
    if (this.lastBootMs === null) return DEFAULT_RETRY_AFTER_S;
    const remainingS = Math.ceil((this.lastBootMs - (this.now() - this.startedAtMs)) / 1000);
    return Math.min(MAX_RETRY_AFTER_S, Math.max(MIN_RETRY_AFTER_S, remainingS));
  }

  snapshot(opts: { includePreviousRestart?: boolean } = {}): BootReadinessSnapshot {
    const ready = this.readyAtMs !== null;
    const subsystems = Object.fromEntries(BOOT_SUBSYSTEMS.map((s) => [s, this.marks.get(s) ?? 'pending'])) as Record<BootSubsystem, BootSubsystemState>;
    const snap: BootReadinessSnapshot = {
      state: this.state,
      startedAt: new Date(this.startedAtMs).toISOString(),
      elapsedMs: (ready ? this.readyAtMs! : this.now()) - this.startedAtMs,
      readyAt: ready ? new Date(this.readyAtMs!).toISOString() : null,
      earlyListen: this.earlyListen ? { at: new Date(this.earlyListen.atMs).toISOString(), host: this.earlyListen.host } : null,
      phase: ready ? 'http' : this.lastSubsystem,
      subsystems,
      lastBootMs: this.lastBootMs,
    };
    if (!ready) snap.retryAfterSeconds = this.retryAfterSeconds();
    if (opts.includePreviousRestart) {
      const r = this.previousRestart;
      snap.previousRestart = r ? { at: r.at, requestedBy: r.requestedBy, attributed: r.attributed, reason: r.reason, targetVersion: r.targetVersion } : null;
    }
    return snap;
  }
}

let instance: BootReadinessTracker | null = null;

/** The process-wide tracker. Created on first use; its clock starts then. */
export function bootReadiness(): BootReadinessTracker {
  if (!instance) instance = new BootReadinessTracker();
  return instance;
}

/** Tests only: start a fresh tracker. */
export function resetBootReadinessForTests(tracker: BootReadinessTracker | null = null): void {
  instance = tracker;
}
