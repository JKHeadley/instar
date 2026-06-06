/**
 * Server Supervisor — manages the full Instar server as a child process.
 *
 * Starts, monitors, and auto-restarts the server. Reports health status
 * back to the lifeline so it can inform users via Telegram.
 *
 * The supervisor spawns the server in a tmux session (same as `instar server start`)
 * and monitors it via health checks.
 *
 * RESTART ARCHITECTURE (v0.9.63):
 * The server NEVER restarts itself. When the AutoUpdater installs an update,
 * it writes a `restart-requested.json` flag. The supervisor detects this flag
 * during its health check polling and performs a graceful restart. This eliminates
 * the entire category of self-restart bugs (PATH mismatch, launchd confusion,
 * binary resolution failures, restart loops).
 */

import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { detectTmuxPath } from '../core/Config.js';
import { SlowRetrySentinelEscalation } from './SlowRetrySentinelEscalation.js';
import { SleepWakeDetector } from '../core/SleepWakeDetector.js';
import { cpuLoadRatio, DEFAULT_MAX_LOAD_RATIO } from '../core/cpuStarvation.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';

/** Execute a shell command safely, returning stdout. */
function shellExec(cmd: string, timeout = 5000): string {
  const shell = process.env.SHELL || '/bin/zsh';
  return spawnSync(shell, ['-c', cmd], { encoding: 'utf-8', timeout }).stdout ?? '';
}

export interface SupervisorEvents {
  serverUp: [];
  serverDown: [reason: string];
  serverRestarting: [attempt: number];
  circuitBroken: [totalFailures: number, lastCrashOutput: string];
  debugRestartRequested: [request: { fixDescription: string; requestedBy: string }];
  debugRestartSkipped: [info: { fixDescription: string; reason: string }];
  /** Emitted when the server recovers after a planned update restart.
   *  The lifeline should self-restart to pick up new code from the shadow install. */
  updateApplied: [targetVersion: string];
}

// ── F-6: Remediator ↔ ServerSupervisor handshake ─────────────────────
//
// Per v2 spec §A15 (partial-upgrade window) + v3 §3 (state-file taxonomy:
// `.instar/state/supervisor-handshake.json` and `restart-requested.json`
// extended with HMAC). The Remediator signs a `restart-requested` request
// with the capability-context leaf key from F-1 RemediationKeyVault; the
// supervisor verifies the HMAC before honouring the request and notifies
// the Remediator once the restart cycle completes (so the attempt state
// machine can advance to verify-phase).

/**
 * The signed payload a Remediator sends to the supervisor to request a
 * planned restart. The HMAC covers the canonical serialization of
 * `{requestId, runbookId, attemptId, blastRadius, requestedAt, monotonicTs,
 * handshakeVersion}` using the Remediator's per-call capability leaf key
 * (RemediationKeyVault.deriveLeafKey('capability', runbookId)).
 */
export interface RestartRequestedPayload {
  requestId: string;
  runbookId: string;
  attemptId: string;
  blastRadius: 'process' | 'machine' | 'fleet';
  /** Wall-clock ms (Date.now()). Used for staleness rejection. */
  requestedAt: number;
  /** `process.hrtime.bigint()` at request issuance. Informational. */
  monotonicTs: bigint;
  /** Handshake protocol version the Remediator is speaking. */
  handshakeVersion: number;
  /** HMAC-SHA256 over canonical payload using the Remediator's capability leaf. */
  hmac: Buffer;
}

/** Reply the supervisor returns from `handleRestartRequested`. */
export interface RestartRequestedReply {
  requestId: string;
  accepted: boolean;
  /** Machine-readable reason code, e.g. `'accepted'`, `'invalid-hmac'`,
   *  `'stale'`, `'blast-radius-out-of-scope'`, `'handshake-version-mismatch'`. */
  reason: string;
  /** Supervisor's handshake protocol version (informational). */
  supervisorHandshakeVersion: number;
  /** Supervisor's build id (informational; A15 lag check). */
  supervisorBuildId: string;
}

// ── W-2: supervisor-preflight runbook surface (Tier-2) ──────────────
//
// Per v2 spec §A34 — the W-2 runbook is a SINGLE wrapper around the
// existing private `preflightSelfHeal()` body (six in-line heal steps).
// Mirrors `RemediatorInvocationContext` from `src/memory/NativeModuleHealer.ts`
// so this file stays runtime-decoupled from `src/remediation/*` — same
// structural-typing rationale as the W-1 NativeModuleHealer surface.

/**
 * Lightweight structural type compatible with F-8 Remediator's
 * `RemediationContext`. Imported as a type-only reference; runtime
 * decoupling lets us avoid a hard dependency from `src/lifeline/*` onto
 * `src/remediation/*` (the legacy spawn-time `preflightSelfHeal()` path
 * must keep working even if remediation files are absent).
 */
export interface SupervisorRemediatorInvocationContext {
  attemptId: string;
  runbookId: string;
  abortSignal: AbortSignal;
  /** `process.hrtime.bigint()` issued + expectedRuntimeMs converted to ns. */
  monotonicDeadline: bigint;
  /** §A3 capability-token HMAC — present on Tier-2 dispatched ctxs. */
  hmac?: Buffer;
  /** Wall-clock expiry, mirrors `RemediationContext.expiresAt`. */
  expiresAt?: number;
}

/**
 * Optional keyVault dependency for `invokeFromRemediator` §A3 / §A23
 * verification. Structural so `src/lifeline/*` doesn't pull in
 * `src/remediation/*` at module load.
 */
export interface SupervisorInvocationContextKeyVault {
  deriveLeafKey(context: 'capability', scopeId: string): Buffer;
}

export interface SupervisorRemediatorExecutionResult {
  outcome: 'success' | 'failure';
  details: Record<string, unknown>;
}

/**
 * §A3 verify the HMAC on a `SupervisorRemediatorInvocationContext`.
 * Mirrors the canonical body layout in
 * `src/remediation/RemediationContext.ts`. We inline rather than import
 * to avoid the `src/lifeline/*` → `src/remediation/*` dependency that
 * would break the legacy `preflightSelfHeal()` path on installs without
 * the remediation tree.
 */
