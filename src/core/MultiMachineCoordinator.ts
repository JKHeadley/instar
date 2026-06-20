/**
 * Multi-machine coordinator — orchestrates distributed agent lifecycle.
 *
 * Brings together HeartbeatManager, MachineIdentityManager, SecurityLog,
 * and NonceStore into a single coordinator that the server lifecycle uses.
 *
 * Responsibilities:
 * - Determine this machine's role on startup (awake/standby)
 * - Periodic heartbeat writes (awake) / monitoring (standby)
 * - Auto-failover when the awake machine goes silent
 * - StateManager read-only enforcement on standby
 * - Graceful shutdown handoff attempt
 *
 * Part of Phase 5 (distributed coordination).
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { MachineIdentityManager } from './MachineIdentity.js';
import { HeartbeatManager } from './HeartbeatManager.js';
import { SecurityLog } from './SecurityLog.js';
import { NonceStore } from './NonceStore.js';
import type { StateManager } from './StateManager.js';
import type { LeaseCoordinator } from './LeaseCoordinator.js';
import { SEAMLESSNESS_PROTOCOL_VERSION } from './seamlessnessConfig.js';
import { FailureEpisodeLatch } from './FailureEpisodeLatch.js';
import { ChurnBreaker } from './churnBreaker.js';
import { writePollIntent } from './pollIntent.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import type { MachineRole, MachineIdentity, MultiMachineConfig, CoordinationMode } from './types.js';

/** Observability shape for /health.multiMachine.syncStatus (spec §11). */
export interface MultiMachineSyncStatus {
  enabled: boolean;
  role: MachineRole;
  leaseHolder: string | null;
  leaseEpoch: number;
  holdsLease: boolean;
  /** 'clear' | 'contested' (more than one awake machine in the registry) | 'self-suspended'. */
  splitBrainState: 'clear' | 'contested' | 'self-suspended';
  protocolVersion: number;
  awakeMachineCount: number;
  /**
   * multi-machine-lease-self-heal observability (Agent Awareness). F1 tick-watchdog
   * health — answers "did the watchdog fire?" / "is it disarmed?". `lastTickAgeMs`
   * is the monotonic age of the last main-tick run (a large value = the tick has
   * stalled). `preferredAwakeMachineId` echoes the F4 config (null = off).
   */
  leaseTickWatchdog?: { lastTickAgeMs: number; reArmCount: number; disarmed: boolean };
  preferredAwakeMachineId?: string | null;
  /**
   * multi-transport-mesh-comms — the KINDS of mesh endpoint THIS machine currently
   * advertises (e.g. ['tailscale','lan','cloudflare']). Kind-only by design: the
   * raw private IPs appear ONLY on the Bearer-authed /health detail, never the
   * unauthenticated basic check (Decision 15). Empty/absent ⇒ mesh transport off
   * or no ropes advertised yet.
   */
  meshEndpoints?: string[];
}

// ── Constants ────────────────────────────────────────────────────────

const HEARTBEAT_WRITE_INTERVAL_MS = 2 * 60_000; // Write heartbeat every 2 min
const HEARTBEAT_CHECK_INTERVAL_MS = 2 * 60_000;  // Check heartbeat every 2 min
const TICK_WATCHDOG_INTERVAL_MS = 60_000;  // F1b — independent tick-stall watchdog cadence
const DEFAULT_FAILOVER_TIMEOUT_MS = 15 * 60_000;  // 15 min before failover
/** Cross-Machine Coherence — default active lease-PULL cadence over the tunnel. */
const DEFAULT_LEASE_PULL_INTERVAL_MS = 5_000;
/**
 * B3 (multimachine-lease-poll-robustness) — the dedicated renew timer fires at
 * `clamp(leaseTtlMs × RENEW_SAFETY_FACTOR, [MIN, MAX])` so a holder renews (same
 * epoch) BEFORE its lease lapses, instead of re-acquiring at epoch+1 on the slow
 * heartbeat tick. Default TTL 60s → 30s renew cadence (well under TTL).
 */
const RENEW_SAFETY_FACTOR = 0.5;
const MIN_RENEW_INTERVAL_MS = 5_000;
const MAX_RENEW_INTERVAL_MS = 60_000;

// ── Types ────────────────────────────────────────────────────────────

export interface CoordinatorConfig {
  /** State directory (.instar) */
  stateDir: string;
  /** Multi-machine config from config.json */
  multiMachine?: MultiMachineConfig;
  /**
   * developmentAgent dark-feature gate (B3 — multimachine-lease-poll-robustness).
   * When a leaseSelfHeal sub-feature OMITS its `enabled` flag, the coordinator
   * resolves it `enabled ?? !!developmentAgent` (live on a dev agent, dark on the
   * fleet). Threaded from the server's top-level `config.developmentAgent`.
   */
  developmentAgent?: boolean;
}

export interface CoordinatorEvents {
  /** Emitted when this machine should promote to awake */
  promote: () => void;
  /** Emitted when this machine should demote to standby */
  demote: () => void;
  /** Emitted when auto-failover triggers */
  failover: (reason: string) => void;
  /** Emitted on role change */
  roleChange: (from: MachineRole, to: MachineRole) => void;
}

// ── Coordinator ──────────────────────────────────────────────────────

export class MultiMachineCoordinator extends EventEmitter {
  private identityManager: MachineIdentityManager;
  private heartbeatManager: HeartbeatManager;
  private securityLog: SecurityLog;
  private nonceStore: NonceStore;
  private state: StateManager;
  private config: CoordinatorConfig;
  private _role: MachineRole = 'standby';
  private _identity: MachineIdentity | null = null;
  private _enabled: boolean = false;
  private heartbeatWriteTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Heartbeat-write failure episode accounting ("No Unbounded Loops" / P19,
   * Eternal Sentinel condition 4). writeHeartbeat() throws raw fs errors
   * (ENOSPC, EACCES) — pre-fix, a throw inside the 2-min timer tick escaped as
   * an uncaughtException and CRASHED the awake holder (the worst possible cost
   * for one failed attempt), while a hypothetical swallowed failure would have
   * gone silent until a peer force-failed-over. Now: each tick's write is
   * guarded, the first failure of an episode logs once, a sustained episode
   * raises ONE degradation signal (before the peer failover horizon), recovery
   * logs once and re-arms. The write keeps being attempted every tick forever
   * — this writer is the awake machine's liveness voice; persistence is the
   * point.
   */
  private readonly hbWriteEpisode = new FailureEpisodeLatch({ signalAfterMs: 6 * 60_000 });
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * B3 (multimachine-lease-poll-robustness) — dedicated renew timer (TTL/2),
   * decoupled from the slow heartbeat-check timer so a held lease never lapses
   * between renewals. Null unless resilientRenew resolves on (dev-gate) AND a
   * leaseCoordinator is attached.
   */
  private leaseRenewTimer: ReturnType<typeof setInterval> | null = null;
  private leaseRenewing: boolean = false;
  private leaseRenewStartLogged: boolean = false;
  /**
   * B2 (multimachine-lease-poll-robustness, Decision 8) — the lease flap
   * circuit-breaker. Lazily built when the churnDetector gate resolves on.
   */
  private churnBreaker: ChurnBreaker | null = null;
  /**
   * B1 (multimachine-lease-poll-robustness, Decision 5) — a per-PROCESS boot id
   * stamped into the poll-intent file so the lifeline can tell a current intent
   * from one left by a prior incarnation of this server.
   */
  private readonly bootId = `${process.pid}-${process.hrtime.bigint().toString(36)}`;
  /** Integrated-Being v1 — tracks whether we've already emitted the
   *  per-machine-ledger warning this boot. Spec §Multi-machine. */
  private integratedBeingWarningEmitted: boolean = false;
  /**
   * Cross-Machine Seamlessness §6 — the fenced lease is the authority for
   * "awake". When attached, holdsLease() gates the hot path (the structural
   * demotion the Phase-0 split-brain was missing). Null on single-machine /
   * non-git meshes, where the heartbeat path remains the authority.
   */
  private leaseCoordinator: LeaseCoordinator | null = null;
  private leaseTicking: boolean = false;
  /**
   * Cross-Machine Coherence — the active lease-PULL loop. A self-rearming
   * (jittered) timer that asks each peer for its current lease at a constant
   * cadence, independent of holder liveness. `leasePullContested` latches a
   * pull-discovered same-epoch split-brain for the Near-Silent surface
   * (getSyncStatus → dashboard) that the registry awakeMachineCount misses in a
   * git-less mesh where each machine only sees itself as awake.
   */
  private leasePullTimer: ReturnType<typeof setTimeout> | null = null;
  private leasePulling: boolean = false;
  private leasePullContested: boolean = false;
  private leasePullStopped: boolean = false;
  /**
   * Cross-Machine Coherence §Problem A — the active CONTESTED-RESOLUTION state.
   * When a same-epoch contested split-brain is detected (a git-less LocalLeaseStore
   * leapfrog), a deterministic tie-break (lower machineId wins) drives a ONE-SHOT
   * resolution per episode: the loser relinquishes, the winner advances once to
   * N+1. `key` is the unordered {machineIdA, machineIdB} pair (epoch-independent,
   * so it SURVIVES the leapfrog where the epoch changes each tick); `resolved`
   * latches the one-shot (no per-tick re-relinquish/re-advance churn); `cycles`
   * counts pull ticks the episode persisted; `escalated` dedupes the bounded
   * K-cycle escalation. Cleared on the falling edge (contested resolved).
   */
  private contestedEpisode: { key: string; cycles: number; resolved: boolean; escalated: boolean } | null = null;

