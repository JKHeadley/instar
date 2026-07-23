/**
 * SessionPoolFailoverRunner boot-wiring — config resolver + a throttled driver
 * + a construct-or-null factory (Multi-Machine Session Pool §Rollout, Track H).
 *
 * The merged pieces:
 *   - `SessionPoolFailoverRunner` (the pure orchestrator: gate → run check →
 *     record verdict HONESTLY — green→green, red→red, THROW→record nothing).
 *   - `makeSubprocessFailoverCheck` (the injectable `runFailoverCheck` that runs
 *     the real two-node failover E2E as a bounded subprocess via an injected
 *     `runProcess`; exit0→green, exit≠0→red, did-not-complete→THROW).
 *
 * What THIS module adds is the wiring the deployed server needs and nothing the
 * merged pieces should carry:
 *   - `resolveSessionPoolFailoverRunnerConfig` — the dev-gate + dryRun-first +
 *     cadence resolution (mirrors resolveSingleMachineFailoverGapConfig).
 *   - `SessionPoolFailoverRunnerDriver` — a stateful, slow-cadence throttle over
 *     the pure runner: it owns the tick-interval gate, the in-flight guard, and
 *     the read-only status snapshot the route serves. The heavy E2E subprocess
 *     must NEVER run on a hot loop, so `maybeTick()` is safe to call from an
 *     existing fast cadence — it only fires the runner when `tickIntervalMs` has
 *     elapsed AND no run is in flight.
 *   - `buildSessionPoolFailoverRunnerDriver` — the construct-or-null factory:
 *     enabled → a driver; dark → null (a strict no-op, no route, no timer).
 *
 * ── Honesty / dark-by-default (load-bearing) ──
 * A recorded `green` can promote the agent's sessionPool stage — real authority.
 * So the runner is dark-by-default (dev-gated: `enabled` OMITTED from
 * ConfigDefaults → resolveDevAgentGate) AND dryRun-FIRST: while `dryRun` holds,
 * the driver points the runner at a SIDE result store (a dry-run file the
 * promotion path NEVER reads), so the check runs live and the would-record
 * verdict is captured for the soak, but nothing the driver/StageAdvancer promote
 * on is written. A deliberate `dryRun:false` is what points it at the real store.
 * A throwing check still records NOTHING in either mode (never a fabricated
 * verdict) — the merged runner owns that decision.
 */

import type { SessionPoolE2EResultStore, StageE2EOutcome } from './SessionPoolE2EResultStore.js';
import { SessionPoolFailoverRunner } from './SessionPoolFailoverRunner.js';
import {
  makeSubprocessFailoverCheck,
  DEFAULT_FAILOVER_E2E_PATH,
  DEFAULT_FAILOVER_TIMEOUT_MS,
  type SubprocessRunResult,
} from './sessionPoolFailoverCheck.js';

/** The raw config block shape (all optional — everything defaults). */
export interface SessionPoolFailoverRunnerConfigBlock {
  /** Dev-agent gate: OMITTED from ConfigDefaults so resolveDevAgentGate decides. */
  enabled?: boolean;
  /** Dry-run FIRST even on a dev agent — record to a SIDE store, never the promotion store. */
  dryRun?: boolean;
  /** Slow cadence the heavy E2E runs on. Default 1h; floored so it can never become a hot loop. */
  tickIntervalMs?: number;
  /** Bounded wall-clock budget for the failover E2E subprocess. Default 180s. */
  checkTimeoutMs?: number;
}

/** The resolved, typed config the driver runs with. */
export interface SessionPoolFailoverRunnerResolvedConfig {
  enabled: boolean;
  dryRun: boolean;
  tickIntervalMs: number;
  checkTimeoutMs: number;
}

/** Default slow cadence — the E2E is a heavy two-server subprocess; never a hot loop. */
export const DEFAULT_FAILOVER_RUNNER_TICK_INTERVAL_MS = 3_600_000; // 1h
/** Floor — a tick interval below this is clamped UP (a hot-loop guard). */
export const MIN_FAILOVER_RUNNER_TICK_INTERVAL_MS = 60_000; // 1m

/**
 * Resolve `multiMachine.sessionPool.failoverRunner` against the dev-agent gate.
 * `resolveEnabled` is the injected `resolveDevAgentGate(explicit, config)` result
 * (kept as a param so this module stays free of a hard import — the server wiring
 * passes the real gate). `dryRun` defaults TRUE (the graduated-rollout first rung);
 * `tickIntervalMs` defaults 1h and is floored at 1m (the E2E must never hot-loop).
 */
