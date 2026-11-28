/**
 * Lock watch (docs/specs/restart-lock-continuity.md, part C.1).
 *
 * A Local Verify machine (or one enrolled unattended/proving) that stays locked
 * for the hold time is reported once per lock episode per host. The episode
 * lives in one host-level file shared by every agent on the OS login, written
 * under its own lock file, so co-resident agents and a restarting agent never
 * double-report. Continuity belongs to the host record: a gap with no reader
 * (longer than the interval plus 60 s) restarts the hold; an `unknown` or
 * screensaver reading interrupts it without ending the episode.
 *
 * Signal only: it reads and reports, and takes no action on the machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync, tryTakeLockOnce, releaseLock, legacyPidDeathLockReclaim } from '../core/hostSemaphoreCore.js';

export type LockReading = 'unlocked' | 'locked' | 'screensaver-or-display-sleep' | 'unknown' | 'not-applicable';

export interface LockEpisode {
  episodeId: string;
  bootAt: number | null;
  firstLockedAt: number;
  continuousLockedSince: number | null;
  lastLockedReadingAt: number | null;
  report: { state: 'none' | 'pending' | 'delivered'; claimedAt?: number; by?: string; floored?: boolean };
  /** Local Verify work was seen waiting at some reading in this episode. */
  workSeen?: boolean;
}

export interface LockWatchFile {
  v: 1;
  episode: LockEpisode | null;
  /** Report times in the last hour, for the hourly floor. */
  reportsAt: number[];
  /** Last definite (non-unknown) reading by any agent on the host; lifts a paused watch. */
  lastDefiniteReadingAt?: number;
}

export interface LockWatchDeps {
  hostDir: string;
  read: () => Promise<LockReading>;
  /** Whether this machine is watched now, and whether the lock is interrupting work. */
  scope: () => { watched: boolean; interruptsWork: boolean; lockOnly: boolean };
  report: (r: { feature: string; firstLockedAt: number; episodeId: string }) => void;
  machineId: string;
  agentName: string;
  bootAt: number | null;
  now?: () => number;
  intervalMs?: number;
  holdMs?: number;
  /** Wait before re-reading an `unknown` deadline reading (past the reader's 5 s cache). */
  rereadDelayMs?: number;
  log?: (line: string) => void;
}