  /**
   * multi-machine-lease-self-heal F1 — the tick self-heal watchdog state.
   * `lastTickRunMonoMs` is stamped on the OBSERVER's own monotonic clock at the
   * TOP of checkHeartbeatAndAct (before any early-return, so a solo agent stamps
   * a healthy advancing value and the watchdog stays a no-op). `*StartMonoMs`
   * stamp when a reentrancy guard is taken, so the watchdog can distinguish a
   * legitimately-slow in-flight tick (leave alone) from a stuck guard (reset).
   * `watchdogReArmTimes` is a rolling window of re-arm timestamps for self-disarm.
   */
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickRunMonoMs: number = 0;
  private leaseTickStartMonoMs: number = 0;
  private leasePullStartMonoMs: number = 0;
  private watchdogReArmTimes: number[] = [];
  private watchdogDisarmed: boolean = false;
  /** F3 — per-incarnation latch so a silent standby relinquishes its held lease once. */
  private silentStandbyRelinquished: boolean = false;

  constructor(state: StateManager, config: CoordinatorConfig) {
    super();
    this.state = state;
    this.config = config;
    this.identityManager = new MachineIdentityManager(config.stateDir);
    this.securityLog = new SecurityLog(config.stateDir);
    this.nonceStore = new NonceStore(path.join(config.stateDir, 'state'));

    // HeartbeatManager gets created once we know our machine ID
    this.heartbeatManager = null as any; // Initialized in start()
  }

  // ── Getters ──────────────────────────────────────────────────────

  /** Whether multi-machine is enabled (has identity). */
  get enabled(): boolean { return this._enabled; }

  /** This machine's current role. */
  get role(): MachineRole { return this._role; }

  /** This machine's identity (null if not initialized). */
  get identity(): MachineIdentity | null { return this._identity; }

  /** Whether this machine is the awake (primary) machine. */
  get isAwake(): boolean { return this._role === 'awake'; }

  /**
   * A SILENT standby (telegramPolling:false — the operator explicitly muted this
   * machine so it never owns the Telegram poll) is LEASE-OBSERVE-ONLY: it never
   * acquires/renews its own lease, it only observes the primary's broadcast and
   * resolves leaseHolder to the primary. Rationale: the git-less LocalLeaseStore
   * has no shared compare-and-swap, so a standby that acquires its own lease at
   * boot (before it has observed the primary's broadcast) leapfrogs epochs with
   * the primary and never adopts it as holder — leaving the standby unable to
   * authenticate the primary's router-only MeshRpc commands (the 2026-05-31
   * cross-machine-transfer split-brain). A muted standby auto-grabbing the awake
   * role would also be incoherent (awake yet not serving Telegram). Failover for
   * such a machine is a deliberate un-mute (telegramPolling → true), not auto.
   */
  get isLeaseObserveOnly(): boolean {
    return this.resolvedLeaseRole() === 'observe-only';
  }

  /**
   * multi-machine-lease-self-heal M3 — the first-class lease-participation mode,
   * decoupled from the overloaded `telegramPolling` flag. Explicit
   * `leaseSelfHeal.leaseRole` wins; otherwise derive from `telegramPolling`
   * (===false ⇒ 'observe-only', else 'active') for back-compat. ('deferential'
   * is an F4 concept handled separately; only 'observe-only' gates acquisition
   * here so F4's down-preferred failover is never accidentally suppressed.)
   */
  private resolvedLeaseRole(): 'active' | 'observe-only' | 'deferential' {
    const explicit = this.config.multiMachine?.leaseSelfHeal?.leaseRole;
    if (explicit === 'active' || explicit === 'observe-only' || explicit === 'deferential') return explicit;
    return this.config.multiMachine?.telegramPolling === false ? 'observe-only' : 'active';
  }

  /**
   * F4 (preferred-awake, opt-in; null = off) — should THIS machine defer (not
   * contend for the lease) right now? True iff a `preferredAwakeMachineId` is
   * configured, it names a DIFFERENT machine (we are NOT the preferred), and that
   * preferred machine is currently a HEALTHY holder. A machine that IS the
   * preferred never defers; a non-preferred machine defers only while the preferred
   * is healthy, so the preferred going down never strands coverage. Safe under any
   * config (no tie-break override, so a divergent config degrades to the existing
   * lower-machineId baseline rather than flapping).
   */
  private shouldDeferToPreferred(): boolean {
    const pref = this.config.multiMachine?.leaseSelfHeal?.preferredAwakeMachineId;
    if (!pref || !this._identity || !this.leaseCoordinator) return false; // F4 off / no identity
    if (pref === this._identity.machineId) return false;                   // WE are preferred → never defer
    return this.preferredIsHealthy(pref);
  }

  /** F4 — the single shared health predicate: is the preferred machine a live holder? */
  private preferredIsHealthy(machineId: string): boolean {
    return this.leaseCoordinator?.isHolderHealthy(machineId) ?? false;
  }

  /** The coordination mode (default: 'primary-standby'). */
  get coordinationMode(): CoordinationMode {
    return this.config.multiMachine?.coordinationMode ?? 'primary-standby';
  }

