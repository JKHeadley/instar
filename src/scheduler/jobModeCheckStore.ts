/**
 * Per-job job-mode check state (docs/specs/job-mode-instructions.md, Change 6).
 *
 * One file per job under `.instar/state/job-mode-checks/`, machine-local by design: it records how
 * THIS machine's Claude Code honoured the launch flags. Every read-modify-write of a job's state runs
 * under a per-job lock in the server process. Each launch captures the job's generation; an
 * operator clear advances it, and a result from an earlier generation is discarded.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TranscriptVerdict } from './jobModeInstructions.js';

export const UNKNOWN_RETRY_LIMIT = 3;
/** A recovery probe with no verdict after this long (for example lost in a restart) is offered again. */
export const PROBE_STALE_MS = 6 * 60 * 60 * 1000;

export interface JobModeCheckState {
  key: string;
  generation: number;
  /** `<instar version>|<claude code version>` the last decision was made for. */
  versionPair: string | null;
  /** Result for the current version pair, once decided. */
  result: 'pass' | 'fail' | 'unknown-exhausted' | null;
  unknownAttempts: number;
  /** Local suppression after a fail: effective mode is full until a passing probe. */
  suppressed: boolean;
  /** A single probe run has been reserved (after a version change or clear). */
  probeReserved: boolean;
  /** Claude config homes (accounts) this job has passed under for the current version pair. */
  passedConfigHomes?: string[];
  /** Unknown results per config home for the current version pair; any home reaching the limit exhausts. */
  unknownByHome?: Record<string, number>;
  /** Id of the reserved recovery probe launch; only its pass may lift a fallback. */
  probeId?: number;
  /** When the current recovery probe launched; a probe that never reports (a restart lost it) is re-offered after PROBE_STALE_MS. */
  probeStartedAt?: number;
  /** Runs since the last check, per pass key, persisted so a restart cannot defer the sampled re-check. */
  runsSinceCheck?: Record<string, number>;
  /** Recovery probe launches for the current version pair (capped at UNKNOWN_RETRY_LIMIT, however they end). */
  probeLaunches?: number;
  /** What the most recently completed job-mode launch actually did (job mode applied, or the reason it was not). */
  lastRun?: { applied: boolean; reason?: string; at: string };
  updatedAt: string;
}

export type LaunchDecision =
  | { launch: 'job-mode'; check: boolean; generation: number; probeId?: number }
  | { launch: 'full'; reason: 'suppressed-after-failed-check' | 'unknown-after-retries'; generation: number };

/**
 * Whether a suppressed job's next launch is a recovery probe: a probe is reserved, or the last one is stale
 * (no verdict after PROBE_STALE_MS), and the cap of probe launches for this version pair is not reached. The
 * single rule both the launch decision and the status route read.
 */
export function recoveryProbeAvailable(s: Pick<JobModeCheckState, 'probeReserved' | 'probeStartedAt' | 'probeLaunches'>, now: number): boolean {
  const wanted = s.probeReserved || (s.probeStartedAt !== undefined && now - s.probeStartedAt > PROBE_STALE_MS);
  return wanted && (s.probeLaunches ?? 0) < UNKNOWN_RETRY_LIMIT;
}

/** Field-by-field shape check: a record that fails it is treated as fresh (the next launch is checked). */
function validState(r: Record<string, unknown>): boolean {
  const optNum = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  const strArr = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  const numMap = (v: unknown) => v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'number' && Number.isFinite(x)));
  return typeof r.generation === 'number' && Number.isInteger(r.generation)
    && (r.versionPair === null || typeof r.versionPair === 'string')
    && (r.result === null || r.result === 'pass' || r.result === 'fail' || r.result === 'unknown-exhausted')
    && typeof r.unknownAttempts === 'number' && typeof r.suppressed === 'boolean' && typeof r.probeReserved === 'boolean'
    && strArr(r.passedConfigHomes) && numMap(r.unknownByHome) && numMap(r.runsSinceCheck)
    && optNum(r.probeId) && optNum(r.probeStartedAt) && optNum(r.probeLaunches);
}

