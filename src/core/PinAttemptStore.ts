/**
 * PinAttemptStore — durable write-through behind the PIN routes' per-IP
 * brute-force lockout (docs/specs/routing-control-room-spend-alerts.md,
 * Surface 2, S2-1 hardening).
 *
 * `checkMandatePin`'s attempt counter was an in-memory Map, so a server restart
 * reset the lockout. This store persists the counters to
 * `<stateDir>/state/pin-attempts.json` (atomic tmp+rename) and is shared by the
 * PIN routes. Semantics unchanged: N attempts per window per IP; the window
 * expiry clears the entry. Express `trust proxy` is off fleet-wide, so req.ip
 * already ignores X-Forwarded-For.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { writeDurable } from './PinShare.js';

interface AttemptEntry {
  count: number;
  resetAt: number;
}

/** One cap across every source address, shared by every route that takes a PIN with no bearer token. */
export const GLOBAL_PIN_KEY = '__dashboard_unlock_global__';
export const GLOBAL_PIN_MAX_ATTEMPTS = 20;

/** identity-security-piece1c: the store never holds more rows than this (oldest unlocked rows go first). */
export const PIN_ATTEMPT_MAX_ROWS = 4096;

export class PinAttemptStore {
  private readonly filePath: string;
  private entries = new Map<string, AttemptEntry>();
  /**
   * identity-security-piece1c: set when the file on disk was empty, corrupt or invalid at load. The
   * file was moved aside; until this time the GLOBAL key reads as saturated (one window), so a
   * damaged file never hands a guesser a fresh budget, and nobody has to repair anything.
   */
  private saturatedUntil = 0;
  private writeFailureReported = false;
  /**
   * SEC-170: set when a wrong guess on the shared unknown-browser key could not be written. While set,
   * that key reads as spent (fail toward stricter), and each check retries the write at most once a
   * second; the first successful write clears it.
   */
  private globalUnsavedSince = 0;
  private lastGlobalRetryAt = 0;
  /**
   * SEC-170 part 3: times of recent wrong guesses on the shared unknown-browser key, for the agent-wide alert
   * (failures across all machines within one hour). In memory only: a restart forgets them, which only
   * delays an alert; it never changes what is admitted.
   */
  private globalFailureTimes: number[] = [];
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  /** SEC-170: refuse on a failed write of the shared key only while the pool-wide budget is on. */
  private readonly strictGlobal: () => boolean;

  constructor(opts: { stateDir: string; maxAttempts?: number; windowMs?: number; now?: () => number; strictGlobal?: () => boolean }) {
    const stateSub = path.join(opts.stateDir, 'state');
    fs.mkdirSync(stateSub, { recursive: true });
    this.filePath = path.join(stateSub, 'pin-attempts.json');
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.windowMs = opts.windowMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.strictGlobal = opts.strictGlobal ?? (() => false);
    this.load();
  }

  /** True when the IP is currently locked out. */
  blocked(ip: string, maxAttempts = this.maxAttempts): boolean {
    // SEC-170: a cap of 0 (a machine whose PIN share is 0) admits nothing, even before any row exists.
    if (maxAttempts <= 0) return true;
    if (ip === GLOBAL_PIN_KEY && this.now() < this.saturatedUntil) return true;
    if (ip === GLOBAL_PIN_KEY && this.globalUnsavedSince && this.strictGlobal()) {
      const now = this.now();
      if (now - this.lastGlobalRetryAt >= 1000) { this.lastGlobalRetryAt = now; if (this.persist()) this.globalUnsavedSince = 0; }
      if (this.globalUnsavedSince) return true;
    }
    const e = this.current(ip);
    return e !== undefined && e.count >= maxAttempts;
  }

  /** Whether the load found a damaged file and the global budget is held saturated for one window. */
  get pausedAfterCorruptLoad(): boolean { return this.now() < this.saturatedUntil; }

  /** Record a FAILED attempt; returns attempts remaining (≥ 0). */
  recordFailure(ip: string, maxAttempts = this.maxAttempts): number {
    let e = this.current(ip);
    if (!e) {
      e = { count: 0, resetAt: this.now() + this.windowMs };
      this.entries.set(ip, e);
    }
    e.count++;
    if (ip === GLOBAL_PIN_KEY) {
      this.globalFailureTimes.push(this.now());
      if (this.globalFailureTimes.length > PIN_ATTEMPT_MAX_ROWS) this.globalFailureTimes.splice(0, this.globalFailureTimes.length - PIN_ATTEMPT_MAX_ROWS);
    }
    this.prune();
    if (!this.persist() && ip === GLOBAL_PIN_KEY && !this.globalUnsavedSince) { this.globalUnsavedSince = this.now(); this.lastGlobalRetryAt = this.now(); }
    return Math.max(0, maxAttempts - e.count);
  }

