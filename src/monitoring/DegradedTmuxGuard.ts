/**
 * DegradedTmuxGuard — the (C) signal-only watcher for a degraded shared tmux server.
 *
 * The failure it closes (2026-06-21/22): the machine runs ONE shared tmux server for
 * every agent. When that server gets slow (a wedged client, a thundering pane, a host
 * under heavy I/O), every synchronous tmux call on the event loop blocks for seconds —
 * the ~0-CPU I/O-wait that #1240's CPU check and the load heuristics cannot see. The (A)
 * async wrapper bounds each call at 9s + SIGKILL and the (B) marker re-labels the drift as
 * a stall, but neither tells the OPERATOR that the shared socket is sick. This guard is the
 * heads-up: it watches the (A) call-latency feed and the (B) `stall` signal, and when the
 * shared tmux server is corroboratedly degraded it raises ONE deduped agent-health
 * Attention item. It is SIGNAL-ONLY — any actual tmux refresh is the operator's explicit
 * Y/N. It NEVER kills the shared socket (the 2026-06-22 lesson: a `tmux kill-server` would
 * take down EVERY agent on the machine).
 *
 * Bounded Accumulation: the latency window is a FIXED-capacity ring (modulo write index,
 * overwrite-in-place — never push-and-shift, which momentarily grows under a burst) plus an
 * EWMA scalar. No unbounded array can grow under sustained load (the burst-invariant CI gate
 * proves the ring length never exceeds windowSize across 10k samples).
 *
 * Signal-vs-Authority: the EWMA + corroboration + load gate are DETECTORS. The only automated
 * action is ONE deduped agent-health Attention item through the existing
 * MessagingToneGate/createAttentionItem authority — no new blocking authority is introduced.
 *
 * Spec: docs/specs/tmux-event-loop-resilience-spec.md (§C). developmentAgent dark-feature gate:
 * the config OMITS `enabled`, so resolveDevAgentGate runs it LIVE on a dev agent and DARK on
 * the fleet. GET /degraded-tmux exposes the in-memory snapshot.
 */

import { EventEmitter } from 'node:events';
import type { StallEvent } from '../core/SleepWakeDetector.js';

/** The outcome classification the (A) tmux wrapper reports for each call. */
export type TmuxCallOutcome = 'success' | 'killed-client' | 'indeterminate';

/** A degraded-tmux episode raised to the operator (the Attention payload shape). */
export interface DegradedTmuxEpisode {
  /** Stable per-episode id (machine-tagged + episode counter). */
  id: string;
  /** Wall-clock (ms) the episode opened. */
  openedAtMs: number;
  /** Wall-clock (ms) of the most recent raise (open or age-escalation). */
  lastRaisedAtMs: number;
  /** How long the degradation has persisted at the latest raise (ms). */
  ageMs: number;
  /** The EWMA call latency (ms) at the latest raise. */
  ewmaMs: number;
  /** Consecutive corroborating slow cycles at the latest raise. */
  consecutiveSlowCycles: number;
}

export interface DegradedTmuxGuardConfig {
  /** developmentAgent-gated at the wiring site; OMITTED from ConfigDefaults. */
  enabled?: boolean;
  /** Fixed ring capacity for the latency window. Default 64. */
  windowSize?: number;
  /** EWMA smoothing factor (0..1). Higher ⇒ more weight on the latest sample. Default 0.3. */
  ewmaAlpha?: number;
  /** A call/EWMA at/above this (ms) is "slow". Default 9000 (matches the (A) per-call timeout). */
  slowCallThresholdMs?: number;
  /** Consecutive corroborating slow cycles required to open an episode. Default 3. */
  episodeCorroborationCycles?: number;
  /** Above this `loadavg[0]/cores` ratio, corroboration does NOT advance (busy-box clause). Default 1.5. */
  loadGateMaxLoadPerCore?: number;
  /** While an episode is open, re-raise (age-escalate) at most every this many ms. Default 30 min. */
  episodeEscalateIntervalMs?: number;
  /** Samples within this window (ms) of an onRefresh() are excluded from corroboration. Default 60s. */
  settleWindowMs?: number;
}