function verifySupervisorContextHmac(
  ctx: SupervisorRemediatorInvocationContext,
  keyVault: SupervisorInvocationContextKeyVault,
): boolean {
  if (!ctx.hmac || !Buffer.isBuffer(ctx.hmac) || ctx.hmac.length === 0) {
    return false;
  }
  if (!ctx.runbookId) return false;
  let leaf: Buffer;
  try {
    leaf = keyVault.deriveLeafKey('capability', ctx.runbookId);
  } catch {
    // @silent-fallback-ok — §A3 verification is fail-closed by design.
    return false;
  }
  const HMAC_TAG = Buffer.from('instar-f8-ctx-v1\x00', 'utf-8');
  const writeStr = (s: string): Buffer => {
    const body = Buffer.from(s, 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  };
  const expiresAtBuf = Buffer.alloc(8);
  expiresAtBuf.writeBigUInt64BE(
    BigInt(Math.max(0, Math.floor(ctx.expiresAt ?? 0))),
    0,
  );
  const monoBuf = Buffer.alloc(8);
  const mono = ctx.monotonicDeadline >= 0n ? ctx.monotonicDeadline : 0n;
  monoBuf.writeBigUInt64BE(mono, 0);
  const body = Buffer.concat([
    HMAC_TAG,
    writeStr(ctx.attemptId),
    writeStr(ctx.runbookId),
    expiresAtBuf,
    monoBuf,
  ]);
  const expected = crypto.createHmac('sha256', leaf).update(body).digest();
  if (expected.length !== ctx.hmac.length) return false;
  try {
    return crypto.timingSafeEqual(expected, ctx.hmac);
  } catch {
    // @silent-fallback-ok — fail-closed.
    return false;
  }
}

/** The Remediator instance interface the supervisor calls back into. */
export interface RegisteredRemediator {
  /** Called by supervisor after a planned restart completes. */
  onRestartComplete: (req: { requestId: string }) => void;
  /** Returns the leaf key the Remediator used to sign restart-requested. */
  getCapabilityLeafKey: () => Buffer;
}

export class ServerSupervisor extends EventEmitter {
  private projectDir: string;
  private projectName: string;
  private port: number;
  private tmuxPath: string | null;
  private serverSessionName: string;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastHealthCheckAt = 0; // Wall-clock ms for sleep/wake detection
  private readonly sleepWakeGapMs = 2 * 60_000; // Gap > 2 min between 10s intervals = machine was suspended
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private restartBackoffMs = 5000;
  private isRunning = false;
  private lastHealthy = 0;
  private startupGraceMs = 180_000; // 3 minutes grace period — allows time for heavy init (Threadline, tunnel, agent discovery)
  private spawnedAt = 0;
  private retryCooldownMs = 5 * 60_000; // 5 minutes cooldown after max retries exhausted
  private maxRetriesExhaustedAt = 0;
  private consecutiveFailures = 0; // Hysteresis: require 2 consecutive failures before marking unhealthy
  private readonly unhealthyThreshold = 2;
  // Bind-failure escalation — incremented when a spawn produces a server that
  // never reaches a healthy /health response before crashing. After 2+ in a
  // row, the next preflight forces an aggressive better-sqlite3 rebuild
  // regardless of what the require-load probe reports. Reset on any healthy
  // tick. See preflightSelfHeal native-module branch.
  private consecutiveBindFailures = 0;
  private readonly bindFailureEscalationThreshold = 2;
  private readonly processAliveThreshold = 6; // When process is alive but unresponsive (e.g., high CPU load), require 6 failures (~60s) before restarting
  // CPU-starvation restart guard: when the box is so oversubscribed (load >>
  // cores) that the live server can't answer /health, restarting it does NOT
  // cure the starvation — the fresh server is starved too, it just drops the
  // in-flight message and loops (the 2026-05-29 restart-loop incident). So while
  // CPU-starved we DEFER the restart up to a hard cap, then force it (in case
  // the server is genuinely hung rather than merely starved). Same load-ratio
  // signal SleepWakeDetector uses (see core/cpuStarvation).
  private readonly maxLoadRatio = DEFAULT_MAX_LOAD_RATIO; // loadavg[0]/cpuCount above this = starved
  private readonly starvationRestartThreshold = 30; // ~5min at 10s checks — force a restart even if starved if unresponsiveness persists this long
  private readonly loadRatioProvider: () => number; // injectable for tests; default cpuLoadRatio
  private stateDir: string | null;

  // Planned restart / maintenance wait — suppress alerts during expected downtime
  private maintenanceWaitStartedAt = 0;
  private maintenanceWaitMs = 5 * 60_000; // 5 minutes default (configurable via maintenanceWaitMinutes)
  private pendingUpdateVersion: string | null = null; // Version being applied — triggers lifeline self-restart on recovery

  // Agent hard-sleep (Stage B mechanism; docs/specs/agent-hard-sleep-mechanism.md).
  // When `slept` is true the server was INTENTIONALLY stopped to save resources —
  // the health loop must NOT treat it as down or auto-respawn it; it only watches
  // for a wake-request. Gated upstream by the SleepController, which writes the
  // sleep-request flag only in live mode (enabled + !dryRun). Always-off here until
  // a sleep-request flag is honored, so existing crash-recovery behavior is intact.
  private slept = false;

  // Circuit breaker — give up after too many total failures, but retry periodically
  private totalFailures = 0;
  private totalFailureWindowStart = 0;
  private readonly circuitBreakerThreshold = 20; // Total failures before tripping
  private readonly circuitBreakerWindowMs = 60 * 60_000; // 1-hour window
  private circuitBroken = false;
  private circuitBreakerTrippedAt = 0;
  private circuitBreakerRetryCount = 0;
  private readonly circuitBreakerRetryIntervalMs = 30 * 60_000; // 30 min between retries
  private readonly maxCircuitBreakerRetries = 3; // Try 3 times at 30-min intervals before entering slow-retry
  private readonly slowRetryIntervalMs = 2 * 60 * 60_000; // 2 hours between slow retries (never truly give up)
  private slowRetryStartedAt = 0; // When slow retry mode started
  /**
   * Eternal Sentinel condition 4 ("No Unbounded Loops", P19): never-give-up
   * must not mean never-tell-anyone. Fires the one-per-episode 'sentinelStalled'
   * escalation after a sustained-failure threshold; the retrying continues.
   */
  private readonly sentinelEscalation: SlowRetrySentinelEscalation;
  private lastCrashOutput = ''; // Last captured crash output for diagnostics
  private doctorSessionSecret: string | null = null; // HMAC secret for doctor restart requests
  private sleepWakeDetector: SleepWakeDetector | null = null; // Detects short sleeps that gap-based detection misses
  private wakeTransitionUntil = 0; // Timestamp until which we're in a wake transition (lenient health checks)
  private readonly wakeTransitionMs = 60_000; // 60 seconds of lenient health checking after wake

  // ── F-6 handshake state ────────────────────────────────────────────
  /** Current handshake protocol version. Bump on any wire-format change. */
  static readonly HANDSHAKE_PROTOCOL_VERSION = 1;
  /** Max staleness of a restart-requested payload before it's rejected. */
  static readonly RESTART_REQUEST_MAX_AGE_MS = 5 * 60_000;
  private registeredRemediator: RegisteredRemediator | null = null;
  /** Pending restart requests awaiting completion notification, keyed by requestId. */
  private pendingRemediatorRequests = new Map<string, { requestId: string; runbookId: string; attemptId: string; }>();
  /** Build id surfaced via handshake. Tests inject; production reads package.json. */
  private supervisorBuildId: string = process.env.INSTAR_SUPERVISOR_BUILD_ID || 'unknown';

  constructor(options: {
    projectDir: string;
    projectName: string;
    port: number;
    stateDir?: string;
    /** How long to wait for server recovery during a planned restart before alerting. Default: 5 minutes. */
    maintenanceWaitMinutes?: number;
    /** How long to wait after spawning before starting health checks. Default: 180 seconds (3 minutes). */
    startupGraceSeconds?: number;
    /** Injectable CPU-load-ratio source (loadavg[0]/cpuCount) for tests. Default: cpuLoadRatio. */
    loadRatioProvider?: () => number;
    /** Sustained-failure threshold before the one-per-episode slow-retry escalation. Default: 12h. */
    slowRetryEscalateAfterMs?: number;
  }) {
    super();
    this.projectDir = options.projectDir;
    this.projectName = options.projectName;
    this.port = options.port;
    this.stateDir = options.stateDir ?? null;
    this.tmuxPath = detectTmuxPath();
    this.serverSessionName = `${this.projectName}-server`;
    this.loadRatioProvider = options.loadRatioProvider ?? (() => cpuLoadRatio());
    this.sentinelEscalation = new SlowRetrySentinelEscalation({
      escalateAfterMs: options.slowRetryEscalateAfterMs,
    });

    if (options.maintenanceWaitMinutes !== undefined) {
      this.maintenanceWaitMs = options.maintenanceWaitMinutes * 60_000;
    }
    if (options.startupGraceSeconds !== undefined) {
      this.startupGraceMs = options.startupGraceSeconds * 1000;
    }
  }

  /**
   * Start the server and begin monitoring.
   */
  async start(): Promise<boolean> {
    if (!this.tmuxPath) {
      console.error('[Supervisor] tmux not found');
      return false;
    }

    // Check if already running.
    //
    // A bare `tmux has-session` check races with a dying session right after a
    // `kickstart -k` of the lifeline: the old server is SIGKILLed but its tmux
    // session lingers for a beat, so has-session returns true and this branch
    // would trust it — setting isRunning=true and never respawning. Observed
    // 2026-05-23: the server then fully exits, the supervisor believes it is
    // running, and it stays dead ~3min until a second kickstart spawns it
    // cleanly. Verify the server actually answers /health before trusting the
    // session; a stale/dying session short-circuits and falls through to a
    // fresh spawn (spawnServer kills the lingering session first).
    if (this.isServerSessionAlive() && (await this.verifyServerResponding())) {
      console.log(`[Supervisor] Server already running and healthy in tmux session: ${this.serverSessionName}`);
      this.isRunning = true;
      this.lastHealthy = Date.now();
      // Set spawnedAt so the startup grace period applies. Without this, a fresh
      // Supervisor (e.g., after Lifeline self-restart for an update) has spawnedAt=0,
      // which disables the grace check and can cause false serverDown alerts if the
      // server responds slowly during the transition window.
      this.spawnedAt = Date.now();
      // Check for planned-exit-marker or restart-requested flag — if present,
      // pre-set maintenance wait so handleUnhealthy() suppresses alerts.
      if (this.stateDir) {
        const markerPath = path.join(this.stateDir, 'state', 'planned-exit-marker.json');
        const restartPath = path.join(this.stateDir, 'state', 'restart-requested.json');
        try {
          if (fs.existsSync(markerPath)) {
            const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
            const markerAge = Date.now() - (new Date(data.exitedAt).getTime() || Date.now());
            if (markerAge < 10 * 60_000) {
              console.log(`[Supervisor] Found planned-exit marker on start — entering maintenance wait`);
              this.maintenanceWaitStartedAt = new Date(data.exitedAt).getTime() || Date.now();
              this.pendingUpdateVersion = data.targetVersion ?? null;
            }
          } else if (fs.existsSync(restartPath)) {
            const data = JSON.parse(fs.readFileSync(restartPath, 'utf-8'));
            if (data.plannedRestart && (!data.expiresAt || new Date(data.expiresAt).getTime() > Date.now())) {
              console.log(`[Supervisor] Found restart-requested flag on start — entering maintenance wait`);
              this.maintenanceWaitStartedAt = Date.now();
              this.pendingUpdateVersion = data.targetVersion ?? null;
            }
          }
        } catch { /* best-effort marker check */ }
      }
      this.startHealthChecks();
      return true;
    }

    return this.spawnServer();
  }

  /**
   * Stop the server and monitoring.
   */
  /**
   * Operator-explicit wake from agent hard-sleep. Clears the `slept` state + the
   * slept-marker so a manual `/lifeline restart` (or `/restart`) actually brings the
   * server back up — without this, startHealthChecks() re-reads the marker and the
   * supervisor immediately re-enters `slept`, leaving an un-monitored server and no
   * in-band recovery. Distinct from a fleet-watchdog auto-bounce (which intentionally
   * stays asleep via the boot-marker); this is reached only from an explicit command.
   */
  wakeFromSleep(): void {
    if (this.slept || this.sleptMarkerPresent()) {
      this.clearSleptMarker();
      this.slept = false;
      console.log('[Supervisor] Explicit wake — cleared slept state for operator restart');
    }
  }

  async stop(): Promise<void> {
    this.stopHealthChecks();

    if (this.tmuxPath && this.isServerSessionAlive()) {
      try {
        // Graceful: send C-c
        execFileSync(this.tmuxPath, ['send-keys', '-t', `=${this.serverSessionName}:`, 'C-c'], {
          stdio: 'ignore', timeout: 5000,
        });

        // Wait briefly for graceful shutdown
        await new Promise(r => setTimeout(r, 3000));

        // Force kill if still alive
        if (this.isServerSessionAlive()) {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        }
      } catch { /* ignore */ }
    }

    this.isRunning = false;
  }

  /**
   * Check if the server is currently healthy.
   */
  get healthy(): boolean {
    return this.isRunning && (Date.now() - this.lastHealthy) < 30_000;
  }

  /**
   * Get supervisor status.
   */
  getStatus(): {
    running: boolean;
    healthy: boolean;
    restartAttempts: number;
    lastHealthy: number;
    serverSession: string;
    coolingDown: boolean;
    cooldownRemainingMs: number;
    circuitBroken: boolean;
    totalFailures: number;
    lastCrashOutput: string;
    circuitBreakerRetryCount: number;
    maxCircuitBreakerRetries: number;
    inMaintenanceWait: boolean;
    maintenanceWaitElapsedMs: number;
    inWakeTransition: boolean;
    wakeTransitionRemainingMs: number;
  } {
    const coolingDown = this.maxRetriesExhaustedAt > 0;
    const cooldownRemainingMs = coolingDown
      ? Math.max(0, this.retryCooldownMs - (Date.now() - this.maxRetriesExhaustedAt))
      : 0;
    const inMaintenanceWait = this.maintenanceWaitStartedAt > 0;
    const inWakeTransition = Date.now() < this.wakeTransitionUntil;
    return {
      running: this.isRunning,
      healthy: this.healthy,
      restartAttempts: this.restartAttempts,
      lastHealthy: this.lastHealthy,
      serverSession: this.serverSessionName,
      coolingDown,
      cooldownRemainingMs,
      circuitBroken: this.circuitBroken,
      totalFailures: this.totalFailures,
      lastCrashOutput: this.lastCrashOutput,
      circuitBreakerRetryCount: this.circuitBreakerRetryCount,
      maxCircuitBreakerRetries: this.maxCircuitBreakerRetries,
      inMaintenanceWait,
      maintenanceWaitElapsedMs: inMaintenanceWait ? Date.now() - this.maintenanceWaitStartedAt : 0,
      inWakeTransition,
      wakeTransitionRemainingMs: inWakeTransition ? this.wakeTransitionUntil - Date.now() : 0,
    };
  }

  /**
   * Reset the circuit breaker — allows restart attempts to resume.
   * Call this after fixing the underlying issue (e.g., via /lifeline restart).
   */
  resetCircuitBreaker(): void {
    this.circuitBroken = false;
    this.circuitBreakerTrippedAt = 0;
    this.circuitBreakerRetryCount = 0;
    this.totalFailures = 0;
    this.totalFailureWindowStart = 0;
    this.restartAttempts = 0;
    this.maxRetriesExhaustedAt = 0;
    this.slowRetryStartedAt = 0;
    this.sentinelEscalation.reset(); // episode over — re-arm the one-shot escalation
    this.wakeTransitionUntil = 0;
    console.log('[Supervisor] Circuit breaker reset');
  }

  /**
   * Set the HMAC secret for validating doctor session restart requests.
   * Called by TelegramLifeline when a doctor session is spawned.
   */
  setDoctorSessionSecret(secret: string): void {
    this.doctorSessionSecret = secret;
  }

  /**
   * Gracefully restart the server: capture output, kill tmux session,
   * clean up child processes, then spawn fresh.
   *
   * Used by: restart-request handling (auto-update), /lifeline restart command.
   */
  async performGracefulRestart(reason: string): Promise<boolean> {
    console.log(`[Supervisor] Graceful restart initiated: ${reason}`);
    this.emit('serverRestarting', 0);

    if (this.tmuxPath && this.isServerSessionAlive()) {
      this.captureCrashOutput();
      this.cleanupChildProcesses();
      try {
        // Send C-c for graceful shutdown
        execFileSync(this.tmuxPath, ['send-keys', '-t', `=${this.serverSessionName}:`, 'C-c'], {
          stdio: 'ignore', timeout: 5000,
        });
        await new Promise(r => setTimeout(r, 3000));

        // Force kill if still alive
        if (this.isServerSessionAlive()) {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        }
      } catch { /* ignore */ }
    }

    // Wait for port release
    await new Promise(r => setTimeout(r, 2000));

    // Spawn fresh server — uses the updated binary since spawnServer resolves
    // cli.js relative to import.meta.url (the globally installed package)
    this.restartAttempts = 0;
    return this.spawnServer();
  }

  // ── Pre-spawn self-healing ──────────────────────────────────────
  //
  // Before starting the server, check prerequisites and fix common issues
  // that would otherwise cause the server to crash immediately. This makes
  // `/lifeline restart` actually useful for recovery — not just a blind retry.

  /**
   * Remediator-orchestrated entry point for the preflight self-heal.
   *
   * Wraps the existing private `preflightSelfHeal()` (six in-line heal steps:
   * shadow-install reinstall, node-symlink repair, stuck-git-rebase abort,
   * better-sqlite3 ABI rebuild, stale lifeline-lock cleanup, settings.json
   * merge-conflict repair) and exposes it as the W-2 `supervisor-preflight`
   * runbook's `surfaceCallable`.
   *
   * SELF-HEALING-REMEDIATOR-V2-SPEC §A34 mandates the runbook is a SINGLE
   * runbook composing all six heal steps rather than six separate runbooks —
   * the verify step asserts the durable lifeline state (not per-step liveness)
   * AFTER all six attempt their fix, mirroring how the in-line path is wired
   * into `spawnServer()`.
   *
   * §A3 capability-token enforcement. When `keyVault` is wired AND `ctx.hmac`
   * is present, the HMAC is verified at entry. An invalid ctx returns an
   * error result and does NOT run the preflight side-effects — falling back
   * to the legacy in-line path is the supervisor's spawn-time concern, not
   * this Remediator path's. This is fail-closed by design.
   *
   * Honours `ctx.abortSignal` at the boundary; the existing preflight body
   * itself is synchronous-leaning and not interruptible mid-step. Surfaces a
   * pre-step abort check so an already-aborted ctx returns immediately.
   *
   * The legacy `private preflightSelfHeal()` stays unchanged. The in-line
   * `spawnServer()` path keeps calling it directly — both entry points share
   * the same body, satisfying the §A2 lock-bound co-existence invariant at
   * the process level (and the MachineLock prevents two simultaneous
   * supervisor-preflight runs across processes).
   */
  async invokeFromRemediator(
    ctx: SupervisorRemediatorInvocationContext,
    keyVault?: SupervisorInvocationContextKeyVault,
  ): Promise<SupervisorRemediatorExecutionResult> {
    // §A3 — verify the capability HMAC when both keyVault and ctx.hmac are
    // present. Fail-closed: invalid ctx does NOT touch any heal step.
    if (keyVault && ctx.hmac !== undefined) {
      const ok = verifySupervisorContextHmac(ctx, keyVault);
      if (!ok) {
        console.warn(
          `[Supervisor] remediation.surface.invalid-context ` +
            `runbookId=${ctx.runbookId} attemptId=${ctx.attemptId} — ` +
            `refusing Remediator-orchestrated preflight`,
        );
        return {
          outcome: 'failure',
          details: {
            reason: 'invalid-context',
            attemptId: ctx.attemptId,
            invalidContext: true,
          },
        };
      }
    }

    if (ctx.abortSignal.aborted) {
      return {
        outcome: 'failure',
        details: {
          reason: 'aborted-before-start',
          attemptId: ctx.attemptId,
        },
      };
    }

    if (!this.stateDir) {
      return {
        outcome: 'failure',
        details: {
          reason: 'no-state-dir',
          attemptId: ctx.attemptId,
        },
      };
    }

    // Check deadline budget — preflight can take up to ~120s on a cold-cache
    // npm install + better-sqlite3 rebuild. Refuse if the ctx has < 5s left.
    const nowHr = process.hrtime.bigint();
    if (ctx.monotonicDeadline > 0n && ctx.monotonicDeadline <= nowHr) {
      return {
        outcome: 'failure',
        details: {
          reason: 'deadline-already-elapsed',
          attemptId: ctx.attemptId,
        },
      };
    }

    let summary = '';
    let threw: Error | null = null;
    try {
      // Delegate to the existing six-step heal body. Synchronous; returns
      // a human-readable summary (empty string if nothing was healed).
      summary = this.preflightSelfHeal();
    } catch (err) {
      threw = err instanceof Error ? err : new Error(String(err));
    }

    if (ctx.abortSignal.aborted) {
      // The abort fired during the synchronous body — record the partial
      // attempt but report aborted so the Remediator's verify step is skipped
      // by the dispatcher's deadline-race path.
      return {
        outcome: 'failure',
        details: {
          reason: 'aborted-mid-step',
          attemptId: ctx.attemptId,
          partialSummary: summary,
        },
      };
    }

    if (threw) {
      return {
        outcome: 'failure',
        details: {
          reason: `preflight-threw: ${threw.message.slice(0, 200)}`,
          attemptId: ctx.attemptId,
        },
      };
    }

    return {
      outcome: 'success',
      details: {
        attemptId: ctx.attemptId,
        healed: summary,
        anyHealed: summary.length > 0,
      },
    };
  }

  /**
   * Run preflight checks and attempt to fix broken prerequisites.
   * Returns a summary of what was healed (empty string if nothing needed fixing).
   */
  private preflightSelfHeal(): string {
    if (!this.stateDir) return '';

    const healed: string[] = [];

    // 1. Shadow install — the most common failure mode.
    //    If the shadow install is missing or corrupt, the server can't start at all.
    const shadowDir = path.join(this.stateDir, 'shadow-install');
    const shadowCli = path.join(shadowDir, 'node_modules', 'instar', 'dist', 'cli.js');

    if (!fs.existsSync(shadowCli)) {
      console.log('[Supervisor] Preflight: shadow install missing — attempting reinstall');
      try {
        // Find a working npm binary
        const npmPath = this.findNpmPath();
        if (npmPath) {
          const result = spawnSync(npmPath, ['install', 'instar', '--prefix', shadowDir], {
            encoding: 'utf-8',
            timeout: 60_000,
            cwd: this.projectDir,
          });
          if (result.status === 0 && fs.existsSync(shadowCli)) {
            healed.push('shadow install restored');
            console.log('[Supervisor] Preflight: shadow install restored successfully');
          } else {
            console.error(`[Supervisor] Preflight: npm install failed (exit ${result.status}): ${(result.stderr || '').slice(-200)}`);
          }
        } else {
          console.error('[Supervisor] Preflight: no npm binary found — cannot restore shadow install');
        }
      } catch (err) {
        console.error(`[Supervisor] Preflight: shadow install repair failed: ${err}`);
      }
    }

    // 2. Node symlink — if broken, the launchd boot wrapper will fail on next restart.
    const nodeSymlink = path.join(this.stateDir, 'bin', 'node');
    try {
      if (!fs.existsSync(nodeSymlink) || spawnSync(nodeSymlink, ['--version'], { timeout: 5000 }).status !== 0) {
        console.log('[Supervisor] Preflight: node symlink missing or broken — attempting fix');
        const nodePath = this.findNodePath();
        if (nodePath) {
          fs.mkdirSync(path.dirname(nodeSymlink), { recursive: true });
          try { SafeFsExecutor.safeUnlinkSync(nodeSymlink, { operation: 'src/lifeline/ServerSupervisor.ts:365' }); } catch { /* may not exist */ }
          fs.symlinkSync(nodePath, nodeSymlink);
          healed.push('node symlink repaired');
          console.log(`[Supervisor] Preflight: node symlink → ${nodePath}`);
        }
      }
    } catch (err) {
      console.error(`[Supervisor] Preflight: node symlink check failed: ${err}`);
    }

    // 3. Stuck git rebase — prevents git-sync from working, blocks updates
    try {
      const statusText = SafeGitExecutor.readSync(['status'], {
        encoding: 'utf-8',
        timeout: 5000,
        cwd: this.projectDir,
        operation: 'src/lifeline/ServerSupervisor.ts:378',
        // Read-only check. On a dogfooding agent (projectDir IS the instar
        // source tree) the SourceTreeGuard otherwise rejects this call and
        // the thrown error aborts recovery — prolonging the exact outage the
        // preflight exists to end (live: echo, 2026-06-05). Same opt-in class
        // as the failure-learning loop's git reads (#550).
        sourceTreeReadOk: true,
      });
      if (statusText.includes('rebase in progress') || statusText.includes('interactive rebase in progress')) {
        console.log('[Supervisor] Preflight: stuck git rebase detected — aborting');
        try {
          SafeGitExecutor.execSync(['rebase', '--abort'], {
            encoding: 'utf-8',
            timeout: 10_000,
            cwd: this.projectDir,
            operation: 'src/lifeline/ServerSupervisor.ts:387',
          });
          healed.push('stuck git rebase aborted');
          console.log('[Supervisor] Preflight: git rebase aborted successfully');
        } catch (abortErr) {
          const message = abortErr instanceof Error ? abortErr.message : String(abortErr);
          console.error(`[Supervisor] Preflight: git rebase --abort failed: ${message}`);
        }
      }
    } catch (err) {
      console.error(`[Supervisor] Preflight: git state check failed: ${err}`);
    }

    // 4. Native module mismatch — better-sqlite3 compiled for wrong Node version.
    //    This is the #1 cause of server crash-loops after a Node upgrade.
    //
    //    IMPORTANT: Test with the node binary the SERVER will use (.instar/bin/node),
    //    not process.execPath (the lifeline's node), since these may differ.
    //
    //    IMPORTANT: Scan ALL nested copies under shadow-install/node_modules.
    //    A previous version checked only the top-level hoisted path
    //    `shadow-install/node_modules/better-sqlite3/...`, but npm does not
    //    always hoist; the actually-loaded copy can live at the nested path
    //    `shadow-install/node_modules/instar/node_modules/better-sqlite3/...`.
    //    This was the root cause of the Inspec 2026-04-29 silent crash-loop.
    if (this.stateDir) {
      const serverNode = path.join(this.stateDir, 'bin', 'node');
      const checkNode = (fs.existsSync(serverNode)) ? serverNode : process.execPath;
      const shadowNodeModules = path.join(this.stateDir, 'shadow-install', 'node_modules');
      const sqliteCopies = findBetterSqlite3Copies(shadowNodeModules);
      // FLEET FIX (native-module rebuild-loop, 2026-05-29): a BIND failure (e.g.
      // EADDRINUSE from a held/duplicate listener.sock or HTTP port) is NOT
      // evidence of a native-module ABI problem. Previously we force-rebuilt
      // better-sqlite3 on any >=2 consecutive bind failures EVEN when the module
      // loaded fine — turning a held-socket situation into hundreds of futile,
      // CPU-heavy node-gyp rebuilds (observed fleet-wide: sagemind 202,
      // deep-signal 144, inspec 112, ai-guy 104). We now rebuild ONLY a copy that
      // actually fails to load with a NODE_MODULE_VERSION ABI mismatch. Genuine
      // native-module crash-loops still self-heal (the load check below catches a
      // server that crashed before binding because the module failed to load); a
      // held-socket bind failure no longer burns the machine on a futile rebuild.
      let anyAbiMismatch = false;
      for (const copy of sqliteCopies) {
        try {
          // Try loading the native module with the SERVER's Node — rebuild only
          // if it ACTUALLY fails to load with an ABI mismatch.
          const result = spawnSync(checkNode, ['-e', `require('${copy.binaryPath.replace(/'/g, "\\'")}')`], {
            encoding: 'utf-8',
            timeout: 10_000,
            cwd: this.projectDir,
          });
          const needsRebuild = result.status !== 0 && (result.stderr?.includes('NODE_MODULE_VERSION') ?? false);
          if (!needsRebuild) continue;
          anyAbiMismatch = true;
          console.log(`[Supervisor] Preflight: better-sqlite3 version mismatch at ${copy.packageDir} — rebuilding (server node: ${checkNode})`);
          const npmPath = this.findNpmPath();
          if (!npmPath) {
            console.error('[Supervisor] Preflight: no npm binary found — cannot rebuild better-sqlite3');
            continue;
          }
          // FLEET FIX (wrong-ABI rebuild + binary-deletion footgun, 2026-05-29 —
          // instar-codey sqlite offline 16h). Three problems the old single
          // `--build-from-source` path had:
          //  (1) node-gyp / prebuild-install resolve `node` from PATH. If a
          //      different Node (e.g. an asdf-managed 22.x, ABI 127) is ahead of
          //      the server's Node (e.g. 25.x, ABI 141) on PATH, the rebuild
          //      "succeeds" but targets the WRONG ABI — the server's Node then
          //      can't load it ("rebuild succeeded but module still fails to
          //      load"). Pin the toolchain to the server Node's dir so every
          //      `env node` in the chain resolves the correct ABI.
          //  (2) from-source compile can fail entirely on a box without a
          //      working C++ toolchain. Prefer the PREBUILT (fast, no compiler);
          //      with the toolchain pinned, the prebuilt fetched is the correct
          //      ABI. Only compile from source as a fallback.
          //  (3) `--build-from-source` deletes build/Release/*.node before
          //      compiling — a failed compile left the agent with NO module at
          //      all (worse than the wrong-ABI degradation it started from). Back
          //      the binary up first and RESTORE it if the rebuild can't produce
          //      a loadable module.
          const serverNodeDir = path.dirname(checkNode);
          const rebuildEnv: Record<string, string | undefined> = {
            ...process.env,
            npm_config_node_gyp: undefined,
            npm_node_execpath: checkNode,
            // Server Node dir FIRST so node-gyp / prebuild-install / any
            // `#!/usr/bin/env node` shebang resolves the server's Node ABI.
            PATH: `${serverNodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
          };
          const verifyLoadable = (): boolean =>
            spawnSync(checkNode, ['-e', `require('${copy.binaryPath.replace(/'/g, "\\'")}')`], {
              encoding: 'utf-8', timeout: 10_000, cwd: this.projectDir,
            }).status === 0;
          // Back up the current (wrong-ABI) binary so a failed rebuild can't
          // leave the agent with no module.
          const backupPath = `${copy.binaryPath}.heal-bak`;
          let hasBackup = false;
          try {
            if (fs.existsSync(copy.binaryPath)) { fs.copyFileSync(copy.binaryPath, backupPath); hasBackup = true; }
          } catch { /* best-effort backup */ }
          // Prebuilt-first, then compile-fallback. `npm install` runs
          // better-sqlite3's install script (`prebuild-install`), which fetches
          // the prebuilt for the SERVER Node's ABI — NO compiler needed and ~2s.
          // (`npm rebuild` always node-gyp-compiles and never fetches a prebuilt,
          // so it can't heal a box without a working toolchain — which is exactly
          // where instar-codey was stuck.) Pin to the exact version instar ships.
          // The from-source fallback keeps `--ignore-scripts` (no arbitrary
          // postinstalls; supply-chain per SELF-HEALING-REMEDIATOR-V3 §A45).
          let pkgVersion = '';
          try {
            pkgVersion = (JSON.parse(fs.readFileSync(path.join(copy.packageDir, 'package.json'), 'utf-8')).version as string) || '';
          } catch { /* no version → install whatever resolves */ }
          const installSpec = pkgVersion ? `better-sqlite3@${pkgVersion}` : 'better-sqlite3';
          const attempts: string[][] = [
            ['install', installSpec, '--no-save', '--prefix', copy.prefixDir],
            ['rebuild', '--build-from-source', '--ignore-scripts', 'better-sqlite3', '--prefix', copy.prefixDir],
          ];
          let rebuilt = false;
          let lastErr = '';
          for (const args of attempts) {
            const r = spawnSync(checkNode, [npmPath, ...args], {
              encoding: 'utf-8', timeout: 120_000, cwd: this.projectDir, env: rebuildEnv,
            });
            if (r.status === 0 && verifyLoadable()) { rebuilt = true; break; }
            lastErr = (r.stderr || '').slice(-200);
          }
          if (rebuilt) {
            try { if (hasBackup) SafeFsExecutor.safeUnlinkSync(backupPath, { operation: 'ServerSupervisor.preflight:bsq-backup-cleanup' }); } catch { /* ignore */ }
            healed.push(`better-sqlite3 rebuilt at ${path.relative(this.stateDir, copy.packageDir)}`);
            console.log(`[Supervisor] Preflight: better-sqlite3 rebuilt and verified at ${copy.packageDir}`);
          } else {
            // Restore the prior binary — wrong-ABI degraded beats a missing
            // module that crashes subsystem init.
            let restored = false;
            try {
              if (hasBackup) { fs.copyFileSync(backupPath, copy.binaryPath); SafeFsExecutor.safeUnlinkSync(backupPath, { operation: 'ServerSupervisor.preflight:bsq-backup-restore' }); restored = true; }
            } catch { /* ignore */ }
            console.error(`[Supervisor] Preflight: better-sqlite3 rebuild could not produce a loadable module at ${copy.packageDir}${restored ? ' — restored prior binary (sqlite stays degraded, not bricked)' : ''}: ${lastErr}`);
          }
        } catch (err) {
          console.error(`[Supervisor] Preflight: native module check failed at ${copy.packageDir}: ${err}`);
        }
      }
      // Diagnostic: repeated bind failures while better-sqlite3 loads fine means
      // the failure is NOT a native-module problem (almost always a held/stale
      // listener.sock or HTTP port from a duplicate/stuck instance). Say so loudly
      // instead of silently rebuilding — the real remedy is freeing the socket
      // (WakeSocketServer now degrades gracefully instead of crash-looping).
      if (this.consecutiveBindFailures >= this.bindFailureEscalationThreshold && !anyAbiMismatch && sqliteCopies.length > 0) {
        console.log(`[Supervisor] Preflight: ${this.consecutiveBindFailures} consecutive bind failures but better-sqlite3 loads fine — NOT a native-module problem (likely a held socket/port from a duplicate or stuck instance). Skipping native rebuild.`);
      }
    }

    // 5. Stale lifeline lock — can prevent the lifeline from restarting properly.
    const lockFile = path.join(this.stateDir, 'state', 'lifeline.lock');
    try {
      if (fs.existsSync(lockFile)) {
        const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (lockAge > 10 * 60_000) { // 10 minutes
          SafeFsExecutor.safeUnlinkSync(lockFile, { operation: 'src/lifeline/ServerSupervisor.ts:463' });
          healed.push('stale lifeline lock removed');
          console.log(`[Supervisor] Preflight: removed stale lifeline lock (${Math.round(lockAge / 60_000)}m old)`);
        }
      }
    } catch { /* ignore */ }

    // 6. Corrupted .claude/settings.json — unresolved merge conflicts crash every
    // Claude Code session silently. The server stays healthy but no session responds.
    const settingsPath = path.join(this.projectDir, '.claude', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        if (raw.includes('<<<<<<<') || raw.includes('>>>>>>>')) {
          console.warn('[Supervisor] Preflight: .claude/settings.json has merge conflicts — repairing');
          const repaired = raw
            .replace(/^<<<<<<< .*\n/gm, '')
            .replace(/^=======\n/gm, '')
            .replace(/^>>>>>>> .*\n/gm, '');
          try {
            JSON.parse(repaired);
            fs.copyFileSync(settingsPath, `${settingsPath}.merge-conflict-backup`);
            fs.writeFileSync(settingsPath, repaired);
            healed.push('settings.json merge conflicts resolved');
            console.log('[Supervisor] Preflight: settings.json repaired');
          } catch {
            console.error('[Supervisor] Preflight: settings.json auto-repair failed — manual fix needed');
          }
        } else {
          JSON.parse(raw); // Validate JSON
        }
      }
    } catch (err) {
      console.error(`[Supervisor] Preflight: .claude/settings.json is invalid JSON: ${err}`);
    }

    if (healed.length > 0) {
      const summary = healed.join(', ');
      console.log(`[Supervisor] Preflight self-heal: ${summary}`);
      return summary;
    }
    return '';
  }

  /**
   * Find a working npm binary. Checks common locations.
   */
  private findNpmPath(): string | null {
    // Try the node that's running us — npm is usually a sibling
    const currentNodeDir = path.dirname(process.execPath);
    const siblingNpm = path.join(currentNodeDir, 'npm');
    if (fs.existsSync(siblingNpm)) return siblingNpm;

    // Common paths
    for (const candidate of ['/opt/homebrew/bin/npm', '/usr/local/bin/npm']) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // Fall back to PATH lookup
    try {
      const which = spawnSync('which', ['npm'], { encoding: 'utf-8', timeout: 5000 });
      if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    } catch { /* ignore */ }

    return null;
  }

  /**
   * Find a working node binary. Checks common locations.
   */
  private findNodePath(): string | null {
    // Current process is always valid
    if (process.execPath) return process.execPath;

    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
      if (fs.existsSync(candidate)) return candidate;
    }

    try {
      const which = spawnSync('which', ['node'], { encoding: 'utf-8', timeout: 5000 });
      if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    } catch { /* ignore */ }

    return null;
  }

  private spawnServer(): boolean {
    if (!this.tmuxPath) return false;

    // Run preflight self-heal before every spawn attempt
    this.preflightSelfHeal();

    try {
      // Get the instar CLI path — resolution order:
      //   1. Shadow install (agent's own managed version from AutoUpdater)
      //   2. Current binary location (how the lifeline was started)
      //
      // Shadow install is the agent's private copy at {stateDir}/shadow-install/.
      // The AutoUpdater installs updates there instead of globally, so each agent
      // manages its own version independently.
      let cliPath = path.resolve(__dirname, '../cli.js');

      // Check for shadow install first — this is the agent's own managed version
      if (this.stateDir) {
        const shadowCli = path.join(this.stateDir, 'shadow-install', 'node_modules', 'instar', 'dist', 'cli.js');
        if (fs.existsSync(shadowCli)) {
          console.log(`[Supervisor] Using shadow install: ${shadowCli}`);
          cliPath = shadowCli;
        }
      }

      // Stderr capture: tee to crash log file for fast-exit diagnostics
      const crashLogDir = this.stateDir ? path.join(this.stateDir, 'logs') : '/tmp';
      try { fs.mkdirSync(crashLogDir, { recursive: true }); } catch { /* ignore */ }
      const crashLogPath = path.join(crashLogDir, 'server-stderr.log');

      // --no-telegram: lifeline owns the Telegram connection, server should not poll
      // Use the agent's node symlink (.instar/bin/node) instead of bare `node` so the
      // server runs the same Node version the native modules were compiled against.
      // Bare `node` resolves to whatever is on PATH in the tmux session, which may be
      // a different major version (e.g. v25 via Homebrew when shadow-install was built
      // with v22), causing better-sqlite3 ABI mismatches and event loop deadlocks.
      const nodeSymlink = this.stateDir ? path.join(this.stateDir, 'bin', 'node') : null;
      const nodeExe = (nodeSymlink && fs.existsSync(nodeSymlink)) ? nodeSymlink : 'node';
      const quotedNode = nodeExe.replace(/'/g, "'\\''");
      const quotedCli = cliPath.replace(/'/g, "'\\''");
      const nodeCmd = `'${quotedNode}' '${quotedCli}' 'server' 'start' '--foreground' '--no-telegram' 2> >(tee '${crashLogPath}' >&2)`;

      // GIT_TERMINAL_PROMPT=0 prevents git operations performed during startup
      // (auto-pull / git-sync) from falling through to an interactive terminal
      // prompt when GIT_ASKPASS fails. Without it, a missing/expired credential
      // helper hangs the bash command behind "Username for 'https://github.com':",
      // which fails the health check and produces a runaway restart loop. tmux
      // `-e` is per-session and survives an existing tmux server (process.env
      // alone does not propagate once tmux is already running).
      //
      // Kill any pre-existing session of this name first. `tmux new-session`
      // fails on a duplicate name, so a lingering/stale session (e.g. a dying
      // server still registered after `kickstart -k`) would otherwise make
      // every respawn attempt throw "duplicate session" and leave the server
      // down. Killing first makes respawn idempotent and race-safe — this is
      // the second half of the P1 fix (the first being start()'s health gate).
      if (this.isServerSessionAlive()) {
        try {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore', timeout: 5000,
          });
          console.log(`[Supervisor] Killed lingering tmux session before respawn: ${this.serverSessionName}`);
        } catch { /* best-effort — new-session below will surface a real failure */ }
      }
      execFileSync(this.tmuxPath, [
        'new-session', '-d',
        '-s', this.serverSessionName,
        '-c', this.projectDir,
        '-e', 'GIT_TERMINAL_PROMPT=0',
        `bash`, '-c', nodeCmd,
      ], { stdio: 'ignore' });

      console.log(`[Supervisor] Server started in tmux session: ${this.serverSessionName}`);
      this.isRunning = true;
      this.spawnedAt = Date.now();
      this.startHealthChecks();
      return true;
    } catch (err) {
      console.error(`[Supervisor] Failed to start server: ${err}`);
      return false;
    }
  }

  private isServerSessionAlive(): boolean {
    if (!this.tmuxPath) return false;
    try {
      execFileSync(this.tmuxPath, ['has-session', '-t', `=${this.serverSessionName}`], {
        stdio: 'ignore', timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    // Agent hard-sleep: if a slept-marker survived from before this supervisor boot,
    // the server was intentionally asleep — stay asleep (the health loop will only
    // watch for a wake-request) rather than respawning it as if it had crashed.
    if (this.sleptMarkerPresent()) {
      this.slept = true;
      console.log('[Supervisor] Booted with a slept-marker present — staying asleep until a wake-request');
    }

    // Start SleepWakeDetector to catch short sleeps (10-30s) that the gap-based
    // detection below misses (its 2-minute threshold is too high for brief suspends).
    // On wake, reset failure counters so stale pre-sleep failures don't cascade.
    if (!this.sleepWakeDetector) {
      // Use 15s drift threshold — low enough to catch real sleeps but high enough
      // to avoid false positives from normal OS scheduling jitter (~5-10s on loaded systems)
      // that still cause health check failures during the transition.
      this.sleepWakeDetector = new SleepWakeDetector({ driftThresholdMs: 15_000 });
      this.sleepWakeDetector.on('wake', (event: { sleepDurationSeconds: number }) => {
        console.log(`[Supervisor] SleepWakeDetector: wake after ~${event.sleepDurationSeconds}s. Resetting failure counters.`);
        this.restartAttempts = 0;
        this.maxRetriesExhaustedAt = 0;
        this.consecutiveFailures = 0;
        this.totalFailures = 0;
        this.totalFailureWindowStart = 0;
        this.spawnedAt = Date.now();
        this.wakeTransitionUntil = Date.now() + this.wakeTransitionMs;
      });
      this.sleepWakeDetector.start();
    }

    this.healthCheckInterval = setInterval(async () => {
      const now = Date.now();

      // Sleep/wake detection: if the gap between health checks is much larger than
      // the poll interval, the machine was likely suspended (e.g., lid close after
      // an auto-update restart). Reset failure counters so brief wake cycles don't
      // exhaust restart attempts before the machine is fully awake.
      if (this.lastHealthCheckAt > 0 && (now - this.lastHealthCheckAt) > this.sleepWakeGapMs) {
        const gapSec = Math.round((now - this.lastHealthCheckAt) / 1000);
        console.log(`[Supervisor] Sleep/wake detected (${gapSec}s gap). Resetting failure counters.`);
        this.restartAttempts = 0;
        this.maxRetriesExhaustedAt = 0;
        this.consecutiveFailures = 0;
        this.totalFailures = 0;
        this.totalFailureWindowStart = 0;
        // Give the server the full startup grace period from wake time
        this.spawnedAt = now;
        this.wakeTransitionUntil = now + this.wakeTransitionMs;
      }
      this.lastHealthCheckAt = now;

      // Agent hard-sleep: when intentionally slept, the server is down BY DESIGN.
      // Skip all health/respawn logic and only watch for a wake-request. This is
      // the single change to the loop's control flow — a pure short-circuit that is
      // a no-op unless a sleep-request was honored (slept === false otherwise).
      if (this.slept) {
        this.checkWakeRequest();
        return;
      }

      // During startup grace period: probe health optimistically but don't act on failures.
      // This allows `lastHealthy` to update as soon as the server is responsive, so
      // TelegramLifeline can forward messages immediately instead of queuing them for
      // the entire grace period. Failures are ignored — the server is still booting.
      if (this.spawnedAt > 0 && (now - this.spawnedAt) < this.startupGraceMs) {
        this.checkRestartRequest();
        // Optimistic health probe — update lastHealthy on success, ignore failures
        try {
          const alive = await this.checkHealth();
          if (alive) {
            this.lastHealthy = Date.now();
            if (!this.isRunning) {
              this.isRunning = true;
              this.emit('serverUp');
            }
          }
        } catch { /* expected during boot — ignore */ }
        return;
      }

      try {
        const healthy = await this.checkHealth();
        if (healthy) {
          if (!this.isRunning) {
            if (this.maintenanceWaitStartedAt > 0) {
              // Recovering from planned restart — quiet recovery, no notification
              const elapsedMs = Date.now() - this.maintenanceWaitStartedAt;
              console.log(`[Supervisor] Server recovered after planned restart (${Math.round(elapsedMs / 1000)}s downtime)`);
              this.maintenanceWaitStartedAt = 0;
              this.clearPlannedExitMarker();
              // Still replay queued messages (important!) but skip serverDown notification
              this.emit('serverUp');
              // Signal the lifeline to self-restart so it picks up new code
              if (this.pendingUpdateVersion) {
                console.log(`[Supervisor] Update to v${this.pendingUpdateVersion} applied — signaling lifeline self-restart`);
                this.emit('updateApplied', this.pendingUpdateVersion);
                this.pendingUpdateVersion = null;
              }
            } else {
              this.emit('serverUp');
            }
          }
          this.isRunning = true;
          this.lastHealthy = Date.now();
          this.restartAttempts = 0;
          this.consecutiveFailures = 0;
          this.consecutiveBindFailures = 0;

          // F-6: notify any pending Remediator restart-requested entries
          // that the planned restart has completed. Idempotent.
          this.notifyPendingRemediatorRequestsOnHealthy();

          // If circuit breaker was tripped and we recovered, reset it
          if (this.circuitBroken) {
            console.log('[Supervisor] Server recovered after circuit breaker — resetting');
            this.resetCircuitBreaker();
          }
        } else {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.unhealthyThreshold) {
            this.evaluateUnhealthyServer();
          }
        }
      } catch {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.unhealthyThreshold) {
          this.evaluateUnhealthyServer();
        }
      }

      // Check for restart requests from the server (e.g., auto-updater)
      this.checkRestartRequest();
      // Check for debug restart requests from doctor sessions
      this.checkDebugRestartRequest();
      // Agent hard-sleep: honor a sleep-request written by the live SleepController
      this.checkSleepRequest();
    }, 10_000); // Check every 10 seconds
  }

  private stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.sleepWakeDetector) {
      this.sleepWakeDetector.stop();
      this.sleepWakeDetector = null;
    }
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      // Use 8s timeout — 5s is too aggressive under high CPU load where even localhost
      // HTTP can be delayed by event loop stalls. The health check interval is 10s so
      // 8s still leaves a gap between checks.
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /**
   * Verify the server actually answers /health, retrying a few times so a
   * momentarily-stalled-but-healthy server is not needlessly respawned.
   *
   * Used by start() to distinguish a genuinely-running server (lifeline
   * self-restart while the server stays up → no-op) from a dying/stale tmux
   * session that merely still registers with `has-session` right after a
   * `kickstart -k` (→ must respawn). A live server answers on the first probe;
   * a dead/dying one fails every attempt. Bias: prefer respawning a possibly
   * stalled server over leaving a dead one running invisibly (the P1 bug).
   */
  private async verifyServerResponding(attempts = 3, delayMs = 1500): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (await this.checkHealth()) return true;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return false;
  }

  // ── Agent hard-sleep: sleep/wake request handling ─────────────────
  //
  // Mirrors the restart-requested.json lifecycle. The live SleepController writes
  // `state/sleep-requested.json` on a would-sleep verdict; this honors it by
  // STOPPING the server (no respawn) and entering `slept`. The lifeline writes
  // `state/wake-requested.json` on the next inbound message; checkWakeRequest()
  // (called only while slept) respawns the server. A `state/slept-marker.json`
  // records the intentional-sleep so a supervisor reboot — or the fleet watchdog —
  // recognizes "asleep", not "crashed". Spec: docs/specs/agent-hard-sleep-mechanism.md.

  /** Stop the server tmux session and enter `slept`. Honors sleep-requested.json. */
  private checkSleepRequest(): void {
    if (!this.stateDir || this.slept) return;
    const flagPath = path.join(this.stateDir, 'state', 'sleep-requested.json');
    try {
      if (!fs.existsSync(flagPath)) return;
      let data: { requestedBy?: string; reason?: string; expiresAt?: string } = {};
      try { data = JSON.parse(fs.readFileSync(flagPath, 'utf-8')); } catch { /* tolerate */ }
      // Consume the flag BEFORE acting so a malformed/processed request can't loop.
      try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:checkSleepRequest' }); } catch { /* ignore */ }
      if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
        console.log('[Supervisor] Expired sleep request — ignoring');
        return;
      }
      console.log(`[Supervisor] Sleep requested (${data.reason ?? 'deep-idle'}) — stopping server to save resources`);
      // Record the intentional sleep BEFORE stopping, so a reboot/watchdog sees it.
      this.writeSleptMarker(data.reason ?? 'deep-idle');
      this.slept = true;
      this.isRunning = false;
      // Stop the server tmux session WITHOUT respawning (the wake path respawns).
      if (this.tmuxPath) {
        try {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], { stdio: 'ignore', timeout: 10_000 });
        } catch { /* @silent-fallback-ok — session may already be gone */ }
      }
      this.emit('serverSlept');
    } catch {
      try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:checkSleepRequest:catch' }); } catch { /* ignore */ }
    }
  }

  /** Respawn the server on a wake-request. Called from the health loop ONLY while slept. */
  private checkWakeRequest(): void {
    if (!this.stateDir || !this.slept) return;
    const flagPath = path.join(this.stateDir, 'state', 'wake-requested.json');
    try {
      if (!fs.existsSync(flagPath)) return;
      try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:checkWakeRequest' }); } catch { /* ignore */ }
      console.log('[Supervisor] Wake requested — respawning server');
      this.clearSleptMarker();
      this.slept = false;
      // Give the fresh server the full startup grace from now (mirrors restart path).
      this.spawnedAt = Date.now();
      this.consecutiveFailures = 0;
      this.restartAttempts = 0;
      this.spawnServer();
      this.emit('serverWoke');
    } catch {
      try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:checkWakeRequest:catch' }); } catch { /* ignore */ }
    }
  }

  private writeSleptMarker(reason: string): void {
    if (!this.stateDir) return;
    try {
      const dir = path.join(this.stateDir, 'state');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'slept-marker.json'), JSON.stringify({ sleptAt: new Date().toISOString(), reason }));
    } catch { /* @silent-fallback-ok — marker is best-effort observability */ }
  }

  private clearSleptMarker(): void {
    if (!this.stateDir) return;
    try { SafeFsExecutor.safeUnlinkSync(path.join(this.stateDir, 'state', 'slept-marker.json'), { operation: 'src/lifeline/ServerSupervisor.ts:clearSleptMarker' }); } catch { /* ignore */ }
  }

  /** True when a slept-marker is on disk — read at boot so a reboot stays asleep. */
  private sleptMarkerPresent(): boolean {
    if (!this.stateDir) return false;
    try { return fs.existsSync(path.join(this.stateDir, 'state', 'slept-marker.json')); } catch { return false; }
  }

  // ── Restart request handling ──────────────────────────────────────

  /**
   * Check if the server (AutoUpdater) has requested a restart.
   * Called during the health check loop. If a valid request exists,
   * initiate a graceful restart of the server tmux session.
   */
  private checkRestartRequest(): void {
    if (!this.stateDir) return;
    const flagPath = path.join(this.stateDir, 'state', 'restart-requested.json');

    try {
      if (!fs.existsSync(flagPath)) return;
      const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));

      // Check TTL
      if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
        try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:827' }); } catch { /* ignore */ }
        console.log('[Supervisor] Expired restart request — ignoring');
        return;
      }

      console.log(`[Supervisor] Restart requested by ${data.requestedBy} for v${data.targetVersion}`);

      // RESTART LOOP DETECTION: If we've already restarted for this version,
      // the binary isn't actually updating (npx cache mismatch). Don't loop.
      const restartCountFile = path.join(this.stateDir!, 'state', 'restart-version-count.json');
      let restartCount = 0;
      try {
        if (fs.existsSync(restartCountFile)) {
          const countData = JSON.parse(fs.readFileSync(restartCountFile, 'utf-8'));
          if (countData.targetVersion === data.targetVersion) {
            restartCount = (countData.count ?? 0);
          }
        }
      } catch { /* fresh count */ }

      if (restartCount >= 2) {
        console.log(`[Supervisor] Restart loop detected — already restarted ${restartCount}x for v${data.targetVersion}. Skipping.`);
        try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:850' }); } catch { /* ignore */ }
        // Clean up the count file so it doesn't block future real updates
        try { SafeFsExecutor.safeUnlinkSync(restartCountFile, { operation: 'src/lifeline/ServerSupervisor.ts:853' }); } catch { /* ignore */ }
        return;
      }

      // Increment restart count for this version
      try {
        const stateSubdir = path.join(this.stateDir!, 'state');
        fs.mkdirSync(stateSubdir, { recursive: true });
        fs.writeFileSync(restartCountFile, JSON.stringify({
          targetVersion: data.targetVersion,
          count: restartCount + 1,
          lastRestartAt: new Date().toISOString(),
        }));
      } catch { /* best-effort */ }

      // Enter maintenance wait if this is a planned restart (suppress serverDown alerts)
      if (data.plannedRestart) {
        this.maintenanceWaitStartedAt = Date.now();
        this.pendingUpdateVersion = data.targetVersion ?? null;
        console.log(`[Supervisor] Planned restart — entering maintenance wait (${Math.round(this.maintenanceWaitMs / 60_000)}m window)`);
      }

      // Clear the flag BEFORE restarting to prevent re-triggering
      try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:877' }); } catch { /* ignore */ }

      // Also clean up legacy flag if present
      this.clearLegacyRestartFlag();

      // Clean up any planned-exit marker from ForegroundRestartWatcher
      this.clearPlannedExitMarker();

      // Initiate graceful restart
      this.performGracefulRestart(`update to v${data.targetVersion}`);
    } catch {
      // Malformed flag — clean up
      try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:890' }); } catch { /* ignore */ }
    }
  }

  // ── Debug restart request handling (doctor session) ─────────────

  /**
   * Check if a doctor session has requested a restart via HMAC-signed file.
   * Called during the health check loop alongside checkRestartRequest().
   */
  private checkDebugRestartRequest(): void {
    if (!this.stateDir) return;
    const requestPath = path.join(this.stateDir, 'debug-restart-request.json');

    try {
      if (!fs.existsSync(requestPath)) return;

      const raw = fs.readFileSync(requestPath, 'utf-8');
      SafeFsExecutor.safeUnlinkSync(requestPath, { operation: 'src/lifeline/ServerSupervisor.ts:909' }); // consume the request immediately

      const request = JSON.parse(raw);

      // TTL check — reject requests older than 30 minutes
      const requestAge = Date.now() - new Date(request.requestedAt).getTime();
      if (requestAge > 30 * 60_000) {
        console.log(`[Supervisor] Stale debug restart request (${Math.round(requestAge / 60_000)}m old) — discarded`);
        return;
      }

      // HMAC validation
      if (!this.validateRestartHmac(request)) {
        console.warn(`[Supervisor] Invalid HMAC on debug restart request — rejected`);
        return;
      }

      // Sanitize fixDescription before display (self-reported, untrusted)
      const safeDescription = (request.fixDescription || 'no description')
        .replace(/[<>&"']/g, '') // strip HTML-like chars
        .slice(0, 200); // cap length

      console.log(`[Supervisor] Debug session fix (self-reported): ${safeDescription}`);

      // Check if server already recovered
      if (this.healthy) {
        console.log(`[Supervisor] Server already healthy — skipping restart, noting fix`);
        this.emit('debugRestartSkipped', { fixDescription: safeDescription, reason: 'server_already_healthy' });
        return;
      }

      this.emit('debugRestartRequested', { fixDescription: safeDescription, requestedBy: request.requestedBy || 'doctor-session' });

      // Reset circuit breaker and restart
      this.resetCircuitBreaker();
      this.stop().then(() => this.start());
    } catch (err) {
      console.error(`[Supervisor] Error processing debug restart request: ${err}`);
    }
  }

  /**
   * Validate HMAC on a debug restart request using the doctor session secret.
   */
  private validateRestartHmac(request: { requestedAt?: string; fixDescription?: string; hmac?: string }): boolean {
    if (!this.doctorSessionSecret || !request.hmac || !request.requestedAt) return false;

    try {
      const expectedPayload = request.requestedAt + (request.fixDescription || '');
      const expectedHmac = crypto
        .createHmac('sha256', this.doctorSessionSecret)
        .update(expectedPayload)
        .digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      const hmacBuf = Buffer.from(request.hmac, 'hex');
      const expectedBuf = Buffer.from(expectedHmac, 'hex');

      if (hmacBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(hmacBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  // ── F-6: Remediator handshake ───────────────────────────────────
  //
  // Per v2 spec §A15 + v3 §3. The Remediator registers itself, providing
  // a `getCapabilityLeafKey()` callback so the supervisor can verify
  // HMACs on `restart-requested` requests, and a `onRestartComplete`
  // callback so the supervisor can notify the Remediator when a planned
  // restart cycle finishes (advancing the attempt to verify-phase).
  //
  // Registration also writes `.instar/state/supervisor-handshake.json`
  // so a freshly-spawned Remediator can detect the supervisor's
  // handshake protocol version + build id without an in-process handle.
  // The A15 partial-upgrade rule lives Remediator-side: a Remediator
  // whose handshakeVersion is NEWER than the supervisor's must refuse to
  // issue `restart-requested` and fall back to alert-only.

  /**
   * Register a Remediator instance for the handshake. Idempotent; calling
   * twice with the same instance is a no-op. Calling with a different
   * instance replaces the previous registration (last-writer-wins is
   * fine because there is only ever one Remediator per process).
   */
  registerRemediator(remediator: RegisteredRemediator): void {
    this.registeredRemediator = remediator;
    this.writeSupervisorHandshakeFile();
  }

  /** Current handshake protocol version (instance accessor). */
  getHandshakeProtocolVersion(): number {
    return ServerSupervisor.HANDSHAKE_PROTOCOL_VERSION;
  }

  /** Build id used for the A15 partial-upgrade lag check. */
  getSupervisorBuildId(): string {
    return this.supervisorBuildId;
  }

  /** Tests inject; production callers should not need to set this. */
  setSupervisorBuildId(buildId: string): void {
    this.supervisorBuildId = buildId;
    if (this.registeredRemediator) this.writeSupervisorHandshakeFile();
  }

  /**
   * Receive a restart-requested from a Remediator. Verifies, in order:
   *   1. A Remediator is registered.
   *   2. Required fields are present and well-typed.
   *   3. `handshakeVersion` matches the supervisor's (A15 rule).
   *   4. `requestedAt` is within RESTART_REQUEST_MAX_AGE_MS of now.
   *   5. `blastRadius` is in {process, machine}. Tier-2 refuses 'fleet'.
   *   6. The HMAC verifies against the canonical payload using the
   *      Remediator's capability leaf key.
   *
   * On accept, the request is tracked under `pendingRemediatorRequests`
   * and a planned graceful restart is initiated. The Remediator's
   * `onRestartComplete` callback fires once the supervisor sees the
   * restart cycle finish (next healthy tick after a serverRestarting).
   */
  async handleRestartRequested(payload: RestartRequestedPayload): Promise<RestartRequestedReply> {
    const supervisorBuildId = this.supervisorBuildId;
    const supervisorHandshakeVersion = ServerSupervisor.HANDSHAKE_PROTOCOL_VERSION;
    const requestId = (payload && typeof payload.requestId === 'string') ? payload.requestId : '';

    const reject = (reason: string): RestartRequestedReply => ({
      requestId,
      accepted: false,
      reason,
      supervisorHandshakeVersion,
      supervisorBuildId,
    });

    if (!this.registeredRemediator) {
      return reject('no-remediator-registered');
    }

    if (!payload || typeof payload !== 'object') {
      return reject('malformed-payload');
    }
    if (
      typeof payload.requestId !== 'string' || !payload.requestId ||
      typeof payload.runbookId !== 'string' || !payload.runbookId ||
      typeof payload.attemptId !== 'string' || !payload.attemptId ||
      typeof payload.blastRadius !== 'string' ||
      typeof payload.requestedAt !== 'number' || !Number.isFinite(payload.requestedAt) ||
      typeof payload.monotonicTs !== 'bigint' ||
      typeof payload.handshakeVersion !== 'number' || !Number.isInteger(payload.handshakeVersion) ||
      !Buffer.isBuffer(payload.hmac)
    ) {
      return reject('malformed-payload');
    }

    // A15: handshake-version mismatch. We accept ONLY exact equality.
    // A Remediator running a newer handshake than the supervisor must
    // fall back to alert-only (rejection is informative, not negotiation).
    if (payload.handshakeVersion !== supervisorHandshakeVersion) {
      return reject(
        `handshake-version-mismatch: remediator=${payload.handshakeVersion} supervisor=${supervisorHandshakeVersion} ` +
        `(A15 partial-upgrade rule — Remediator must fall back to alert-only)`,
      );
    }

    // Staleness check — requestedAt must be within the window. Future
    // timestamps are also rejected to bound clock-skew abuse.
    const ageMs = Date.now() - payload.requestedAt;
    if (ageMs > ServerSupervisor.RESTART_REQUEST_MAX_AGE_MS || ageMs < -ServerSupervisor.RESTART_REQUEST_MAX_AGE_MS) {
      return reject(`stale: ageMs=${ageMs}`);
    }

    // Blast radius — Tier-2 supervisor handles process + machine restarts.
    // 'fleet' is reserved for a future coordination-protocol surface and
    // is refused by Tier-2 unconditionally.
    if (payload.blastRadius !== 'process' && payload.blastRadius !== 'machine') {
      return reject(`blast-radius-out-of-scope: ${payload.blastRadius}`);
    }

    // HMAC verification — use the Remediator's capability leaf key.
    // Canonical payload format MUST be deterministic; see
    // canonicalRestartRequestedBody() below.
    let expected: Buffer;
    try {
      const key = this.registeredRemediator.getCapabilityLeafKey();
      if (!Buffer.isBuffer(key) || key.length === 0) {
        return reject('invalid-leaf-key');
      }
      const body = canonicalRestartRequestedBody(payload);
      expected = crypto.createHmac('sha256', key).update(body).digest();
    } catch (err) {
      return reject(`hmac-compute-failed: ${(err as Error).message}`);
    }

    if (
      expected.length !== payload.hmac.length ||
      !crypto.timingSafeEqual(expected, payload.hmac)
    ) {
      return reject('invalid-hmac');
    }

    // Accepted. Track the pending request for completion notification,
    // then initiate the planned restart. The graceful-restart path
    // already emits `serverRestarting` and pre-sets maintenance wait via
    // performGracefulRestart(); we wire the completion callback through
    // the next healthy tick (see notifyPendingRemediatorRequestsOnHealthy).
    this.pendingRemediatorRequests.set(payload.requestId, {
      requestId: payload.requestId,
      runbookId: payload.runbookId,
      attemptId: payload.attemptId,
    });

    // Fire-and-forget restart; the request is already tracked and the
    // completion callback fires on the next healthy tick.
    this.maintenanceWaitStartedAt = Date.now();
    void this.performGracefulRestart(`remediator:${payload.runbookId}:${payload.attemptId}`);

    return {
      requestId: payload.requestId,
      accepted: true,
      reason: 'accepted',
      supervisorHandshakeVersion,
      supervisorBuildId,
    };
  }

  /**
   * Notify any pending Remediator restart-requested entries that the
   * server is healthy again. Called from the health-check loop after a
   * serverRestarting → healthy transition. Safe to call repeatedly; each
   * entry is removed after its callback fires so subsequent ticks are
   * no-ops.
   */
  private notifyPendingRemediatorRequestsOnHealthy(): void {
    if (this.pendingRemediatorRequests.size === 0) return;
    if (!this.registeredRemediator) {
      // Lost the registration mid-flight; drop the pending entries so we
      // don't leak memory. The Remediator will time out attempt-side.
      this.pendingRemediatorRequests.clear();
      return;
    }
    for (const [, entry] of this.pendingRemediatorRequests) {
      try {
        this.registeredRemediator.onRestartComplete({ requestId: entry.requestId });
      } catch (err) {
        console.error(`[Supervisor] Remediator onRestartComplete threw: ${(err as Error).message}`);
      }
    }
    this.pendingRemediatorRequests.clear();
  }

  /**
   * Write the supervisor-handshake state file so a freshly-spawned
   * Remediator (post-restart, post-crash, cross-process) can read the
   * supervisor's protocol version + build id without an in-process
   * handle. Best-effort; failure is logged and ignored — the
   * Remediator's A15 fallback then trips, which is the correct fail-safe
   * shape.
   */
  private writeSupervisorHandshakeFile(): void {
    if (!this.stateDir) return;
    try {
      const stateSubdir = path.join(this.stateDir, 'state');
      fs.mkdirSync(stateSubdir, { recursive: true });
      const filePath = path.join(stateSubdir, 'supervisor-handshake.json');
      const body = {
        version: ServerSupervisor.HANDSHAKE_PROTOCOL_VERSION,
        supervisorBuildId: this.supervisorBuildId,
        writtenAt: new Date().toISOString(),
      };
      fs.writeFileSync(filePath, JSON.stringify(body, null, 2));
    } catch (err) {
      console.error(`[Supervisor] Failed to write supervisor-handshake.json: ${(err as Error).message}`);
    }
  }

  /** Test helper — surface pending-request count for assertions. */
  getPendingRemediatorRequestCount(): number {
    return this.pendingRemediatorRequests.size;
  }

  /** Test helper — simulate a healthy tick driving completion notifications. */
  triggerHealthyTickForTests(): void {
    this.notifyPendingRemediatorRequestsOnHealthy();
  }

  // ── Unhealthy handling ──────────────────────────────────────────

  /**
   * Decide what to do about a server that has failed `>= unhealthyThreshold`
   * consecutive health checks. Shared by the health-check loop's two failure
   * paths (unhealthy /health response, and a thrown check).
   *
   *   - Process dead → restart immediately.
   *   - Process alive but unresponsive, below the (load-lenient) threshold →
   *     keep waiting.
   *   - Process alive, threshold reached, but the box is CPU-starved → DEFER the
   *     restart (restarting a starved server only drops the in-flight message
   *     and loops) until starvation eases or the hard cap forces it.
   *   - Process alive, threshold reached, not starved → restart.
   */
  private evaluateUnhealthyServer(): void {
    if (!this.isServerSessionAlive()) {
      // Process is genuinely gone — restart immediately.
      this.handleUnhealthy();
      return;
    }

    // Server process exists but isn't responding to health checks. Under high
    // CPU load (or during wake transitions), this is normal — the event loop is
    // stalled, not the process dead. Use a much higher threshold to avoid
    // killing a server that would recover on its own.
    const inWakeTransition = Date.now() < this.wakeTransitionUntil;
    const effectiveThreshold = inWakeTransition
      ? this.unhealthyThreshold  // During wake transition: already lenient via counter reset
      : this.processAliveThreshold;

    if (this.consecutiveFailures < effectiveThreshold) {
      if (this.consecutiveFailures === this.unhealthyThreshold) {
        console.log(`[Supervisor] Health check failed but server process is alive — waiting for ${effectiveThreshold} consecutive failures before restart (${this.consecutiveFailures}/${effectiveThreshold})`);
      }
    } else if (this.deferRestartForCpuStarvation()) {
      // Box is CPU-starved — bouncing the server won't help, it only drops the
      // in-flight message. Defer; the next healthy tick resets the counter.
      if (this.consecutiveFailures === effectiveThreshold) {
        console.log(`[Supervisor] Server alive but unresponsive (${this.consecutiveFailures} checks) AND the box is CPU-starved (load ratio ${this.loadRatioProvider().toFixed(2)} > ${this.maxLoadRatio}) — DEFERRING restart; restarting a starved server only drops in-flight messages. Will force-restart at ${this.starvationRestartThreshold} checks (~${this.starvationRestartThreshold * 10}s) if it persists.`);
      }
    } else {
      console.log(`[Supervisor] Server process alive but unresponsive for ${this.consecutiveFailures} checks (~${this.consecutiveFailures * 10}s) — restarting`);
      this.handleUnhealthy();
    }

    if (inWakeTransition) {
      this.consecutiveFailures = 0; // Reset during wake transition as before
    }
  }

  /**
   * True when we should hold off restarting an alive-but-unresponsive server
   * because the machine is CPU-starved — but only up to the hard cap. Past the
   * cap we restart regardless (the server may be genuinely hung, not starved).
   */
  private deferRestartForCpuStarvation(): boolean {
    if (this.consecutiveFailures >= this.starvationRestartThreshold) return false; // hard cap — restart even if starved
    return this.loadRatioProvider() > this.maxLoadRatio;
  }

  private handleUnhealthy(): void {
    // Circuit breaker — periodic retry instead of permanent death
    if (this.circuitBroken) {
      // Phase 1: Fast retries (every 30 min, 3x)
      if (this.circuitBreakerRetryCount < this.maxCircuitBreakerRetries) {
        const elapsed = Date.now() - this.circuitBreakerTrippedAt;
        const nextRetryAt = this.circuitBreakerRetryIntervalMs * (this.circuitBreakerRetryCount + 1);

        if (elapsed >= nextRetryAt) {
          this.circuitBreakerRetryCount++;
          console.log(`[Supervisor] Circuit breaker retry ${this.circuitBreakerRetryCount}/${this.maxCircuitBreakerRetries}`);
          this.emit('serverRestarting', this.circuitBreakerRetryCount);

          // Kill existing session if alive
          if (this.tmuxPath && this.isServerSessionAlive()) {
            this.captureCrashOutput();
            this.cleanupChildProcesses();
            try {
              execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
                stdio: 'ignore',
              });
            } catch { /* ignore */ }
          }

          this.spawnServer();
        }
        return;
      }

      // Phase 2: Slow retry — never truly give up. Transient issues (Node version change,
      // disk full, port conflict) often resolve themselves. Try every 2 hours forever.
      //
      // ETERNAL SENTINEL (declared per "No Unbounded Loops" / P19): this loop is the
      // healer of last resort for the server — the sanctioned never-give-up class.
      // Its brakes: rate floor (one attempt per slowRetryIntervalMs, constant cost),
      // and condition-4 observability below — after escalateAfterMs of sustained
      // failure it tells the operator ONCE per episode, then keeps quietly trying.
      if (this.slowRetryStartedAt === 0) {
        this.slowRetryStartedAt = Date.now();
        console.log(`[Supervisor] Circuit breaker fast retries exhausted. Entering slow-retry mode (every ${this.slowRetryIntervalMs / 3600_000}h). Use /lifeline reset for immediate retry.`);
      }

      // Condition 4 — never-give-up must not mean never-tell-anyone. One
      // escalation per episode after the sustained-failure threshold; the
      // latch lives in SlowRetrySentinelEscalation, keyed on this episode.
      if (this.sentinelEscalation.shouldEscalate(this.slowRetryStartedAt)) {
        const hoursStalled = Math.round((Date.now() - this.slowRetryStartedAt) / 3600_000);
        console.log(`[Supervisor] Slow-retry sentinel stalled ${hoursStalled}h without recovery — escalating once (retries continue)`);
        this.emit('sentinelStalled', { hoursStalled, retryIntervalHours: this.slowRetryIntervalMs / 3600_000 });
      }

      const slowElapsed = Date.now() - (this.slowRetryStartedAt + this.slowRetryIntervalMs * Math.floor((Date.now() - this.slowRetryStartedAt) / this.slowRetryIntervalMs));
      if (slowElapsed < 60_000) { // Within 60s of a 2-hour boundary (wider window to avoid missed retries)
        console.log(`[Supervisor] Slow retry attempt (${Math.round((Date.now() - this.slowRetryStartedAt) / 3600_000)}h since circuit breaker exhaustion)`);

        // Kill existing session if alive
        if (this.tmuxPath && this.isServerSessionAlive()) {
          this.captureCrashOutput();
          this.cleanupChildProcesses();
          try {
            execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
              stdio: 'ignore',
            });
          } catch { /* ignore */ }
        }

        this.spawnServer();
      }
      return;
    }

    // Check for legacy planned restart flag (backward compatibility with old AutoUpdater)
    if (this.isLegacyPlannedRestart()) {
      if (!this.isServerSessionAlive()) {
        console.log('[Supervisor] Legacy planned restart detected — server session dead. Respawning.');
        this.clearLegacyRestartFlag();
        this.consecutiveFailures = 0;
        this.spawnServer();
        return;
      }
      console.log('[Supervisor] Health check failed but legacy update-restart flag is active — suppressing alert');
      this.consecutiveFailures = 0;
      this.spawnedAt = Date.now();
      return;
    }

    // Check for planned restart (new AutoUpdater with plannedRestart: true, or
    // ForegroundRestartWatcher exit marker). Suppress serverDown during the
    // maintenance wait window — this is expected downtime, not a crash.
    if (this.isPendingPlannedRestart()) {
      if (!this.isServerSessionAlive()) {
        console.log('[Supervisor] Planned restart in progress — server session dead. Respawning.');
        this.consecutiveFailures = 0;
        this.spawnServer();
        return;
      }
      console.log('[Supervisor] Health check failed during planned restart — suppressing alert');
      this.consecutiveFailures = 0;
      return;
    }

    if (this.isRunning) {
      this.isRunning = false;
      this.emit('serverDown', 'Health check failed');
    }
    this.consecutiveFailures = 0; // Reset after triggering action

    // Bind-failure tracking — if the server never reached a healthy /health
    // tick during this spawn cycle (lastHealthy is older than spawnedAt),
    // the spawn produced a process that crashed before binding. After 2+ in
    // a row, preflightSelfHeal will force an aggressive better-sqlite3
    // rebuild on the next attempt.
    if (this.spawnedAt > 0 && this.lastHealthy < this.spawnedAt) {
      this.consecutiveBindFailures++;
      if (this.consecutiveBindFailures >= this.bindFailureEscalationThreshold) {
        console.log(`[Supervisor] Bind-failure escalation armed: ${this.consecutiveBindFailures} consecutive spawns failed before binding. Next preflight will force-rebuild native modules.`);
      }
    }

    // After max retries exhausted, wait for cooldown before trying again.
    // IMPORTANT: Check cooldown BEFORE incrementing totalFailures. Otherwise, passive health check
    // failures during cooldown accumulate and trip the circuit breaker, escalating a recoverable
    // 5-min cooldown into a 30-min circuit breaker stall. Only actual restart failures should
    // count toward the circuit breaker threshold.
    if (this.restartAttempts >= this.maxRestartAttempts) {
      if (this.maxRetriesExhaustedAt === 0) {
        this.maxRetriesExhaustedAt = Date.now();
        console.error(`[Supervisor] Max restart attempts (${this.maxRestartAttempts}) reached. Cooling down for ${this.retryCooldownMs / 1000}s before retrying.`);
      }

      if ((Date.now() - this.maxRetriesExhaustedAt) >= this.retryCooldownMs) {
        console.log(`[Supervisor] Cooldown elapsed. Resetting restart counter.`);
        this.restartAttempts = 0;
        this.maxRetriesExhaustedAt = 0;
      } else {
        return; // Still cooling down — skip totalFailures increment
      }
    }

    // Track total failures for circuit breaker (only incremented for active failure handling, not passive cooldown)
    const now = Date.now();
    if (this.totalFailureWindowStart === 0 || (now - this.totalFailureWindowStart) > this.circuitBreakerWindowMs) {
      // Reset window
      this.totalFailureWindowStart = now;
      this.totalFailures = 0;
    }
    this.totalFailures++;

    // Circuit breaker: too many total failures in the window → trip (but with periodic retry)
    if (this.totalFailures >= this.circuitBreakerThreshold) {
      this.circuitBroken = true;
      this.circuitBreakerTrippedAt = Date.now();
      this.circuitBreakerRetryCount = 0;
      console.error(`[Supervisor] CIRCUIT BREAKER: ${this.totalFailures} failures in ${Math.round(this.circuitBreakerWindowMs / 60000)}m window. Will retry every ${this.circuitBreakerRetryIntervalMs / 60000}m (${this.maxCircuitBreakerRetries}x).`);
      console.error(`[Supervisor] Last crash output:\n${this.lastCrashOutput}`);
      this.emit('circuitBroken', this.totalFailures, this.lastCrashOutput);
      return;
    }

    // Auto-restart with backoff
    this.restartAttempts++;
    const delay = this.restartBackoffMs * Math.pow(2, this.restartAttempts - 1);
    console.log(`[Supervisor] Server unhealthy. Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} in ${delay}ms`);
    this.emit('serverRestarting', this.restartAttempts);

    setTimeout(() => {
      // Capture crash output BEFORE killing the tmux session
      if (this.tmuxPath && this.isServerSessionAlive()) {
        this.captureCrashOutput();
        this.cleanupChildProcesses();
        try {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        } catch { /* ignore */ }
      }

      this.spawnServer();
    }, delay);
  }

  // ── Crash diagnostics ──────────────────────────────────────────

  /**
   * Capture crash output from multiple sources:
   * 1. tmux pane capture (last 50 lines of terminal output)
   * 2. stderr crash log file (tee'd from server process)
   */
  // RULE 3: EXEMPT — this `tmux capture-pane` is a forensic best-effort
  // read of the dead server's terminal scrollback, NOT a state-detector
  // that gates behavior. The result is logged for human triage only; no
  // restart / heal / authority decision branches on its content. It also
  // pre-exists this PR (lifeline-version-skew-recovery) — modifying it
  // is out of scope. See specs/provider-portability/05-state-detection-robustness.md.
  private captureCrashOutput(): void {
    // Try tmux pane capture first
    if (this.tmuxPath) {
      try {
        const output = execFileSync(this.tmuxPath, [
          'capture-pane', '-t', `=${this.serverSessionName}:`, '-p', '-S', '-50',
        ], { encoding: 'utf-8', timeout: 5000 });
        if (output.trim()) {
          this.lastCrashOutput = output.trim();
          console.log(`[Supervisor] Crash output from tmux:\n${this.lastCrashOutput.slice(-500)}`);
          return;
        }
      } catch { // @silent-fallback-ok — capture may fail if session already dead
      }
    }

    // Fallback: read the stderr crash log
    if (this.stateDir) {
      const crashLogPath = path.join(this.stateDir, 'logs', 'server-stderr.log');
      try {
        if (fs.existsSync(crashLogPath)) {
          const content = fs.readFileSync(crashLogPath, 'utf-8');
          const last500 = content.slice(-500).trim();
          if (last500) {
            this.lastCrashOutput = last500;
            console.log(`[Supervisor] Crash output from stderr log:\n${last500}`);
          }
        }
      } catch { /* ignore */ }
    }
  }

  /**
   * Kill child processes (cloudflared, etc.) that were spawned by the server
   * but will become orphans when the tmux session is killed.
   */
  private cleanupChildProcesses(): void {
    if (!this.tmuxPath) return;
    try {
      const panePid = execFileSync(this.tmuxPath, [
        'list-panes', '-t', `=${this.serverSessionName}`, '-F', '#{pane_pid}',
      ], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];

      if (!panePid) return;

      const descendants = shellExec(
        `pgrep -P ${panePid} 2>/dev/null; pgrep -g ${panePid} 2>/dev/null`,
      ).trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));

      const unique = [...new Set(descendants)].filter(pid => pid !== parseInt(panePid));

      if (unique.length > 0) {
        console.log(`[Supervisor] Cleaning up ${unique.length} child process(es) before restart: ${unique.join(', ')}`);
        for (const pid of unique) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        }
        setTimeout(() => {
          for (const pid of unique) {
            try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* dead */ }
          }
        }, 3000);
      }
    } catch { // @silent-fallback-ok — cleanup is best-effort
    }
  }

  // ── Legacy flag handling (backward compatibility) ──────────────

  /**
   * Check for the legacy update-restart.json flag (written by old AutoUpdater versions).
   * New versions write restart-requested.json instead, handled by checkRestartRequest().
   */
  private isLegacyPlannedRestart(): boolean {
    if (!this.stateDir) return false;
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    try {
      if (!fs.existsSync(flagPath)) return false;
      const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
      if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
        try { SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:1217' }); } catch { /* ignore */ }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private clearLegacyRestartFlag(): void {
    if (!this.stateDir) return;
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    try {
      if (fs.existsSync(flagPath)) {
        SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'src/lifeline/ServerSupervisor.ts:1232' });
        console.log('[Supervisor] Cleared legacy update-restart flag');
      }
    } catch { /* ignore */ }
  }

  // ── Planned restart detection ──────────────────────────────

  /**
   * Check if a planned restart is in progress.
   *
   * Two sources of truth (covers both race scenarios):
   * 1. Internal state: set by checkRestartRequest() when it sees plannedRestart: true
   * 2. Planned-exit marker: written by ForegroundRestartWatcher before process.exit()
   *    when it consumed the restart-requested.json before us
   *
   * Auto-expires after maintenanceWaitMs (default 5 min). If the server doesn't
   * come back within the window, fall back to normal alerting.
   */
  private isPendingPlannedRestart(): boolean {
    // Source 1: Internal state (supervisor saw the flag directly)
    if (this.maintenanceWaitStartedAt > 0) {
      const elapsed = Date.now() - this.maintenanceWaitStartedAt;
      if (elapsed > this.maintenanceWaitMs) {
        console.warn(`[Supervisor] Maintenance wait expired after ${Math.round(elapsed / 1000)}s — falling back to normal alerting`);
        this.maintenanceWaitStartedAt = 0;
        return false;
      }
      return true;
    }

    // Source 2: Planned-exit marker (ForegroundRestartWatcher consumed the flag first)
    if (!this.stateDir) return false;
    const markerPath = path.join(this.stateDir, 'state', 'planned-exit-marker.json');
    try {
      if (!fs.existsSync(markerPath)) return false;
      const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));

      // TTL check: marker expires after 10 minutes. If the server hasn't recovered
      // by then, the marker is stale and should not keep suppressing alerts or
      // triggering maintenance-mode respawns indefinitely.
      const markerAge = Date.now() - (new Date(data.exitedAt).getTime() || Date.now());
      const markerTtlMs = 10 * 60_000; // 10 minutes
      if (markerAge > markerTtlMs) {
        console.warn(`[Supervisor] Planned-exit marker expired (${Math.round(markerAge / 60_000)}m old) — clearing and falling back to normal alerting`);
        try { SafeFsExecutor.safeUnlinkSync(markerPath, { operation: 'src/lifeline/ServerSupervisor.ts:1278' }); } catch { /* ignore */ }
        return false;
      }

      // Marker exists and is fresh — enter maintenance wait mode
      console.log(`[Supervisor] Found planned-exit marker (target: v${data.targetVersion}) — entering maintenance wait`);
      this.maintenanceWaitStartedAt = new Date(data.exitedAt).getTime() || Date.now();
      this.pendingUpdateVersion = data.targetVersion ?? null;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up the planned-exit marker written by ForegroundRestartWatcher.
   */
  private clearPlannedExitMarker(): void {
    if (!this.stateDir) return;
    const markerPath = path.join(this.stateDir, 'state', 'planned-exit-marker.json');
    try {
      if (fs.existsSync(markerPath)) {
        SafeFsExecutor.safeUnlinkSync(markerPath, { operation: 'src/lifeline/ServerSupervisor.ts:1301' });
      }
    } catch { /* ignore */ }
  }
}