  /** The underlying managers (for route wiring). */
  get managers() {
    return {
      identityManager: this.identityManager,
      heartbeatManager: this.heartbeatManager,
      securityLog: this.securityLog,
      nonceStore: this.nonceStore,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Initialize and start the coordinator.
   * Returns the determined role for this machine.
   */
  start(): MachineRole {
    // Check if multi-machine is set up
    if (!this.identityManager.hasIdentity()) {
      this._enabled = false;
      this._role = 'awake'; // Single machine = always awake
      return this._role;
    }

    this._enabled = true;
    this._identity = this.identityManager.loadIdentity();

    // Self-heal: if the registry is missing our own machine, re-register it
    // before any updateRole call. Without this, a registry wiped by a sync
    // corruption, disk glitch, or manual cleanup hard-crashes the server
    // on boot because updateRole throws on unknown machineIds.
    this.identityManager.ensureSelfRegistered(this._identity, 'standby');

    // Integrated-Being v1 — per-machine ledger warning.
    // Emit exactly once per startup when the registry shows >1 machine.
    // The ledger itself is per-machine and does NOT sync cross-machine (see
    // .gitignore entry for shared-state.jsonl*).
    this.emitIntegratedBeingMultiMachineWarning();

    this.securityLog.initialize();

    // Create HeartbeatManager with our machine ID
    const timeoutMs = (this.config.multiMachine?.failoverTimeoutMinutes ?? 15) * 60_000;
    const autoFailover = this.config.multiMachine?.autoFailover ?? true;
    this.heartbeatManager = new HeartbeatManager(this.config.stateDir, this._identity.machineId, {
      enabled: autoFailover,
      timeoutMs,
    });

    const mode = this.coordinationMode;

    // ── Independent Mode (Gap 1) ─────────────────────────────────
    // Both machines are always awake. No failover, no demotion.
    // Each machine has its own Telegram group — no polling conflict.
    if (mode === 'independent') {
      this._role = 'awake';
      this.identityManager.updateRole(this._identity.machineId, 'awake');
      this.startHeartbeatWriter(); // For diagnostics, not failover
      // Do NOT start heartbeat monitor (no failover logic in independent mode)

      this.securityLog.append({
        event: 'coordinator_started',
        machineId: this._identity.machineId,
        role: this._role,
        coordinationMode: 'independent',
      });

      console.log(`[MultiMachine] Independent mode — machine ${this._identity.machineId} always awake`);
      return this._role;
    }

    // ── Primary-Standby Mode (default) ───────────────────────────
    // Determine initial role from registry
    const registry = this.identityManager.loadRegistry();
    const myEntry = registry.machines[this._identity.machineId];
    this._role = myEntry?.role ?? 'standby';

    // Check the heartbeat to validate our role
    const heartbeatCheck = this.heartbeatManager.checkHeartbeat();

    if (this._role === 'awake') {
      // We think we're awake — verify no one else took over
      if (heartbeatCheck.status === 'healthy' && heartbeatCheck.holder !== this._identity.machineId) {
        // Another machine has a valid heartbeat — demote
        console.log(`[MultiMachine] Another machine (${heartbeatCheck.holder}) has valid heartbeat — demoting to standby`);
        this._role = 'standby';
        this.identityManager.updateRole(this._identity.machineId, 'standby');
      } else {
        // We're the rightful awake machine — start heartbeat writes
        this.startHeartbeatWriter();
      }
    } else {
      // We're standby — check if we should failover
      if (heartbeatCheck.status === 'expired' || heartbeatCheck.status === 'missing') {
        const failoverResult = this.heartbeatManager.shouldFailover();
        if (failoverResult.should) {
          console.log(`[MultiMachine] Failover condition: ${failoverResult.reason}`);
          this.promoteToAwake(`Startup failover: ${failoverResult.reason}`);
        }
      }
    }

    // Set StateManager read-only for standby
    if (this._role === 'standby') {
      this.state.setReadOnly(true);
    }

    // Start the heartbeat monitor (checks periodically regardless of role)
    this.startHeartbeatMonitor();

    this.securityLog.append({
      event: 'coordinator_started',
      machineId: this._identity.machineId,
      role: this._role,
    });

    return this._role;
  }

  /**
   * Stop the coordinator. Call on server shutdown.
   */
  /**
   * Integrated-Being v1 — log a one-time warning when paired on >1 machine.
   * Spec §Multi-machine. The ledger is per-machine; cross-machine coherence
   * is out of scope for v1.
   */
  private emitIntegratedBeingMultiMachineWarning(): void {
    if (this.integratedBeingWarningEmitted) return;
    try {
      const registry = this.identityManager.loadRegistry();
      const count = Object.keys(registry.machines ?? {}).length;
      if (count > 1) {
        console.warn(
          `[integrated-being] This agent runs on ${count} machines. ` +
          `Each machine has its own ledger; cross-machine visibility is not yet implemented.`,
        );
        this.integratedBeingWarningEmitted = true;
      }
    } catch {
      // Don't fail startup on warning-emission failure.
    }
  }

  stop(): void {
    if (this.heartbeatWriteTimer) {
      clearInterval(this.heartbeatWriteTimer);
      this.heartbeatWriteTimer = null;
    }
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = null;
    }
    if (this.tickWatchdogTimer) {
      clearInterval(this.tickWatchdogTimer);
      this.tickWatchdogTimer = null;
    }
    this.leasePullStopped = true;
    if (this.leasePullTimer) {
      clearTimeout(this.leasePullTimer);
      this.leasePullTimer = null;
    }
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = null;
    }
    this.nonceStore.destroy();
  }

  // ── Role Transitions ─────────────────────────────────────────────

  /**
   * Promote this machine to awake.
   * Called on failover or explicit wakeup.
   */
  promoteToAwake(reason: string): void {
    if (!this._identity) return;
    const oldRole = this._role;
    this._role = 'awake';

    // Update registry
    this.identityManager.updateRole(this._identity.machineId, 'awake');

    // Write initial heartbeat. This is the ONE call site where a write failure
    // is NOT retryable-in-place (second-pass reviewer): a promotion that cannot
    // voice its liveness must ABORT CLEANLY — completing it silently would
    // leave this machine serving as awake with no heartbeat, and (pre-fix) a
    // raw throw left the role flipped + registry updated with no writer
    // running. Roll both back, then rethrow for the caller.
    try {
      this.heartbeatManager.writeHeartbeat();
    } catch (err) {
      this._role = oldRole;
      this.identityManager.updateRole(this._identity.machineId, oldRole);
      console.error(`[MultiMachine] promotion aborted — initial heartbeat write failed (${err instanceof Error ? err.message : String(err)}); role rolled back to '${oldRole}'`);
      throw err;
    }

    // Start heartbeat writer
    this.startHeartbeatWriter();

    // Enable writes on StateManager
    this.state.setReadOnly(false);

    this.securityLog.append({
      event: 'role_transition',
      machineId: this._identity.machineId,
      from: oldRole,
      to: 'awake',
      reason,
    });

    this.emit('promote');
    this.emit('roleChange', oldRole, 'awake');
    console.log(`[MultiMachine] Promoted to awake: ${reason}`);
  }

  /**
   * Demote this machine to standby.
   * Called when another machine takes over.
   */
  demoteToStandby(reason: string): void {
    if (!this._identity) return;
    const oldRole = this._role;
    this._role = 'standby';

    // Update registry
    this.identityManager.updateRole(this._identity.machineId, 'standby');

    // Stop heartbeat writer
    if (this.heartbeatWriteTimer) {
      clearInterval(this.heartbeatWriteTimer);
      this.heartbeatWriteTimer = null;
    }

    // Set StateManager read-only
    this.state.setReadOnly(true);

    this.securityLog.append({
      event: 'role_transition',
      machineId: this._identity.machineId,
      from: oldRole,
      to: 'standby',
      reason,
    });

    this.emit('demote');
    this.emit('roleChange', oldRole, 'standby');
    console.log(`[MultiMachine] Demoted to standby: ${reason}`);
  }

  // ── Heartbeat Hot-Path ───────────────────────────────────────────

  /**
   * The hot-path check that runs before every Telegram poll.
   * Returns true if this machine should NOT process messages.
   */
  shouldSkipProcessing(): boolean {
    if (!this._enabled) return false; // Single machine = always process
    // Independent mode: both machines always process
    if (this.coordinationMode === 'independent') return false;

    // Lease is authority when attached: a machine processes ONLY while it
    // structurally holds the lease at the current epoch. A wedged old-awake
    // whose lease moved on fails this even if its in-memory _role still says
    // 'awake' — the exact structural demotion Phase-0 was missing.
    if (this.leaseCoordinator) {
      return !this.leaseCoordinator.holdsLease();
    }

    if (this._role !== 'awake') return true; // Standby = skip
    // Even if we think we're awake, check the heartbeat file
    return this.heartbeatManager.shouldDemote();
  }

