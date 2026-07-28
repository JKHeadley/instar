/**
 * ExternalHogSentinel — the composition shell that turns the reviewed pure modules into a live,
 * tickable monitor (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §1-§8).
 *
 * This is the ADAPTER LAYER, not new decision logic: it holds the cross-tick scan state (sampler
 * baseline + kill ledger + per-signature deferral counts), reads the real I/O through an INJECTED
 * adapter seam (so the whole shell is unit-testable with fakes — no real `ps`, model call, or
 * signal), and on each tick delegates the ENTIRE decision to the reviewed `runScanTick`
 * orchestrator. It adds nothing to the kill decision: the watch-only guarantee, the floor veto,
 * the classifier authority, the P19 breaker and P17 coalescing all live below it and are unchanged.
 *
 * The shell's only responsibilities:
 *  - carry state across ticks (sampler map, kill ledger, deferral counts) — none of which the
 *    pure orchestrator can hold;
 *  - bridge the async real reads (spawn `ps` off-loop, resolve owned pids) into the sync closures
 *    the orchestrator expects, by reading BEFORE the tick and closing over the snapshot;
 *  - persist the deferral count per target signature so `maxKillDeferrals` actually bounds across
 *    ticks (a target deferred for an open workspace file eventually proceeds to SIGKILL);
 *  - deliver the coalesced notices and expose an honest guard-posture `status()`.
 *
 * Watch-only rides straight through: in the shipped dryRun state the funnel returns `would-kill`
 * and no signal is sent, so a tick produces would-kill records + the §4 observability notices and
 * kills NOTHING.
 *
 * Self-action convergence (Capacity Safety — No Unbounded Self-Action): the kill loop's respawn
 * brake is registered in the convergence ratchet, driving the REAL pure ledger functions.
 */
/* @self-action-controller: external-hog-kill-breaker */

import { runScanTick, type ScanState, type ScanDeps, type ScanOpts, type ScanOutcome, type ScanResult } from './ExternalHogScanTick.js';
import { EMPTY_SAMPLER_STATE, isSamplerDead } from './ExternalHogSampler.js';
import { EMPTY_KILL_LEDGER } from './ExternalHogKillLedger.js';
import { EMPTY_SUSTAINED_STATE } from './ExternalHogSustained.js';
import type { ProcTableRow } from './ExternalHogProcTable.js';
import type { ProcTree, ProcNode, OwnedRefs } from './ExternalHogOwnership.js';
import type { ExternalHogFacts } from './ExternalHogFloor.js';
import type { Candidate } from './ExternalHogSampler.js';
import type { KillFunnelDeps } from './ExternalHogKillFunnel.js';
import type { CoalesceResult } from './ExternalHogNoticeCoalescer.js';
import { externalHogEffectiveState } from './ExternalHogGuardStatus.js';
import type { GuardEffectiveState } from './guardPostureView.js';
import {
  buildScanEvidenceView,
  EXTERNAL_HOG_SENTINEL_COMPONENT,
  HOG_ENACTED_DISPOSITION_RULE_ID,
  type ExternalHogDecisionStore,
  type HogGradeEvent,
} from './ExternalHogDecisionStore.js';
import type { DecisionProvenanceBlock } from '../core/decisionQualityTypes.js';

