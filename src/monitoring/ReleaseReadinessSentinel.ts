/**
 * ReleaseReadinessSentinel — Layer B of the release-readiness-visibility spec.
 *
 * Watches whether a release is blocked/stalling and makes it impossible to miss.
 * The original incident (2026-05-27): npm publishing silently stalled since
 * v1.3.26 — green merges, green CI, no published release, no alert. The publish
 * workflow's NEXT.md gate is a *silent skip*: a stalled release is
 * indistinguishable from "nothing to publish". This sentinel is the missing
 * visibility — a recurring, near-silent check that surfaces a stuck release as
 * a single, deduped, escalating Attention item.
 *
 * Design (spec §4.2):
 *   - Reads canonical `main` (FETCH_HEAD), not the local checkout, so a stale
 *     dev branch can't produce a false "all clear".
 *   - "Blocked" is decoupled from NEXT.md state (so Layer A's auto-draft can't
 *     silence the alarm by clearing the file): unreleased feature/fix commits
 *     exist AND the guide can't publish (missing/template/unreviewed), OR the
 *     analyzer reports critical/high coverage gaps.
 *   - Near-silent: silent below threshold (state + log only); ONE Attention
 *     item per stall episode above it, keyed on the OLDEST unreleased commit
 *     SHA (stable across ticks — not a resettable per-tick id), priority scaled
 *     by backlog age, 12h hysteresis on re-raise after an auto-resolve.
 *   - Fail-loud: any evaluation failure (fetch error, analyzer error) raises a
 *     low-priority Attention item — never a silent catch (that would re-create
 *     the exact bug this fixes).
 *   - Lifecycle owner: detect → surface → auto-resolve → reap, with
 *     resolveEpisodesInRange consulted by the publish-finalize path.
 *   - Repo-gated: needs an analyzable instar git repo (dev/maintainer env). On
 *     an npm-installed agent with no such repo the deps make the check inert.
 *   - Supervision: Tier 0 (mechanical computation + fixed-template wording).
 */

import { EventEmitter } from 'node:events';

/** Parsed subset of `analyze-release.js --json` the sentinel needs. */
export interface AnalyzerReport {
  lastTag: string;
  commitCount: number;
  analysis: {
    commitClassification: { features: number; fixes: number };
  };
  guideCoverage: { criticalGaps: number; highGaps: number };
}

export interface OldestCommit {
  sha: string;
  dateMs: number;
}

export interface ReadinessEpisode {
  /** Stable key: SHA of the oldest unreleased commit at first detection. */
  oldestSha: string;
  firstDetectedMs: number;
  /** Set when an Attention item was raised (age crossed the threshold). */
  openedMs?: number;
  attentionId?: string;
  lastPriority?: ReadinessPriority;
  resolvedMs?: number;
  resolvedReason?: 'published' | 'stale' | 'rolled-back' | 'cleared';
}

export interface ReadinessState {
  episodes: ReadinessEpisode[];
  /** Episodes resolved recently — used for the re-raise hysteresis window. */
  recentResolves: Array<{ oldestSha: string; resolvedMs: number }>;
  /** Last failure-episode key we signaled, to dedupe fail-loud notices. */
  lastFailureKey?: string;
  lastTickAt?: number;
  lastSignalAt?: number;
  cacheHeadSha?: string;
  canonicalRemoteOverridden?: boolean;
  /** Runtime kill-switch set by POST /release-readiness/rollback. When true,
   *  tick() no-ops without evaluating. Cleared by /release-readiness/enable. */
  disabled?: boolean;
  rollbackHistory?: Array<{ ts: number; sessionId?: string; sourceIp?: string; reason?: string }>;
}

export type ReadinessPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export interface AttentionItem {
  id: string;
  title: string;
  summary: string;
  category?: string;
  priority?: string;
}