  // ── Fenced-Lease integration (spec §6) ───────────────────────────

  /**
   * Attach the LeaseCoordinator (built once gitSync exists in server boot).
   * From here the lease is the authority for awake/standby. Wires the lease's
   * epoch-advance to a coordinator `leaseEpochChange` event so the registry
   * sync debouncer pushes the new epoch durably.
   */
  attachLeaseCoordinator(lc: LeaseCoordinator): void {
    this.leaseCoordinator = lc;
  }

  /**
   * B2 — the churn breaker, gated by `leaseSelfHeal.churnDetector` (OMIT `enabled`
   * ⇒ developmentAgent gate). Returns null when off. Uses the monotonic clock so a
   * wall-clock step can't fake or mask a flap.
   */
  private getChurnBreaker(): ChurnBreaker | null {
    const c = this.config.multiMachine?.leaseSelfHeal?.churnDetector;
    const enabled = resolveDevAgentGate(c?.enabled, this.config);
    if (!enabled) { this.churnBreaker = null; return null; }
    if (!this.churnBreaker) {
      this.churnBreaker = new ChurnBreaker(
        { maxFlipsPerWindow: c?.maxFlipsPerWindow, windowMs: c?.windowMs, maxLatchesPerHour: c?.maxLatchesPerHour },
        () => this.monoNowMs(),
      );
    }
    return this.churnBreaker;
  }

  /**
   * B1 — resolve the pollFollowsLease gate. OMIT `enabled` ⇒ developmentAgent
   * gate. When on, the server writes its lease-derived poll intent to the
   * cross-process file so the lifeline can follow the lease at runtime.
   */
  private pollFollowsLeaseEnabled(): boolean {
    const m = this.config.multiMachine as { pollFollowsLease?: { enabled?: boolean } } | undefined;
    return resolveDevAgentGate(m?.pollFollowsLease?.enabled, this.config);
  }

  /**
   * B1 — write the lease-derived poll intent for the lifeline. No-op when the gate
   * is off. Guarded: a write failure is logged once, never thrown into the
   * caller's hot path (the intent file is advisory; a missed write degrades to the
   * lifeline's "no current opinion" → hold, the safe direction).
   */
  private writeLeasePollIntent(shouldPoll: boolean, role: MachineRole): void {
    if (!this.pollFollowsLeaseEnabled() || !this.leaseCoordinator) return;
    try {
      writePollIntent(this.config.stateDir, {
        shouldPoll,
        leaseEpoch: this.leaseCoordinator.currentEpoch(),
        role: role === 'awake' ? 'awake' : 'standby',
        serverPid: process.pid,
        bootId: this.bootId,
        ts: Date.now(),
      });
    } catch (err) {
      console.log(`[MultiMachine] [poll-intent] write failed (non-fatal): ${(err as Error).message}`);
    }
  }

  /**
   * B3 — resolve the resilientRenew gate. OMITTED `enabled` ⇒ developmentAgent
   * gate (live-on-dev / dark-on-fleet); an explicit boolean wins. Read live so a
   * config flip applies on the next renew tick without a restart.
   */
  private resilientRenewEnabled(): boolean {
    const explicit = this.config.multiMachine?.leaseSelfHeal?.resilientRenew?.enabled;
    return resolveDevAgentGate(explicit, this.config);
  }

  /** B3 — the renew cadence, clamped so it is always comfortably under the TTL. */
  private renewIntervalMs(): number {
    const ttl = this.leaseCoordinator?.ttlMs ?? MAX_RENEW_INTERVAL_MS * 2;
    return Math.max(MIN_RENEW_INTERVAL_MS, Math.min(MAX_RENEW_INTERVAL_MS, Math.round(ttl * RENEW_SAFETY_FACTOR)));
  }