function fileSafe(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class JobModeCheckStore {
  private readonly dir: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'state', 'job-mode-checks');
  }

  private file(key: string): string { return path.join(this.dir, `${fileSafe(key)}.json`); }

  read(key: string): JobModeCheckState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(key), 'utf8'));
      if (raw && typeof raw === 'object' && raw.key === key && validState(raw)) return raw as JobModeCheckState;
    } catch { /* @silent-fallback-ok — no state yet, or an unreadable file, starts fresh (fresh state launches job-mode with a check, the conservative-to-verify path) */ }
    return { key, generation: 0, versionPair: null, result: null, unknownAttempts: 0, suppressed: false, probeReserved: false, updatedAt: new Date(0).toISOString() };
  }

  private write(s: JobModeCheckState): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(s.key)}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, this.file(s.key));
  }

  /** Serialize every read-modify-write for one job. */
  withLock<T>(key: string, fn: () => T): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /**
   * Decide the effective launch for a job configured as job-mode. A new version pair resets the
   * decision and, if the job was suppressed, reserves one probe run under the lock.
   */
  decideLaunch(key: string, versionPair: string): Promise<LaunchDecision> {
    return this.withLock(key, () => {
      const s = this.read(key);
      if (s.versionPair !== versionPair) {
        s.versionPair = versionPair;
        // A version change starts a new generation, so a late verdict from a run under an earlier stint of this same
        // pair (A -> B -> A) is discarded instead of landing on the fresh state.
        s.generation += 1;
        s.result = null;
        s.unknownAttempts = 0;
        s.passedConfigHomes = [];
        s.unknownByHome = {};
        s.probeLaunches = 0;
        s.runsSinceCheck = {};
        if (s.suppressed) s.probeReserved = true;
      }
      if (s.suppressed) {
        // At most UNKNOWN_RETRY_LIMIT probe launches per version pair, however they ended (recoveryProbeAvailable).
        const probe = recoveryProbeAvailable(s, Date.now());
        if (!probe && (s.probeLaunches ?? 0) >= UNKNOWN_RETRY_LIMIT) { s.probeReserved = false; s.probeStartedAt = undefined; }
        if (probe) {
          s.probeReserved = false; // the single probe is consumed by this launch
          s.probeId = (s.probeId ?? 0) + 1;
          s.probeStartedAt = Date.now();
          s.probeLaunches = (s.probeLaunches ?? 0) + 1;
          this.write(s);
          return { launch: 'job-mode', check: true, generation: s.generation, probeId: s.probeId } as LaunchDecision;
        }
        this.write(s);
        return { launch: 'full', reason: 'suppressed-after-failed-check', generation: s.generation } as LaunchDecision;
      }
      if (s.result === 'unknown-exhausted') {
        // Unmeasurable counts as a failure, never a pass: run with full instructions until a version
        // change or an operator clear allows a fresh check (smaller-context-never-costs-coherence, obligation 3).
        this.write(s);
        return { launch: 'full', reason: 'unknown-after-retries', generation: s.generation } as LaunchDecision;
      }
      const check = s.result === null;
      this.write(s);
      return { launch: 'job-mode', check, generation: s.generation } as LaunchDecision;
    });
  }

  /** Record a transcript verdict for a run launched at `generation`. Stale generations are discarded. */
  /**
   * Count one completed run for a key that already passed; true when this run is due a sampled re-check
   * (every `every`-th run). Persisted, so restarts do not reset the count.
   */
  noteRunForRecheck(key: string, passKey: string, every: number): Promise<boolean> {
    return this.withLock(key, () => {
      const s = this.read(key);
      const n = ((s.runsSinceCheck ?? {})[passKey] ?? 0) + 1;
      const due = n >= every;
      // Not reset here: the count resets only when the sampled check's verdict is recorded (recordResult), so a
      // restart between the two cannot lose the sample.
      s.runsSinceCheck = { ...(s.runsSinceCheck ?? {}), [passKey]: n };
      this.write(s);
      return due;
    });
  }

  /** Whether this job has passed under `configHome` for `versionPair` (a run under a new account is checked). */
  hasPassedUnder(key: string, versionPair: string, configHome: string): boolean {
    const s = this.read(key);
    return s.versionPair === versionPair && (s.passedConfigHomes ?? []).includes(configHome);
  }

  recordResult(key: string, generation: number, versionPair: string, verdict: TranscriptVerdict, configHome?: string, probeId?: number): Promise<{ applied: boolean; state: JobModeCheckState; newlyFailed: boolean; exhaustedUnknown: boolean }> {
    return this.withLock(key, () => {
      const s = this.read(key);
      if (s.generation !== generation || s.versionPair !== versionPair) {
        return { applied: false, state: s, newlyFailed: false, exhaustedUnknown: false };
      }
      let newlyFailed = false;
      let exhaustedUnknown = false;
      // Once the job has fallen back (failed check or exhausted unknowns), only the reserved recovery
      // probe's pass may lift it; a pass from an ordinary run already in flight is recorded for its
      // account but does not restore job-mode.
      if (configHome) s.runsSinceCheck = { ...(s.runsSinceCheck ?? {}), [configHome]: 0 }; // a verdict for this key resets its sample count
      const fallenBack = s.suppressed || s.result === 'unknown-exhausted';
      const isProbe = probeId !== undefined && probeId === s.probeId;
      if (isProbe) s.probeStartedAt = undefined; // the probe reported
      if (verdict === 'pass' && fallenBack && !isProbe) {
        if (configHome) s.passedConfigHomes = [...new Set([...(s.passedConfigHomes ?? []), configHome])];
        this.write(s);
        return { applied: true, state: s, newlyFailed: false, exhaustedUnknown: false };
      }
      if (verdict === 'pass') {
        s.result = 'pass'; s.suppressed = false; s.probeReserved = false;
        if (configHome) {
          s.passedConfigHomes = [...new Set([...(s.passedConfigHomes ?? []), configHome])];
          // A pass clears only its own account's unknown count; another account's unknowns still add up.
          if (s.unknownByHome) delete s.unknownByHome[configHome];
          // A verified pass also shows launches are going through: clear the spawn-rejection count, so occasional
          // rejections spread across successful runs never add up to a fallback.
          if (s.unknownByHome) delete s.unknownByHome['spawn-rejected'];
          s.unknownAttempts = Math.max(0, ...Object.values(s.unknownByHome ?? {}));
        } else {
          s.unknownAttempts = 0;
        }
      } else if (verdict === 'fail') {
        newlyFailed = !s.suppressed;
        // Any failed check ends recovery for this version pair outright: no reservation, no pending timer,
        // no attempts left (an update or an operator clear starts recovery afresh).
        s.result = 'fail'; s.suppressed = true; s.probeReserved = false; s.probeStartedAt = undefined; s.probeLaunches = UNKNOWN_RETRY_LIMIT;
        // The failing combination loses any earlier pass, so it is re-checked if recovery ever reaches it again.
        if (configHome) s.passedConfigHomes = (s.passedConfigHomes ?? []).filter((h) => h !== configHome);
        if (!isProbe && s.probeId !== undefined) s.probeId += 1; // an in-flight probe is no longer current: its later pass cannot lift this
      } else {
        if (configHome) {
          // An unknown revokes that key's earlier pass, so its next run is checked (not deferred to the next sample).
          s.passedConfigHomes = (s.passedConfigHomes ?? []).filter((h) => h !== configHome);
          s.unknownByHome = { ...(s.unknownByHome ?? {}), [configHome]: ((s.unknownByHome ?? {})[configHome] ?? 0) + 1 };
          s.unknownAttempts = Math.max(...Object.values(s.unknownByHome));
        } else {
          s.unknownAttempts += 1;
        }
        if (s.unknownAttempts >= UNKNOWN_RETRY_LIMIT) { s.result = 'unknown-exhausted'; exhaustedUnknown = true; }
        // A suppressed job's probe that came back unknown gets another probe on the next run, at most
        // UNKNOWN_RETRY_LIMIT probe launches per version pair in total across all accounts.
        const totalUnknown = configHome ? Object.values(s.unknownByHome ?? {}).reduce((a, b) => a + b, 0) : s.unknownAttempts;
        // Only the CURRENT recovery probe's unknown re-offers a probe; a late unknown from a superseded probe or an
        // ordinary run never reopens recovery (for example after a newer probe failed).
        if (s.suppressed && isProbe && !exhaustedUnknown && totalUnknown < UNKNOWN_RETRY_LIMIT) s.probeReserved = true;
      }
      this.write(s);
      return { applied: true, state: s, newlyFailed, exhaustedUnknown };
    });
  }

  /** Record what the latest job-mode launch actually did, for the status route. */
  noteLastRun(key: string, run: { applied: boolean; reason?: string }): Promise<void> {
    return this.withLock(key, () => {
      const s = this.read(key);
      s.lastRun = { applied: run.applied, ...(run.reason ? { reason: run.reason } : {}), at: new Date().toISOString() };
      this.write(s);
    });
  }

  /** A probe launch that did not run in job mode (spawn failed, or the flags were skipped): give the probe back. */
  releaseProbe(key: string, probeId: number): Promise<void> {
    return this.withLock(key, () => {
      const s = this.read(key);
      if (s.suppressed && s.probeId === probeId && !s.probeReserved) {
        s.probeStartedAt = undefined;
        // The launch never ran in job mode, so it does not count: refund its attempt and offer the probe again.
        s.probeLaunches = Math.max(0, (s.probeLaunches ?? 0) - 1);
        s.probeReserved = true;
        this.write(s);
      }
    });
  }

  /** Operator clear: advance the generation, lift suppression, and re-check on the next run. */
  clear(key: string): Promise<JobModeCheckState> {
    return this.withLock(key, () => {
      const s = this.read(key);
      s.generation += 1;
      s.result = null; s.unknownAttempts = 0; s.suppressed = false; s.probeReserved = false; s.passedConfigHomes = []; s.unknownByHome = {}; s.probeStartedAt = undefined; s.probeLaunches = 0; s.runsSinceCheck = {};
      this.write(s);
      return s;
    });
  }
}
