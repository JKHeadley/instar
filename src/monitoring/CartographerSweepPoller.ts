/**
 * CartographerSweepPoller — the cadence + breaker + re-escalation wrapper around
 * the CartographerSweepEngine (spec #2, doc-freshness). Mirrors TokenLedgerPoller:
 * an in-process, idle-aware, reentrancy-guarded poller constructed in server.ts
 * beside the other background pollers. Ships dark behind
 * `cartographer.freshnessSweep.enabled` (which itself rides `cartographer.enabled`).
 *
 * Why a poller and not a scheduler Job: a spawned session can reach none of the
 * in-process setSummary()/LlmQueue/IntelligenceRouter routing. The poller runs in
 * the AgentServer process so all author writes go through the one CartographerTree
 * instance (single in-process writer).
 *
 * The breaker (Eternal-Sentinel rule — never-give-up must not mean
 * never-tell-anyone): after `zeroProgressTicksToBreak` consecutive ticks that
 * author ZERO nodes despite having candidates (model rejects everything /
 * rate-limited / routing-refused), the poller backs off its cadence (the idle
 * lane) and emits ONE degradation notice, then re-escalates once per
 * `breakerReescalateHours` of continuous stall — not silence forever. The
 * backed-off probe is constant-cost and re-runs the engine's routing probe, so it
 * never silently routes to Claude.
 */
import { IdleAwareCadence } from './IdleAwareCadence.js';
import type { CartographerSweepEngine, SweepPassResult } from '../core/CartographerSweepEngine.js';

export interface CartographerSweepDegradation {
  feature: string;
  primary: string;
  fallback: string;
  reason: string;
  impact: string;
}

export interface CartographerSweepPollerOptions {
  engine: CartographerSweepEngine;
  /** Full cadence while there is work (default 600000 = 10 min). */
  cadenceMs?: number;
  /** Backed-off cadence while idle (no candidates) or breaker-open (default 30 min). */
  idleCadenceMs?: number;
  /** Consecutive zero-author-with-candidates ticks before the breaker opens (default 3). */
  zeroProgressTicksToBreak?: number;
  /** Re-escalate a continuous stall at most once per this many hours (default 6). */
  breakerReescalateHours?: number;
  /** Consecutive zero-candidate ticks before backing off to the idle cadence (default 2). */
  idleAfterZeroCandidateTicks?: number;
  onError?: (err: unknown) => void;
  reportDegradation?: (d: CartographerSweepDegradation) => void;
  log?: (msg: string) => void;
  now?: () => number;
}

export class CartographerSweepPoller {
  private readonly engine: CartographerSweepEngine;
  private readonly cadenceMs: number;
  private readonly idleCadenceMs: number;
  private readonly zeroProgressTicksToBreak: number;
  private readonly reescalateMs: number;
  private readonly idleAfterZeroCandidateTicks: number;
  private readonly onError: (err: unknown) => void;
  private readonly reportDegradation: ((d: CartographerSweepDegradation) => void) | null;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  private cadence: IdleAwareCadence | null = null;
  private running = false;

  private zeroProgressTicks = 0;
  private consecutiveZeroCandidate = 0;
  private breakerOpen = false;
  private breakerOpenedAt: number | null = null;
  private lastEscalateAt: number | null = null;
  private lastCandidateCount = 0;
  private backlogGrowthTicks = 0;

