/**
 * decisionQualityTypes — the correlation spine of the LLM-Decision Quality Meter
 * (docs/specs/llm-decision-quality-meter.md §5.1; FD1/FD7/FD8).
 *
 * Layer A (always-on, zero callsite edits): `IntelligenceRouter.evaluate()` mints a
 * per-DECISION correlation id at entry on a router-INTERNAL clone of the options
 * object; the id threads down through every swap attempt of the same decision, and
 * the funnel wrapper (`CircuitBreakingIntelligenceProvider`) stamps it into every
 * `kind:'llm'` metric row's `verdict_id`. A funnel-wrapped provider used DIRECTLY
 * (router bypassed) reaches the breaker without the router's per-call mint marker
 * and gets a local `b-` mint — so no llm row is ever uncorrelated, and
 * provenance-of-mint is derivable from the id prefix alone.
 *
 * This module is deliberately import-free of the rest of core (only node:crypto),
 * so BOTH the router and the breaker can share the symbols/mints/counters without
 * a layering cycle. The recorder singleton follows the setFeatureMetricsRecorder
 * pattern (injected once at AgentServer construction; null = clean no-op).
 */

import { randomUUID } from 'node:crypto';

// ── Correlation plumbing symbols (router → breaker, internal-only) ──────────
//
// Symbol-keyed + enumerable ON PURPOSE: the router's per-attempt option objects
// are built by object spread, which copies own enumerable symbol-keyed
// properties — so every fresh attempt object carries its OWN copy of the mint
// marker, while `JSON.stringify`/`Object.keys` (CLI adapters, logs) never see
// it. Plain Symbols (not Symbol.for): a second module instance failing to
// recognize the marker degrades safely to a `b-` mint, never to id injection.

/** The router-minted correlation id, attached to the router-INTERNAL options clone. */
export const DECISION_CORRELATION_ID: unique symbol = Symbol('instar.decision-quality.correlation-id');

/**
 * The per-call single-use mint marker (§5.1.2). The breaker honors an inbound
 * correlation id ONLY when this marker is present, and CONSUMES it (deletes the
 * property from the received object) on acceptance — a reused options object
 * cannot replay a stale marked id into a later decision's chain.
 */
export const DECISION_MINT_MARKER: unique symbol = Symbol('instar.decision-quality.mint-marker');

// ── Layer B enrollment block (per-callsite contract, §5.1.4) ────────────────

/**
 * The additive `options.provenance` enrollment block an enrolling callsite
 * supplies (Layer B — opt-in, per decision point). The block is CONSUMED by the
 * seam: the router strips it from every per-attempt option spread, and the
 * breaker ALSO strips it before `inner.evaluate` — it can never reach an inner
 * adapter on any path (§5.1.6).
 */
export interface DecisionProvenanceBlock {
  /**
   * Stable decision-point id — IMPORTED from the census module (§5.6 typed
   * registration; the settlement write additionally validates membership and
   * counts unknowns in later phases).
   */
  decisionPoint: string;
  /**
   * Decision context, built via the decision point's content-class envelope
   * BUILDER (§5.2) — callsites do not hand-roll envelopes. Scrubbed + clamped
   * at the settlement write.
   */
  context?: Record<string, unknown>;
  /** The bounded action space shown to the model — static, code-authored, enum-like labels (§5.2 clamps). */
  optionsPresented?: string[];
  /** Prompt identity — a hash/version tag (charset/length-clamped at write, §5.2). */
  promptId?: string;
  /**
   * Fired by the ROUTER synchronously at MINT (entry, before the first attempt),
   * exactly once per `evaluate()` invocation, INCLUDING decisions that
   * subsequently throw — never after the returned promise settles. The router
   * invokes it inside try/catch: a throwing callback is caught + counted and
   * never propagates (the documented `classifyVerdict` containment contract).
   * A router-BYPASSED call never fires it (the breaker strips the block).
   */
  onCorrelationId?: (id: string) => void;
}

// ── Settlement (write-once, §5.1.5 / FD7) ───────────────────────────────────

/** Usage/model captured per attempt via fresh wrapper closures (per-attempt scoping). */
export interface DecisionAttemptCapture {
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  resolved?: { model: string; framework?: string };
}

/**
 * One settled decision, handed to the recorder at EVERY `evaluate()` exit —
 * ladder success, ladder-final failure, the `!cfg` early return, the
 * provider-unavailable degrade arm, the `enforcedNoRoute` throw, the
 * `RouterFailClosedError` rethrow, and the fallback-`'none'` throw. Exactly ONE
 * settlement per router invocation (write-once latch).
 */