export interface DegradedTmuxGuardDeps {
  /** Raise ONE deduped agent-health Attention item for an episode. Wrapped in try/catch by the guard. */
  raiseAttention: (ep: DegradedTmuxEpisode) => void;
  /** Current `loadavg[0]/cores` ratio (the same signal as SleepWakeDetector.maxLoadRatio). */
  loadPerCore: () => number;
  /** Optional injectable clock (tests). Default Date.now. */
  now?: () => number;
}

/** Class defaults — absence of a config value falls back to these (runtime fallback, not config). */
const DEFAULTS = {
  windowSize: 64,
  ewmaAlpha: 0.3,
  slowCallThresholdMs: 9000,
  episodeCorroborationCycles: 3,
  loadGateMaxLoadPerCore: 1.5,
  episodeEscalateIntervalMs: 30 * 60 * 1000,
  settleWindowMs: 60 * 1000,
} as const;

/**
 * Signal-only degraded-tmux watcher. Bounded fixed-capacity ring + EWMA; never kills tmux.
 */
export class DegradedTmuxGuard extends EventEmitter {
  private readonly enabled: boolean;
  private readonly windowSize: number;
  private readonly ewmaAlpha: number;
  private readonly slowCallThresholdMs: number;
  private readonly episodeCorroborationCycles: number;
  private readonly loadGateMaxLoadPerCore: number;
  private readonly episodeEscalateIntervalMs: number;
  private readonly settleWindowMs: number;
  private readonly deps: DegradedTmuxGuardDeps;
  private readonly now: () => number;

  // ── Bounded latency window: a FIXED-capacity ring (modulo write, overwrite-in-place). ──
  private readonly ring: number[];
  private ringWrite = 0;
  private ringCount = 0;
  /** EWMA of call latency (ms); null until the first sample. */
  private ewmaMs: number | null = null;

  // ── Observability counters (all O(1), never arrays). ──
  private slowCallCount = 0;
  private killedClientCount = 0;
  private staleCount = 0;
  private totalSamples = 0;
  private episodesRaised = 0;
  private lastTickAt = 0;

  // ── Corroboration + episode state. ──
  private consecutiveSlowCycles = 0;
  /** A stall arriving this cycle forces the cycle degraded (a corroborating slow cycle). */
  private stallThisCycle = false;
  private openEpisode: DegradedTmuxEpisode | null = null;
  private episodeCounter = 0;
  /** Wall-clock (ms) of the most recent onRefresh(); drives the settle-window exclusion. */
  private lastRefreshAt = 0;

  constructor(config: DegradedTmuxGuardConfig | undefined, deps: DegradedTmuxGuardDeps) {
    super();
    const c = config ?? {};
    this.enabled = c.enabled ?? false;
    this.windowSize = c.windowSize && c.windowSize > 0 ? Math.floor(c.windowSize) : DEFAULTS.windowSize;
    this.ewmaAlpha =
      typeof c.ewmaAlpha === 'number' && c.ewmaAlpha > 0 && c.ewmaAlpha <= 1 ? c.ewmaAlpha : DEFAULTS.ewmaAlpha;
    this.slowCallThresholdMs =
      typeof c.slowCallThresholdMs === 'number' && c.slowCallThresholdMs > 0
        ? c.slowCallThresholdMs
        : DEFAULTS.slowCallThresholdMs;
    this.episodeCorroborationCycles =
      typeof c.episodeCorroborationCycles === 'number' && c.episodeCorroborationCycles > 0
        ? Math.floor(c.episodeCorroborationCycles)
        : DEFAULTS.episodeCorroborationCycles;
    this.loadGateMaxLoadPerCore =
      typeof c.loadGateMaxLoadPerCore === 'number' && c.loadGateMaxLoadPerCore > 0
        ? c.loadGateMaxLoadPerCore
        : DEFAULTS.loadGateMaxLoadPerCore;
    this.episodeEscalateIntervalMs =
      typeof c.episodeEscalateIntervalMs === 'number' && c.episodeEscalateIntervalMs > 0
        ? c.episodeEscalateIntervalMs
        : DEFAULTS.episodeEscalateIntervalMs;
    this.settleWindowMs =
      typeof c.settleWindowMs === 'number' && c.settleWindowMs >= 0 ? c.settleWindowMs : DEFAULTS.settleWindowMs;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    // FIXED-capacity ring allocated ONCE. It never grows — the burst-invariant guarantee.
    this.ring = new Array<number>(this.windowSize).fill(0);
  }