  constructor(opts: CartographerSweepPollerOptions) {
    this.engine = opts.engine;
    this.cadenceMs = opts.cadenceMs && opts.cadenceMs > 0 ? opts.cadenceMs : 600_000;
    this.idleCadenceMs = opts.idleCadenceMs && opts.idleCadenceMs > 0 ? opts.idleCadenceMs : 30 * 60_000;
    this.zeroProgressTicksToBreak = opts.zeroProgressTicksToBreak ?? 3;
    this.reescalateMs = (opts.breakerReescalateHours ?? 6) * 60 * 60_000;
    this.idleAfterZeroCandidateTicks = opts.idleAfterZeroCandidateTicks ?? 2;
    this.onError = opts.onError ?? ((err) => console.warn('[cartographer-sweep] error:', err));
    this.reportDegradation = opts.reportDegradation ?? null;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.parse(new Date().toISOString()));
  }

  start(): void {
    if (this.cadence) return;
    this.cadence = new IdleAwareCadence({
      activeMs: this.cadenceMs,
      idleMs: this.idleCadenceMs,
      // Back off when broken OR when there's been no work for a few ticks.
      isIdle: () => this.breakerOpen || this.consecutiveZeroCandidate >= this.idleAfterZeroCandidateTicks,
      tick: () => this.tick(),
    });
    this.cadence.start();
  }

  stop(): void {
    if (this.cadence) { this.cadence.stop(); this.cadence = null; }
  }

  /** Visible for tests + the breaker logic. */
  isBreakerOpen(): boolean { return this.breakerOpen; }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.breakerOpen) {
        await this.brokenTick();
        return;
      }
      const r = await this.runPass();
      if (!r) return;
      this.updateBacklogTrend(r);
      this.classifyProgress(r);
    } catch (err) {
      // @silent-fallback-ok — a tick error is reported via onError (the injected
      // logger) and the tick is retried on the next cadence; the breaker +
      // reportDegradation are the user-facing surface for a *sustained* stall.
      // A single transient tick failure is not a degradation to announce.
      this.onError(err);
    } finally {
      this.running = false;
    }
  }

  private async runPass(): Promise<SweepPassResult | null> {
    try {
      return await this.engine.runPass();
    } catch (err) {
      // @silent-fallback-ok — reported via onError; null signals the caller to
      // skip this tick's classification. The next tick retries; a sustained
      // failure trips the breaker (the real degradation surface).
      this.onError(err);
      return null;
    }
  }

  private classifyProgress(r: SweepPassResult): void {
    // Not the lease holder → inert; don't accrue stall (another machine authors).
    if (!r.ranAuthorPath && !r.refused) { return; }

    const authoredSomething = r.authored + r.fingerprintRefreshed > 0;
    if (r.candidateCount === 0 && !r.refused) {
      // Genuinely nothing to do — not a stall.
      this.consecutiveZeroCandidate += 1;
      this.zeroProgressTicks = 0;
      return;
    }
    this.consecutiveZeroCandidate = 0;

    if (authoredSomething) {
      this.zeroProgressTicks = 0;
      return;
    }
    // Had candidates (or routing refused) but authored zero → stall progress.
    this.zeroProgressTicks += 1;
    if (this.zeroProgressTicks >= this.zeroProgressTicksToBreak) {
      this.openBreaker(r);
    }
  }

  private updateBacklogTrend(r: SweepPassResult): void {
    if (r.candidateCount > this.lastCandidateCount && this.lastCandidateCount > 0) {
      this.backlogGrowthTicks += 1;
      if (this.backlogGrowthTicks === 3) {
        this.log(`[cartographer-sweep] backlog growing ${this.lastCandidateCount}→${r.candidateCount} over 3 ticks — drain rate may be below stale-arrival rate`);
        this.reportDegradation?.({
          feature: 'CartographerSweep',
          primary: 'background sweep keeps the doc-tree fresh',
          fallback: 'the stale backlog is growing faster than it is drained',
          reason: `candidate backlog grew for 3 consecutive ticks (now ${r.candidateCount})`,
          impact: 'parts of the code map are drifting stale; raise maxNodesPerPass or cadence',
        });
      }
    } else {
      this.backlogGrowthTicks = 0;
    }
    this.lastCandidateCount = r.candidateCount;
  }

  private openBreaker(r: SweepPassResult): void {
    this.breakerOpen = true;
    this.breakerOpenedAt = this.now();
    this.lastEscalateAt = this.now();
    const reason = r.refused
      ? (r.refusalReason ?? 'routing refused')
      : `${this.zeroProgressTicks} consecutive ticks authored zero nodes (model rejecting every attempt)`;
    this.log(`[cartographer-sweep] breaker OPEN — backing off cadence. ${reason}`);
    this.reportDegradation?.({
      feature: 'CartographerSweep',
      primary: 'background sweep authors doc-tree summaries on a light off-Claude model',
      fallback: 'the sweep is stalled and not authoring (backed off, will retry)',
      reason,
      impact: 'the code map will not refresh until the author model / routing recovers',
    });
  }

  private closeBreaker(): void {
    if (!this.breakerOpen) return;
    this.breakerOpen = false;
    this.breakerOpenedAt = null;
    this.lastEscalateAt = null;
    this.zeroProgressTicks = 0;
    this.log('[cartographer-sweep] breaker CLOSED — authoring resumed.');
  }

  /** While broken: constant-cost probe; never authors on Claude. Try a real pass only if routing is OK. */
  private async brokenTick(): Promise<void> {
    const probe = this.engine.probeRouting();
    if (!probe.ok) { this.maybeReescalate(); return; }
    const r = await this.runPass();
    if (r && r.authored + r.fingerprintRefreshed > 0) {
      this.closeBreaker();
    } else {
      this.maybeReescalate();
    }
  }

  private maybeReescalate(): void {
    const now = this.now();
    if (this.lastEscalateAt != null && now - this.lastEscalateAt >= this.reescalateMs) {
      this.lastEscalateAt = now;
      const stalledHours = this.breakerOpenedAt != null ? Math.round((now - this.breakerOpenedAt) / 3_600_000) : 0;
      this.log(`[cartographer-sweep] still stalled after ~${stalledHours}h — re-escalating.`);
      this.reportDegradation?.({
        feature: 'CartographerSweep',
        primary: 'background sweep authors doc-tree summaries',
        fallback: 'the sweep has been stalled and not authoring',
        reason: `continuous stall for ~${stalledHours}h (author model still unavailable/refusing)`,
        impact: 'the code map remains un-refreshed; check off-Claude framework availability',
      });
    }
  }
}
