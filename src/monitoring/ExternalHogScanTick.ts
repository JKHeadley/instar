/**
 * ExternalHogScanTick — the orchestrator that composes the External-Hog sentinel's modules into
 * ONE scan tick (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §1-§6).
 *
 * This is the "make it alive" integration: discovery (sampler) → classify (worst-CPU-first under
 * the cap) → floor → kill funnel → P19 ledger → P17 coalesced notices. All I/O is INJECTED
 * (read ps, build ownership, classify, the kill-funnel deps, clock, deliver) so the whole tick
 * is end-to-end testable without a real ps read, a real model call, or a real signal. The thin
 * server-side wiring (the actual ps spawn, LlmQueue call, notice delivery, interval) is a
 * separate slice; this is the pure control flow that ties the reviewed modules together.
 *
 * Watch-only rides through: the kill funnel returns `would-kill` (no signal) unless a live kill
 * is authorized, so in the shipped dryRun state a scan tick produces would-kill records + the
 * §4 observability notices, and kills NOTHING.
 */

import type { ProcTableRow } from './ExternalHogProcTable.js';
import { advanceSampler, type SamplerState, type SamplerOpts, type Candidate } from './ExternalHogSampler.js';
import type { ProcTree, OwnedRefs } from './ExternalHogOwnership.js';
import { selectForClassification, parseClassifierVerdict, type ClassifierVerdict } from './ExternalHogClassifier.js';
import { evaluateKillFloor, matchAllowlistClass, type ExternalHogFacts, type FloorVerdict } from './ExternalHogFloor.js';
import { parseParentPid, lstartToEpochMs } from './ExternalHogFactBuilder.js';
import { runKillFunnel, type KillOutcome, type KillTarget, type KillFunnelDeps, type KillFunnelOpts } from './ExternalHogKillFunnel.js';
import {
  isBreakerTripped, recordKill, type KillLedgerState, type BreakerOpts,
} from './ExternalHogKillLedger.js';
import { coalesceNotices, type Notice, type CoalesceResult } from './ExternalHogNoticeCoalescer.js';
import { advanceSustained, isSustained, candidateSignature, type SustainedState } from './ExternalHogSustained.js';
import { governor, consumeAdmissionToken } from './selfaction/governor.js';
import type { DerivedTarget } from './selfaction/types.js';
import { DP_EXTERNAL_HOG_KILL_LEAVE } from '../data/provenanceCoverage.js';
import type { DecisionProvenanceBlock } from '../core/decisionQualityTypes.js';

/* @self-action-controller: external-hog-kill-breaker */
// Unified self-action backpressure (Increment B, OBSERVE-ONLY): the live kill
// path rides the SelfActionGovernor ADDITIVELY — the shipped P19 kill-ledger
// breaker below stays exactly as it is (the tightest bound wins). This is the
// multi-file half of the `external-hog-kill-breaker` controller (marker also
// on ExternalHogSentinel.ts; both files ride the per-controller allowlist —
// the handle is minted ONCE, here, at the emit site).
const externalHogKillGov = governor.for('external-hog-kill-breaker');

/** Canonical target derivation: the ledger key IS the recurrence SIGNATURE
 *  (stable across respawns — a new pid, same signature, collapses to ONE
 *  target), with the allowlist class as the stable classId — mirroring the
 *  deployed ExternalHogKillLedger (key, classId, keyIsVolatile) triple. */
export function deriveTargetKey(ctx: { ledgerKey: string; classId: string }): DerivedTarget {
  return { key: ctx.ledgerKey, classId: ctx.classId, keyIsVolatile: false };
}

export interface ScanState {
  readonly sampler: SamplerState;
  readonly ledger: KillLedgerState;
  /** Stage-2 N-window sustained-CPU streaks (§1 anti-spike; feeds sustainedHighCpu authoritatively). */
  readonly sustained: SustainedState;
}

// ── LLM-Decision Quality Meter — the §5.3 first-customer wiring ─────────────
// (docs/specs/llm-decision-quality-meter.md §5.3: enrollment via
// options.provenance on the classifier call + the enacted-disposition space
// the durable ExternalHogDecisionStore records.)

