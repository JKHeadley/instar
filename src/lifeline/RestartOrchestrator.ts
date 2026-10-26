/**
 * RestartOrchestrator — single-owner state machine for lifeline self-restart.
 *
 * Multiple initiators may fire concurrently:
 *   - LifelineHealthWatchdog (tick-based)
 *   - ForwardVersionSkewError handler (event-based)
 *   - SIGTERM handler (external, e.g., `instar lifeline restart`)
 *
 * All three route through `requestRestart()`. The orchestrator serializes
 * them: only the first transition from `idle` proceeds; subsequent requests
 * are logged and suppressed.
 *
 * State machine: idle → quiescing → persisting → exiting (terminal)
 *
 * Step 1 (quiesce) halts Telegram polling, replay loops, and the watchdog
 * BEFORE any persist, so the queue snapshot is causally consistent.
 *
 * The `exitFn` is injected so tests can assert the sequence without
 * terminating the test runner. Production injects `process.exit`.
 */

import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export type RestartState = 'idle' | 'quiescing' | 'persisting' | 'exiting';

export interface RestartRequest {
  reason: string;              // e.g., 'noForwardStuck', 'version-skew', 'external-signal'
  bucket: 'watchdog' | 'versionSkew' | 'plannedUpgrade';
  context?: Record<string, unknown>;
  /**
   * A lifeline-only restart: the server is already current, so quiesce leaves it running
   * for the next lifeline to adopt instead of stopping it (and its in-flight work).
   */
  keepServer?: boolean;
}

/**
 * Does a restart on this bucket leave the server running? `versionSkew` (the lifeline is
 * behind the server: drift auto-promote, a 426 handshake) and `plannedUpgrade` (the
 * coordinated signal the server/updater/migrator write when the LIFELINE must move onto
 * the current code) are lifeline-only restarts: the server is already current, so stopping
 * it only kills its in-flight work (a 23-minute local verify, 2026-10-26). `watchdog`
 * (server unhealthy, an external signal) keeps stopping the server. An explicit
 * `keepServer` on the request wins.
 */
export function restartKeepsServer(bucket: RestartRequest['bucket']): boolean {
  // These buckets ask the LIFELINE to reload its code. A server restart the updater asked for
  // at the same time (restart-requested.json) stays the supervisor's job: the successor's
  // supervisor reads that file at start() and performs it.
  return bucket === 'versionSkew' || bucket === 'plannedUpgrade';
}

export interface OrchestratorDeps {
  /** Halt polling, replay interval, watchdog timer; abort in-flight forwards. Returns when drained. Receives the request (keepServer). */
  quiesce: (req?: RestartRequest) => Promise<void>;
  /** Persist all state files atomically. Returns when all writes complete. */
  persistAll: () => Promise<void>;
  /** Called to exit the process. Production: process.exit. Tests: spy. */
  exitFn: (code: number) => void;
  /**
   * Stop the server even though quiesce already detached from it: a request that must
   * stop the server (watchdog, an external signal) arrived while a keep-server restart was
   * in flight. The later request is suppressed as usual, but its server policy wins —
   * otherwise a `launchctl bootout` landing inside a drift restart's quiesce window would
   * exit the lifeline and leave the server running with no successor to adopt it.
   */
  stopServer?: () => Promise<void>;
  /** Whether this process runs under launchd (true) or dev (false). */
  isSupervised: boolean;
  /**
   * Returns true if a shadow-install update is in progress. The orchestrator
   * will defer the restart by one tick if so, per spec §Shadow-install coordination.
   * Tests can return a fixed value.
   */
  isShadowInstallUpdating?: () => boolean;
  /** Optional DegradationReporter override for tests. */
  reporter?: DegradationReporter;
  /** Maximum ms to wait for persistAll before hard-killing. */
  persistBudgetMs?: number;     // default 2000
  /** Budget of the stop phase a competing stop request earns (default 10 s: the supervisor's 3 s graceful wait + a bounded force-kill). */
  stopPhaseMs?: number;
  /** Hard-kill timeout — if persist hangs this long, call exitFn(1). */
  hardKillMs?: number;          // default 5000
  /** Defer duration if shadow-install lockfile is present. Default 30000 (one watchdog tick). */
  shadowInstallDeferMs?: number;
}

export class RestartOrchestrator {
  private _state: RestartState = 'idle';
  private readonly reporter: DegradationReporter;
  private readonly persistBudgetMs: number;
  private readonly hardKillMs: number;
  private readonly stopPhaseMs: number;
  public lastSuppressed: { reason: string; currentState: RestartState } | null = null;
  /** The request being carried out, with its resolved server policy. */
  private inFlight: { reason: string; keepServer: boolean } | null = null;
  /** A suppressed request that must stop the server arrived while the in-flight one keeps it. */
  private stopServerOverride = false;

  constructor(private readonly deps: OrchestratorDeps) {
    this.reporter = deps.reporter ?? DegradationReporter.getInstance();
    this.persistBudgetMs = deps.persistBudgetMs ?? 2000;
    this.hardKillMs = deps.hardKillMs ?? 5000;
    this.stopPhaseMs = deps.stopPhaseMs ?? 10_000;
  }

  get state(): RestartState {
    return this._state;
  }

