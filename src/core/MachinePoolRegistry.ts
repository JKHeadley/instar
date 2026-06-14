/**
 * MachinePoolRegistry — the live machine-pool view (Multi-Machine Session Pool
 * §L2). Assembles a `MachineCapacity` per machine from the machine registry
 * (nickname + hardware), MachineHeartbeat (liveness), `os` (load), and
 * SessionManager diagnostics (sessions/memory), and runs the clock-skew
 * quarantine FSM. It is the input to placement (§L4) and the data behind
 * `GET /pool` + the Machines dashboard tab.
 *
 * Correctness rules from §L2 (do not weaken):
 *  - Liveness + placement freshness key on `routerReceivedAt` (the ROUTER's own
 *    clock at heartbeat arrival), NEVER the machine's self-reported timestamp —
 *    a fast-clocked machine must not appear fresher than it is.
 *  - A machine whose self-reported vs router-observed timestamps diverge beyond
 *    tolerance is quarantined via an explicit FSM (2-divergent-beats-out,
 *    2-clean-beats-in), not silently degraded.
 *
 * The pure pieces (`captureHardware`, `clockSkewTransition`) are exported so they
 * are unit-testable without I/O.
 */

import os from 'node:os';
import type { ClockSkewStatus, MachineCapacity, MachineHardware } from './types.js';

// ── Hardware capture (pure-ish: reads `os`, no other I/O) ────────────

/** Capture this machine's static hardware properties (§L2). */
export function captureHardware(instarVersion?: string): MachineHardware {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() || 'unknown',
    cpuCores: cpus.length,
    totalMemBytes: os.totalmem(),
    hostname: os.hostname(),
    ...(instarVersion ? { instarVersion } : {}),
  };
}

// ── Clock-skew quarantine FSM (pure, §L2) ────────────────────────────

export interface ClockSkewFsmState {
  status: ClockSkewStatus;
  /** Consecutive in-tolerance beats since entering suspect-clock-removed (re-admit at 2). */
  removedCleanCount: number;
}

export type ClockSkewSideEffect =
  | 'none'
  | 'logged' // first divergent beat — armed, not removed
  | 'removed' // 2nd consecutive divergent — removed from placement + Attention
  | 'reset' // a divergent-armed machine recovered
  | 're-admitted'; // 2 consecutive clean beats after removal

export const INITIAL_CLOCK_SKEW_STATE: ClockSkewFsmState = { status: 'ok', removedCleanCount: 0 };

/**
 * Pure transition of the clock-skew FSM (§L2 transition table). `divergent` =
 * `|selfReportedLastSeen − routerReceivedAt| > clockSkewToleranceMs` for this beat.
 * Returns the next state + the side-effect the caller must enact (removal +
 * Attention happen on 'removed'; re-admission on 're-admitted').
 */
export function clockSkewTransition(
  current: ClockSkewFsmState,
  divergent: boolean,
): { next: ClockSkewFsmState; sideEffect: ClockSkewSideEffect } {
  switch (current.status) {
    case 'ok':
      return divergent
        ? { next: { status: 'divergence-detected-once', removedCleanCount: 0 }, sideEffect: 'logged' }
        : { next: { status: 'ok', removedCleanCount: 0 }, sideEffect: 'none' };
    case 'divergence-detected-once':
      return divergent
        ? { next: { status: 'suspect-clock-removed', removedCleanCount: 0 }, sideEffect: 'removed' }
        : { next: { status: 'ok', removedCleanCount: 0 }, sideEffect: 'reset' };
    case 'suspect-clock-removed':
      if (divergent) {
        return { next: { status: 'suspect-clock-removed', removedCleanCount: 0 }, sideEffect: 'none' };
      }
      // in-tolerance: re-admit only on the 2nd consecutive clean beat.
      if (current.removedCleanCount + 1 >= 2) {
        return { next: { status: 'ok', removedCleanCount: 0 }, sideEffect: 're-admitted' };
      }
      return {
        next: { status: 'suspect-clock-removed', removedCleanCount: current.removedCleanCount + 1 },
        sideEffect: 'none',
      };
    default:
      return { next: INITIAL_CLOCK_SKEW_STATE, sideEffect: 'none' };
  }
}

/** Whether a machine in this clock-skew state may receive placement. */
export function isPlacementEligibleByClock(status: ClockSkewStatus): boolean {
  return status !== 'suspect-clock-removed';
}