export interface DecisionSettlement {
  /** The router-minted correlation id (`d-<machineId8>-<uuid>` / `d-<uuid>`). */
  correlationId: string;
  /** Router settlements are always router mints (breaker `b-` mints never settle — census-pending by rule). */
  mintedBy: 'router';
  /** Whether the call carried an `options.provenance` enrollment block (Layer B). */
  enrolled: boolean;
  /** The CONSUMED enrollment block (callback omitted) — present iff enrolled. */
  provenance?: {
    decisionPoint: string;
    context?: Record<string, unknown>;
    optionsPresented?: string[];
    promptId?: string;
  };
  /**
   * Usage/model/door of the attempt whose promise the router actually returned
   * (§5.1.5 per-attempt capture scoping) — rejected attempts and
   * withSwapTimeout-abandoned late callbacks never contribute. Empty on an
   * errored settlement where no attempt resolved.
   */
  settledAttempt: {
    model?: string;
    framework?: string;
    usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  };
  /**
   * `'fired'`/`'noop'` (from `classifyVerdict` where implemented) or
   * `'unclassified'` on a successful settlement; the fixed marker `'<errored>'`
   * on any throwing exit (so failure-swap-ladder quality is itself gradeable).
   */
  verdictClass: string;
  /** The error class name, set only when `verdictClass === '<errored>'`. */
  errorClass?: string;
  /**
   * A caller-supplied `classifyVerdict.verdictId`, RELOCATED here (FD8): it no
   * longer lands in `feature_metrics.verdict_id` on llm rows. Present only when
   * enrolled (destined for the provenance row's context as `callerRef`);
   * dropped otherwise.
   */
  callerRef?: string;
  /**
   * Head of the raw model response (§5.1.5): present ONLY when enrolled AND
   * the settlement classified `'unclassified'` (no classifier / classifier
   * threw). Bounded at source; the seam scrubs + clamps it to 300 chars into
   * the provenance row's `context` — it NEVER lands in the served `decision`
   * field.
   */
  rawResponseHead?: string;
  /** Wall-clock timestamps: the mint (evaluate entry) and the settlement (exit). */
  mintedAtMs: number;
  settledAtMs: number;
}

/**
 * The decision-quality recorder the router's settlement seam writes to. The
 * concrete substrate (SQLite `decision_quality` + provenance JSONL, later
 * phases) is injected at AgentServer construction via
 * `setDecisionQualityRecorder` — the setFeatureMetricsRecorder pattern. Null =
 * no recording (CLI commands without a server), a clean no-op. A recorder MUST
 * never throw into the decision path; the router additionally isolates the
 * call defensively — observability must not break what it observes.
 */
export interface DecisionQualityRecorder {
  recordSettlement(settlement: DecisionSettlement): void;
}

// ── Module singletons (injected once at AgentServer construction) ───────────

let _decisionQualityRecorder: DecisionQualityRecorder | null = null;
export function setDecisionQualityRecorder(recorder: DecisionQualityRecorder | null): void {
  _decisionQualityRecorder = recorder;
}
export function getDecisionQualityRecorder(): DecisionQualityRecorder | null {
  return _decisionQualityRecorder;
}

// machineId8 — the first 8 chars of the pool/mesh self machine id (§5.1.1),
// injected beside the recorder singleton. Absent (single-machine install) ⇒ the
// id segment is omitted. Shared by BOTH mint sites (router `d-`, breaker `b-`).
let _machineId8: string | null = null;
export function setDecisionQualityMachineId(machineId: string | null | undefined): void {
  _machineId8 = typeof machineId === 'string' && machineId.length > 0 ? machineId.slice(0, 8) : null;
}

/** Router mint: `d-<machineId8>-<uuid>` on multi-machine installs, else `d-<uuid>` (FD1 — uuid-based, never time+seq). */
export function mintRouterCorrelationId(): string {
  return _machineId8 ? `d-${_machineId8}-${randomUUID()}` : `d-${randomUUID()}`;
}

/** Breaker-floor mint for router-bypassing calls: `b-<machineId8>-<uuid>` / `b-<uuid>` (§5.1.2). */
export function mintBreakerCorrelationId(): string {
  return _machineId8 ? `b-${_machineId8}-${randomUUID()}` : `b-${randomUUID()}`;
}

// ── Counters (observability for the seam's own containment paths) ──────────

export interface DecisionQualityCounters {
  /** onCorrelationId callbacks that threw (caught + contained; the decision call succeeded). */
  onCorrelationIdThrows: number;
  /** `options.provenance` blocks stripped at the BREAKER (a router-bypassed carrier — census-pending by rule). */
  provenanceStrippedAtBreaker: number;
  /** Inbound correlation ids DISCARDED at the breaker (unmarked / marker-less / marker already consumed). */
  inboundCorrelationIdDiscarded: number;
}

const _counters: DecisionQualityCounters = {
  onCorrelationIdThrows: 0,
  provenanceStrippedAtBreaker: 0,
  inboundCorrelationIdDiscarded: 0,
};

export function bumpOnCorrelationIdThrow(): void {
  _counters.onCorrelationIdThrows++;
}
export function bumpProvenanceStrippedAtBreaker(): void {
  _counters.provenanceStrippedAtBreaker++;
}
export function bumpInboundCorrelationIdDiscarded(): void {
  _counters.inboundCorrelationIdDiscarded++;
}
export function getDecisionQualityCounters(): Readonly<DecisionQualityCounters> {
  return { ..._counters };
}

/** Test-only seam (the _resetUnlabeledEmissionForTest precedent). */
export function _resetDecisionQualityForTest(): void {
  _decisionQualityRecorder = null;
  _machineId8 = null;
  _counters.onCorrelationIdThrows = 0;
  _counters.provenanceStrippedAtBreaker = 0;
  _counters.inboundCorrelationIdDiscarded = 0;
}
