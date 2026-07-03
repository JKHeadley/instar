/**
 * MachineCoherenceSentinel — the machine-coherence guard's evaluator core
 * (machine-coherence-guard §3.3/§3.4; roadmap 4.1, F4/P0-1).
 *
 * A pure-core, tick-driven, signal-only sentinel in the `checkPoolFlagCoherence`
 * shape: it compares, across every ONLINE machine in the pool, the §3.2 advert
 * dimensions (version / resolved flags / protocol / manifest generation) and —
 * when the pool diverges — will raise ONE deduped, episode-scoped attention item
 * from exactly ONE elected machine. It never blocks, equalizes, or restarts
 * anything.
 *
 * INCREMENT STATUS (C₁ is landing in sub-units — see the side-effects artifact):
 *   - LANDED here: config resolution (spec §7 keys, code-side defaults,
 *     `enabled` OMITTED from ConfigDefaults → resolveDevAgentGate, the #1001
 *     anti-mechanism), the tick loop's early no-op gates (single-machine strict
 *     no-op BEFORE any state is touched), the per-tick peer-classification pass
 *     (composing the pure C₀ helpers), the §3.4 election over live candidates,
 *     the M11 comparison-universe honesty accounting, and the §6 status
 *     snapshot shape.
 *   - NOT YET here (Session B): dimension comparison + confirmation counters
 *     (R2-L3 consecutive rule, M6 update-wave suppression, N8 warm-up
 *     accounting beyond the tick gate), the §4 episode state machine + the ONE
 *     attention item + §4.2.1 fix flow, the alarm-marker attach into
 *     refreshPool's advert, jsonl transitions, and the status route.
 *
 * Fail toward silence (§3.3): any evaluator error → no emit this tick, an
 * error counter on the status snapshot. A guard that can flood on its own
 * malfunction re-creates the disease it treats.
 *
 * Supervision tier (N6): Tier 0 — fully deterministic; no LLM call anywhere.
 * Signal-vs-authority: PURE SIGNAL (dev-gated dark; dry-run first even on dev).
 */

import type { MachineCapacity } from '../core/types.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { getByPath } from '../core/machineCoherenceManifest.js';
import {
  classifyPeer,
  electRaiser,
  type ClassifiedPeer,
} from './machineCoherenceEvaluate.js';

/** Resolved config (spec §7 — every knob carries its shipped default in code). */
export interface MachineCoherenceResolvedConfig {
  enabled: boolean;
  dryRun: boolean;
  flagConfirmTicks: number;
  versionSkewGraceMs: number;
  resolveTicks: number;
  escalateAfterMs: number;
  advertStaleMs: number;
  warmupTicks: number;
  reopenWindowMs: number;
  maxEpisodeItemsPerDay: number;
  suspendedEpisodeExpiryMs: number;
  raiserTakeoverTicks: number;
  flappingLatchReopens: number;
  episodeAppendBudget: number;
  episodeAppendWindowMs: number;
  fixVerifyTicks: number;
}

/**
 * Resolve the guard's config from the full agent config object. `enabled` is
 * DELIBERATELY absent from ConfigDefaults — resolveDevAgentGate decides (LIVE
 * on a development agent, DARK on the fleet; an explicit value always wins —
 * the #1001 anti-mechanism). `dryRun` defaults TRUE even on dev (dry-run
 * FIRST: evaluator runs, counters record would-raise, NO item).
 */
