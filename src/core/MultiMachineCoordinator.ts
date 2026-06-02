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
}

// ── Constants ────────────────────────────────────────────────────────

const HEARTBEAT_WRITE_INTERVAL_MS = 2 * 60_000; // Write heartbeat every 2 min
const HEARTBEAT_CHECK_INTERVAL_MS = 2 * 60_000;  // Check heartbeat every 2 min
const DEFAULT_FAILOVER_TIMEOUT_MS = 15 * 60_000;  // 15 min before failover
/** Cross-Machine Coherence — default active lease-PULL cadence over the tunnel. */
const DEFAULT_LEASE_PULL_INTERVAL_MS = 5_000;

// ── Types ────────────────────────────────────────────────────────────

export interface CoordinatorConfig {
  /** State directory (.instar) */
  stateDir: string;
  /** Multi-machine config from config.json */
  multiMachine?: MultiMachineConfig;
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
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
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
    return this.config.multiMachine?.telegramPolling === false;
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
    this.leasePullStopped = true;
    if (this.leasePullTimer) {
      clearTimeout(this.leasePullTimer);
      this.leasePullTimer = null;
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

    // Write initial heartbeat
    this.heartbeatManager.writeHeartbeat();

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
    };
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
    } else {
      await this.leaseCoordinator.acquireIfEligible();
      this.reconcileRoleToLease('lease-init');
    }
    // Cross-Machine Coherence — start the active pull loop on every machine once
    // the lease is attached. Pulling is read-only and benefits all roles (a
    // standby learns of a takeover it was never pushed; a holder learns of a
    // same-epoch contender). No-op when the transport can't pull (git-only mesh).
    this.startLeasePullLoop();
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
    try {
      if (this.isLeaseObserveOnly) {
        // Silent standby: never acquire/renew — just reconcile role to the
        // observed holder (effectiveView folds the primary's broadcast lease).
        this.reconcileRoleToLease('lease-tick-observe-only');
      } else if (this.leaseCoordinator.holdsLease()) {
        await this.leaseCoordinator.renew();
        this.reconcileRoleToLease('lease-tick');
      } else {
        await this.leaseCoordinator.acquireIfEligible();
        this.reconcileRoleToLease('lease-tick');
      }
    } catch {
      // @silent-fallback-ok — a tick failure is retried next interval
    } finally {
      this.leaseTicking = false;
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
    try {
      await this.leaseCoordinator!.pullFromPeers();
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
      // @silent-fallback-ok — a pull failure is retried next tick
    } finally {
      this.leasePulling = false;
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
    this.heartbeatManager.writeHeartbeat();

    // Then every 2 minutes
    this.heartbeatWriteTimer = setInterval(() => {
      if (this._role === 'awake') {
        this.heartbeatManager.writeHeartbeat();
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
  }

  /**
   * Check the heartbeat and take action if needed.
   */
  private checkHeartbeatAndAct(): void {
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