/** The real-I/O seam. Every method is injected so the shell is fully testable with fakes. */
export interface ExternalHogAdapters {
  /** Spawn `ps` off the event loop and parse it. Empty/failed read → []. */
  readProcTable(): Promise<readonly ProcTableRow[]>;
  /** instar-owned pids → their EXPECTED start-time (server pid, sampler pid, tmux panes). */
  ownedRefs(): Promise<OwnedRefs>;
  /** Deterministic facts for a candidate (the floor input); null if it vanished/unreadable. May be
   *  async (a per-candidate ps -o args= read + launchctl) — the orchestrator awaits it. */
  factsFor(candidate: Candidate, table: readonly ProcTableRow[]): ExternalHogFacts | null | Promise<ExternalHogFacts | null>;
  /** command-hash + ledger key + class for a candidate; null if not a killable allowlist class. */
  identityFor(candidate: Candidate, facts: ExternalHogFacts): { commandHash: string; ledgerKey: string; classId: string } | null;
  /** The classifier (LlmQueue). Raw model output, or null when the decider is unavailable.
   *  `provenance` is the §5.3 enrollment block (llm-decision-quality-meter) — the real adapter
   *  threads it as `options.provenance` on the underlying intelligence.evaluate call. */
  classify(facts: ExternalHogFacts, provenance?: DecisionProvenanceBlock): Promise<unknown>;
  /** The hardened kill-funnel I/O (re-read facts/arm, fd-probe, signal, aliveness, wait). */
  killFunnelDeps: KillFunnelDeps;
  /** Deliver the coalesced notices (attention queue / telegram). */
  deliverNotices(result: CoalesceResult): void;
  /** The live arm status for the guard posture (enabled/dryRun/valid PIN marker). */
  armStatus(): { enabled: boolean; dryRun: boolean; markerValid: boolean };
  /** A monotonic clock reading (ms). Same clock the sampler + kill-funnel use. */
  nowMs(): number;
  /** Append one audit row per tick (scrubbed, metadata-only). Never throws into the tick. */
  auditTick?(row: ExternalHogAuditRow): void;
}

export interface ExternalHogRuntimeOpts extends ScanOpts {
  /** Heartbeat age past which the sampler is DEAD (blind) → guard posture on-stale (§1). */
  readonly samplerDeadThresholdMs: number;
  /** Hard cap on the deferral map (memory bound; oldest pruned past this). */
  readonly deferralMapMax?: number;
}

export interface ExternalHogAuditRow {
  readonly at: number;
  readonly candidates: number;
  readonly killed: number;
  readonly wouldKill: number;
  readonly alertOnly: number;
  readonly deferred: number;
}

export interface ExternalHogStatus {
  readonly effectiveState: GuardEffectiveState;
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly markerValid: boolean;
  readonly samplerDead: boolean;
  readonly lastTickAt: number | null;
  readonly recentOutcomes: readonly ScanOutcome[];
  readonly trackedDeferrals: number;
  /** LLM-Decision Quality Meter wiring posture (§5.3) — Observable Intelligence:
   *  the durable-store/annotate arms are visible, never a silent skip. */
  readonly decisionQuality: {
    readonly storeWired: boolean;
    readonly annotateBound: boolean;
    readonly recordsWritten: number;
    readonly gradeEvents: number;
    readonly storeErrors: number;
  };
}

// ── LLM-Decision Quality Meter — annotation seam (§5.3/§5.4) ────────────────

/**
 * One outcome annotation handed to the §5.4 chokepoint. Content-free by
 * construction (ids, enums, numbers — pointer discipline). Rung/strength are
 * DERIVED registry-side from `gradedBy.ruleId`, never carried here.
 */
export interface HogOutcomeAnnotation {
  /** The decision join key (§5.4.1). */
  readonly correlationId: string;
  /** Component + ruleId — the chokepoint rejects a component that is not the
   *  ruleId's registered owner (§5.4.2). */
  readonly gradedBy: { readonly component: string; readonly ruleId: string };
  readonly grade: 'right' | 'wrong' | 'unknown';
  /** Structured, clamp-safe evidence (§5.2 ≤500-char pointer discipline);
   *  records the effective `windowMs` for window-bounded rules (§5.4.5). */
  readonly evidence: Record<string, unknown>;
}

/** The §5.4 chokepoint binding, or null while unbound (P6 handoff). */
export type HogAnnotateOutcomeFn = (annotation: HogOutcomeAnnotation) => void;

/** The decision-quality wiring handed to the sentinel at construction (all
 *  optional — absent pieces degrade to honest no-ops, counted in status()). */
export interface ExternalHogDecisionQualityDeps {
  /** The durable §5.3 decision store (hydrated at ITS construction). */
  readonly decisionStore?: ExternalHogDecisionStore;
  /** The §5.4 annotate chokepoint, or null/absent while unbound (P6 handoff). */
  readonly annotate?: HogAnnotateOutcomeFn | null;
}

const DEFAULT_DEFERRAL_MAP_MAX = 128;