  /**
   * Attempt to initiate a restart. Only proceeds if currently idle.
   * Returns a promise that resolves only if the request was suppressed
   * (process didn't exit); otherwise the process exits before resolve.
   */
  async requestRestart(req: RestartRequest): Promise<'suppressed' | 'proceeded'> {
    // Synchronous guard — set BEFORE any await to prevent re-entry.
    const keepServer = req.keepServer ?? restartKeepsServer(req.bucket);
    if (this._state !== 'idle') {
      this.lastSuppressed = { reason: req.reason, currentState: this._state };
      // The suppressed request's SERVER policy still counts: a stop request cannot be
      // swallowed by a lifeline-only restart that happens to be a second ahead of it.
      if (this.inFlight?.keepServer && !keepServer && this._state !== 'exiting') {
        this.stopServerOverride = true;
        console.log(`[RestartOrchestrator] stop-server override: ${req.reason} arrived during keep-server restart ${this.inFlight.reason} — the server will be stopped before exit`);
      }
      console.log(
        `[RestartOrchestrator] restart-request-suppressed ` +
        `reason=${req.reason} currentState=${this._state}`
      );
      return 'suppressed';
    }
    this._state = 'quiescing';
    this.inFlight = { reason: req.reason, keepServer };
    this.stopServerOverride = false;

    // Fire-and-forget degradation event (best-effort, budget 500ms).
    try {
      await Promise.race([
        Promise.resolve(
          this.reporter.report({
            feature: 'TelegramLifeline.selfRestart',
            primary: `exit-for-restart (${req.reason})`,
            fallback: 'launchd will respawn',
            reason: req.reason,
            impact: 'Lifeline process exits; message queue persisted; respawned by launchd.',
          }),
        ),
        new Promise<void>(resolve => setTimeout(resolve, 500)),
      ]);
    } catch {
      // best-effort; never block restart on telemetry failure
    }

    // Shadow-install coordination: if the updater is mid-`npm i`, defer by
    // one tick rather than respawn against a half-written tree. Spec §Shadow-
    // install coordination. A deferred restart re-enters idle and can be
    // re-requested on the next tick.
    if (this.deps.isShadowInstallUpdating?.()) {
      console.warn(
        `[RestartOrchestrator] restart-deferred-shadow-updating ` +
        `reason=${req.reason} — retry after tick`
      );
      this._state = 'idle';
      this.inFlight = null;
      this.stopServerOverride = false;
      return 'suppressed';
    }

    // Unsupervised mode: log loud + stop here. Never call exitFn in dev/test.
    if (!this.deps.isSupervised) {
      console.warn(
        `[RestartOrchestrator] would restart (trigger=${req.reason}) but unsupervised; ` +
        `skipping exit. set INSTAR_SUPERVISED=1 to enable.`
      );
      this._state = 'idle';
      this.inFlight = null;
      this.stopServerOverride = false;
      return 'suppressed';
    }

    // Step 1: quiesce — halt mutations before persist. A stop request that arrived during
    // the telemetry wait above already won: quiesce then stops the server itself.
    const quiesceKeepsServer = keepServer && !this.stopServerOverride;
    try {
      await Promise.race([
        this.deps.quiesce({ ...req, keepServer: quiesceKeepsServer }),
        new Promise<void>(resolve => setTimeout(resolve, 1000)),
      ]);
    } catch (err) {
      console.error(`[RestartOrchestrator] quiesce error (continuing): ${err}`);
    }

    // Step 2: persist. Budget 2s. Hard-kill fallback 5s from now.
    this._state = 'persisting';
    const hardKill = setTimeout(() => {
      console.error('[RestartOrchestrator] hard-kill: persist exceeded budget');
      this.deps.exitFn(1);
    }, this.hardKillMs);
    if (typeof hardKill.unref === 'function') hardKill.unref();

    try {
      await Promise.race([
        this.deps.persistAll(),
        new Promise<void>(resolve => setTimeout(resolve, this.persistBudgetMs)),
      ]);
    } catch (err) {
      console.error(`[RestartOrchestrator] persistAll error (continuing to exit): ${err}`);
    }

    // Step 2b: a stop request that lost the race to a keep-server restart still stops the
    // server. The persist hard-kill timer is cleared FIRST: it was armed for the persist
    // budget and would otherwise fire during the supervisor's 3 s graceful wait, exiting
    // the lifeline with the server still up and no successor to adopt it. The stop phase
    // has its own budget; the supervisor force-kills within it.
    clearTimeout(hardKill);
    if (this.stopServerOverride && quiesceKeepsServer && this.deps.stopServer) {
      console.log('[RestartOrchestrator] stopping the server after all (stop-server override)');
      let done = false;
      try {
        await Promise.race([
          this.deps.stopServer().then(() => { done = true; }),
          new Promise<void>(resolve => setTimeout(resolve, this.stopPhaseMs)),
        ]);
      } catch (err) {
        console.error(`[RestartOrchestrator] stopServer error (continuing to exit): ${err}`);
      }
      if (!done) console.error(`[RestartOrchestrator] stop phase exceeded ${this.stopPhaseMs}ms — exiting; the server may still be running`);
    }

    // Step 3: exit.
    this._state = 'exiting';
    this.deps.exitFn(0);
    return 'proceeded';
  }

  /** Test helper: reset state to idle without exiting. Only safe in tests. */
  _resetForTesting(): void {
    this.inFlight = null;
    this.stopServerOverride = false;
    this._state = 'idle';
    this.lastSuppressed = null;
  }
}