export function resolveSessionPoolFailoverRunnerConfig(
  block: SessionPoolFailoverRunnerConfigBlock | undefined,
  resolveEnabled: (explicit: boolean | undefined) => boolean,
): SessionPoolFailoverRunnerResolvedConfig {
  const b = block ?? {};
  const tickIntervalMs =
    typeof b.tickIntervalMs === 'number' && Number.isFinite(b.tickIntervalMs)
      ? Math.max(MIN_FAILOVER_RUNNER_TICK_INTERVAL_MS, b.tickIntervalMs)
      : DEFAULT_FAILOVER_RUNNER_TICK_INTERVAL_MS;
  const checkTimeoutMs =
    typeof b.checkTimeoutMs === 'number' && Number.isFinite(b.checkTimeoutMs) && b.checkTimeoutMs > 0
      ? b.checkTimeoutMs
      : DEFAULT_FAILOVER_TIMEOUT_MS;
  return {
    enabled: resolveEnabled(typeof b.enabled === 'boolean' ? b.enabled : undefined),
    dryRun: typeof b.dryRun === 'boolean' ? b.dryRun : true,
    tickIntervalMs,
    checkTimeoutMs,
  };
}

/** The guard-posture grade (dark ▸ dry-run ▸ live), mirroring the sibling resolvers. */
export function guardStatusForFailoverRunner(
  cfg: SessionPoolFailoverRunnerResolvedConfig,
): 'dark' | 'dry-run' | 'live' {
  return cfg.enabled ? (cfg.dryRun ? 'dry-run' : 'live') : 'dark';
}

/** The read-only status snapshot the route serves (503 when the driver is null/dark). */
export interface SessionPoolFailoverRunnerStatus {
  enabled: boolean;
  dryRun: boolean;
  /** Which store the recorded verdict lands in — the real promotion store, or the dry-run side store. */
  resultsSink: 'real' | 'dry-run';
  provenStage: number;
  commitSha: string;
  tickIntervalMs: number;
  checkTimeoutMs: number;
  /** True while a failover check subprocess is in flight (the throttle's re-entrancy guard). */
  inFlight: boolean;
  lastRunAt: string | null;
  /** The verdict of the LAST run: 'green'/'red' recorded, 'error' = check threw (nothing recorded), null = never ran. */
  lastOutcome: StageE2EOutcome | 'error' | null;
  /** True iff the LAST run wrote a verdict row (false on error and while never-run). */
  lastRecorded: boolean;
  lastEvidenceRef: string | null;
  counters: { ticks: number; recordedGreen: number; recordedRed: number; errored: number };
}