/** Build a ProcTree (pid → node) from a parsed ps table — the ownership walk's input. */
export function buildProcTree(table: readonly ProcTableRow[]): ProcTree {
  const tree = new Map<number, ProcNode>();
  for (const row of table) {
    if (!Number.isInteger(row.pid) || row.pid <= 0) continue;
    tree.set(row.pid, { pid: row.pid, ppid: row.ppid, startTime: row.startTime });
  }
  return tree;
}

/** Is this outcome a live deferral that should bump the per-signature count? */
function isDeferred(o: ScanOutcome['outcome']): boolean {
  return typeof o === 'object' && o !== null && o.action === 'deferred';
}
/** Is this a TERMINAL outcome that resolves a target (so its deferral count is cleared)? */
function isTerminal(o: ScanOutcome['outcome']): boolean {
  return typeof o === 'object' && o !== null && (o.action === 'killed' || o.action === 'sigterm-exited' || o.action === 'aborted');
}

export class ExternalHogSentinel {
  private state: ScanState = { sampler: EMPTY_SAMPLER_STATE, ledger: EMPTY_KILL_LEDGER, sustained: EMPTY_SUSTAINED_STATE };
  /** ledgerKey → how many times this signature has been deferred (persisted across ticks). */
  private readonly deferrals = new Map<string, number>();
  private lastTickAt: number | null = null;
  private lastOutcomes: readonly ScanOutcome[] = [];
  /** Decision-quality counters (Observable Intelligence — visible in status()). */
  private dqRecordsWritten = 0;
  private dqGradeEvents = 0;
  private dqStoreErrors = 0;

  constructor(
    private readonly adapters: ExternalHogAdapters,
    private readonly opts: ExternalHogRuntimeOpts,
    /** §5.3 decision-quality wiring (optional — absent = no store writes, counted honestly). */
    private readonly decisionQuality: ExternalHogDecisionQualityDeps = {},
  ) {}

  /**
   * The durable §5.3 decision store the P9 grading endpoint reads (window-close
   * `hog-sustained-right-v1` over `list()`); null when the store is unwired
   * (the grade-pass then grades nothing for the hog point — honest). Read-only.
   */
  decisionStoreRef(): ExternalHogDecisionStore | null {
    return this.decisionQuality.decisionStore ?? null;
  }

  /**
   * Run one scan tick. Reads the real table + owned pids (async, off-loop), then delegates the
   * whole decision to the reviewed orchestrator over a snapshot-closing ScanDeps. Watch-only in
   * the shipped state (no signal). Never throws — a read failure degrades to an empty tick
   * (the sampler heartbeat simply does not advance → eventually on-stale).
   */
  async tick(): Promise<ScanResult> {
    const table = await this.adapters.readProcTable();
    const owned = await this.adapters.ownedRefs();
    const tree = buildProcTree(table);

    const deps: ScanDeps = {
      readProcTable: () => table,
      buildOwnership: () => ({ tree, owned }),
      factsFor: (c) => this.adapters.factsFor(c, table),
      identityFor: (c, f) => this.adapters.identityFor(c, f),
      classify: (f, p) => this.adapters.classify(f, p),
      killFunnelDeps: this.adapters.killFunnelDeps,
      nowMs: () => this.adapters.nowMs(),
      deferralsFor: (key) => this.deferrals.get(key) ?? 0,
    };

    const result = await runScanTick(this.state, deps, this.opts);
    this.state = result.nextState;
    this.updateDeferrals(result.outcomes);
    this.lastOutcomes = result.outcomes.slice(-16);
    this.lastTickAt = this.adapters.nowMs();

    this.recordDecisions(result.outcomes, table);
    this.adapters.deliverNotices(result.notices);
    this.emitAudit(result.outcomes);
    return result;
  }