export function resolveMachineCoherenceConfig(config: Record<string, unknown>): MachineCoherenceResolvedConfig {
  const block = (getByPath(config, 'monitoring.machineCoherence') ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number): number => {
    const v = block[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    enabled: resolveDevAgentGate(
      typeof block.enabled === 'boolean' ? block.enabled : undefined,
      config as { developmentAgent?: boolean },
    ),
    dryRun: typeof block.dryRun === 'boolean' ? block.dryRun : true,
    flagConfirmTicks: num('flagConfirmTicks', 2),
    versionSkewGraceMs: num('versionSkewGraceMs', 2_700_000), // 45 min
    resolveTicks: num('resolveTicks', 3),
    escalateAfterMs: num('escalateAfterMs', 86_400_000), // 24 h
    advertStaleMs: num('advertStaleMs', 300_000), // 5 min (M5)
    warmupTicks: num('warmupTicks', 4), // N8
    reopenWindowMs: num('reopenWindowMs', 3_600_000), // 60 min (M2)
    maxEpisodeItemsPerDay: num('maxEpisodeItemsPerDay', 3), // M2
    suspendedEpisodeExpiryMs: num('suspendedEpisodeExpiryMs', 604_800_000), // 7 d (M1)
    raiserTakeoverTicks: num('raiserTakeoverTicks', 10), // C1/R2-M1
    flappingLatchReopens: num('flappingLatchReopens', 3), // R2-N4
    episodeAppendBudget: num('episodeAppendBudget', 6), // R3-M5
    episodeAppendWindowMs: num('episodeAppendWindowMs', 21_600_000), // 6 h (R3-M5)
    fixVerifyTicks: num('fixVerifyTicks', 10), // R2-M3-v
  };
}

/** The guard's own posture, derived from resolved config (feeds candidacy). */
export function selfPostureOf(cfg: Pick<MachineCoherenceResolvedConfig, 'enabled' | 'dryRun'>): 'live' | 'dry-run' | 'dark' {
  return cfg.enabled ? (cfg.dryRun ? 'dry-run' : 'live') : 'dark';
}

export interface MachineCoherenceSentinelDeps {
  /** The pool view (self + peers) — `machinePoolRegistry.getCapacities()`. */
  listCapacities: () => MachineCapacity[];
  /** This machine's id (null before pool identity is established). */
  selfMachineId: () => string | null;
  /** The serving-lease holder's machine id, or null when unknown/none. */
  leaseHolderMachineId: () => string | null;
  /** Wall clock — injectable for tests. */
  now?: () => number;
}

/** The §6 status snapshot (the future `GET /pool/machine-coherence` body core). */
export interface MachineCoherenceStatus {
  enabled: boolean;
  dryRun: boolean;
  lastTickAt: string | null;
  machinesRegisteredOnline: number;
  machinesCompared: number;
  peerClassifications: { compared: number; unknown: number; advertStale: number; advertRejected: number };
  raiser: { machineId: string | null; isSelf: boolean; candidates: string[] };
  /** Episode machinery is a Session-B sub-unit — always null until it lands. */
  openEpisode: null;
  counters: { ticks: number; errors: number };
}

export class MachineCoherenceSentinel {
  private lastTickAtMs = 0;
  private ticks = 0;
  private errors = 0;
  /** Post-boot warm-up accounting (N8): ticks completed since construction. */
  private ticksSinceBoot = 0;
  private lastClassified: ClassifiedPeer[] = [];
  private lastRegisteredOnline = 0;
  private lastRaiser: string | null = null;
  private lastCandidates: string[] = [];

  constructor(
    private readonly deps: MachineCoherenceSentinelDeps,
    private readonly cfg: MachineCoherenceResolvedConfig,
  ) {}

  /**
   * Whether this tick is still inside the N8 post-boot warm-up window:
   * `MachinePoolRegistry` is in-memory, so a local restart wipes every peer's
   * advert until the next 30s pull — for `warmupTicks` after boot,
   * `unknown`/`advert-stale` classifications must count toward NOTHING (no
   * confirmation progress, no version-class grace clock). The classification
   * itself still runs (the status snapshot stays honest); the CONSUMERS of
   * warm-up (confirmation counters, Session B) read this flag.
   */
  inWarmup(): boolean {
    return this.ticksSinceBoot < this.cfg.warmupTicks;
  }

  /**
   * One evaluator tick (rides the existing 30s peerPresenceTick — no timer of
   * its own). Runs only when the guard resolves live or dry-run; the caller
   * owns the gate (a dark guard never constructs/ticks the sentinel). Fails
   * toward silence: any error increments the error counter and emits nothing.
   */
  tick(): void {
    this.ticks += 1;
    this.ticksSinceBoot += 1;
    const nowMs = (this.deps.now ?? Date.now)();
    this.lastTickAtMs = nowMs;
    try {
      const self = this.deps.selfMachineId();
      const online = this.deps.listCapacities().filter((c) => c.online);
      this.lastRegisteredOnline = online.length;
      // Single-machine strict no-op (§3.3): the comparison set is {self} —
      // short-circuit at fewer than 2 members BEFORE any state is touched.
      if (online.length < 2 || self === null) {
        this.lastClassified = [];
        this.lastRaiser = null;
        this.lastCandidates = [];
        return;
      }
      // Per-machine classification (M11 universe honesty: every ONLINE machine
      // is accounted — one that cannot be compared classifies `unknown`/
      // `advert-stale`/`advert-rejected`, surfaced, never silently coherent).
      this.lastClassified = online.map((c) => classifyPeer(c, nowMs, this.cfg.advertStaleMs));
      // §3.4 election: candidates are the machines whose guard posture reads
      // 'live'. Self's posture is known LOCALLY (resolved config — authoritative
      // over our own possibly-stale advert echo); peers' via their adverts.
      const selfLive = selfPostureOf(this.cfg) === 'live';
      const candidates = this.lastClassified
        .filter((p) => (p.machineId === self ? selfLive : p.advert?.guard === 'live'))
        .map((p) => p.machineId);
      this.lastCandidates = candidates;
      this.lastRaiser = electRaiser(candidates, this.deps.leaseHolderMachineId());
    } catch {
      // Fail toward silence (§3.3): no emit, a visible error counter.
      this.errors += 1;
    }
  }

  /** The §6 status snapshot (pure read — never mutates). */
  status(): MachineCoherenceStatus {
    const counts = { compared: 0, unknown: 0, advertStale: 0, advertRejected: 0 };
    for (const p of this.lastClassified) {
      if (p.cls === 'compared') counts.compared += 1;
      else if (p.cls === 'unknown') counts.unknown += 1;
      else if (p.cls === 'advert-stale') counts.advertStale += 1;
      else counts.advertRejected += 1;
    }
    const self = this.deps.selfMachineId();
    // Self is always comparable (§3.3): a below-2 pool reports compared=1.
    const machinesCompared = this.lastClassified.length === 0 ? (self !== null ? 1 : 0) : counts.compared;
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      lastTickAt: this.lastTickAtMs ? new Date(this.lastTickAtMs).toISOString() : null,
      machinesRegisteredOnline: this.lastRegisteredOnline,
      machinesCompared,
      peerClassifications: counts,
      raiser: {
        machineId: this.lastRaiser,
        isSelf: this.lastRaiser !== null && this.lastRaiser === self,
        candidates: [...this.lastCandidates],
      },
      openEpisode: null,
      counters: { ticks: this.ticks, errors: this.errors },
    };
  }
}
