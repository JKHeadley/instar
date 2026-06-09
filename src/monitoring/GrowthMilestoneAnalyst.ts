// GrowthMilestoneAnalyst — the proactive "growth & milestone" analyst.
//
// WHY THIS EXISTS (grounded requirement, Justin 2026-06-06, topic 21624):
// Instar built excellent *sensors* (InitiativeTracker, FeatureRolloutReconciler,
// ApprovalLedger, CorrectionLedger) and excellent *anti-flood plumbing* — but
// never the *analyst layer* in between that reads the tracked data, decides what
// crosses from noise into "a concrete milestone or realization worth telling the
// operator," and proactively surfaces it. The result was total silence on the
// three questions the operator actually asked:
//   1. Are initiatives being left behind?
//   2. Are features earning their way through the maturity path (dark → enabled)?
//   3. Are patterns being extracted from conversation data (approve-vs-change-spec
//      rate, correction rate)?
//
// THE KEY DESIGN LEVER (Justin, same conversation): the incubation/maturation
// window must stay TIGHT — a week MAX, a few days for low-risk features — and
// **the window EXPIRING is the trigger itself**. "Left behind" becomes
// structurally impossible because every incubating feature carries a deadline
// that drags it in front of the operator: either it proved itself (→ promote?)
// or it never did (→ extend / fix / kill?).
//
// MATURITY HONESTY (ref keystone-dormancy #905): promotion requires real
// proof-of-life (the feature actually fired), NOT merely elapsed time. A feature
// that sat dark and never ran is a *kill/fix* candidate, never a *promote* one.
//
// THIS COMPONENT ADDS NO NEW SENSORS. It composes the existing read surfaces and
// keeps ONE piece of minimal internal bookkeeping: a stage-observation journal,
// because the rollout engines do not cleanly stamp "entered stage X at time T"
// for every stage (notably `dark`). The journal records the first time we
// observed a feature in its current stage so "days in stage" is robust.
//
// Spec: docs/specs/PROACTIVE-GROWTH-MILESTONE-ANALYST-SPEC.md
// Ships DARK (monitoring.growthAnalyst.enabled defaults false). This slice
// COMPUTES findings + exposes them via read routes; it does NOT send to Telegram.
// Sending / cadence / enabling the muted analyzers ride later slices, behind
// their own review (they are the flood-sensitive part).

import fs from 'node:fs';
import path from 'node:path';
import type { InitiativeTracker, Initiative, RolloutStage } from '../core/InitiativeTracker.js';
import type { ApprovalLedger, ClassSummary, DivergenceCategory } from '../core/ApprovalLedger.js';
import type { CorrectionLedger, CorrectionRecord } from './CorrectionLedger.js';

/** Risk tiers govern how long a feature may incubate before the window expires. */
export type GrowthRiskTier = 'lowRisk' | 'standard' | 'highRisk';

/** The five notify-rules. R1/R2 = feature maturity (the key lever); R3 =
 *  initiatives left behind; R4 = spec approve-vs-change pattern; R5 = correction
 *  pattern. */
export type GrowthRuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export type GrowthFindingPriority = 'low' | 'normal' | 'high';

export type GrowthSuggestedAction =
  | 'promote'
  | 'extend-fix-kill'
  | 'review'
  | 'bake-in-default'
  | 'route-correction';

export interface GrowthFinding {
  rule: GrowthRuleId;
  priority: GrowthFindingPriority;
  /** Stable identity of the thing this finding is about (initiative id /
   *  approval decision-class / correction dedupe-key). */
  subjectId: string;
  title: string;
  detail: string;
  suggestedAction: GrowthSuggestedAction;
  // R1/R2 only:
  stage?: RolloutStage;
  daysInStage?: number;
  windowDays?: number;
  proved?: boolean | 'unknown';
}

export interface GrowthDigestCounts {
  incubating: number;
  promotionReady: number;
  expiredUnproven: number;
  stalling: number;
  specPatterns: number;
  correctionPatterns: number;
}

export interface GrowthDigest {
  generatedAt: string;
  /** True when NOTHING crossed a notify-rule. The digest still renders a short
   *  "all healthy" line so the operator knows the analyst ran — the deliberate
   *  reversal of the over-silence default that made the old digest never speak. */
  calm: boolean;
  summary: string;
  findings: GrowthFinding[];
  counts: GrowthDigestCounts;
  /** Days until the soonest incubation window closes (drives the calm message:
   *  "next window closes in Xd"). Undefined when nothing is incubating. */
  nextWindowClosesInDays?: number;
}