  /**
   * Persist this tick's decisions into the durable §5.3 store and route the resulting
   * annotations. The store's `record()` runs grade-on-supersede — the positive-evidence
   * rules (respawn-wrong / leave-recurrence) fire HERE, because every fully-identified
   * candidate produces exactly one decision write per tick, so a same-commandHash
   * re-flag ALWAYS arrives as a same-ledgerKey supersede (the "scan ticks +
   * grade-on-supersede" §5.3 paths are one funnel by construction). Window-close
   * grading (hog-sustained-right-v1) belongs to the P9 grading job reading the store.
   * Never throws into the tick; failures are counted, never silent (status()).
   */
  private recordDecisions(outcomes: readonly ScanOutcome[], table: readonly ProcTableRow[]): void {
    const store = this.decisionQuality.decisionStore;
    if (!store || outcomes.length === 0) return;
    const scan = buildScanEvidenceView(outcomes, table);
    const events: HogGradeEvent[] = [];
    for (const o of outcomes) {
      try {
        events.push(...store.record(o.decision, scan));
        this.dqRecordsWritten++;
      } catch {
        // @silent-fallback-ok: NOT silent — counted in dqStoreErrors and surfaced on
        // status().decisionQuality; a persist failure (disk full/perms) must never
        // break the scan tick it observes. The decision then ages out `unknown`.
        this.dqStoreErrors++;
      }
    }
    this.dqGradeEvents += events.length;

    // §5.3 immediate enacted-disposition self-report (rung self-report, rule
    // hog-enacted-disposition-v1) + the positive-evidence grade annotations.
    // The annotate seam is the §5.4 chokepoint binding; while unbound (P6
    // handoff) the store still carries everything a later grading pass needs.
    const annotate = this.decisionQuality.annotate;
    if (!annotate) return;
    for (const o of outcomes) {
      if (!o.decision.correlationId) continue; // never fabricate a join key
      this.safeAnnotate(annotate, {
        correlationId: o.decision.correlationId,
        gradedBy: { component: EXTERNAL_HOG_SENTINEL_COMPONENT, ruleId: HOG_ENACTED_DISPOSITION_RULE_ID },
        grade: 'unknown', // a self-report records WHAT WAS ENACTED, never correctness
        evidence: { kind: 'hog-enacted-disposition', enacted: o.enacted, classId: o.classId },
      });
    }
    for (const ev of events) {
      if (!ev.correlationId) continue;
      this.safeAnnotate(annotate, {
        correlationId: ev.correlationId,
        gradedBy: { component: EXTERNAL_HOG_SENTINEL_COMPONENT, ruleId: ev.ruleId },
        grade: ev.grade,
        evidence: { kind: 'hog-evidence', windowMs: ev.windowMs, note: ev.evidenceNote },
      });
    }
  }

  private safeAnnotate(annotate: HogAnnotateOutcomeFn, annotation: HogOutcomeAnnotation): void {
    try {
      annotate(annotation);
    } catch {
      // @silent-fallback-ok: an annotation write failure must never propagate into the
      // scan tick it observes; the decision then honestly ages out `unknown` (§5.4.6),
      // and the chokepoint counts its own rejections.
    }
  }

  /**
   * The `/guards` runtime getter (GuardRegistry). `lastTickAt` is the last SUCCESSFUL PARSE (the
   * sampler heartbeat), NOT the tick time — so a sentinel that is ticking but BLIND (ps failing,
   * never parsing) reports a stale/zero lastTickAt and `/guards` honestly derives `on-stale`
   * instead of a falsely-reassuring `on-confirmed`. A never-parsed sentinel → 0 → on-stale.
   */
  guardRuntimeStatus(): { enabled: boolean; dryRun: boolean; lastTickAt: number } {
    const arm = this.adapters.armStatus();
    return { enabled: arm.enabled, dryRun: arm.dryRun, lastTickAt: this.state.sampler.lastSnapshotAt ?? 0 };
  }

  /** Honest guard posture (§8): reflects VERIFIED kill-capability, never a config wish. */
  status(): ExternalHogStatus {
    const arm = this.adapters.armStatus();
    // BLIND ⇒ on-stale, never on-confirmed. Two ways to be blind: (1) NO successful parse has
    // EVER happened (a boot where `ps` fails from the start — Phase-5 reviewer note D: without
    // this, an armed-but-never-parsed sentinel would falsely read on-confirmed), or (2) the
    // heartbeat has gone stale after previously parsing. on-confirmed REQUIRES a fresh successful
    // parse — a feature that has never read the process table is not verified kill-capable.
    const everParsed = this.state.sampler.lastSnapshotAt !== null;
    const samplerDead = !everParsed
      || isSamplerDead(this.state.sampler, this.adapters.nowMs(), this.opts.samplerDeadThresholdMs);
    return {
      effectiveState: externalHogEffectiveState({
        enabled: arm.enabled, dryRun: arm.dryRun, markerValid: arm.markerValid, samplerDead,
      }),
      enabled: arm.enabled,
      dryRun: arm.dryRun,
      markerValid: arm.markerValid,
      samplerDead,
      lastTickAt: this.lastTickAt,
      recentOutcomes: this.lastOutcomes,
      trackedDeferrals: this.deferrals.size,
      decisionQuality: {
        storeWired: !!this.decisionQuality.decisionStore,
        annotateBound: !!this.decisionQuality.annotate,
        recordsWritten: this.dqRecordsWritten,
        gradeEvents: this.dqGradeEvents,
        storeErrors: this.dqStoreErrors,
      },
    };
  }