  /**
   * (B) feed — a `stall` from SleepWakeDetector is ONE corroborating slow cycle (the
   * event-loop was blocked while a sync tmux op was in flight). NEVER throws.
   */
  onStall(e: StallEvent): void {
    try {
      if (!this.enabled) return;
      // A stall is a slow CYCLE, not a single call — record its duration into the EWMA so a
      // genuine multi-second block pulls the average toward degraded, then mark the cycle.
      const durationMs = Math.max(0, Math.round((e?.stallSeconds ?? 0) * 1000));
      if (durationMs > 0) this.recordLatency(durationMs);
      this.stallThisCycle = true;
      this.lastTickAt = this.now();
      this.evaluate();
    } catch {
      /* signal-only — a guard throw must never crash the detector tick */
    }
  }

  /**
   * (A) feed — every hot-path tmux call reports its wall-duration + outcome. NEVER throws.
   * A sample within `settleWindowMs` of an onRefresh() is recorded for liveness but EXCLUDED
   * from corroboration (the refresh deliberately stirs tmux; don't count its own latency).
   */
  observeTmuxCall(durationMs: number, outcome: TmuxCallOutcome): void {
    try {
      if (!this.enabled) return;
      const ts = this.now();
      this.lastTickAt = ts;
      const d = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
      this.recordLatency(d);
      if (outcome === 'killed-client') this.killedClientCount += 1;
      else if (outcome === 'indeterminate') this.staleCount += 1;
      const inSettleWindow = this.settleWindowMs > 0 && ts - this.lastRefreshAt < this.settleWindowMs;
      if (inSettleWindow) {
        // Liveness recorded (lastTickAt bumped, EWMA updated) but corroboration is NOT advanced.
        return;
      }
      this.evaluate();
    } catch {
      /* signal-only — a guard throw must never crash (A)'s wrapper */
    }
  }

  /** Operator-authorized refresh just happened: start the settle window. Signal-only hook. */
  onRefresh(): void {
    this.lastRefreshAt = this.now();
  }

  /** Record a latency sample into the bounded ring + EWMA + slow-call counter. */
  private recordLatency(durationMs: number): void {
    // Overwrite-in-place at the modulo index — the ring length is constant; it NEVER grows.
    this.ring[this.ringWrite] = durationMs;
    this.ringWrite = (this.ringWrite + 1) % this.windowSize;
    if (this.ringCount < this.windowSize) this.ringCount += 1;
    this.ewmaMs = this.ewmaMs === null ? durationMs : this.ewmaAlpha * durationMs + (1 - this.ewmaAlpha) * this.ewmaMs;
    this.totalSamples += 1;
    if (durationMs >= this.slowCallThresholdMs) this.slowCallCount += 1;
  }

  /** Current load ratio, defensively (a throw/non-finite ⇒ 0 = not load-gated). */
  private currentLoadPerCore(): number {
    try {
      const v = this.deps.loadPerCore();
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      // @silent-fallback-ok: a load-probe failure defaults to 0 (= not load-gated) so the
      // signal-only guard never crashes the detector tick; the worst case is one calm,
      // deduped agent-health Attention item raised under load that would otherwise have been
      // gated — never a destructive action (the guard NEVER kills the shared socket).
      return 0;
    }
  }