/** Resolved, defaulted settings (mirrors the `monitoring.growthAnalyst` config). */
export interface GrowthAnalystSettings {
  enabled: boolean;
  incubationWindows: Record<GrowthRiskTier, number>;
  proofOfLifeMinActivations: number;
  /** Per-rule enable flags. */
  rules: {
    promotionReady: boolean;
    incubationExpired: boolean;
    initiativeStalling: boolean;
    specPattern: boolean;
    correctionPattern: boolean;
  };
  /** R4: minimum decisions in a class before a spec-pattern is worth surfacing. */
  specPatternMinTotal: number;
  /** R4: fraction of decisions that must be approved-with-change. */
  specPatternMinChangeRatio: number;
  /** R5: occurrences before a correction pattern surfaces. */
  correctionPatternMinOccurrences: number;
  /** Whether to render the "all healthy" line even when calm (default true). */
  digestEvenWhenCalm: boolean;
}

export const DEFAULT_GROWTH_WINDOWS: Record<GrowthRiskTier, number> = {
  lowRisk: 3,
  standard: 7,
  highRisk: 7,
};

export const DEFAULT_GROWTH_SETTINGS: GrowthAnalystSettings = {
  enabled: false,
  incubationWindows: { ...DEFAULT_GROWTH_WINDOWS },
  proofOfLifeMinActivations: 1,
  rules: {
    promotionReady: true,
    incubationExpired: true,
    initiativeStalling: true,
    specPattern: true,
    correctionPattern: true,
  },
  specPatternMinTotal: 3,
  specPatternMinChangeRatio: 0.6,
  correctionPatternMinOccurrences: 3,
  digestEvenWhenCalm: true,
};

/** Resolve raw config (possibly partial / undefined) into fully-defaulted
 *  settings. Pure — safe to unit test, and used by both the class and routes. */
export function resolveGrowthSettings(raw?: Partial<GrowthAnalystSettings> | Record<string, unknown>): GrowthAnalystSettings {
  const r = (raw ?? {}) as Partial<GrowthAnalystSettings>;
  const windows = (r.incubationWindows ?? {}) as Partial<Record<GrowthRiskTier, number>>;
  const rules = (r.rules ?? {}) as Partial<GrowthAnalystSettings['rules']>;
  return {
    enabled: r.enabled === true,
    incubationWindows: {
      lowRisk: numOr(windows.lowRisk, DEFAULT_GROWTH_WINDOWS.lowRisk),
      standard: numOr(windows.standard, DEFAULT_GROWTH_WINDOWS.standard),
      highRisk: numOr(windows.highRisk, DEFAULT_GROWTH_WINDOWS.highRisk),
    },
    proofOfLifeMinActivations: numOr(r.proofOfLifeMinActivations, DEFAULT_GROWTH_SETTINGS.proofOfLifeMinActivations),
    rules: {
      promotionReady: rules.promotionReady !== false,
      incubationExpired: rules.incubationExpired !== false,
      initiativeStalling: rules.initiativeStalling !== false,
      specPattern: rules.specPattern !== false,
      correctionPattern: rules.correctionPattern !== false,
    },
    specPatternMinTotal: numOr(r.specPatternMinTotal, DEFAULT_GROWTH_SETTINGS.specPatternMinTotal),
    specPatternMinChangeRatio: numOr(r.specPatternMinChangeRatio, DEFAULT_GROWTH_SETTINGS.specPatternMinChangeRatio),
    correctionPatternMinOccurrences: numOr(r.correctionPatternMinOccurrences, DEFAULT_GROWTH_SETTINGS.correctionPatternMinOccurrences),
    digestEvenWhenCalm: r.digestEvenWhenCalm !== false,
  };
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ── Stage-observation journal ──────────────────────────────────────────────
// The ONE piece of internal bookkeeping. Keyed by initiative id; records the
// stage we last saw and the first time we saw it in THAT stage. A stage change
// (forward promotion OR backward regression) resets firstObservedAt — "days in
// stage" always means days in the CURRENT stage.

export interface StageObservation {
  stage: RolloutStage;
  firstObservedAt: string; // ISO
}

export type StageJournal = Record<string, StageObservation>;

// ── Pure classification (the heart — unit-tested on both sides of every edge) ──

export type RolloutClassification =
  | 'incubating'        // still inside its window
  | 'promotion-ready'   // window expired + proved itself  → R1
  | 'expired-unproven'  // window expired + NOT proved      → R2
  | 'terminal';         // default-on — nothing to decide

export interface RolloutVerdict {
  classification: RolloutClassification;
  stage: RolloutStage;
  daysInStage: number;
  windowDays: number;
  /** true / false / 'unknown' (no evidence source wired — treated as NOT proved
   *  for promotion, but surfaced honestly as unknown rather than asserted). */
  proved: boolean | 'unknown';
}

/** Whole calendar-ish days between an ISO timestamp and `now` (fractional). */
export function daysSince(iso: string, now: Date): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return (now.getTime() - then) / 86_400_000;
}