// ── Registry assembly ────────────────────────────────────────────────

/** A heartbeat observation handed to the registry (router-side). */
export interface HeartbeatObservation {
  machineId: string;
  /** The machine's own timestamp from its heartbeat (ISO) — advisory. */
  selfReportedLastSeen?: string;
  loadAvg?: number;
  memPressure?: MachineCapacity['memPressure'];
  activeSessionCount?: number;
  maxSessions?: number;
  /** The machine's self-reported LLM-account quota state (quota-aware placement,
   *  2026-06-05). Absent = unknown (older heartbeats) = treated as not blocked. */
  quotaState?: MachineCapacity['quotaState'];
  /** WS1.1 (MULTI-MACHINE-SEAMLESSNESS-SPEC invariant 5): the machine's
   *  self-advertised seamlessness capabilities. Absent = pre-spec peer or
   *  feature dark = non-participant (the conservative side). */
  seamlessnessFlags?: MachineCapacity['seamlessnessFlags'];
  /** Compact guard-posture summary (GUARD-POSTURE-ENDPOINT-SPEC §2.3). The
   *  caller keys the observation on the REGISTRY's machine identity — this
   *  field is the peer's self-reported DATA, never its identity. Absent =
   *  older peer / no posture (renders "unknown"). */
  guardPosture?: MachineCapacity['guardPosture'];
  /** Durable Inbound Message Queue heartbeat fields (spec §5.1). Absent =
   *  older peer / queue dark — depth honestly unknown. */
  inboundQueue?: MachineCapacity['inboundQueue'];
}

export interface MachinePoolRegistryDeps {
  /** Returns {machineId, nickname, hardware?, capabilities?} for every known machine. */
  listMachines: () => Array<{
    machineId: string;
    nickname?: string;
    hardware?: MachineHardware;
    capabilities?: string[];
    modelsAvailable?: string[];
    agentsResident?: string[];
  }>;
  /** Clock-skew divergence tolerance (ms). */
  clockSkewToleranceMs: number;
  /** A machine is offline if (now − routerReceivedAt) ≥ this (ms). */
  failoverThresholdMs: number;
  /** Wall clock (injectable for tests). */
  now?: () => number;
  /** Fired when a machine is removed from placement for clock skew (Attention item). */
  onClockQuarantine?: (machineId: string, reason: string) => void;
  logger?: (msg: string) => void;
  /** Durable last-known guard posture (GUARD-POSTURE-ENDPOINT-SPEC §2.3(c)).
   *  When wired, every posture-carrying heartbeat persists, and `assemble`
   *  falls back to the stored copy (with its REAL receipt age) for a machine
   *  with no live observation — dark-peer honesty across local restarts. */
  postureStore?: {
    record: (machineId: string, posture: NonNullable<MachineCapacity['guardPosture']>, receivedAtMs: number) => void;
    get: (machineId: string) => { posture: NonNullable<MachineCapacity['guardPosture']>; receivedAtMs: number } | null;
  } | null;
}

/**
 * Tracks live per-machine state (router-observed timestamp + clock-skew FSM) and
 * assembles the MachineCapacity list. In-memory; rebuilt from heartbeats — the
 * durable machine identity/registry is the source of nickname/hardware.
 */
export class MachinePoolRegistry {
  private readonly d: MachinePoolRegistryDeps;
  private readonly observed = new Map<
    string,
    {
      routerReceivedAtMs: number;
      obs: HeartbeatObservation;
      skew: ClockSkewFsmState;
      /** Posture receipt is tracked SEPARATELY from heartbeat receipt: a
       *  posture-less beat carries the old block forward without refreshing
       *  its age (the age must reflect when the POSTURE was received). */
      posture?: { block: NonNullable<MachineCapacity['guardPosture']>; receivedAtMs: number };
    }
  >();