/**
 * The sentinel's REAL enacted-disposition space (spec §5.3, verified against
 * this orchestrator's branches): the five kill-funnel outcomes plus the four
 * alert-only branches plus decider-unavailable. Only `killed`/`sigterm-exited`
 * ever enter the kill-grading evidence rules; `would-kill`/`deferred`/
 * `aborted`/`decider-unavailable` age out `unknown` — during the watch-only
 * dev soak EVERY kill verdict enacts as `would-kill`.
 */
export type HogEnactedDisposition =
  | 'killed'
  | 'sigterm-exited'
  | 'would-kill'
  | 'deferred'
  | 'aborted'
  | 'alert-only-model-spared'
  | 'alert-only-floor-veto'
  | 'alert-only-breaker-held'
  | 'alert-only-governor-hold'
  | 'decider-unavailable';

/**
 * Stable prompt identity for the classifier decision point. The prompt module
 * (ExternalHogClassifierPrompt) carries no version tag of its own, so this is
 * the §5.2 promptId literal — bump it when buildClassifierPrompt changes
 * materially (a prompt change is exactly what the meter's per-prompt
 * attribution exists to distinguish).
 */
export const HOG_CLASSIFIER_PROMPT_ID = 'external-hog-classifier-v1';

/**
 * The candidate's OWN spoof-proof identity (§5.3 targetTuple): pid + lstart
 * parsed to epoch ms FOR ORDERING (start-times cannot be forged old). A null
 * `startTimeMs` (un-parseable lstart) degrades every ordering-dependent
 * evidence predicate to `unknown`, never `wrong`.
 */
export interface HogTargetTuple {
  readonly pid: number;
  readonly startTimeMs: number | null;
}

/**
 * MEMBER-WISE owner identity (§5.3, ADV r4/r5/r6): `parentPid` is ALWAYS
 * derivable for a floor-PERMITTED kill by construction (parseParentPid
 * succeeded, else the floor's ownerAppRunning veto fired), so it is always
 * present on ENACTED kills — but a floor-VETOED kill verdict whose veto came
 * from a null parse legitimately has NO parentPid, so nothing here is
 * hard-asserted. `parentStartTimeMs` is recorded where derivable and absent
 * in the dominant orphan-kill case (no live parent to stamp).
 */
export interface HogOwnerTuple {
  readonly parentPid?: number;
  readonly parentStartTimeMs?: number;
}

/**
 * The durable decision-store seed for ONE per-candidate decision — everything
 * the ExternalHogDecisionStore's per-ledgerKey record needs except the wall
 * timestamp + effective window (the store stamps those; the scan tick's clock
 * is monotonic and must never be persisted).
 */
export interface HogDecisionSeed {
  readonly ledgerKey: string;
  readonly classId: string;
  readonly commandHash: string;
  readonly verdict: ClassifierVerdict | 'decider-unavailable';
  readonly enacted: HogEnactedDisposition;
  /** Router-minted correlation id (via provenance.onCorrelationId); null when
   *  no mint reached us (no classify call, router-bypassed, provider down). */
  readonly correlationId: string | null;
  readonly targetTuple: HogTargetTuple;
  readonly ownerTuple: HogOwnerTuple;
  /** The floor verdict AT DECISION TIME. False for over-cap degraded rows
   *  (the floor was never evaluated — conservative, excludes every
   *  floorPermitted-gated evidence rule). */
  readonly floorPermitted: boolean;
}

/** Derive the member-wise owner tuple from argv + the live proc tree (§5.3). */
export function deriveHogOwnerTuple(argv: string, tree: ProcTree): HogOwnerTuple {
  const parentPid = parseParentPid(argv);
  if (parentPid === null) return {};
  const parent = tree.get(parentPid);
  const parentStartTimeMs = parent ? lstartToEpochMs(parent.startTime) : null;
  return { parentPid, ...(parentStartTimeMs !== null ? { parentStartTimeMs } : {}) };
}

/**
 * The bounded §5.2 content-bearing hog envelope: identity + verdict-relevant
 * fields ONLY — commandHash/ledgerKey/classId, the (length-clamped) process
 * name, floor booleans, CPU numbers, and the code-derived identity tuples.
 * NEVER raw argv (attacker-controllable, can carry positional passwords).
 */