/** Injected dependencies for the throttled driver (all pure/injectable → unit-testable with zero subprocess). */
export interface SessionPoolFailoverRunnerDriverDeps {
  config: SessionPoolFailoverRunnerResolvedConfig;
  /** The REAL signed E2E store — the promotion path (StageAdvancer/driver) reads THIS. Used when dryRun is false. */
  resultStore: SessionPoolE2EResultStore;
  /** A SIDE store the promotion path never reads — used when dryRun holds (would-record soak trail). */
  dryRunResultStore: SessionPoolE2EResultStore;
  /** Spawn the failover E2E and resolve once it finishes (or times out). MUST resolve, never reject. */
  runProcess: (args: { testPath: string; timeoutMs: number }) => Promise<SubprocessRunResult>;
  /** The commit the recorded verdict is bound to. */
  currentCommitSha: () => string;
  /** The stage index this failover proves (the PRIOR stage StageAdvancer reads). */
  provenStage: () => number;
  /** Which E2E to run (defaults to the merged two-node failover E2E). */
  testPath?: string;
  audit?: (event: string, detail: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * A slow-cadence throttle over the pure `SessionPoolFailoverRunner`. Safe to call
 * `maybeTick()` from an existing fast tick — it fires the runner AT MOST once per
 * `tickIntervalMs` and never while a prior run is in flight (the E2E is a heavy
 * two-server subprocess). Every failure path fails toward silence.
 */
export class SessionPoolFailoverRunnerDriver {
  private readonly runner: SessionPoolFailoverRunner;
  private readonly now: () => number;
  private _inFlight = false;
  private _lastRunAtMs = 0;
  private _lastRunAtIso: string | null = null;
  private _lastOutcome: StageE2EOutcome | 'error' | null = null;
  private _lastRecorded = false;
  private _lastEvidenceRef: string | null = null;
  private readonly _counters = { ticks: 0, recordedGreen: 0, recordedRed: 0, errored: 0 };

  constructor(private readonly d: SessionPoolFailoverRunnerDriverDeps) {
    this.now = d.now ?? (() => Date.now());
    // In dryRun, the runner records to the SIDE store (never the promotion store);
    // a deliberate dryRun:false points it at the real store. The runner's own
    // honesty line (THROW → record nothing) holds in both cases.
    const sink = d.config.dryRun ? d.dryRunResultStore : d.resultStore;
    this.runner = new SessionPoolFailoverRunner({
      resultStore: sink,
      runFailoverCheck: makeSubprocessFailoverCheck({
        runProcess: d.runProcess,
        testPath: d.testPath ?? DEFAULT_FAILOVER_E2E_PATH,
        timeoutMs: d.config.checkTimeoutMs,
      }),
      currentCommitSha: d.currentCommitSha,
      provenStage: d.provenStage,
      enabled: () => d.config.enabled,
      audit: d.audit,
    });
  }

  /**
   * Fire the runner iff enabled, not in flight, and `tickIntervalMs` has elapsed
   * since the last run. Returns the run result, or null when the throttle skipped.
   * Never throws — a check error is recorded as an 'error' outcome (nothing written).
   */
  async maybeTick(): Promise<{ ran: boolean; outcome: StageE2EOutcome | 'error' | null } | null> {
    if (!this.d.config.enabled) return null;
    if (this._inFlight) return null;
    const now = this.now();
    if (this._lastRunAtMs !== 0 && now - this._lastRunAtMs < this.d.config.tickIntervalMs) return null;
    this._inFlight = true;
    this._lastRunAtMs = now;
    this._lastRunAtIso = new Date(now).toISOString();
    this._counters.ticks += 1;
    try {
      const r = await this.runner.tick();
      this._lastOutcome = r.outcome;
      this._lastRecorded = r.recorded;
      if (r.recorded && r.outcome === 'green') this._counters.recordedGreen += 1;
      else if (r.recorded && r.outcome === 'red') this._counters.recordedRed += 1;
      else if (r.outcome === 'error') this._counters.errored += 1;
      return { ran: r.ran, outcome: r.outcome };
    } catch (err) {
      // @silent-fallback-ok — belt-and-suspenders driver guard: the error is
      // surfaced via audit('failover-driver-errored') below and returned as an
      // honest outcome:'error' (never a false green — a throwing check records
      // nothing), so a driver-level surprise never escapes toward the caller's
      // slow timer. The runner itself already fails toward silence.
      this._lastOutcome = 'error';
      this._lastRecorded = false;
      this._counters.errored += 1;
      this.d.audit?.('failover-driver-errored', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ran: true, outcome: 'error' };
    } finally {
      this._inFlight = false;
    }
  }

  /** The read-only status snapshot the route serves. */
  status(): SessionPoolFailoverRunnerStatus {
    return {
      enabled: this.d.config.enabled,
      dryRun: this.d.config.dryRun,
      resultsSink: this.d.config.dryRun ? 'dry-run' : 'real',
      provenStage: this.d.provenStage(),
      commitSha: this.d.currentCommitSha(),
      tickIntervalMs: this.d.config.tickIntervalMs,
      checkTimeoutMs: this.d.config.checkTimeoutMs,
      inFlight: this._inFlight,
      lastRunAt: this._lastRunAtIso,
      lastOutcome: this._lastOutcome,
      lastRecorded: this._lastRecorded,
      lastEvidenceRef: this._lastEvidenceRef,
      counters: { ...this._counters },
    };
  }
}

/**
 * Construct-or-null factory: enabled → a throttled driver; dark → null (a strict
 * no-op — no driver, no route status, no timer). This is the wiring seam the
 * boot path + the unit test both use.
 */
export function buildSessionPoolFailoverRunnerDriver(
  deps: SessionPoolFailoverRunnerDriverDeps,
): SessionPoolFailoverRunnerDriver | null {
  if (!deps.config.enabled) return null;
  return new SessionPoolFailoverRunnerDriver(deps);
}