/** Map a feature to a risk tier. Heuristic for now (overridable later via an
 *  explicit per-feature tag). default-on/live features that already shipped are
 *  treated 'standard'; everything dark is 'standard' unless flagged lowRisk. */
export function riskTierForInitiative(init: Initiative): GrowthRiskTier {
  // An explicit tag on the rollout's promotionCriteria wins if present.
  const crit = init.rollout?.promotionCriteria?.toLowerCase() ?? '';
  if (crit.includes('low-risk') || crit.includes('lowrisk')) return 'lowRisk';
  if (crit.includes('high-risk') || crit.includes('highrisk')) return 'highRisk';
  return 'standard';
}

/** The core verdict. PURE. `proofCount === undefined` ⇒ no evidence source wired
 *  ⇒ proved:'unknown' ⇒ cannot be promotion-ready (honest: never promote a
 *  feature we can't prove ran). */
export function classifyRollout(
  stage: RolloutStage,
  daysInStage: number,
  windowDays: number,
  proofCount: number | undefined,
  minProof: number,
): RolloutVerdict {
  const proved: boolean | 'unknown' = proofCount === undefined ? 'unknown' : proofCount >= minProof;
  if (stage === 'default-on') {
    return { classification: 'terminal', stage, daysInStage, windowDays, proved };
  }
  const expired = daysInStage >= windowDays;
  if (!expired) {
    return { classification: 'incubating', stage, daysInStage, windowDays, proved };
  }
  if (proved === true) {
    return { classification: 'promotion-ready', stage, daysInStage, windowDays, proved };
  }
  return { classification: 'expired-unproven', stage, daysInStage, windowDays, proved };
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface GrowthMilestoneAnalystDeps {
  /** Where to persist the stage journal (the agent stateDir root). */
  stateDir: string;
  /** Resolved settings (use resolveGrowthSettings on the raw config). */
  settings: GrowthAnalystSettings;
  /** Initiatives + feature-rollout state (required). */
  tracker: Pick<InitiativeTracker, 'list' | 'digest'>;
  /** Spec approve-vs-change ledger (optional — R4 skipped when absent). */
  approvalLedger?: Pick<ApprovalLedger, 'summarize'> | null;
  /** Corrections ledger (optional — R5 skipped when absent). */
  correctionLedger?: Pick<CorrectionLedger, 'list'> | null;
  /** Proof-of-life counter: how many times did this feature actually fire?
   *  Returns undefined when no evidence source is wired (⇒ proved:'unknown'). */
  evidenceCounter?: (init: Initiative) => number | undefined;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Optional error sink. */
  onError?: (where: string, err: unknown) => void;
}

export class GrowthMilestoneAnalyst {
  private readonly stateDir: string;
  private readonly journalPath: string;
  private readonly deps: GrowthMilestoneAnalystDeps;
  private settings: GrowthAnalystSettings;

  constructor(deps: GrowthMilestoneAnalystDeps) {
    this.deps = deps;
    this.settings = deps.settings;
    this.stateDir = path.join(deps.stateDir, 'state', 'growth-milestone-analyst');
    this.journalPath = path.join(this.stateDir, 'stage-journal.json');
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
    } catch (err) {
      this.deps.onError?.('mkdir', err);
    }
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  isEnabled(): boolean {
    return this.settings.enabled === true;
  }

  // ── Stage journal persistence ──────────────────────────────────────────

  private loadJournal(): StageJournal {
    try {
      const raw = fs.readFileSync(this.journalPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as StageJournal) : {};
    } catch {
      // @silent-fallback-ok: a missing/corrupt journal → empty, then self-heals
      // on the next observeStages write. Observe-only analyst — never gates an
      // action, so an empty journal only means "recompute stage clocks", not a
      // wrong decision. (No DegradationReporter: this is expected first-run state.)
      return {};
    }
  }

  private saveJournal(j: StageJournal): void {
    try {
      fs.writeFileSync(this.journalPath, JSON.stringify(j, null, 2));
    } catch (err) {
      this.deps.onError?.('saveJournal', err);
    }
  }

  /**
   * Observe the current rollout stage of every staged feature and reconcile the
   * journal: new feature → record; stage changed → reset firstObservedAt; gone →
   * prune. Returns the updated journal (also persisted). PUBLIC so a tick can run
   * the observation step independently of finding computation.
   */
  observeStages(now: Date = this.now()): StageJournal {
    const journal = this.loadJournal();
    const live = new Set<string>();
    for (const init of this.stagedInitiatives()) {
      const stage = init.rollout!.stage;
      live.add(init.id);
      const prev = journal[init.id];
      if (!prev || prev.stage !== stage) {
        journal[init.id] = { stage, firstObservedAt: now.toISOString() };
      }
    }
    // Prune features no longer staged (deleted / archived away from rollout).
    for (const id of Object.keys(journal)) {
      if (!live.has(id)) delete journal[id];
    }
    this.saveJournal(journal);
    return journal;
  }

  private stagedInitiatives(): Initiative[] {
    let list: Initiative[];
    try {
      list = this.deps.tracker.list();
    } catch (err) {
      // @silent-fallback-ok: input-read failure surfaced via onError; returning
      // [] yields a smaller digest (the safe direction) for this observe-only,
      // never-acting component — it can never cause a wrong action.
      this.deps.onError?.('tracker.list', err);
      return [];
    }
    return list.filter((i) => i.rollout && i.rollout.stage);
  }

  // ── Notify-rule computation ─────────────────────────────────────────────

  /** R1 + R2: feature maturity via the tight incubation window. */
  computeRolloutFindings(now: Date, journal: StageJournal): GrowthFinding[] {
    const findings: GrowthFinding[] = [];
    const s = this.settings;
    for (const init of this.stagedInitiatives()) {
      const obs = journal[init.id];
      if (!obs) continue; // observeStages must run first
      const tier = riskTierForInitiative(init);
      const windowDays = s.incubationWindows[tier];
      const daysInStage = daysSince(obs.firstObservedAt, now);
      let proofCount: number | undefined;
      try {
        proofCount = this.deps.evidenceCounter?.(init);
      } catch (err) {
        // @silent-fallback-ok: surfaced via onError; undefined → proved:'unknown',
        // the HONEST conservative result (a feature we can't prove ran can never
        // be promotion-ready). Never a wrong action — observe-only.
        this.deps.onError?.('evidenceCounter', err);
        proofCount = undefined;
      }
      const v = classifyRollout(init.rollout!.stage, daysInStage, windowDays, proofCount, s.proofOfLifeMinActivations);
      const rounded = Math.round(daysInStage * 10) / 10;
      if (v.classification === 'promotion-ready' && s.rules.promotionReady) {
        findings.push({
          rule: 'R1',
          priority: 'normal',
          subjectId: init.id,
          title: `${init.title} — ready to promote`,
          detail: `Incubated ${rounded}d in '${v.stage}' (window ${windowDays}d) with ${proofCount} real activation(s) and no issues. Promote to the next stage?`,
          suggestedAction: 'promote',
          stage: v.stage,
          daysInStage: rounded,
          windowDays,
          proved: v.proved,
        });
      } else if (v.classification === 'expired-unproven' && s.rules.incubationExpired) {
        const provedNote = v.proved === 'unknown'
          ? 'no evidence source is wired, so it cannot prove it ran'
          : `it has not reached ${s.proofOfLifeMinActivations} activation(s)`;
        findings.push({
          rule: 'R2',
          priority: 'normal',
          subjectId: init.id,
          title: `${init.title} — incubation expired, unproven`,
          detail: `Sat in '${v.stage}' ${rounded}d (window ${windowDays}d) but ${provedNote}. Extend, fix, or kill?`,
          suggestedAction: 'extend-fix-kill',
          stage: v.stage,
          daysInStage: rounded,
          windowDays,
          proved: v.proved,
        });
      }
    }
    return findings;
  }

  /** R3: initiatives left behind — reuse the tracker's own staleness digest. */
  computeStallingFindings(now: Date): GrowthFinding[] {
    if (!this.settings.rules.initiativeStalling) return [];
    let items: { initiativeId: string; title: string; reason: string; detail: string }[];
    try {
      items = this.deps.tracker.digest(now).items;
    } catch (err) {
      // @silent-fallback-ok: input-read failure surfaced via onError; [] yields a
      // smaller digest (safe direction) for this observe-only component.
      this.deps.onError?.('tracker.digest', err);
      return [];
    }
    const findings: GrowthFinding[] = [];
    for (const it of items) {
      if (it.reason !== 'stale' && it.reason !== 'needs-user') continue;
      findings.push({
        rule: 'R3',
        priority: 'normal',
        subjectId: it.initiativeId,
        title: `${it.title} — ${it.reason === 'needs-user' ? 'waiting on you' : 'drifting'}`,
        detail: it.detail || (it.reason === 'needs-user' ? 'An open decision is waiting on you.' : 'No update in a while.'),
        suggestedAction: 'review',
      });
    }
    return findings;
  }

  /** R4: spec approve-vs-change pattern — "you keep changing X the same way." */
  computeSpecPatternFindings(): GrowthFinding[] {
    if (!this.settings.rules.specPattern || !this.deps.approvalLedger) return [];
    let summaries: ClassSummary[];
    try {
      summaries = this.deps.approvalLedger.summarize();
    } catch (err) {
      // @silent-fallback-ok: input-read failure surfaced via onError; [] yields a
      // smaller digest (safe direction) for this observe-only component.
      this.deps.onError?.('approvalLedger.summarize', err);
      return [];
    }
    const s = this.settings;
    const findings: GrowthFinding[] = [];
    for (const cs of summaries) {
      if (cs.total < s.specPatternMinTotal) continue;
      const changeRatio = cs.total > 0 ? cs.approvedWithChange / cs.total : 0;
      if (changeRatio < s.specPatternMinChangeRatio) continue;
      const dominant = dominantDivergence(cs.divergenceCounts);
      if (!dominant) continue;
      findings.push({
        rule: 'R4',
        priority: 'low',
        subjectId: cs.decisionClass,
        title: `Spec pattern: '${cs.decisionClass}' keeps getting changed`,
        detail: `${cs.approvedWithChange}/${cs.total} '${cs.decisionClass}' decisions were approved-with-change, mostly '${dominant.category}' (${dominant.count}). Bake this into the default?`,
        suggestedAction: 'bake-in-default',
      });
    }
    return findings;
  }

  /** R5: correction pattern — a recurring correction worth surfacing. The
   *  CORRECTION-PREFERENCE spec owns the routing; this only SURFACES it. */
  computeCorrectionFindings(now: Date): GrowthFinding[] {
    if (!this.settings.rules.correctionPattern || !this.deps.correctionLedger) return [];
    let records: CorrectionRecord[];
    try {
      records = this.deps.correctionLedger.list({});
    } catch (err) {
      // @silent-fallback-ok: input-read failure surfaced via onError; [] yields a
      // smaller digest (safe direction) for this observe-only component.
      this.deps.onError?.('correctionLedger.list', err);
      return [];
    }
    const min = this.settings.correctionPatternMinOccurrences;
    const findings: GrowthFinding[] = [];
    for (const r of records) {
      // Only surface still-open recurring patterns (acted-on/verified are owned
      // by the correction loop's own lifecycle).
      if (r.status !== 'open' && r.status !== 'reopened') continue;
      if (r.occurrenceCount < min) continue;
      findings.push({
        rule: 'R5',
        priority: 'low',
        subjectId: r.dedupeKey,
        title: `Recurring correction (${r.occurrenceCount}×)`,
        // scrubbedSummary is the only HTTP-safe text on a correction record.
        detail: `${r.scrubbedSummary} — recurred ${r.occurrenceCount}×. Worth a durable preference or infra fix?`,
        suggestedAction: 'route-correction',
      });
    }
    return findings;
  }

  /** Run the full observation + computation pass. Returns all findings. */
  computeFindings(now: Date = this.now()): GrowthFinding[] {
    const journal = this.observeStages(now);
    return [
      ...this.computeRolloutFindings(now, journal),
      ...this.computeStallingFindings(now),
      ...this.computeSpecPatternFindings(),
      ...this.computeCorrectionFindings(now),
    ];
  }

  /** Build the operator-facing digest. Calm digests still render so the operator
   *  knows the analyst ran (fixes the old "near-silent → never speaks" failure). */
  buildDigest(now: Date = this.now()): GrowthDigest {
    const journal = this.observeStages(now);
    const rollout = this.computeRolloutFindings(now, journal);
    const stalling = this.computeStallingFindings(now);
    const spec = this.computeSpecPatternFindings();
    const corr = this.computeCorrectionFindings(now);
    const findings = [...rollout, ...stalling, ...spec, ...corr];

    const counts: GrowthDigestCounts = {
      incubating: this.countIncubating(now, journal),
      promotionReady: rollout.filter((f) => f.rule === 'R1').length,
      expiredUnproven: rollout.filter((f) => f.rule === 'R2').length,
      stalling: stalling.length,
      specPatterns: spec.length,
      correctionPatterns: corr.length,
    };

    const nextWindowClosesInDays = this.nextWindowClose(now, journal);
    const calm = findings.length === 0;
    const summary = calm
      ? this.calmSummary(counts, nextWindowClosesInDays)
      : this.activeSummary(counts);

    return {
      generatedAt: now.toISOString(),
      calm,
      summary,
      findings,
      counts,
      nextWindowClosesInDays,
    };
  }

  /** Lightweight status for a GET route / dashboard. */
  getStatus(now: Date = this.now()): {
    enabled: boolean;
    settings: GrowthAnalystSettings;
    counts: GrowthDigestCounts;
    nextWindowClosesInDays?: number;
  } {
    const digest = this.buildDigest(now);
    return {
      enabled: this.isEnabled(),
      settings: this.settings,
      counts: digest.counts,
      nextWindowClosesInDays: digest.nextWindowClosesInDays,
    };
  }

  // ── digest helpers ──────────────────────────────────────────────────────

  private countIncubating(now: Date, journal: StageJournal): number {
    let n = 0;
    for (const init of this.stagedInitiatives()) {
      const obs = journal[init.id];
      if (!obs) continue;
      const tier = riskTierForInitiative(init);
      const windowDays = this.settings.incubationWindows[tier];
      const v = classifyRollout(
        init.rollout!.stage,
        daysSince(obs.firstObservedAt, now),
        windowDays,
        this.safeProof(init),
        this.settings.proofOfLifeMinActivations,
      );
      if (v.classification === 'incubating') n++;
    }
    return n;
  }

  private nextWindowClose(now: Date, journal: StageJournal): number | undefined {
    let soonest: number | undefined;
    for (const init of this.stagedInitiatives()) {
      const obs = journal[init.id];
      if (!obs) continue;
      const tier = riskTierForInitiative(init);
      const windowDays = this.settings.incubationWindows[tier];
      const daysInStage = daysSince(obs.firstObservedAt, now);
      if (init.rollout!.stage === 'default-on') continue;
      if (daysInStage >= windowDays) continue; // already expired
      const remaining = windowDays - daysInStage;
      if (soonest === undefined || remaining < soonest) soonest = remaining;
    }
    return soonest === undefined ? undefined : Math.round(soonest * 10) / 10;
  }

  private safeProof(init: Initiative): number | undefined {
    try {
      return this.deps.evidenceCounter?.(init);
    } catch {
      // @silent-fallback-ok: count-only helper for the calm-digest incubating
      // tally; undefined → proved:'unknown' (the honest conservative result).
      // Observe-only — never gates an action.
      return undefined;
    }
  }

  private calmSummary(counts: GrowthDigestCounts, nextClose?: number): string {
    const base = `All healthy — ${counts.incubating} feature(s) incubating, nothing past its window.`;
    if (nextClose !== undefined) return `${base} Next window closes in ${nextClose}d.`;
    return base;
  }

  private activeSummary(counts: GrowthDigestCounts): string {
    const parts: string[] = [];
    if (counts.promotionReady) parts.push(`${counts.promotionReady} ready to promote`);
    if (counts.expiredUnproven) parts.push(`${counts.expiredUnproven} expired-unproven`);
    if (counts.stalling) parts.push(`${counts.stalling} stalling`);
    if (counts.specPatterns) parts.push(`${counts.specPatterns} spec pattern(s)`);
    if (counts.correctionPatterns) parts.push(`${counts.correctionPatterns} correction pattern(s)`);
    return `Growth digest: ${parts.join(', ')}.`;
  }
}

/** The divergence category with the highest count (ties → first by declaration),
 *  or null when there are no divergences at all. PURE. */
export function dominantDivergence(
  counts: Record<DivergenceCategory, number>,
): { category: DivergenceCategory; count: number } | null {
  let best: { category: DivergenceCategory; count: number } | null = null;
  for (const [category, count] of Object.entries(counts) as [DivergenceCategory, number][]) {
    if (count <= 0) continue;
    if (!best || count > best.count) best = { category, count };
  }
  return best;
}