  /** Bump deferral counts for live deferrals; clear resolved targets; bound the map. */
  private updateDeferrals(outcomes: readonly ScanOutcome[]): void {
    for (const o of outcomes) {
      if (isDeferred(o.outcome)) {
        this.deferrals.set(o.ledgerKey, (this.deferrals.get(o.ledgerKey) ?? 0) + 1);
      } else if (isTerminal(o.outcome)) {
        this.deferrals.delete(o.ledgerKey); // resolved or gone → forget it
      }
    }
    const max = this.opts.deferralMapMax ?? DEFAULT_DEFERRAL_MAP_MAX;
    while (this.deferrals.size > max) {
      const oldest = this.deferrals.keys().next().value; // Map preserves insertion order
      if (oldest === undefined) break;
      this.deferrals.delete(oldest);
    }
  }

  private emitAudit(outcomes: readonly ScanOutcome[]): void {
    if (!this.adapters.auditTick) return;
    let killed = 0, wouldKill = 0, alertOnly = 0, deferred = 0;
    for (const o of outcomes) {
      if (o.outcome === 'alert-only') alertOnly++;
      else if (o.outcome.action === 'killed') killed++;
      else if (o.outcome.action === 'would-kill') wouldKill++;
      else if (o.outcome.action === 'deferred') deferred++;
    }
    try {
      this.adapters.auditTick({ at: this.lastTickAt ?? this.adapters.nowMs(), candidates: outcomes.length, killed, wouldKill, alertOnly, deferred });
    } catch {
      /* audit is best-effort — never break a tick on an audit-write failure */
    }
  }
}

// ── TODO(P6-handoff): production chokepoint binding — SINGLE handoff point ──
// The hardened §5.4 annotate chokepoint (correlationId keying + registry-
// derived rung + owner rejection; DecisionQualityRecorderImpl / the upgraded
// JudgmentProvenanceLog.annotateOutcome) was built CONCURRENTLY with this
// wiring and was not importable at P7 build time. When it lands, bind BOTH
// decision-quality arms at the sentinel construction site
// (commands/server.ts, the `new ExternalHogSentinel(...)` call) — passing
// EXACTLY:
//
//   new ExternalHogSentinel(ehAdapters, { ...opts }, {
//     decisionStore: new ExternalHogDecisionStore({
//       stateDir: config.stateDir,
//       config,                                  // reads provenance.quality.{evidenceWindowHours,gradingSlackHours}
//       killLedgerBreakerWindowMs: 3_600_000,    // MUST equal opts.breaker.windowMs (§5.3 retention derivation)
//     }),
//     annotate: (a) => decisionQualityRecorder.annotateOutcome({
//       correlationId: a.correlationId,          // §5.4.1 keying
//       gradedBy: a.gradedBy,                    // { component: 'ExternalHogSentinel', ruleId: 'hog-…-v1' }
//       grade: a.grade,                          // enacted self-reports are 'unknown' + evidence.enacted
//       evidence: a.evidence,                    // structured, content-free (§5.2 clamp discipline)
//     }),
//   });
//
// ALSO required at the same site: the ServerPrimitiveDeps.evaluate lambda must
// forward the provenance block into the intelligence options —
//   evaluate: (prompt, provenance) => sharedIntelligence.evaluate(prompt, {
//     model: 'fast',
//     attribution: { component: 'ExternalHogClassifier' },   // must stay 1:1 with the census key
//     ...(provenance ? { provenance } : {}),
//   }),
// Until both land, `decisionQuality` stays {} → the sentinel counts the
// unwired arms honestly in status() and never fabricates a grade.
