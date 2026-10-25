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
import { DEV_GATED_FEATURES, getConfigByPath } from '../core/devGatedFeatures.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import type { GuardRow } from './guardPostureView.js';
import type {
  DarkFlagEntry,
  DarkFlagMaturationRegistry,
  DarkFlagOwner,
  DarkFlagState,
} from './DarkFlagMaturationRegistry.js';

/** Risk tiers govern how long a feature may incubate before the window expires. */
export type GrowthRiskTier = 'lowRisk' | 'standard' | 'highRisk';


/** The seven notify-rules. R1/R2/R7 = feature maturity (the key lever); R3 =
 *  initiatives left behind; R4 = spec approve-vs-change pattern; R5 = correction
 *  pattern; R6 = dev-gate conformance (a registered dev-gated feature observed
 *  DARK on this dev agent — the forgot-the-gate / misconfig class); R7 =
 *  dark-flag maturity, read from the `/guards` posture inventory (Standard A of
 *  `maturation-followthrough-fix`) rather than from specs that opted in.
 *
 *  Why R7 exists: R1/R2 can only see features whose SPEC registered a rollout
 *  stage — 3 tracks out of 1,201 items — so the real inventory of dark and
 *  dry-run switches aged out of sight entirely. R7 keys on the guard key, so a
 *  staged switch is visible whether or not anyone remembered to register it. */
export type GrowthRuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';

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
  // R7 only: the guard keys this aggregate finding covers. R7 findings
  // AGGREGATE by class (Bounded Notification Surface) — one row carrying the
  // count and the list, never one row per flag, so a 100-flag backlog can
  // never become a 100-item notification flood.
  affected?: string[];
  /** R7 only: how many of `affected` are un-owned — itself the Close-the-Loop gap. */
  unowned?: number;
  /** R7 only: subset of `affected` that G3 already grades as load-bearing, so a
   *  consumer routes those to the EXISTING loadBearingGap surface instead of
   *  raising a second competing row. */
  loadBearingKeys?: string[];
}