export const PENDING_RECLAIM_MS = 2 * 60 * 1000;
export const HOURLY_FLOOR = 3;
const GAP_SLACK_MS = 60_000;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class LockWatch {
  private readonly file: string;
  private readonly lockPath: string;
  private consecutiveUnknown = 0;
  private paused = false;
  private pausedAt = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: LockWatchDeps) {
    this.file = path.join(d.hostDir, 'lock-watch.json');
    this.lockPath = `${this.file}.lock`;
  }

  private now(): number { return (this.d.now ?? Date.now)(); }
  get intervalMs(): number { return this.d.intervalMs ?? 5 * 60 * 1000; }
  get holdMs(): number { return this.d.holdMs ?? 10 * 60 * 1000; }

  status(): { paused: boolean; consecutiveUnknown: number; file: LockWatchFile } {
    return { paused: this.paused, consecutiveUnknown: this.consecutiveUnknown, file: this.readFile() };
  }

  private readFile(): LockWatchFile {
    try {
      const f = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as LockWatchFile;
      if (f && f.v === 1) return { v: 1, episode: f.episode ?? null, reportsAt: Array.isArray(f.reportsAt) ? f.reportsAt : [], ...(f.lastDefiniteReadingAt ? { lastDefiniteReadingAt: f.lastDefiniteReadingAt } : {}) };
    } catch { /* absent or unreadable: start fresh */ }
    return { v: 1, episode: null, reportsAt: [] };
  }

  /** Run fn on the host file under the lock-watch lock (never HostMaintenanceStore's). */
  private withHostFile<T>(fn: (f: LockWatchFile) => { next: LockWatchFile; out: T }): T | null {
    fs.mkdirSync(this.d.hostDir, { recursive: true });
    const deadline = this.now() + 500;
    for (;;) {
      const taken = tryTakeLockOnce(this.lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
      if (taken.ok) {
        try {
          const { next, out } = fn(this.readFile());
          atomicWriteFileSync(this.file, JSON.stringify(next, null, 2), { operation: 'LockWatch:write' });
          return out;
        } finally {
          releaseLock(this.lockPath, taken.fd, 'LockWatch:release');
        }
      }
      if (taken.reason !== 'held') return null;
      if (legacyPidDeathLockReclaim(this.lockPath, pidAlive)) continue;
      if (Date.now() >= deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  /** One reading and its effect on the host record. Returns what happened. */
  async tick(opts: { deadlineReread?: boolean } = {}): Promise<string> {
    if (this.paused) {
      // A definite reading by another agent on the host since the pause lifts it.
      const last = this.readFile().lastDefiniteReadingAt ?? 0;
      if (last > this.pausedAt) { this.paused = false; this.consecutiveUnknown = 0; this.d.log?.('[lock-watch] resumed: another agent read the lock'); }
      else return 'paused';
    }
    let reading: LockReading;
    try { reading = await this.d.read(); } catch { reading = 'unknown'; }
    if (reading === 'unknown' && opts.deadlineReread) {
      // The reader caches for 5 s; wait past it so the re-read is a fresh reading.
      await new Promise((r) => setTimeout(r, this.d.rereadDelayMs ?? 6000));
      try { reading = await this.d.read(); } catch { reading = 'unknown'; }
    }
    if (reading === 'unknown') {
      this.consecutiveUnknown++;
      if (this.consecutiveUnknown >= 12) {
        this.paused = true;
        this.pausedAt = this.now();
        this.d.log?.('[lock-watch] paused: probe failing (12 unknown readings in a row)');
      }
    } else {
      this.consecutiveUnknown = 0;
    }
    const now = this.now();
    const scope = this.d.scope();
    let claimed = null as LockEpisode | null;
    const result = this.withHostFile<string>((f) => {
      const hourAgo = now - 3600_000;
      f.reportsAt = f.reportsAt.filter((t) => t > hourAgo);
      if (reading !== 'unknown') f.lastDefiniteReadingAt = now;
      if (reading === 'unlocked' || reading === 'not-applicable') {
        return { next: { ...f, episode: null }, out: f.episode ? 'episode-ended' : 'unlocked' };
      }
      if (reading === 'unknown' || reading === 'screensaver-or-display-sleep') {
        if (f.episode) f.episode.continuousLockedSince = null;
        return { next: f, out: 'interrupted' };
      }
      // locked
      let ep = f.episode;
      if (!ep) {
        ep = { episodeId: randomUUID(), bootAt: this.d.bootAt, firstLockedAt: now, continuousLockedSince: now, lastLockedReadingAt: now, report: { state: 'none' } };
      } else {
        const gap = ep.lastLockedReadingAt == null ? Infinity : now - ep.lastLockedReadingAt;
        if (ep.continuousLockedSince == null || gap > this.intervalMs + GAP_SLACK_MS) ep.continuousLockedSince = now;
        ep.lastLockedReadingAt = now;
      }
      if (scope.interruptsWork) ep.workSeen = true;
      f.episode = ep;
      if (!scope.watched) return { next: f, out: 'locked-not-watched' };
      const interrupts = scope.interruptsWork || ep.workSeen === true;
      const held = now - (ep.continuousLockedSince ?? now) >= this.holdMs;
      if (!held) return { next: f, out: 'locked-holding' };
      if (!scope.lockOnly && !interrupts) return { next: f, out: 'locked-attended-idle' };
      const claimable = ep.report.state === 'none'
        || (ep.report.state === 'pending' && (ep.report.claimedAt ?? 0) < now - PENDING_RECLAIM_MS);
      if (!claimable) return { next: f, out: `already-${ep.report.state}` };
      if (f.reportsAt.length >= HOURLY_FLOOR && !interrupts) {
        if (!ep.report.floored) { ep.report.floored = true; this.d.log?.(`[lock-watch] episode ${ep.episodeId} recorded, not alerted: hourly floor`); }
        return { next: f, out: 'floored' };
      }
      ep.report = { state: 'pending', claimedAt: now, by: `${this.d.agentName}@${this.d.machineId}` };
      claimed = { ...ep, report: { ...ep.report } };
      return { next: f, out: 'claimed' };
    });
    if (result === 'claimed' && claimed !== null) {
      const ep = claimed as LockEpisode;
      this.d.report({ feature: `machine-lock.screen-locked:${this.d.machineId}:${ep.episodeId}`, firstLockedAt: ep.firstLockedAt, episodeId: ep.episodeId });
      // Mark delivered, retrying a busy lock so contention cannot cause a second report.
      let marked = false;
      for (let i = 0; i < 3 && !marked; i++) {
        marked = this.withHostFile((f) => {
          if (f.episode && f.episode.episodeId === ep.episodeId) f.episode.report = { ...f.episode.report, state: 'delivered' };
          f.reportsAt.push(now);
          return { next: f, out: true };
        }) === true;
      }
      if (!marked) this.d.log?.(`[lock-watch] episode ${ep.episodeId} reported but could not be marked delivered; a co-resident agent may report it again after ${PENDING_RECLAIM_MS / 60000} min`);
      return 'reported';
    }
    if (result === 'locked-holding') this.scheduleDeadline();
    return result ?? 'lock-busy';
  }

  /** One extra reading exactly at the hold deadline. */
  private scheduleDeadline(): void {
    if (this.deadlineTimer) return;
    const ep = this.readFile().episode;
    if (!ep || ep.continuousLockedSince == null) return;
    const wait = Math.max(0, ep.continuousLockedSince + this.holdMs - this.now());
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      void this.tick({ deadlineReread: true }).catch(() => { /* next interval retries */ });
    }, wait);
    this.deadlineTimer.unref?.();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const loop = (): void => {
      const delay = this.consecutiveUnknown >= 3 ? 15 * 60 * 1000 : this.intervalMs;
      this.timer = setTimeout(() => {
        // A paused watch keeps a 15-minute check of the host file so another agent's reading can lift it.
        void this.tick().catch(() => { /* next interval retries */ }).finally(() => { if (!this.stopped) loop(); });
      }, this.paused ? 15 * 60 * 1000 : delay);
      this.timer.unref?.();
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.timer = null;
    this.deadlineTimer = null;
  }
}

let activeLockWatch: LockWatch | null = null;
export function setActiveLockWatch(w: LockWatch | null): void { activeLockWatch = w; }
export function getActiveLockWatch(): LockWatch | null { return activeLockWatch; }