  /** SEC-170 part 3: wrong guesses on the shared unknown-browser key within the last `withinMs`. */
  globalFailuresWithin(withinMs: number): number {
    const since = this.now() - withinMs;
    while (this.globalFailureTimes.length > 0 && this.globalFailureTimes[0] < since) this.globalFailureTimes.shift();
    return this.globalFailureTimes.length;
  }

  /** Clear an IP's counter on a successful PIN entry. */
  recordSuccess(ip: string): void {
    if (this.entries.delete(ip)) this.persist();
  }

  private current(ip: string): AttemptEntry | undefined {
    const e = this.entries.get(ip);
    if (e && this.now() > e.resetAt) {
      this.entries.delete(ip);
      this.persist();
      return undefined;
    }
    return e;
  }

  /** Drop expired rows; above the cap, drop the oldest rows that are not locked out. */
  private prune(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (now > e.resetAt) this.entries.delete(k);
    if (this.entries.size <= PIN_ATTEMPT_MAX_ROWS) return;
    const unlocked = [...this.entries].filter(([k, e]) => k !== GLOBAL_PIN_KEY && e.count < this.maxAttempts)
      .sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [k] of unlocked) {
      if (this.entries.size <= PIN_ATTEMPT_MAX_ROWS) break;
      this.entries.delete(k);
    }
  }

  /**
   * identity-security-piece1c. A missing file starts fresh (first boot, a restore). An empty,
   * corrupt or invalid file (a negative, non-integer or non-finite count) is moved aside and the
   * global budget is held saturated for one window, then counting resumes — never the fail-open
   * reset to empty, and no operator step.
   */
  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return; // @silent-fallback-ok: no file yet = nothing counted yet
      this.quarantine('unreadable', err);
      return;
    }
    try {
      const raw = JSON.parse(text) as Record<string, AttemptEntry>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      const loaded = new Map<string, AttemptEntry>();
      for (const [ip, e] of Object.entries(raw)) {
        if (!e || !Number.isInteger(e.count) || e.count < 0 || !Number.isFinite(e.resetAt)) throw new Error(`invalid row ${ip.slice(0, 40)}`);
        loaded.set(ip, e);
      }
      this.entries = loaded;
      this.prune();
    } catch (err) {
      this.quarantine('corrupt', err);
    }
  }

  private quarantine(kind: string, err: unknown): void {
    this.entries = new Map();
    this.saturatedUntil = this.now() + this.windowMs;
    try {
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath.replace(/\.json$/, '')}.corrupt-${this.now()}.json`);
    } catch { /* @silent-fallback-ok: the in-memory saturation below holds regardless */ }
    // Write the paused window back as a valid file, so a restart during the pause sees the global
    // budget used up instead of a missing file (which would start fresh).
    this.entries.set(GLOBAL_PIN_KEY, { count: Number.MAX_SAFE_INTEGER, resetAt: this.saturatedUntil });
    this.persist();
    DegradationReporter.getInstance().report({ feature: 'PinAttemptStore.load',
      primary: 'PIN guess counters loaded from disk', fallback: 'Damaged file set aside; unmarked PIN sign-in paused for one window, then counting resumes',
      reason: `${kind}: ${err instanceof Error ? err.message : String(err)}`,
      impact: 'For up to five minutes, PIN sign-in from a browser that never signed in before is refused; known browsers, the phone and this computer still work.' });
  }

  /** True when the counters reached the disk (flushed when SEC-170's pool-wide budget is on). */
  private persist(): boolean {
    try {
      const text = JSON.stringify(Object.fromEntries(this.entries));
      if (this.strictGlobal()) {
        writeDurable(this.filePath, text); // SEC-170: flushed, so a counted guess survives a power loss
      } else {
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, this.filePath);
      }
      this.writeFailureReported = false;
      return true;
    } catch (err) {
      // A failed write keeps enforcing the in-memory counters and is reported once per episode. For the
      // shared unknown-browser key it also refuses until a write succeeds (SEC-170: fail toward stricter).
      if (!this.writeFailureReported) {
        this.writeFailureReported = true;
        DegradationReporter.getInstance().report({ feature: 'PinAttemptStore.persist',
          primary: 'PIN guess counters written to disk', fallback: 'Counters keep enforcing in memory',
          reason: err instanceof Error ? err.message : String(err),
          impact: 'A restart during this episode would lose at most the current five-minute window of counted guesses. PIN sign-in from new browsers is refused until a write succeeds.' });
      }
      return false;
    }
  }
}