export function buildHogDecisionContext(input: {
  readonly id: { commandHash: string; ledgerKey: string; classId: string };
  readonly facts: ExternalHogFacts;
  readonly floor: FloorVerdict;
  readonly coreEquivalents: number;
  readonly targetTuple: HogTargetTuple;
  readonly ownerTuple: HogOwnerTuple;
}): Record<string, unknown> {
  const { id, facts, floor, coreEquivalents, targetTuple, ownerTuple } = input;
  return {
    commandHash: id.commandHash,
    ledgerKey: id.ledgerKey,
    classId: id.classId,
    name: typeof facts.name === 'string' ? facts.name.slice(0, 200) : '',
    floorPermitted: floor.permitted,
    ...(floor.permitted ? {} : { floorVetoReason: floor.vetoReason }),
    ownerAppRunning: facts.ownerAppRunning === true,
    sustainedHighCpu: facts.sustainedHighCpu === true,
    isInstarProcess: facts.isInstarProcess === true,
    ownerRootDaemon: facts.ownerRootDaemon === true,
    hasLaunchctlLabel: facts.hasLaunchctlLabel === true,
    coreEquivalents,
    pid: targetTuple.pid,
    startTimeMs: targetTuple.startTimeMs,
    ...(ownerTuple.parentPid !== undefined ? { parentPid: ownerTuple.parentPid } : {}),
  };
}

export interface ScanDeps {
  /** The current parsed ps table (the sampler's input). */
  readProcTable(): readonly ProcTableRow[];
  /** Build the ownership sets (tree + owned pids) from the current table + instar pids. */
  buildOwnership(table: readonly ProcTableRow[]): { tree: ProcTree; owned: OwnedRefs };
  /** Full deterministic facts for a candidate (the floor input); null if it vanished. May be async
   *  (a per-candidate ps -o args= read + launchctl) — the orchestrator awaits it. */
  factsFor(candidate: Candidate): ExternalHogFacts | null | Promise<ExternalHogFacts | null>;
  /** The command-hash + ledger key + class for a candidate (identity for the ledger/funnel). */
  identityFor(candidate: Candidate, facts: ExternalHogFacts): { commandHash: string; ledgerKey: string; classId: string } | null;
  /** Call the classifier (LlmQueue). Returns raw model output, or null if the decider is unavailable.
   *  `provenance` is the §5.3 enrollment block (llm-decision-quality-meter) — the adapter threads it
   *  as `options.provenance` on the underlying intelligence.evaluate call. */
  classify(facts: ExternalHogFacts, provenance?: DecisionProvenanceBlock): Promise<unknown>;
  /** The kill-funnel I/O (re-read facts/arm, fd-probe, signal, aliveness, wait). */
  killFunnelDeps: KillFunnelDeps;
  /** A monotonic clock reading (ms). */
  nowMs(): number;
  /** How many times a target signature has already been deferred (for maxKillDeferrals). */
  deferralsFor(ledgerKey: string): number;
}

export interface ScanOpts {
  readonly sampler: SamplerOpts;
  /** N consecutive delta windows over threshold before sustainedHighCpu is true (§1 anti-spike). */
  readonly sustainedSampleCount: number;
  readonly maxClassificationsPerScan: number;
  readonly breaker: Omit<BreakerOpts, 'nowMs'>;
  readonly killFunnel: Omit<KillFunnelOpts, 'currentDeferrals'>;
  readonly noticeBudgetPerWindow: number;
  readonly killLedgerRetentionMs: number;
}

/** One per-candidate outcome row (for the audit/soak log AND cross-tick deferral tracking).
 *  `ledgerKey`/`classId` carry the target IDENTITY so a consumer (the sentinel shell) can
 *  persist how many times a signature has been deferred without re-deriving it. */
export interface ScanOutcome {
  readonly pid: number;
  readonly ledgerKey: string;
  readonly classId: string;
  readonly verdict: ClassifierVerdict | 'decider-unavailable';
  readonly outcome: KillOutcome | 'alert-only';
  /** The ENACTED disposition (spec §5.3 10-value space) — what actually
   *  happened after floors/breakers/governors, never the raw verdict. */
  readonly enacted: HogEnactedDisposition;
  /** The durable decision-store seed (the ExternalHogDecisionStore record
   *  minus the store-stamped wall time + effective window). Present on every
   *  outcome — each row comes from a fully-identified (enriched) candidate. */
  readonly decision: HogDecisionSeed;
}