  constructor(deps: MachinePoolRegistryDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Record a heartbeat arrival: stamp router-clock receipt + run the clock-skew FSM. */
  recordHeartbeat(obs: HeartbeatObservation): ClockSkewSideEffect {
    const nowMs = this.now();
    const prev = this.observed.get(obs.machineId);
    let divergent = false;
    if (obs.selfReportedLastSeen) {
      const selfMs = Date.parse(obs.selfReportedLastSeen);
      if (Number.isFinite(selfMs)) {
        divergent = Math.abs(selfMs - nowMs) > this.d.clockSkewToleranceMs;
      }
    }
    const { next, sideEffect } = clockSkewTransition(prev?.skew ?? INITIAL_CLOCK_SKEW_STATE, divergent);
    // Posture handling (GUARD-POSTURE-ENDPOINT-SPEC §2.3): a beat WITH a block
    // stamps a fresh receiver-side receipt time and persists durably; a beat
    // WITHOUT one (older peer / lighter beat) carries the previous block
    // forward UNCHANGED — including its original receipt time, so the
    // rendered age stays honest.
    let posture = prev?.posture;
    if (obs.guardPosture) {
      posture = { block: obs.guardPosture, receivedAtMs: nowMs };
      this.d.postureStore?.record(obs.machineId, obs.guardPosture, nowMs);
    }
    this.observed.set(obs.machineId, { routerReceivedAtMs: nowMs, obs, skew: next, posture });
    if (sideEffect === 'removed') {
      this.d.onClockQuarantine?.(
        obs.machineId,
        `clock divergence > ${this.d.clockSkewToleranceMs}ms on 2 consecutive heartbeats — removed from placement`,
      );
      this.d.logger?.(`[pool] machine ${obs.machineId} clock-skew quarantined`);
    } else if (sideEffect === 're-admitted') {
      this.d.logger?.(`[pool] machine ${obs.machineId} clock recovered — re-admitted to placement`);
    }
    return sideEffect;
  }

  /** Current clock-skew status for a machine (defaults to ok if unseen). */
  clockSkewStatus(machineId: string): ClockSkewStatus {
    return this.observed.get(machineId)?.skew.status ?? 'ok';
  }

  /** Whether a machine is eligible for placement (online + clock ok). */
  isPlacementEligible(machineId: string): boolean {
    const cap = this.getCapacity(machineId);
    return !!cap && cap.online && isPlacementEligibleByClock(cap.clockSkewStatus);
  }

  /** Assemble the MachineCapacity for one machine (null if unknown to the registry). */
  getCapacity(machineId: string): MachineCapacity | null {
    const known = this.d.listMachines().find((m) => m.machineId === machineId);
    if (!known) return null;
    return this.assemble(known);
  }

  /** Assemble the full pool view (§L2) — the data behind GET /pool. */
  getCapacities(): MachineCapacity[] {
    return this.d.listMachines().map((m) => this.assemble(m));
  }

  private assemble(known: {
    machineId: string;
    nickname?: string;
    hardware?: MachineHardware;
    capabilities?: string[];
    modelsAvailable?: string[];
    agentsResident?: string[];
  }): MachineCapacity {
    const live = this.observed.get(known.machineId);
    const nowMs = this.now();
    const online =
      !!live && nowMs - live.routerReceivedAtMs < this.d.failoverThresholdMs;
    return {
      machineId: known.machineId,
      nickname: known.nickname,
      online,
      selfReportedLastSeen: live?.obs.selfReportedLastSeen,
      routerReceivedAt: live ? new Date(live.routerReceivedAtMs).toISOString() : undefined,
      loadAvg: live?.obs.loadAvg,
      memPressure: live?.obs.memPressure,
      activeSessionCount: live?.obs.activeSessionCount,
      maxSessions: live?.obs.maxSessions,
      capabilities: known.capabilities,
      modelsAvailable: known.modelsAvailable,
      agentsResident: known.agentsResident,
      hardware: known.hardware,
      clockSkewStatus: live?.skew.status ?? 'ok',
      quotaState: live?.obs.quotaState,
      inboundQueue: live?.obs.inboundQueue,
      // WS1.1: capability advertisement passthrough. LIVE observation only —
      // a peer that goes dark stops advertising (no durable fallback), which
      // is the safe direction: senders queue instead of forwarding blind.
      seamlessnessFlags: live?.obs.seamlessnessFlags,
      // Guard posture: live observation first, durable last-known second —
      // a machine with no posture EVER received carries neither field
      // (renders "guards: unknown", never "0 on / 0 off").
      ...(() => {
        const p = live?.posture ?? this.d.postureStore?.get(known.machineId) ?? null;
        if (!p) return {};
        const block = 'block' in p ? p.block : p.posture;
        return {
          guardPosture: block,
          guardPostureReceivedAt: new Date(p.receivedAtMs).toISOString(),
        };
      })(),
    };
  }
}