/**
 * Information about a discovered better-sqlite3 install copy.
 */
export interface BetterSqlite3Copy {
  /** Absolute path to the package directory (contains package.json). */
  packageDir: string;
  /** Absolute path to the compiled .node binary. */
  binaryPath: string;
  /** Absolute path to use as `--prefix` when invoking npm rebuild. */
  prefixDir: string;
}

/**
 * Scan a node_modules tree for every copy of better-sqlite3 that has a
 * compiled binary. Bounded depth (5) and bounded count (5) to guarantee
 * termination on pathological trees.
 *
 * Why this exists: npm does not always hoist `better-sqlite3` to the top of
 * `shadow-install/node_modules/`. A common shape is the package nested under
 * `instar/node_modules/better-sqlite3/...`. The previous preflight only
 * checked the hoisted path and silently missed the nested copy that was
 * actually being loaded — root cause of the Inspec 2026-04-29 silent
 * crash-loop.
 *
 * Exported for testing.
 */
export function findBetterSqlite3Copies(nodeModulesRoot: string): BetterSqlite3Copy[] {
  const found: BetterSqlite3Copy[] = [];
  const MAX_DEPTH = 5;
  const MAX_COPIES = 5;

  if (!fs.existsSync(nodeModulesRoot)) return found;

  let capHit = false;
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (found.length >= MAX_COPIES) {
      capHit = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_COPIES) return;
      if (!entry.isDirectory()) continue;
      const childPath = path.join(dir, entry.name);
      if (entry.name === 'better-sqlite3') {
        const binaryPath = path.join(childPath, 'build', 'Release', 'better_sqlite3.node');
        if (fs.existsSync(binaryPath)) {
          // The prefix for `npm rebuild` is the parent of the package's
          // node_modules dir — i.e., the package whose deps contain the copy.
          // For a top-level copy (`shadow-install/node_modules/better-sqlite3`),
          // prefix = shadow-install. For a nested copy
          // (`shadow-install/node_modules/instar/node_modules/better-sqlite3`),
          // prefix = shadow-install/node_modules/instar.
          const prefixDir = path.dirname(path.dirname(childPath));
          found.push({ packageDir: childPath, binaryPath, prefixDir });
        }
        // Don't descend into better-sqlite3's own node_modules; deps of
        // better-sqlite3 itself are not better-sqlite3.
        continue;
      }
      // Descend into nested node_modules trees only.
      const nestedNodeModules = path.join(childPath, 'node_modules');
      if (fs.existsSync(nestedNodeModules)) {
        visit(nestedNodeModules, depth + 1);
      }
    }
  };

  visit(nodeModulesRoot, 0);
  if (capHit) {
    console.warn(`[Supervisor] findBetterSqlite3Copies: hit MAX_COPIES=${MAX_COPIES} cap under ${nodeModulesRoot} — additional copies will not be checked. If this is a real install layout (not pathological), raise the cap.`);
  }
  return found;
}