export interface ScanResult {
  readonly nextState: ScanState;
  /** Per-candidate outcomes (for the audit/soak log). */
  readonly outcomes: ReadonlyArray<ScanOutcome>;
  /** The coalesced notices to deliver. */
  readonly notices: CoalesceResult;
}

/**
 * Run one scan tick. Pure control flow over the injected I/O; mutates nothing. In the shipped
 * dryRun state every `outcome` is `would-kill`/`alert-only` and no signal is sent.
 */
export async function runScanTick(state: ScanState, deps: ScanDeps, opts: ScanOpts): Promise<ScanResult> {
  const now = deps.nowMs();
  const table = deps.readProcTable();
  const { tree, owned } = deps.buildOwnership(table);

  // Stage-1 candidacy.
  const tick = advanceSampler(state.sampler, table, tree, owned, now, opts.sampler);
  const nextSampler = tick.nextState;

  // Stage-2 sustained confirmation (§1 anti-spike): advance the per-signature streak with THIS
  // tick's over-threshold candidates. A failed/empty parse yields no candidates → every streak
  // resets (fail toward not-sustained). This is the AUTHORITATIVE N-window signal that overrides
  // whatever single-window read the fact builder produced.
  const sustainedTick = advanceSustained(state.sustained, tick.candidates.map((c) => candidateSignature(c.pid, c.startTime)));
  const nextSustained = sustainedTick.nextState;

  // Worst-CPU-first under the per-scan classifier cap.
  const outcomes: ScanOutcome[] = [];
  const notices: Notice[] = [];
  let ledger = state.ledger;

  // Enrich candidates. A candidate whose facts VANISHED (factsFor null) is skipped silently —
  // the process is gone, there is nothing to surface. But a PRESENT candidate (non-null facts)
  // that we can't fully IDENTIFY (identityFor null — e.g. a sustained hog outside the killable
  // allowlist class, or an identity race on the command-hash) is NEVER a killable target, yet
  // it IS a sustained external hog: it MUST be SURFACED, never silently dropped (round-13 —
  // second-pass reviewer: the §4 broad-observability guarantee — no present hog is invisible).
  const enriched: Array<{ c: Candidate; facts: ExternalHogFacts; id: { commandHash: string; ledgerKey: string; classId: string }; tuple: { pid: number; startTime: string; commandHash: string }; coreEquivalents: number; targetTuple: HogTargetTuple; ownerTuple: HogOwnerTuple }> = [];
  for (const c of tick.candidates) {
    const rawFacts = await deps.factsFor(c);
    if (!rawFacts) continue; // vanished → nothing to surface (safe)
    // Override sustainedHighCpu with the AUTHORITATIVE N-window signal: it stays true ONLY if the
    // fact builder's single-window read was GENUINELY boolean-true AND the streak has reached N
    // consecutive windows (§1). A one-window spike (streak < N) is forced to false → the floor's
    // hard veto downgrades it to alert — never a kill on a transient burst.
    //
    // We apply the AND-gate ONLY to a strict `=== true`; a MALFORMED value (a degraded fact
    // builder emitting `1`/undefined/null under the CPU starvation this sentinel hunts) is
    // PRESERVED verbatim, NOT coerced. `x && sustained` would launder a truthy non-boolean into
    // boolean `true`, defeating the floor's round-11 `typeof !== 'boolean' → field-unknown` veto
    // in the kill-PERMITTING direction (Phase-5 reviewer). Preserving it keeps that veto intact.
    const sustained = isSustained(sustainedTick, candidateSignature(c.pid, c.startTime), opts.sustainedSampleCount);
    const facts: ExternalHogFacts = { ...rawFacts, sustainedHighCpu: rawFacts.sustainedHighCpu === true ? sustained : rawFacts.sustainedHighCpu };
    const id = deps.identityFor(c, facts);
    if (!id) {
      // Present sustained hog, not kill-eligible → surface (observability), never classify/kill.
      notices.push({ cls: 'hog-left-alive', signature: `${c.pid} ${c.startTime}`, text: `sustained external hog (not kill-eligible): pid ${c.pid}` });
      continue;
    }
    enriched.push({
      c, facts, id,
      tuple: { pid: c.pid, startTime: c.startTime, commandHash: id.commandHash },
      coreEquivalents: c.coreEquivalents,
      // §5.3 durable-store identity tuples, derived ONCE per candidate from the
      // code-read table/argv (never from model output).
      targetTuple: { pid: c.pid, startTimeMs: lstartToEpochMs(c.startTime) },
      ownerTuple: deriveHogOwnerTuple(facts.argv, tree),
    });
  }

  const { toClassify, degradedToAlert } = selectForClassification(enriched, opts.maxClassificationsPerScan);

  for (const cand of toClassify) {
    const floor = evaluateKillFloor(cand.facts);

    // §5.3 enrollment (llm-decision-quality-meter): the classifier call carries
    // options.provenance so the router mints + settles a decision row for it.
    // onCorrelationId fires SYNCHRONOUSLY at mint (before the first attempt),
    // so `correlationId` is set by the time the classify promise resolves.
    let correlationId: string | null = null;
    const provenance: DecisionProvenanceBlock = {
      decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
      context: buildHogDecisionContext({
        id: cand.id, facts: cand.facts, floor,
        coreEquivalents: cand.coreEquivalents,
        targetTuple: cand.targetTuple, ownerTuple: cand.ownerTuple,
      }),
      optionsPresented: ['kill', 'leave'],
      promptId: HOG_CLASSIFIER_PROMPT_ID,
      onCorrelationId: (id) => { correlationId = id; },
    };
    const raw = await deps.classify(cand.facts, provenance);
    const verdict = parseClassifierVerdict(raw); // null → decider-unavailable → alert

    /** The durable-store seed for this candidate's decision (persisted by the sentinel shell). */
    const decisionSeed = (v: ClassifierVerdict | 'decider-unavailable', enacted: HogEnactedDisposition): HogDecisionSeed => ({
      ledgerKey: cand.id.ledgerKey, classId: cand.id.classId, commandHash: cand.id.commandHash,
      verdict: v, enacted, correlationId,
      targetTuple: cand.targetTuple, ownerTuple: cand.ownerTuple,
      floorPermitted: floor.permitted,
    });

    // The §4 observability floor: a deterministic sustained hog that is NOT killed is ALWAYS
    // surfaced (the model can never silence it).
    const surfaceLeftAlive = () => notices.push({ cls: 'hog-left-alive', signature: cand.id.ledgerKey, text: `sustained hog left alive: pid ${cand.c.pid}` });

    if (verdict === null) {
      // Decider unavailable → no kill → alert.
      outcomes.push({ pid: cand.c.pid, ledgerKey: cand.id.ledgerKey, classId: cand.id.classId, verdict: 'decider-unavailable', outcome: 'alert-only', enacted: 'decider-unavailable', decision: decisionSeed('decider-unavailable', 'decider-unavailable') });
      notices.push({ cls: 'decider-unavailable', signature: cand.id.ledgerKey, text: `decider unavailable: pid ${cand.c.pid}` });
      continue;
    }

    if (verdict !== 'kill' || !floor.permitted) {
      // Model spared it, or the floor vetoes → alert-only (observability floor still surfaces).
      // Disposition honesty (§5.3): a spared verdict is 'alert-only-model-spared' (the
      // leave-recurrence rule's precondition ALSO requires floorPermitted, recorded on the
      // seed); a kill verdict the floor vetoed is 'alert-only-floor-veto' — never graded
      // as if the classifier's recommendation had been executed.
      const enacted: HogEnactedDisposition = verdict !== 'kill' ? 'alert-only-model-spared' : 'alert-only-floor-veto';
      outcomes.push({ pid: cand.c.pid, ledgerKey: cand.id.ledgerKey, classId: cand.id.classId, verdict, outcome: 'alert-only', enacted, decision: decisionSeed(verdict, enacted) });
      surfaceLeftAlive();
      if (!floor.permitted) notices.push({ cls: 'floor-veto-downgrade', signature: cand.id.ledgerKey, text: `floor vetoed a kill: pid ${cand.c.pid}` });
      continue;
    }

    // verdict === 'kill' && floor permits. Check the P19 breaker before acting.
    const tripped = isBreakerTripped(ledger, cand.id.ledgerKey, cand.id.classId, { ...opts.breaker, nowMs: now });
    if (tripped) {
      outcomes.push({ pid: cand.c.pid, ledgerKey: cand.id.ledgerKey, classId: cand.id.classId, verdict, outcome: 'alert-only', enacted: 'alert-only-breaker-held', decision: decisionSeed(verdict, 'alert-only-breaker-held') });
      surfaceLeftAlive(); // shielded from KILL only, never from surfacing
      continue;
    }

    // Self-action backpressure admission (observe-only: always allows; an
    // enforce-mode non-allow downgrades to alert-only — the observability
    // floor still surfaces the hog, never a silent stand-down).
    const hogTarget = deriveTargetKey({ ledgerKey: cand.id.ledgerKey, classId: cand.id.classId });
    const hogAdmission = externalHogKillGov.admitSync(hogTarget, { incarnation: String(cand.c.pid), lane: 'job' });
    const hogSink =
      hogAdmission.outcome === 'allow'
        ? consumeAdmissionToken(hogAdmission.token, 'external-hog-kill-breaker', { targetKey: hogTarget.key })
        : null;
    if (hogAdmission.outcome !== 'allow' || !hogSink?.proceed) {
      outcomes.push({ pid: cand.c.pid, ledgerKey: cand.id.ledgerKey, classId: cand.id.classId, verdict, outcome: 'alert-only', enacted: 'alert-only-governor-hold', decision: decisionSeed(verdict, 'alert-only-governor-hold') });
      surfaceLeftAlive();
      continue;
    }

    // Run the kill funnel (watch-only unless armed → would-kill, no signal).
    const target: KillTarget = { pid: cand.c.pid, startTime: cand.c.startTime, commandHash: cand.id.commandHash, classId: cand.id.classId };
    const funnelOpts: KillFunnelOpts = { ...opts.killFunnel, currentDeferrals: deps.deferralsFor(cand.id.ledgerKey) };
    const outcome = await runKillFunnel(target, funnelOpts, deps.killFunnelDeps);
    // The funnel's action IS the enacted disposition (killed | sigterm-exited |
    // would-kill | deferred | aborted) — the §5.3 enum reuses the same names.
    outcomes.push({ pid: cand.c.pid, ledgerKey: cand.id.ledgerKey, classId: cand.id.classId, verdict, outcome, enacted: outcome.action, decision: decisionSeed(verdict, outcome.action) });

    if (outcome.action === 'killed') {
      ledger = recordKill(ledger, { key: cand.id.ledgerKey, classId: cand.id.classId, atMs: now }, opts.killLedgerRetentionMs, now);
      notices.push({ cls: 'kill', signature: cand.id.ledgerKey, text: `auto-killed zombie: pid ${cand.c.pid}` });
    } else {
      // would-kill (watch-only) / deferred / aborted / sigterm-exited → surface as left-alive.
      surfaceLeftAlive();
    }
  }

  // The over-cap remainder degrades to alert-only (observability floor). No classifier ran,
  // so verdict + enacted are 'decider-unavailable', there is no correlation id, and
  // floorPermitted is false (the floor was never evaluated — conservative).
  for (const cand of degradedToAlert) {
    outcomes.push({
      pid: cand.c.pid, ledgerKey: cand.id.ledgerKey, classId: cand.id.classId,
      verdict: 'decider-unavailable', outcome: 'alert-only', enacted: 'decider-unavailable',
      decision: {
        ledgerKey: cand.id.ledgerKey, classId: cand.id.classId, commandHash: cand.id.commandHash,
        verdict: 'decider-unavailable', enacted: 'decider-unavailable', correlationId: null,
        targetTuple: cand.targetTuple, ownerTuple: cand.ownerTuple, floorPermitted: false,
      },
    });
    notices.push({ cls: 'hog-left-alive', signature: cand.id.ledgerKey, text: `sustained hog left alive (over cap): pid ${cand.c.pid}` });
  }

  const coalesced = coalesceNotices(notices, { budgetPerWindow: opts.noticeBudgetPerWindow });
  return { nextState: { sampler: nextSampler, ledger, sustained: nextSustained }, outcomes, notices: coalesced };
}