  /**
   * B3 — start the dedicated renew timer. No-op unless a leaseCoordinator is
   * attached AND resilientRenew resolves on. Keeps the held lease fresh (renew =
   * same epoch) so it never lapses between the slow heartbeat ticks → the
   * epoch-climb stops. Pure timing: it only renews a lease THIS machine already
   * holds; it never acquires, never relaxes the monotonic self-fence.
   */
  private startLeaseRenewTimer(): void {
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = null;
    }
    if (!this.leaseCoordinator || !this.resilientRenewEnabled()) return;
    const interval = this.renewIntervalMs();
    if (!this.leaseRenewStartLogged) {
      console.log(`[MultiMachine] lease renew timer armed (every ${interval}ms; TTL ${this.leaseCoordinator.ttlMs}ms) — B3 resilient renew`);
      this.leaseRenewStartLogged = true;
    }
    this.leaseRenewTimer = setInterval(() => { void this.leaseRenewTick(); }, interval);
    if (this.leaseRenewTimer.unref) this.leaseRenewTimer.unref();
  }

  /**
   * B3 — one renew tick. Renews ONLY when this machine currently holds the lease
   * (same-epoch refresh); a non-holder is left entirely to tickLease's acquire
   * path. Re-entrancy-guarded and bounded by withTickTimeout so a hung broadcast
   * can't wedge the timer.
   */
  private async leaseRenewTick(): Promise<void> {
    if (this.leaseRenewing || !this.leaseCoordinator) return;
    // A muted/observe-only machine NEVER renews — same rule tickLease's
    // observe-only branch enforces. Without this, a machine that booted
    // observe-only while still NAMED in a persisted prior lease (the F3
    // silent-standby zombie) would have its lease renewed/re-broadcast here for
    // up to ~TTL, fighting the silent-standby-relinquish self-heal. (2nd-pass.)
    if (this.isLeaseObserveOnly) return;
    // Only a current holder renews. A lapsed/non-holder is acquireIfEligible's job.
    if (!this.leaseCoordinator.holdsLease()) return;
    this.leaseRenewing = true;
    try {
      await this.withTickTimeout('lease-renew', () => this.leaseCoordinator!.renew());
    } catch (err) {
      console.log(`[MultiMachine] lease renew tick error (non-fatal): ${(err as Error).message}`);
    } finally {
      this.leaseRenewing = false;
    }
  }

  /** Whether this machine structurally holds the lease (false if none attached). */
  holdsLease(): boolean {
    return this.leaseCoordinator?.holdsLease() ?? this._role === 'awake';
  }

  /**
   * Whether this machine currently holds the ROUTER role (Multi-Machine Session
   * Pool, spec §L1). In v0.1 the router lease IS the fenced leader lease — the
   * single machine holding it owns channel ingress and runs the placement
   * engine. This is a semantic alias of `holdsLease()` so session-pool code can
   * ask the question in router terms ("am I the router?") without coupling to
   * the leader/awake vocabulary; it inherits the same monotonic self-fence (a
   * holder that cannot confirm a renewal within TTL on its monotonic clock stops
   * being the router — see LeaseCoordinator §L−1).
   */
  isRouter(): boolean {
    return this.holdsLease();
  }

  /**
   * The current lease fencing epoch (0 if no lease is attached). Used as the
   * fencing token for message-ledger transitions (spec §8 G3a) so a stale-epoch
   * holder's writes are distinguishable from the current holder's.
   */
  getLeaseEpoch(): number {
    return this.leaseCoordinator?.currentEpoch() ?? 0;
  }

  /**
   * Observability snapshot for /health.multiMachine.syncStatus (spec §11).
   * Always returns valid fields (never null/throws) — this is the Phase-1
   * "feature is alive" surface. On a single-machine install it reports the
   * trivially-held lease.
   */
  getSyncStatus(): MultiMachineSyncStatus {
    let awakeMachineCount = 0;
    try {
      const reg = this.identityManager.loadRegistry();
      for (const e of Object.values(reg.machines ?? {})) {
        if (e.role === 'awake') awakeMachineCount++;
      }
    } catch { /* @silent-fallback-ok — registry unreadable → count 0 */ }

    const holds = this.holdsLease();
    const selfSuspended = this.leaseCoordinator?.isSuspended ?? false;
    const splitBrainState: MultiMachineSyncStatus['splitBrainState'] = selfSuspended
      ? 'self-suspended'
      : (awakeMachineCount > 1 || this.leasePullContested)
        ? 'contested'
        : 'clear';

    return {
      enabled: this._enabled,
      role: this._role,
      leaseHolder: this.leaseCoordinator?.currentHolder() ?? (holds ? this._identity?.machineId ?? null : null),
      leaseEpoch: this.leaseCoordinator?.currentEpoch() ?? 0,
      holdsLease: holds,
      splitBrainState,
      protocolVersion: SEAMLESSNESS_PROTOCOL_VERSION,
      awakeMachineCount,
      leaseTickWatchdog: this.leaseCoordinator
        ? {
            lastTickAgeMs: this.lastTickRunMonoMs > 0 ? this.monoNowMs() - this.lastTickRunMonoMs : -1,
            reArmCount: this.watchdogReArmTimes.length,
            disarmed: this.watchdogDisarmed,
          }
        : undefined,
      preferredAwakeMachineId: this.config.multiMachine?.leaseSelfHeal?.preferredAwakeMachineId ?? null,
      meshEndpoints: this.selfMeshEndpointKinds(),
    };
  }

  /**
   * multi-transport-mesh-comms — the KINDS of mesh endpoint this machine advertises
   * (kind-only; raw IPs stay off this surface — Decision 15). Best-effort read of
   * our own registry entry; [] on any error or when none are advertised.
   */
  private selfMeshEndpointKinds(): string[] {
    try {
      const id = this._identity?.machineId;
      if (!id) return [];
      const eps = this.identityManager.getMachineEndpoints?.(id);
      return Array.isArray(eps) ? eps.map((e) => e.kind) : [];
    } catch {
      // @silent-fallback-ok: a read-only /health observability field — an unreadable
      // registry yields an empty kinds list, never an error on the health path.
      return [];
    }
  }

  /**
   * Initialize the lease-based role at boot: attempt acquisition if eligible,
   * then reconcile _role + StateManager read-only to whether we hold the lease.
   */
  async initializeLease(): Promise<void> {
    if (!this.leaseCoordinator) return;
    if (this.isLeaseObserveOnly) {
      // Silent standby: do NOT acquire — only observe the primary's lease.
      this.reconcileRoleToLease('lease-init-observe-only');
    } else if (this.shouldDeferToPreferred()) {
      // F4 — boot as a deferential standby to a healthy preferred peer (no contend).
      this.reconcileRoleToLease('lease-init-defer-preferred');
    } else {
      await this.leaseCoordinator.acquireIfEligible();
      this.reconcileRoleToLease('lease-init');
    }
    // Cross-Machine Coherence — start the active pull loop on every machine once
    // the lease is attached. Pulling is read-only and benefits all roles (a
    // standby learns of a takeover it was never pushed; a holder learns of a
    // same-epoch contender). No-op when the transport can't pull (git-only mesh).
    this.startLeasePullLoop();
    // B3 — keep the held lease fresh (renew before it lapses) so the epoch stops
    // climbing. No-op unless resilientRenew resolves on (dev-gate).
    this.startLeaseRenewTimer();
    // B1 — at boot the role isn't yet reconciled; publish the SAFE default
    // (shouldPoll:false / mute) so a stale prior-boot {shouldPoll:true} can't
    // resurrect a poller before the first reconcile decides the real role.
    this.writeLeasePollIntent(false, 'standby');
  }

  /**
   * Acquire the lease on an explicit yield from the outgoing holder (planned
   * handoff, spec §8 G3e). Called by the /api/handoff/yield handler on the
   * INCOMING machine. Delegates to the guarded consent path (which refuses a
   * yield from any non-holder), then reconciles role → awake on success.
   * Returns true if this machine now holds the lease.
   */
  async acquireLeaseOnConsent(yieldFromMachineId: string): Promise<boolean> {
    if (!this.leaseCoordinator) return false;
    const acquired = await this.leaseCoordinator.acquireOnConsent(yieldFromMachineId);
    this.reconcileRoleToLease('handoff-yield');
    return acquired;
  }

  /**
   * Drive the lease on each monitor tick: renew if we hold it, else attempt
   * failover acquisition. Reconciles role afterward. Fire-and-forget safe.
   */
  private async tickLease(): Promise<void> {
    if (!this.leaseCoordinator || this.leaseTicking) return;
    this.leaseTicking = true;
    this.leaseTickStartMonoMs = this.monoNowMs(); // F1b — for the watchdog's ceiling-gated guard reset
    // B2 — advance the churn breaker so a settled system auto-resets the latch
    // after a calm window (no-op when the churnDetector gate is off).
    this.getChurnBreaker()?.tick();
    try {
      if (this.isLeaseObserveOnly) {
        // F3 (silentStandbyRelinquish, DARK) — LEVEL-TRIGGERED: a silent standby
        // that is STILL the named holder (the 2026-06-19 zombie: muted while
        // holding epoch N) relinquishes + broadcasts a signed tombstone ONCE per
        // incarnation, so peers stop deferring to it. Config flips need a restart,
        // and the zombie is a persisted prior-process record, so this fires on the
        // observe-only tick — not on an (absent) transition event.
        if (
          this.config.multiMachine?.leaseSelfHeal?.silentStandbyRelinquish?.enabled &&
          !this.silentStandbyRelinquished &&
          this._identity &&
          this.leaseCoordinator.currentHolder() === this._identity.machineId
        ) {
          this.silentStandbyRelinquished = true;
          await this.withTickTimeout('relinquishAndBroadcast', () => this.leaseCoordinator!.relinquishAndBroadcast());
        }
        // Silent standby: never acquire/renew — just reconcile role to the
        // observed holder (effectiveView folds the primary's broadcast lease).
        this.reconcileRoleToLease('lease-tick-observe-only');
      } else if (this.leaseCoordinator.holdsLease()) {
        // F1a — bounded await: a hung renew can never wedge the tick.
        await this.withTickTimeout('renew', () => this.leaseCoordinator!.renew());
        this.reconcileRoleToLease('lease-tick');
      } else if (this.shouldDeferToPreferred()) {
        // F4 (preferred-awake, opt-in) — we are NON-preferred and observe the
        // preferred machine holding a HEALTHY lease: defer, do not contend. If the
        // preferred goes down/unhealthy, shouldDeferToPreferred() flips false and we
        // acquire normally next tick (no coverage stranding, no flap — a deferential
        // machine creates no contention to leapfrog, so no agreement-gossip needed).
        this.reconcileRoleToLease('lease-tick-defer-preferred');
      } else {
        await this.withTickTimeout('acquireIfEligible', () => this.leaseCoordinator!.acquireIfEligible());
        this.reconcileRoleToLease('lease-tick');
      }
    } catch {
      // @silent-fallback-ok — a tick failure (incl. a bounded-await timeout) is retried next interval
    } finally {
      this.leaseTicking = false;
      this.leaseTickStartMonoMs = 0;
    }
  }

  /** Bring _role + read-only into line with whether we hold the lease. */
  private reconcileRoleToLease(reason: string): void {
    if (!this.leaseCoordinator || !this._identity) return;
    const holds = this.leaseCoordinator.holdsLease();
    const desired: MachineRole = holds ? 'awake' : 'standby';
    if (desired === this._role) return;
    const oldRole = this._role;
    this._role = desired;
    this.identityManager.updateRole(this._identity.machineId, desired);
    this.state.setReadOnly(!holds);
    if (holds) this.startHeartbeatWriter();
    else if (this.heartbeatWriteTimer) {
      clearInterval(this.heartbeatWriteTimer);
      this.heartbeatWriteTimer = null;
    }
    this.securityLog.append({
      event: 'role_transition',
      machineId: this._identity.machineId,
      from: oldRole,
      to: desired,
      reason: `lease:${reason}`,
    });
    this.emit('roleChange', oldRole, desired);
    if (holds) this.emit('promote');
    else this.emit('demote');
    console.log(`[MultiMachine] Lease reconcile → ${desired} (${reason})`);
    // B1 — publish the lease-derived poll intent for the lifeline (shouldPoll =
    // awake). No-op unless pollFollowsLease resolves on. Nothing consumes it yet
    // (the lifeline reconcile loop is the next increment), so this is a safe,
    // observe-only producer — it cannot change ingress.
    this.writeLeasePollIntent(holds, desired);
    // B2 — feed the flap circuit-breaker on every REAL role transition (this is
    // past the `desired === this._role` early-return, so it counts only true
    // flips). Observe/dry-run: log the would-latch; applying the deterministic
    // role is the live graduation (dryRun:false).
    const breaker = this.getChurnBreaker();
    if (breaker) {
      const v = breaker.recordFlip();
      if (v.latched) {
        const pref = this.config.multiMachine?.leaseSelfHeal?.preferredAwakeMachineId;
        const wouldRole = breaker.latchedRole(!!pref && pref === this._identity.machineId);
        const dryRun = this.config.multiMachine?.leaseSelfHeal?.churnDetector?.dryRun !== false;
        console.log(
          `[MultiMachine] [churn] breaker LATCHED — flips=${v.flipsInWindow}, latchesThisHour=${v.latchesInHour}` +
          `${v.exhausted ? ' (EXHAUSTED — operator attention)' : ''} — ` +
          `${dryRun ? `would hold role '${wouldRole}' (dry-run)` : `holding role '${wouldRole}'`}`,
        );
      }
    }
  }

  // ── Cross-Machine Coherence: active lease PULL ───────────────────

  /**
   * Start the constant-cadence active lease-PULL loop. Self-rearming setTimeout
   * (jittered ±20% so peers don't synchronize their pulls). Runs at
   * leasePullIntervalMs (default 5s) REGARDLESS of holder liveness — the
   * anti-blinding guarantee that a quiet or one-way (NAT) network can't hide a
   * takeover or a same-epoch split-brain. No-op when the transport can't pull
   * (git-only mesh). Tier-0: no LLM; a failed pull is data, retried next tick.
   */
  private startLeasePullLoop(): void {
    // Defensive: an injected coordinator may not implement the pull API (a
    // partial test double, or a build predating active-pull) — never assume it.
    if (!this.leaseCoordinator || typeof this.leaseCoordinator.canPullPeers !== 'function' || !this.leaseCoordinator.canPullPeers()) return;
    if (this.leasePullTimer) return; // already running
    this.leasePullStopped = false;
    const base = this.config.multiMachine?.leasePullIntervalMs ?? DEFAULT_LEASE_PULL_INTERVAL_MS;
    const arm = () => {
      // Respect a stop() that landed while a tick was in-flight (its finally
      // re-arms; this prevents the timer resurrecting after shutdown).
      if (this.leasePullStopped) return;
      // ±20% jitter to de-synchronize peer pulls (floor 1s so a tiny config
      // can't busy-loop).
      const jitter = base * 0.2 * (Math.random() * 2 - 1);
      const delay = Math.max(1_000, Math.round(base + jitter));
      this.leasePullTimer = setTimeout(() => { void this.tickLeasePull(arm); }, delay);
      if (this.leasePullTimer.unref) this.leasePullTimer.unref();
    };
    arm();
  }

  /**
   * One pull tick: fan-out pull every peer, fold the freshest lease into our
   * view, reconcile role (a pulled HIGHER-epoch peer fences us → auto-demote),
   * then surface a SAME-epoch contested split-brain Near-Silently. Pull is for
   * LEARNING (anti-blinding); the heartbeat tickLease remains the only path that
   * ACTS (acquire/renew). Re-arms via `arm` even on failure.
   */
  private async tickLeasePull(arm: () => void): Promise<void> {
    if (this.leasePulling) { arm(); return; }
    this.leasePulling = true;
    this.leasePullStartMonoMs = this.monoNowMs(); // F1b — watchdog ceiling-gated guard reset
    try {
      // F1a — bounded await: a hung peer pull can never wedge the pull loop.
      await this.withTickTimeout('pullFromPeers', () => this.leaseCoordinator!.pullFromPeers());
      // Only reconcile role / surface split-brain when a peer lease was actually
      // OBSERVED. A solo machine (no peers, or no peer lease seen this boot) must
      // NEVER be demoted by the pull loop on a transient self-lease lapse — that
      // is the heartbeat tickLease's job, which RE-ACQUIRES rather than just
      // demoting. The pull's purpose is LEARNING from peers; with no peer signal
      // there is nothing to learn and nothing to reconcile. Acting on the local
      // lease state alone here turned the ~5s pull cadence into a demotion DoS:
      // whenever a solo holder's lease momentarily lapsed between renewals it
      // flipped to read-only standby, and a standby write crashed the server in a
      // restart loop (incident 2026-06-02). Gating on an observed peer lease keeps
      // the real feature intact (a standby pulling a higher-epoch holder still
      // demotes) while removing the spurious solo demotion.
      if (this.leaseCoordinator!.observedPeerLease()) {
        // DEMOTE via the pull loop ONLY when a peer genuinely supersedes us — a
        // LIVE, strictly-higher-epoch lease (peerLeaseSupersedes()). A stale/expired
        // or lower-or-equal-epoch observed peer must NOT flip a legitimate holder to
        // read-only when its own lease merely lapsed transiently between renewals —
        // that re-acquisition is tickLease's job. Without this guard, a 2-day-expired
        // epoch-150 peer lease flapped the real laptop holder to read-only ~50% of
        // the time (live incident 2026-06-02). Promotion stays tickLease's job; the
        // same-epoch contested tie is handled by the resolver below regardless.
        if (this.leaseCoordinator!.peerLeaseSupersedes()) {
          this.reconcileRoleToLease('lease-pull');
        }
        this.surfacePullDiscoveredSplitBrain();
        // §Problem A — ACT on a same-epoch contested tie (not just surface it):
        // deterministic tie-break → loser relinquishes / winner advances once.
        await this.resolveContestedSplitBrain();
      }
    } catch {
      // @silent-fallback-ok — a pull failure (incl. a bounded-await timeout) is retried next tick
    } finally {
      this.leasePulling = false;
      this.leasePullStartMonoMs = 0;
      arm();
    }
  }

  /**
   * Near-Silent split-brain surface. After a pull, if we STILL hold the lease yet
   * a peer's RAW observed lease names a different holder at our epoch (a same-epoch
   * tie a git-less LocalLeaseStore can produce — effectiveView()'s tie-break masks
   * it because our self-issued lease wins), latch `leasePullContested` and log once
   * on the rising edge. This feeds getSyncStatus().splitBrainState='contested' for
   * the dashboard; it does NOT buzz the user (the unresolvable-partition Attention
   * item is a separate, deduped escalation path). Clears on the falling edge.
   */
  private surfacePullDiscoveredSplitBrain(): void {
    if (!this.leaseCoordinator || !this._identity) return;
    const self = this._identity.machineId;
    const weHold = this.leaseCoordinator.holdsLease();
    const peer = this.leaseCoordinator.observedPeerLease();
    const ourEpoch = this.leaseCoordinator.currentEpoch();
    const contested = !!(weHold && peer && peer.holder && peer.holder !== self && peer.epoch >= ourEpoch);
    if (contested && !this.leasePullContested) {
      this.leasePullContested = true;
      console.warn(
        `[MultiMachine] lease-pull: same-epoch contested lease — peer ${peer!.holder} ` +
        `claims epoch ${peer!.epoch} while we hold epoch ${ourEpoch} (near-silent split-brain signal)`,
      );
      this.emit('splitBrainDetected', { peer: peer!.holder, peerEpoch: peer!.epoch, ourEpoch });
    } else if (!contested && this.leasePullContested) {
      this.leasePullContested = false;
      console.log('[MultiMachine] lease-pull: contested lease cleared');
    }
  }

  /**
   * §Problem A — RESOLVE a same-epoch contested split-brain (the git-less
   * LocalLeaseStore leapfrog) to a single holder. surfacePullDiscoveredSplitBrain
   * only DETECTS + latches the dashboard signal; this ACTS:
   *
   *   1. Deterministic tie-break — the lexicographically LOWER `machineId` WINS.
   *      Both machines compute the SAME winner, so exactly one relinquishes and
   *      exactly one advances (no coordination needed).
   *   2. LOSER relinquishes ONCE (clears selfIssued + forces local expiry →
   *      stops being a live holder@N, reconciles to standby).
   *   3. WINNER advances ONCE to N+1 (a strictly-higher signed lease the loser
   *      then adopts via effectiveView()'s strict-`>` tunnel fold → single holder).
   *
   * Both actions are LATCHED one-shot per contested episode (keyed on the
   * epoch-independent {self,peer} pair), so they fire ONCE, not every ~5s tick —
   * a per-tick relinquish/advance would re-introduce the very leapfrog this fixes.
   * If the episode persists past K cycles (the resolution genuinely failed — a
   * stuck/partitioned peer), emit ONE deduped escalation with a DETERMINISTIC
   * recommendation (demote the tie-break loser). Distinct from the
   * unresolvable-PARTITION path (checkForUnresolvableSplit); this is the
   * same-epoch-CONTESTED path. Cleared on the falling edge.
   */
  private async resolveContestedSplitBrain(): Promise<void> {
    if (!this.leaseCoordinator || !this._identity) return;
    const ESCALATE_AFTER_CYCLES = 5;
    const self = this._identity.machineId;
    const peer = this.leaseCoordinator.observedPeerLease();
    const weHold = this.leaseCoordinator.holdsLease();
    const ourEpoch = this.leaseCoordinator.currentEpoch();
    // A genuine same-epoch contested tie: we still hold AND a peer claims a
    // different-holder lease at our epoch (or higher-but-equal after a leapfrog).
    const contested = !!(weHold && peer && peer.holder && peer.holder !== self && peer.epoch >= ourEpoch);
    if (!contested) {
      // Falling edge — the tie resolved (we adopted the winner, or it cleared).
      // Drop the episode so a future contested tie starts a fresh latch.
      this.contestedEpisode = null;
      return;
    }
    const peerHolder = peer!.holder;
    const episodeKey = [self, peerHolder].sort().join('~'); // epoch-INDEPENDENT
    if (!this.contestedEpisode || this.contestedEpisode.key !== episodeKey) {
      this.contestedEpisode = { key: episodeKey, cycles: 0, resolved: false, escalated: false };
    }
    const ep = this.contestedEpisode;
    ep.cycles++;
    const winner = self < peerHolder ? self : peerHolder; // lower machineId WINS
    const loser = self < peerHolder ? peerHolder : self;
    const iAmWinner = winner === self;
    if (!ep.resolved) {
      if (iAmWinner) {
        await this.leaseCoordinator.advanceEpochForContestedWin();
        console.log(
          `[MultiMachine] contested tie-break: WON vs ${peerHolder} at epoch ${ourEpoch} ` +
          `— advanced once to N+1 to break the same-epoch split`,
        );
      } else {
        this.leaseCoordinator.relinquish();
        this.reconcileRoleToLease('contested-relinquish');
        console.log(
          `[MultiMachine] contested tie-break: YIELDED to ${winner} at epoch ${ourEpoch} ` +
          `— relinquished self-lease (will adopt the winner's N+1)`,
        );
      }
      ep.resolved = true; // one-shot latch — no per-tick churn (no re-leapfrog)
    }
    // Bounded escalation: the resolution did NOT converge after K cycles → a
    // genuinely stuck/partitioned peer. Surface ONCE, deduped per episode, with a
    // DETERMINISTIC recommendation (never a raw Y/N the operator could mis-answer).
    if (ep.cycles >= ESCALATE_AFTER_CYCLES && !ep.escalated) {
      ep.escalated = true;
      this.emit('splitBrainEscalation', {
        episodeKey,
        winner,
        loser,
        recommendation: `demote ${loser}`,
        reason: `same-epoch contested split-brain persisted ${ep.cycles} pull cycles without converging`,
      });
      console.warn(
        `[MultiMachine] contested split-brain UNRESOLVED after ${ep.cycles} cycles — ` +
        `recommend demoting ${loser} (episode ${episodeKey})`,
      );
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Start periodic heartbeat writes (awake machine only).
   */
  private startHeartbeatWriter(): void {
    if (this.heartbeatWriteTimer) {
      clearInterval(this.heartbeatWriteTimer);
    }

    // Write immediately
    this.writeHeartbeatGuarded();

    // Then every 2 minutes
    this.heartbeatWriteTimer = setInterval(() => {
      if (this._role === 'awake') {
        this.writeHeartbeatGuarded();
        // Touch lastSeen in registry
        if (this._identity) {
          try {
            this.identityManager.touchMachine(this._identity.machineId);
          } catch {
            // @silent-fallback-ok — lastSeen update non-critical
          }
        }
      }
    }, HEARTBEAT_WRITE_INTERVAL_MS);

    if (this.heartbeatWriteTimer.unref) {
      this.heartbeatWriteTimer.unref();
    }
  }

  /**
   * ETERNAL SENTINEL (declared per "No Unbounded Loops" / P19): the heartbeat
   * writer is the awake machine's liveness voice — it must keep attempting
   * every tick forever (rate floor = HEARTBEAT_WRITE_INTERVAL_MS, constant
   * cost). Its brakes live here: a write failure can no longer escape the
   * timer tick as an uncaughtException (pre-fix: ENOSPC at the wrong moment
   * CRASHED the awake holder), failure logging is state-change-bounded (first
   * + recovery, one line each), and a sustained episode raises ONE degradation
   * signal — sized at 6min (3 failed cycles) so the operator hears about it
   * BEFORE the peer's ~15min heartbeat-expiry failover horizon.
   */
  private writeHeartbeatGuarded(): void {
    try {
      this.heartbeatManager.writeHeartbeat();
      const s = this.hbWriteEpisode.recordSuccess();
      if (s.recovered) {
        console.log(`[MultiMachine] heartbeat write recovered after ${s.failures} consecutive failures`);
      }
    } catch (err) {
      const f = this.hbWriteEpisode.recordFailure();
      const msg = err instanceof Error ? err.message : String(err);
      if (f.firstOfEpisode) {
        console.error(`[MultiMachine] heartbeat write FAILED (${msg}) — retrying every ${HEARTBEAT_WRITE_INTERVAL_MS / 60_000}min; peers may failover if this persists`);
      }
      if (f.shouldSignal) {
        console.error(`[MultiMachine] heartbeat write failing for ${Math.round(f.failingForMs / 60_000)}min (${f.failures} consecutive) — signaling once; retries continue`);
        DegradationReporter.getInstance().report({
          feature: 'MultiMachine.heartbeatWrite',
          primary: "Awake machine persists its liveness heartbeat so peers don't failover",
          fallback: `Heartbeat writes failing for ~${Math.round(f.failingForMs / 60_000)}min (${f.failures} consecutive: ${msg}); retries continue every ${HEARTBEAT_WRITE_INTERVAL_MS / 60_000}min`,
          reason: 'Heartbeat file write throwing (disk full / permissions / path issue)',
          impact: 'If this persists past the heartbeat expiry window, a standby peer will treat this machine as dead and fail over while it is still serving.',
        });
      }
    }
  }

  // ── multi-machine-lease-self-heal F1 — tick self-heal ─────────────

  /** Monotonic milliseconds (NTP-step / sleep-resume immune), like LeaseCoordinator §L−1. */
  private monoNowMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  /** Resolved F1 watchdog config (defaults baked in; read live so disable needs no restart). */
  private get tickWatchdogCfg(): { enabled: boolean; staleMs: number; awaitTimeoutMs: number; maxReArmsPerHour: number } {
    const w = this.config.multiMachine?.leaseSelfHeal?.tickWatchdog;
    const staleFactor = Math.max(2, w?.staleFactorMissedTicks ?? 5);
    return {
      enabled: w?.enabled ?? true,
      staleMs: HEARTBEAT_CHECK_INTERVAL_MS * staleFactor,
      awaitTimeoutMs: Math.max(1000, w?.awaitTimeoutMs ?? 20_000),
      maxReArmsPerHour: Math.max(2, w?.maxReArmsPerHour ?? 6),
    };
  }

  /**
   * F1a — bound a tick-path network await so a never-settling call (the proven
   * 2026-06-19 freeze: a hung fetch left `leaseTicking` stuck true forever) can
   * NEVER hang the tick. ALL tick-path awaits route through this one helper, so
   * the "no unbounded tick await" invariant is structural + grep-auditable.
   */
  private withTickTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const ms = this.tickWatchdogCfg.awaitTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`tick-await timeout after ${ms}ms: ${label}`));
      }, ms);
      if (typeof t.unref === 'function') t.unref();
      fn().then(
        (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
        (e) => { if (!settled) { settled = true; clearTimeout(t); reject(e); } },
      );
    });
  }

  /**
   * F1b — the monotonic-clocked tick watchdog. Detects a stalled main tick loop
   * (lost timer / stuck reentrancy guard) and re-arms it. SAFE-BY-CONSTRUCTION:
   * never crashes (try/catch), never touches authority/epoch/suspend state, only
   * resets a reentrancy guard whose in-flight tick is ALSO older than the ceiling
   * (so a legitimately-slow live tick is never preempted), reads `enabled` live,
   * and self-disarms (one DegradationReporter signal) if it re-arms too often.
   * A true event-loop stall freezes this timer too — that case is layer-2 (the
   * out-of-process fleet/launchd watchdog), as documented in the spec.
   */
  private runTickWatchdog(): void {
    try {
      const cfg = this.tickWatchdogCfg;
      if (!cfg.enabled || this.watchdogDisarmed) return;
      // No lease coordinator (solo / non-git mesh) ⇒ nothing to self-heal.
      if (!this.leaseCoordinator) return;
      const now = this.monoNowMs();
      // lastTickRunMonoMs is stamped at the TOP of checkHeartbeatAndAct; if it
      // has not advanced within the stale window, the main loop is stalled.
      if (this.lastTickRunMonoMs > 0 && now - this.lastTickRunMonoMs <= cfg.staleMs) return;

      // Ceiling-gated guard reset: only clear a guard whose in-flight tick is
      // ALSO older than the ceiling (a stuck guard, not a slow-but-live tick).
      if (this.leaseTicking && this.leaseTickStartMonoMs > 0 && now - this.leaseTickStartMonoMs > cfg.staleMs) {
        this.leaseTicking = false;
      }
      if (this.leasePulling && this.leasePullStartMonoMs > 0 && now - this.leasePullStartMonoMs > cfg.staleMs) {
        this.leasePulling = false;
      }
      // Re-arm the main monitor (clears + recreates the interval).
      this.startHeartbeatMonitor();
      this.lastTickRunMonoMs = now; // reset so we don't re-fire next tick on the same stall

      // Self-disarm bookkeeping (rolling 1h window).
      this.watchdogReArmTimes.push(now);
      const hourAgo = now - 3_600_000;
      this.watchdogReArmTimes = this.watchdogReArmTimes.filter((t) => t >= hourAgo);
      console.log(`[MultiMachine] lease-tick watchdog: stalled >${cfg.staleMs}ms — re-armed (${this.watchdogReArmTimes.length}/${cfg.maxReArmsPerHour} this hour)`);
      this.emit('tickStallRecovered', { reArmCount: this.watchdogReArmTimes.length });

      if (this.watchdogReArmTimes.length > cfg.maxReArmsPerHour) {
        this.watchdogDisarmed = true;
        console.error('[MultiMachine] lease-tick watchdog SELF-DISARMED — re-arming too often; the tick itself is the incident');
        DegradationReporter.getInstance().report({
          feature: 'MultiMachine.leaseTickWatchdog',
          primary: 'The lease-tick self-heal watchdog re-arms a stalled coordinator tick',
          fallback: `Watchdog re-armed >${cfg.maxReArmsPerHour}×/hour and has self-disarmed; the lease tick is repeatedly stalling`,
          reason: 'A persistently-stalling lease tick (transport hang / event-loop pressure) the in-process watchdog cannot durably fix',
          impact: 'The awake-machine election may be unstable; investigate the coordinator/transport. The out-of-process fleet watchdog remains the backstop.',
        });
      }
    } catch (err) {
      // @silent-fallback-ok — the watchdog must NEVER throw out of its interval
      // callback (an uncaughtException would turn a partial wedge into a crash).
      console.error(`[MultiMachine] tick watchdog error (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Start periodic heartbeat monitoring (all machines).
   */
  private startHeartbeatMonitor(): void {
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
    }

    this.heartbeatCheckTimer = setInterval(() => {
      this.checkHeartbeatAndAct();
    }, HEARTBEAT_CHECK_INTERVAL_MS);

    if (this.heartbeatCheckTimer.unref) {
      this.heartbeatCheckTimer.unref();
    }

    // F1b — arm the independent tick watchdog ONCE (shorter 60s cadence so
    // detection latency isn't gated by the 2-min main cadence). startHeartbeat-
    // Monitor is also called BY the watchdog to re-arm the main timer, so guard
    // against stacking a second watchdog on re-arm.
    if (!this.tickWatchdogTimer) {
      this.tickWatchdogTimer = setInterval(() => {
        this.runTickWatchdog();
      }, TICK_WATCHDOG_INTERVAL_MS);
      if (this.tickWatchdogTimer.unref) this.tickWatchdogTimer.unref();
    }
  }

  /**
   * Check the heartbeat and take action if needed.
   */
  private checkHeartbeatAndAct(): void {
    // F1b — stamp the monotonic liveness mark FIRST, before any early-return, so
    // a solo / no-leaseCoordinator agent still advances it and the watchdog never
    // re-arms there (genuine no-op on single-machine agents).
    this.lastTickRunMonoMs = this.monoNowMs();
    if (!this._identity) return;
    // Independent mode: no failover/demotion logic
    if (this.coordinationMode === 'independent') return;

    // Lease is authority when attached — renew/acquire + reconcile role. The
    // heartbeat below is retained only for liveness display in this mode.
    if (this.leaseCoordinator) {
      void this.tickLease();
      return;
    }

    if (this._role === 'awake') {
      // Awake machine: check if someone else took over
      if (this.heartbeatManager.shouldDemote()) {
        this.demoteToStandby('Another machine has a valid heartbeat');
      }
    } else {
      // Standby machine: check for failover condition
      const failoverResult = this.heartbeatManager.shouldFailover();
      if (failoverResult.should) {
        this.heartbeatManager.recordFailover();
        this.promoteToAwake(`Auto-failover: ${failoverResult.reason}`);
        this.emit('failover', failoverResult.reason);
      }
    }
  }
}