export interface ReleaseReadinessSentinelDeps {
  /** Fetch canonical main; resolve FETCH_HEAD sha. ok:false ⇒ unreachable. */
  fetchCanonical(): Promise<{ ok: boolean; headSha?: string }>;
  /** Run analyze-release.js --json --ref against the canonical ref. null ⇒ error. */
  runAnalyzer(ref: string): Promise<AnalyzerReport | null>;
  /** Oldest unreleased feature/fix commit relative to lastTag..ref. */
  oldestUnreleasedCommit(lastTag: string, ref: string): Promise<OldestCommit | null>;
  /** True when the publish gate would refuse the guide (missing/template/unreviewed). */
  guideBlocksPublish(): Promise<boolean>;
  /** Best-effort: seed NEXT.md via Layer A (analyze-release.js --draft-guide). */
  draftGuide(ref: string): Promise<void>;
  /** Post an Attention item; resolves to true on delivery. */
  postAttention(item: AttentionItem): Promise<boolean>;
  /** Resolve an open Attention item by id. */
  resolveAttention(id: string, reason: string): Promise<boolean>;
  /** Load persisted state (or a fresh empty state). */
  loadState(): ReadinessState;
  /** Persist state atomically. */
  saveState(state: ReadinessState): void;
  /** Is `sha` an ancestor of `ref`? (for resolveEpisodesInRange) */
  isAncestor(sha: string, ref: string): Promise<boolean>;
  /** Append a structured audit line (sentinel-events.jsonl). */
  audit(event: Record<string, unknown>): void;
  now(): number;
}

export interface ReleaseReadinessSentinelConfig {
  enabled?: boolean;
  tickIntervalMs?: number;
  backlogAgeDaysSilent?: number;
  backlogAgeDaysLow?: number;
  backlogAgeDaysMedium?: number;
  backlogAgeDaysHigh?: number;
  hysteresisHours?: number;
  staleEpisodeTtlDays?: number;
  /**
   * Fast-trigger (RELEASE-FRAGMENT-GATE-SPEC Layer 2, D7): when the block is
   * specifically a missing release-note fragment (guideBlocksPublish) WITH
   * unreleased feature/fix work — the case where publish.yml would SILENTLY
   * SKIP — surface at LOW IMMEDIATELY instead of waiting out the multi-day age
   * floor. This closes the "fresh fragment-less merge sits silent for 2 days"
   * gap that the 2026-06-27 incident exposed. Default on.
   */
  fastTriggerOnGuideBlock?: boolean;
}