export interface GrowthDigestCounts {
  incubating: number;
  promotionReady: number;
  expiredUnproven: number;
  stalling: number;
  specPatterns: number;
  correctionPatterns: number;
  /** R6: dev-gated features observed DARK on this dev agent (should be live). */
  devGateDark: number;
  /** R7: dark/dry-run guards inside their incubation window. */
  darkIncubating: number;
  /** R7: dark guards past their window WITH signs of life. NOT a readiness
   *  verdict — readiness is D7's (`evaluateMaturation`); this only says the
   *  window closed and the flag has fired. */
  darkWindowElapsed: number;
  /** R7: dark guards past their window WITHOUT proof → extend / fix / kill? */
  darkExpiredUnproven: number;
  /** R7: dark flags that were already dark at first registration — the
   *  forgotten backlog, surfaced overdue rather than given a fresh window. */
  darkLegacyUnproven: number;
  /** R7: how many tracked dark flags have no accountable owner at all. */
  darkUnowned: number;
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
    devGateConformance: boolean;
    /** R7 — dark-flag maturity from the guard-posture inventory. */
    darkFlagMaturity: boolean;
  };
  /** Standard A/B rollout flag. Dark-first: with `enabled:false` the analyst
   *  reverts to exactly today's InitiativeTracker-only behavior, and R3 keeps
   *  its place in the headline. `dryRun` computes and records the registry but
   *  keeps R7 findings OUT of the digest, so the soak can be observed before the
   *  engine's voice changes. */
  darkFlagInventory: {
    enabled: boolean;
    dryRun: boolean;
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
    devGateConformance: true,
    darkFlagMaturity: true,
  },
  darkFlagInventory: { enabled: false, dryRun: true },
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
  const darkFlag = (r.darkFlagInventory ?? {}) as Partial<GrowthAnalystSettings['darkFlagInventory']>;
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
      devGateConformance: rules.devGateConformance !== false,
      darkFlagMaturity: rules.darkFlagMaturity !== false,
    },
    darkFlagInventory: {
      // Dark-first: absent ⇒ OFF. Only an explicit `true` turns it on, and
      // dryRun stays on unless explicitly set false (the canary ordering).
      enabled: darkFlag.enabled === true,
      dryRun: darkFlag.dryRun !== false,
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

/** Map a GUARD to a risk tier. A guard the manifest marks load-bearing sits on
 *  a declared critical path, so it gets the highRisk window; everything else is
 *  standard. PURE, and deliberately conservative — it never shortens a window
 *  on a guess (a shorter window would expire a flag sooner and could promote it
 *  on thinner evidence, so erring long is the safe direction). */
export function riskTierForGuard(row: GuardRow): GrowthRiskTier {
  return row.loadBearing ? 'highRisk' : 'standard';
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
  /** R6: the live agent config, for the dev-gate conformance cross-check. Only
   *  meaningful on a development agent; absent/null ⇒ R6 is skipped. Read with
   *  getConfigByPath (which accepts unknown), so no index signature is required. */
  liveConfig?: { developmentAgent?: boolean } | null;
  /** R7 (Standard A): the live `/guards` posture inventory — the code-derived
   *  dark-flag source. Injected (not read here) so the analyst stays pure and
   *  the inventory keeps its single funnel in `buildGuardInventory`. Absent or
   *  returning null ⇒ R7 is skipped entirely. */
  darkFlagInventory?: (() => GuardRow[] | null) | null;
  /** R7/Standard B: the durable owner + deadline + proof-of-life registry.
   *  Absent ⇒ R7 is skipped (we never classify a dark flag without somewhere
   *  durable to anchor its window — an in-memory window cannot prove a soak). */
  darkFlagRegistry?: Pick<DarkFlagMaturationRegistry, 'reconcile'> | null;
  /** R7 proof-of-life counter. `undefined` ⇒ `'unknown'` (never asserted-proved). */
  darkFlagEvidenceCounter?: (row: GuardRow) => number | undefined;
  /** R7: owner derivation. Only ever a REAL code-derived source; returning null
   *  leaves the flag un-owned, which is itself a surfaced finding. */
  darkFlagOwnerFor?: (row: GuardRow) => DarkFlagOwner;
  /** R7: optional old-key → new-key map so a renamed guard tombstones as
   *  `superseded` instead of `killed`. */
  darkFlagSupersededBy?: Record<string, string>;
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
    // Standard A ordering, kept IDENTICAL to buildDigest's: maturity signal
    // first (R1 → R7 → R6 → R2), then patterns, and R3 (stalling) demoted last.
    // These two aggregation points must never diverge — "the criterion lives in
    // two places that disagree" is one of the defects this spec exists to fix,
    // and a route that silently omitted R7 was exactly that bug reappearing.
    return [
      ...this.computeRolloutFindings(now, journal),
      ...this.computeDarkFlagFindings(now).findings,
      ...this.computeDevGateConformanceFindings(),
      ...this.computeSpecPatternFindings(),
      ...this.computeCorrectionFindings(now),
      ...this.computeStallingFindings(now),
    ];
  }

  /** R6 (dev-gate conformance): on a development agent, every registered
   *  dev-gated feature MUST resolve LIVE. One observed DARK means it was wired
   *  wrong / misconfigured (a hardcoded enabled:false default, or an operator
   *  override) — the forgot-the-gate class the Slice-1 lint can't see and the
   *  Slice-2 default test only catches at the default level. Surfacing it here
   *  makes it a live finding on the very dev agent it affects.
   *  Spec: DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC (Slice 3). */
  private computeDevGateConformanceFindings(): GrowthFinding[] {
    if (!this.settings.rules.devGateConformance) return [];
    const cfg = this.deps.liveConfig;
    if (!cfg || cfg.developmentAgent !== true) return []; // only meaningful on a dev agent
    const findings: GrowthFinding[] = [];
    for (const feature of DEV_GATED_FEATURES) {
      let live: boolean;
      try {
        const explicit = getConfigByPath(cfg, feature.configPath) as boolean | undefined;
        live = resolveDevAgentGate(explicit, cfg);
      } catch (err) {
        this.deps.onError?.('devGateConformance', err);
        continue;
      }
      if (!live) {
        findings.push({
          rule: 'R6',
          priority: 'normal',
          subjectId: feature.name,
          title: `Dev-gated feature "${feature.name}" is DARK on this dev agent`,
          // C2 (maturation-followthrough-fix Standard C): the operator-facing
          // detail must NOT embed the raw config key (`${feature.configPath}`) —
          // that dotted config-key literal is exactly the pattern the always-on
          // tone gate blocks (a sibling of the 2026-06-29 footer block). Name the
          // feature in plain English; the exact config path stays in the local
          // audit / dashboard, never in the operator-facing digest line.
          detail:
            `${feature.description} It follows the developmentAgent dark-feature gate, ` +
            `so it should run LIVE on a development agent — but the live config resolves ` +
            `it DARK on this agent. Likely a hardcoded disabled default or an operator ` +
            `override (the forgot-the-gate / misconfig class the lint can't see).`,
          suggestedAction: 'review',
        });
      }
    }
    return findings;
  }

  /**
   * R7 (Standard A + B): dark-flag maturity, read from the guard-posture
   * inventory rather than from specs that opted in.
   *
   * Returns AGGREGATE findings — at most one per class (promotion-ready /
   * expired-unproven / legacy-unproven), each carrying its count and the list
   * of guard keys. This is deliberate (Bounded Notification Surface): a
   * 100-flag backlog must be one digest section and at most one coalesced
   * attention row, never 100 notifications. The per-flag detail lives in the
   * durable registry, which is the right place for it.
   *
   * Signal, never authority: this classifies and records. It does not flip a
   * flag, accept a risk, or block anything.
   */
  computeDarkFlagFindings(now: Date = this.now()): { findings: GrowthFinding[]; entries: DarkFlagEntry[] } {
    const empty = { findings: [] as GrowthFinding[], entries: [] as DarkFlagEntry[] };
    if (!this.settings.darkFlagInventory.enabled) return empty;
    if (!this.settings.rules.darkFlagMaturity) return empty;
    const read = this.deps.darkFlagInventory;
    const registry = this.deps.darkFlagRegistry;
    if (!read || !registry) return empty;

    let rows: GuardRow[] | null;
    try {
      rows = read();
    } catch (err) {
      // @silent-fallback-ok: input-read failure surfaced via onError. No rows
      // ⇒ no R7 findings (the smaller, safe direction for an observe-only
      // rule). It can never produce a wrong action because R7 takes none.
      this.deps.onError?.('darkFlagInventory', err);
      return empty;
    }
    if (!rows) return empty;

    let entries: DarkFlagEntry[];
    try {
      entries = registry.reconcile({
        rows,
        now,
        windowFor: (row) => {
          const tier = riskTierForGuard(row);
          return { tier, windowDays: this.settings.incubationWindows[tier] };
        },
        proofCountFor: (row) => {
          try {
            return this.deps.darkFlagEvidenceCounter?.(row);
          } catch {
            // @silent-fallback-ok: undefined ⇒ proved:'unknown', the honest
            // conservative result — an unprovable flag is never promoted.
            return undefined;
          }
        },
        minProof: this.settings.proofOfLifeMinActivations,
        ownerFor: (row) => {
          try {
            return this.deps.darkFlagOwnerFor?.(row) ?? null;
          } catch {
            // @silent-fallback-ok: null ⇒ un-owned ⇒ surfaced as a finding.
            // Failing toward "needs an owner" can only over-surface, never hide.
            return null;
          }
        },
        ...(this.deps.darkFlagSupersededBy ? { supersededBy: this.deps.darkFlagSupersededBy } : {}),
      });
    } catch (err) {
      this.deps.onError?.('darkFlagRegistry.reconcile', err);
      return empty;
    }

    // dryRun: the registry IS written (so the soak accrues durable evidence
    // from day one) but the engine's voice does not change yet.
    if (this.settings.darkFlagInventory.dryRun) return { findings: [], entries };

    const findings: GrowthFinding[] = [];
    const classes: {
      state: DarkFlagState;
      rule: 'R7';
      priority: GrowthFindingPriority;
      action: GrowthSuggestedAction;
      title: (n: number) => string;
      lead: string;
    }[] = [
      {
        state: 'window-elapsed',
        rule: 'R7',
        priority: 'normal',
        action: 'promote',
        title: (n) => `${n} staged switch${n === 1 ? ' has' : 'es have'} run and passed its trial window`,
        lead: 'Each has fired at least once and its window has closed, so each is worth a decision. Whether it meets its own bar is scored separately.',
      },
      {
        state: 'legacy-unproven',
        rule: 'R7',
        // The forgotten backlog is the headline by construction — this is the
        // inventory the engine could not see, so it leads at high priority.
        priority: 'high',
        action: 'extend-fix-kill',
        title: (n) => `${n} staged switch${n === 1 ? ' was' : 'es were'} already dark before anyone was watching`,
        lead: 'These were dark at first registration, so their window cannot be anchored. They are overdue now, not newly incubating.',
      },
      {
        state: 'expired-unproven',
        rule: 'R7',
        priority: 'normal',
        action: 'extend-fix-kill',
        title: (n) => `${n} staged switch${n === 1 ? '' : 'es'} past its window with nothing to show`,
        lead: 'The window closed and there is no evidence it ever ran. Extend with a date, fix the evidence, or retire it.',
      },
    ];

    for (const c of classes) {
      const matching = entries.filter((e) => e.state === c.state);
      if (matching.length === 0) continue;
      const keys = matching.map((e) => e.guardKey).sort();
      const unowned = matching.filter((e) => e.owner === null).length;
      const loadBearingKeys = matching.filter((e) => e.loadBearing).map((e) => e.guardKey).sort();
      const ownerNote = unowned === 0
        ? ''
        : unowned === matching.length
          ? ' None of them has an owner.'
          : ` ${unowned} of them have no owner.`;
      // A load-bearing flag is NOT given a second competing row here — G3's
      // GuardPostureProbe already owns that alarm. We name them so the consumer
      // can route to the existing surface.
      const lbNote = loadBearingKeys.length > 0
        ? ` ${loadBearingKeys.length} sit on a critical path and are already tracked as a guard gap.`
        : '';
      findings.push({
        rule: c.rule,
        priority: c.priority,
        subjectId: `dark-flags:${c.state}`,
        title: c.title(matching.length),
        // DELIBERATELY free of raw guard keys. `detail` is rendered verbatim
        // into the weekly Telegram digest (GrowthDigestPublisher.renderFinding),
        // and a dotted config path is exactly the literal the always-on tone
        // gate blocks — it is what cost the 2026-06-29 digest window, which is
        // the failure Standard C of this same spec exists to prevent. The keys
        // travel in the structured `affected` field instead (consumed by the
        // dashboard and the read routes, never rendered into a message), and
        // the durable registry holds the per-flag detail.
        detail: `${c.lead}${ownerNote}${lbNote} The full list is in your dashboard.`.trim(),
        suggestedAction: c.action,
        affected: keys,
        unowned,
        ...(loadBearingKeys.length > 0 ? { loadBearingKeys } : {}),
      });
    }
    return { findings, entries };
  }

  /** Build the operator-facing digest. Calm digests still render so the operator
   *  knows the analyst ran (fixes the old "near-silent → never speaks" failure). */
  buildDigest(now: Date = this.now()): GrowthDigest {
    const journal = this.observeStages(now);
    const rollout = this.computeRolloutFindings(now, journal);
    const stalling = this.computeStallingFindings(now);
    const spec = this.computeSpecPatternFindings();
    const corr = this.computeCorrectionFindings(now);
    const devGate = this.computeDevGateConformanceFindings();
    const dark = this.computeDarkFlagFindings(now);
    // Same order as computeFindings — maturity first, R3 demoted last.
    const findings = [...rollout, ...dark.findings, ...devGate, ...spec, ...corr, ...stalling];

    const darkBy = (state: DarkFlagState): number => dark.entries.filter((e) => e.state === state).length;
    const counts: GrowthDigestCounts = {
      incubating: this.countIncubating(now, journal),
      promotionReady: rollout.filter((f) => f.rule === 'R1').length,
      expiredUnproven: rollout.filter((f) => f.rule === 'R2').length,
      stalling: stalling.length,
      specPatterns: spec.length,
      correctionPatterns: corr.length,
      devGateDark: devGate.length,
      darkIncubating: darkBy('incubating'),
      darkWindowElapsed: darkBy('window-elapsed'),
      darkExpiredUnproven: darkBy('expired-unproven'),
      darkLegacyUnproven: darkBy('legacy-unproven'),
      // Un-owned counts only LIVE dark flags: a tombstoned or graduated entry
      // needs no owner, and counting those would manufacture a permanent,
      // un-closable finding — the exact noise this rule replaces.
      darkUnowned: dark.entries.filter(
        (e) => e.owner === null
          && e.state !== 'graduated' && e.state !== 'killed' && e.state !== 'superseded',
      ).length,
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
    const watched = counts.incubating + counts.darkIncubating;
    const base = `All healthy — ${watched} feature(s) incubating, nothing past its window.`;
    if (nextClose !== undefined) return `${base} Next window closes in ${nextClose}d.`;
    return base;
  }

  /**
   * Standard A: the MATURITY signal leads the summary and R3 (initiative
   * stalling) is demoted to the tail.
   *
   * R3 produced ~258 items of InitiativeTracker work-item noise and 0
   * promotion-ready — which is how the engine ended up loud about the wrong
   * thing and silent about the right one. R3 stays computable and still renders
   * in the digest body; it simply no longer leads, and it is reported last so a
   * reader sees maturity first.
   */
  private activeSummary(counts: GrowthDigestCounts): string {
    const parts: string[] = [];
    if (counts.promotionReady) parts.push(`${counts.promotionReady} ready to promote`);
    if (counts.darkWindowElapsed) parts.push(`${counts.darkWindowElapsed} staged switch(es) ready`);
    if (counts.darkLegacyUnproven) parts.push(`${counts.darkLegacyUnproven} dark before anyone was watching`);
    if (counts.expiredUnproven) parts.push(`${counts.expiredUnproven} expired-unproven`);
    if (counts.darkExpiredUnproven) parts.push(`${counts.darkExpiredUnproven} staged switch(es) past window`);
    if (counts.darkUnowned) parts.push(`${counts.darkUnowned} without an owner`);
    if (counts.specPatterns) parts.push(`${counts.specPatterns} spec pattern(s)`);
    if (counts.correctionPatterns) parts.push(`${counts.correctionPatterns} correction pattern(s)`);
    if (counts.devGateDark) parts.push(`${counts.devGateDark} dev-gated-dark`);
    // Demoted: last, always.
    if (counts.stalling) parts.push(`${counts.stalling} stalling`);
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