// ── F-6 handshake helpers ───────────────────────────────────────────

/**
 * Canonical, deterministic serialization of a restart-requested payload
 * EXCLUDING the `hmac` field, used as the HMAC input on both sides of
 * the handshake. Field order is fixed and lengths are length-prefixed
 * so a malicious crafter cannot shift bytes across field boundaries.
 *
 * Format (network byte order, big-endian):
 *   "instar-f6-restart-v1\0"          // 21-byte version tag
 *   uint32 version                    // 4 bytes — handshakeVersion
 *   uint8  blastRadiusTag             // 1 = process, 2 = machine, 3 = fleet
 *   uint64 requestedAt (BE)           // wall-clock ms
 *   uint64 monotonicTs (BE)           // hrtime ns
 *   uint32 requestIdLen + requestId   // utf-8
 *   uint32 runbookIdLen + runbookId   // utf-8
 *   uint32 attemptIdLen + attemptId   // utf-8
 *
 * The tag byte for `blastRadius` ensures unknown future values cannot
 * be silently re-cast to a known value at canonicalization time.
 */
export function canonicalRestartRequestedBody(payload: RestartRequestedPayload): Buffer {
  const tag = Buffer.from('instar-f6-restart-v1\x00', 'utf-8');

  const versionBuf = Buffer.alloc(4);
  versionBuf.writeUInt32BE(payload.handshakeVersion >>> 0, 0);

  let blastTag = 0;
  if (payload.blastRadius === 'process') blastTag = 1;
  else if (payload.blastRadius === 'machine') blastTag = 2;
  else if (payload.blastRadius === 'fleet') blastTag = 3;
  // Unknown values become 0 → HMAC mismatch on legitimate side, which is
  // the intended fail-closed shape.
  const blastBuf = Buffer.from([blastTag]);

  const requestedAtBuf = Buffer.alloc(8);
  requestedAtBuf.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(payload.requestedAt))), 0);

  const monoBuf = Buffer.alloc(8);
  // monotonicTs is `bigint`; clamp non-negative for unsigned write.
  const mono = payload.monotonicTs >= 0n ? payload.monotonicTs : 0n;
  monoBuf.writeBigUInt64BE(mono, 0);

  const writeStr = (s: string): Buffer => {
    const body = Buffer.from(s, 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  };

  return Buffer.concat([
    tag,
    versionBuf,
    blastBuf,
    requestedAtBuf,
    monoBuf,
    writeStr(payload.requestId),
    writeStr(payload.runbookId),
    writeStr(payload.attemptId),
  ]);
}