const DEFAULTS: Required<ReleaseReadinessSentinelConfig> = {
  enabled: false,
  tickIntervalMs: 6 * 60 * 60 * 1000, // 6h
  backlogAgeDaysSilent: 2,
  backlogAgeDaysLow: 2,
  backlogAgeDaysMedium: 4,
  backlogAgeDaysHigh: 7,
  hysteresisHours: 12,
  staleEpisodeTtlDays: 30,
  fastTriggerOnGuideBlock: true,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export class ReleaseReadinessSentinel extends EventEmitter {
  private readonly cfg: Required<ReleaseReadinessSentinelConfig>;
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: ReleaseReadinessSentinelDeps,
    cfg: ReleaseReadinessSentinelConfig = {},
  ) {
    super();
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  start(): void {
    if (!this.cfg.enabled || this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      void this.tick();
    }, this.cfg.tickIntervalMs);
    if (typeof this.tickHandle.unref === 'function') this.tickHandle.unref();
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Priority for a given backlog age, or null when below the silent threshold. */
  priorityForAge(ageDays: number): ReadinessPriority | null {
    if (ageDays >= this.cfg.backlogAgeDaysHigh) return 'HIGH';
    if (ageDays >= this.cfg.backlogAgeDaysMedium) return 'MEDIUM';
    if (ageDays >= this.cfg.backlogAgeDaysLow) return 'LOW';
    return null;
  }

  /** The cron entry point. Top-level catch converts any error into a loud signal. */
  async tick(): Promise<void> {
    const state = this.deps.loadState();
    state.lastTickAt = this.deps.now();
    if (state.disabled) {
      this.deps.audit({ kind: 'release-readiness', event: 'tick-skipped-disabled' });
      this.deps.saveState(state);
      return;
    }
    try {
      await this.evaluate(state);
      this.deps.saveState(state);
    } catch (err) {
      // Fail-loud — a silent catch here would re-create the very silent-failure
      // bug this sentinel exists to fix.
      await this.failLoud(state, 'tick', err);
      this.deps.saveState(state);
    }
  }

  /** Read-only snapshot of current state (for GET /release-readiness). */
  snapshot(): ReadinessState {
    return this.deps.loadState();
  }

  /**
   * Runtime kill-switch (POST /release-readiness/rollback). Disables future
   * ticks, resolves all open Attention items, and is ITSELF loud — raises a
   * HIGH-priority Attention item + audits — so the rollback can never be a
   * silent way to mute the alarm (iter-3 Adversarial V5).
   */
  async rollback(meta: { sessionId?: string; sourceIp?: string } = {}): Promise<void> {
    const state = this.deps.loadState();
    state.disabled = true;
    await this.resolveAll(state, 'rolled-back');
    state.rollbackHistory ??= [];
    state.rollbackHistory.push({ ts: this.deps.now(), sessionId: meta.sessionId, sourceIp: meta.sourceIp, reason: 'rollback' });
    this.deps.audit({ kind: 'release-readiness', event: 'rollback', sessionId: meta.sessionId, sourceIp: meta.sourceIp });
    await this.deps.postAttention({
      id: 'release-readiness-rolled-back',
      title: 'Release-readiness alarm disabled',
      summary: `The release-readiness watchdog was disabled via /release-readiness/rollback${meta.sessionId ? ` by session ${meta.sessionId}` : ''} at ${new Date(this.deps.now()).toISOString()}. Re-enable via POST /release-readiness/enable.`,
      category: 'degradation',
      priority: 'HIGH',
    });
    this.deps.saveState(state);
  }

  /** Re-arm after a rollback. */
  enable(): void {
    const state = this.deps.loadState();
    state.disabled = false;
    this.deps.audit({ kind: 'release-readiness', event: 'enabled' });
    this.deps.saveState(state);
  }

  private async evaluate(state: ReadinessState): Promise<void> {
    const fetched = await this.deps.fetchCanonical();
    if (!fetched.ok) {
      await this.failLoud(state, 'fetch', new Error('canonical ref unreachable'));
      return;
    }
    state.cacheHeadSha = fetched.headSha;
    const ref = fetched.headSha ?? 'FETCH_HEAD';

    // Keep NEXT.md seeded (Layer A). Best-effort: a draft failure is not a
    // readiness failure.
    try {
      await this.deps.draftGuide(ref);
    } catch {
      /* draft is advisory; the readiness signal below is what matters */
    }

    const report = await this.deps.runAnalyzer(ref);
    if (!report) {
      await this.failLoud(state, 'analyzer', new Error('analyze-release returned no report'));
      return;
    }

    const guideBlocks = await this.deps.guideBlocksPublish();
    const blocked = this.isBlocked(report, guideBlocks);
    if (!blocked) {
      // Backlog clear — resolve any open episodes.
      await this.resolveAll(state, 'cleared');
      // A successful evaluation clears any prior fail-loud episode.
      state.lastFailureKey = undefined;
      this.reap(state);
      return;
    }

    const oldest = await this.deps.oldestUnreleasedCommit(report.lastTag, ref);
    if (!oldest) {
      // Blocked by coverage gaps but no datable commit — surface at LOW.
      await this.raiseGapOnly(state, report);
      this.reap(state);
      return;
    }

    const ageDays = (this.deps.now() - oldest.dateMs) / DAY_MS;
    const ageBasedPriority = this.priorityForAge(ageDays);

    // Fast-trigger (D7): a missing-fragment block with unreleased feature/fix
    // work is the SILENT-SKIP case — surface at LOW immediately, bypassing the
    // multi-day age floor, instead of letting a fresh fragment-less merge sit
    // silent for days (the 2026-06-27 gap).
    const featureOrFix =
      report.analysis.commitClassification.features + report.analysis.commitClassification.fixes;
    const fastTriggered =
      this.cfg.fastTriggerOnGuideBlock && guideBlocks && featureOrFix > 0 && !ageBasedPriority;
    const priority: ReadinessPriority | null = ageBasedPriority ?? (fastTriggered ? 'LOW' : null);

    let episode = state.episodes.find((e) => e.oldestSha === oldest.sha && !e.resolvedMs);
    if (!episode) {
      episode = { oldestSha: oldest.sha, firstDetectedMs: this.deps.now() };
      state.episodes.push(episode);
    }

    if (!priority) {
      // Below the silent threshold AND not a fast-trigger case — recorded, no message.
      this.reap(state);
      return;
    }

    // Hysteresis: don't re-raise the same sha within the window of a recent resolve.
    const recent = state.recentResolves.find((r) => r.oldestSha === oldest.sha);
    if (recent && this.deps.now() - recent.resolvedMs < this.cfg.hysteresisHours * HOUR_MS && !episode.openedMs) {
      this.reap(state);
      return;
    }

    if (!episode.openedMs || episode.lastPriority !== priority) {
      const id = episode.attentionId ?? `release-readiness-${oldest.sha.slice(0, 12)}`;
      const days = Math.floor(ageDays);
      const delivered = await this.deps.postAttention({
        id,
        title: 'Release blocked — unreleased work is piling up',
        summary:
          `${report.analysis.commitClassification.features + report.analysis.commitClassification.fixes} ` +
          `unreleased feature/fix commit(s) since ${report.lastTag}; oldest is ${days} day(s) old and publishing is blocked ` +
          `(NEXT.md needs review/coverage). Oldest commit ${oldest.sha.slice(0, 12)}.`,
        category: 'degradation',
        priority,
      });
      episode.openedMs = episode.openedMs ?? this.deps.now();
      episode.attentionId = id;
      episode.lastPriority = priority;
      state.lastSignalAt = this.deps.now();
      this.deps.audit({ kind: 'release-readiness', event: 'signal', oldestSha: oldest.sha, priority, ageDays: days, delivered, fastTriggered });
      this.emit('signal', { oldestSha: oldest.sha, priority, fastTriggered });
    }
    this.reap(state);
  }

  private isBlocked(report: AnalyzerReport, guideBlocks: boolean): boolean {
    const featureOrFix =
      report.analysis.commitClassification.features + report.analysis.commitClassification.fixes;
    const backlogBlocked = featureOrFix > 0 && guideBlocks;
    const coverageBlocked = report.guideCoverage.criticalGaps + report.guideCoverage.highGaps > 0;
    return backlogBlocked || coverageBlocked;
  }

  private async raiseGapOnly(state: ReadinessState, report: AnalyzerReport): Promise<void> {
    const id = 'release-readiness-coverage-gaps';
    let episode = state.episodes.find((e) => e.oldestSha === id && !e.resolvedMs);
    if (!episode) {
      episode = { oldestSha: id, firstDetectedMs: this.deps.now() };
      state.episodes.push(episode);
    }
    if (!episode.openedMs) {
      const delivered = await this.deps.postAttention({
        id,
        title: 'Release blocked — upgrade-guide coverage gaps',
        summary: `analyze-release reports ${report.guideCoverage.criticalGaps + report.guideCoverage.highGaps} critical/high coverage gap(s) in the upgrade guide. Publishing is blocked until they are addressed.`,
        category: 'degradation',
        priority: 'LOW',
      });
      episode.openedMs = this.deps.now();
      episode.attentionId = id;
      episode.lastPriority = 'LOW';
      state.lastSignalAt = this.deps.now();
      this.deps.audit({ kind: 'release-readiness', event: 'signal-gaps', delivered });
    }
  }

  private async failLoud(state: ReadinessState, stage: string, err: unknown): Promise<void> {
    const key = `failure:${stage}`;
    this.deps.audit({ kind: 'release-readiness', event: 'eval-failed', stage, error: String(err) });
    if (state.lastFailureKey === key) return; // dedupe per failure episode
    state.lastFailureKey = key;
    await this.deps.postAttention({
      id: `release-readiness-eval-failure-${stage}`,
      title: 'Release-readiness check could not evaluate',
      summary: `The release-readiness check failed at the "${stage}" stage: ${String(err)}. Last evaluated ${state.lastSignalAt ? new Date(state.lastSignalAt).toISOString() : 'never'}.`,
      category: 'degradation',
      priority: 'LOW',
    });
    state.lastSignalAt = this.deps.now();
    this.emit('eval-failed', { stage });
  }

  private async resolveAll(state: ReadinessState, reason: ReadinessEpisode['resolvedReason']): Promise<void> {
    for (const e of state.episodes) {
      if (e.resolvedMs) continue;
      if (e.attentionId) await this.deps.resolveAttention(e.attentionId, reason ?? 'cleared');
      e.resolvedMs = this.deps.now();
      e.resolvedReason = reason;
      state.recentResolves.push({ oldestSha: e.oldestSha, resolvedMs: this.deps.now() });
      this.deps.audit({ kind: 'release-readiness', event: 'resolved', oldestSha: e.oldestSha, reason });
    }
  }

  /**
   * Called by the publish-finalize path (and the /rollback route via 'rolled-back').
   * Resolves every open episode whose oldestSha is an ancestor of newTagSha —
   * correct even when the oldest-unreleased SHA churned during the open window.
   */
  async resolveEpisodesInRange(newTagSha: string, reason: ReadinessEpisode['resolvedReason'] = 'published'): Promise<void> {
    const state = this.deps.loadState();
    let changed = false;
    for (const e of state.episodes) {
      if (e.resolvedMs) continue;
      if (e.oldestSha.startsWith('release-readiness-')) continue; // synthetic (gap) episodes
      const ancestor = await this.deps.isAncestor(e.oldestSha, newTagSha);
      if (ancestor) {
        if (e.attentionId) await this.deps.resolveAttention(e.attentionId, reason ?? 'published');
        e.resolvedMs = this.deps.now();
        e.resolvedReason = reason;
        state.recentResolves.push({ oldestSha: e.oldestSha, resolvedMs: this.deps.now() });
        this.deps.audit({ kind: 'release-readiness', event: 'resolved-in-range', oldestSha: e.oldestSha, newTagSha, reason });
        changed = true;
      }
    }
    if (changed) this.deps.saveState(state);
  }

  /** TTL-reap episodes/resolves so state doesn't grow unbounded. */
  private reap(state: ReadinessState): void {
    const ttl = this.cfg.staleEpisodeTtlDays * DAY_MS;
    const now = this.deps.now();
    for (const e of state.episodes) {
      if (!e.resolvedMs && now - e.firstDetectedMs > ttl) {
        // Backlog vanished without a finalize (e.g. branch abandoned) — reap loudly.
        e.resolvedMs = now;
        e.resolvedReason = 'stale';
        if (e.attentionId) void this.deps.resolveAttention(e.attentionId, 'stale');
        this.deps.audit({ kind: 'release-readiness', event: 'reaped-stale', oldestSha: e.oldestSha });
      }
    }
    state.episodes = state.episodes.filter((e) => !e.resolvedMs || now - (e.resolvedMs ?? 0) < ttl);
    state.recentResolves = state.recentResolves.filter((r) => now - r.resolvedMs < this.cfg.hysteresisHours * HOUR_MS * 2);
    if ((state.rollbackHistory?.length ?? 0) > 50) {
      state.rollbackHistory = state.rollbackHistory!.slice(-50);
    }
  }

  static emptyState(): ReadinessState {
    return { episodes: [], recentResolves: [] };
  }
}