  /**
   * The SINGLE decision point. Runs after every (non-settle-window) ingest:
   *   1. load gate — under heavy host load, do NOT advance corroboration (busy-box clause).
   *   2. degraded = EWMA at/above threshold OR a stall arrived this cycle.
   *   3. N-cycle corroboration — degraded+not-gated ⇒ ++; a clean cycle resets AND closes any open episode.
   *   4. at >= corroborationCycles with no open episode ⇒ open + raise.
   *   5. age-escalation — while open, re-raise at the escalate cadence with the escalated age.
   */
  private evaluate(): void {
    const ts = this.now();
    const stallThisCycle = this.stallThisCycle;
    this.stallThisCycle = false; // consume the per-cycle stall flag

    // (1) Load gate — a busy host slows tmux for reasons unrelated to a sick socket; the
    // incident machine runs 5+ agents. Do NOT advance corroboration while over the threshold.
    if (this.currentLoadPerCore() > this.loadGateMaxLoadPerCore) {
      return;
    }

    // (2) Degraded this cycle?
    const degraded = (this.ewmaMs !== null && this.ewmaMs >= this.slowCallThresholdMs) || stallThisCycle;

    if (!degraded) {
      // (3a) A clean cycle resets corroboration AND closes any open episode (recovery).
      this.consecutiveSlowCycles = 0;
      if (this.openEpisode) {
        this.openEpisode = null;
      }
      return;
    }

    // (3b) Corroborating slow cycle.
    this.consecutiveSlowCycles += 1;

    if (this.consecutiveSlowCycles >= this.episodeCorroborationCycles) {
      if (!this.openEpisode) {
        // (4) Open a fresh episode + raise ONE deduped item.
        this.episodeCounter += 1;
        const ep: DegradedTmuxEpisode = {
          id: `ep${this.episodeCounter}`,
          openedAtMs: ts,
          lastRaisedAtMs: ts,
          ageMs: 0,
          ewmaMs: Math.round(this.ewmaMs ?? 0),
          consecutiveSlowCycles: this.consecutiveSlowCycles,
        };
        this.openEpisode = ep;
        this.raiseEpisode(ep);
      } else if (ts - this.openEpisode.lastRaisedAtMs >= this.episodeEscalateIntervalMs) {
        // (5) Age-escalation: re-raise the SAME episode (same healthKey/sourceContext) with the
        // escalated age so the operator learns it has persisted, never a new-episode spam.
        this.openEpisode.lastRaisedAtMs = ts;
        this.openEpisode.ageMs = ts - this.openEpisode.openedAtMs;
        this.openEpisode.ewmaMs = Math.round(this.ewmaMs ?? 0);
        this.openEpisode.consecutiveSlowCycles = this.consecutiveSlowCycles;
        this.raiseEpisode(this.openEpisode);
      }
    }
  }

  /** Wrap the operator-notify dep so a notify throw can never crash an ingest path. */
  private raiseEpisode(ep: DegradedTmuxEpisode): void {
    this.episodesRaised += 1;
    try {
      this.deps.raiseAttention(ep);
    } catch {
      /* signal-only — a notify failure is swallowed; the episode state is already recorded */
    }
    this.emit('episode', ep);
  }

  /**
   * Sync in-memory runtime read for the GuardRegistry (GET /guards). MUST stay a cheap
   * property read — no I/O, no listing (the SocketDisconnectSentinel.guardStatus contract).
   */
  guardStatus(): { enabled: boolean; lastTickAt: number } {
    return { enabled: this.enabled, lastTickAt: this.lastTickAt };
  }

  /** Pure in-memory snapshot for an optional GET /degraded-tmux. No I/O. */
  snapshot(): {
    enabled: boolean;
    windowSize: number;
    ringCount: number;
    ewmaMs: number | null;
    slowCallThresholdMs: number;
    consecutiveSlowCycles: number;
    episodeOpen: boolean;
    openEpisode: DegradedTmuxEpisode | null;
    slowCallCount: number;
    killedClientCount: number;
    staleCount: number;
    totalSamples: number;
    episodesRaised: number;
    lastTickAt: number;
  } {
    return {
      enabled: this.enabled,
      windowSize: this.windowSize,
      ringCount: this.ringCount,
      ewmaMs: this.ewmaMs === null ? null : Math.round(this.ewmaMs),
      slowCallThresholdMs: this.slowCallThresholdMs,
      consecutiveSlowCycles: this.consecutiveSlowCycles,
      episodeOpen: this.openEpisode !== null,
      openEpisode: this.openEpisode ? { ...this.openEpisode } : null,
      slowCallCount: this.slowCallCount,
      killedClientCount: this.killedClientCount,
      staleCount: this.staleCount,
      totalSamples: this.totalSamples,
      episodesRaised: this.episodesRaised,
      lastTickAt: this.lastTickAt,
    };
  }
}
