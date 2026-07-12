/**
 * DecisionQualityRecorderImpl — the concrete decision-quality substrate behind
 * the router's settlement seam (llm-decision-quality-meter §5.2/§5.4/§5.5).
 *
 * Two write paths live here, both observe-only (never gate, never throw into
 * the path they observe):
 *
 * 1. `recordSettlement` (the DecisionQualityRecorder contract, §5.1.5/FD7):
 *    consumes the router's write-once DecisionSettlement. For every ENROLLED
 *    settled decision it ALWAYS writes the ~250-byte content-free
 *    `decision_quality` row (regardless of volume class — outcome rows always
 *    have parents, counts are complete), validates the decision point against
 *    the census (unknown → counted, row still written with the raw point id),
 *    and writes the provenance JSONL row under the census VOLUME VALVE
 *    (`full` always / `sampled:<rate>` deterministic FNV-1a on the correlation
 *    id / `budget:<rows/day>` indexed COUNT since UTC-day start with a loud
 *    droppedByBudget counter).
 *
 * 2. `annotateOutcome` (the §5.4 write-integrity CHOKEPOINT): the ONE path an
 *    outcome annotation takes into the substrate. Keyed on the correlation id;
 *    rung + evidence strength are DERIVED from the registered evidence rule —
 *    never caller-supplied — and the chokepoint REJECTS + COUNTS: an invalid
 *    grade enum, a rung mismatch (incl. an unregistered ruleId — DC r7), an
 *    owner mismatch (gradedBy.component ≠ the rule's registered owning
 *    component — ADV r5), and an unknown decision point. Accepted outcomes
 *    land via `ledger.upsertOutcome` (idempotent on correlationId × gradedBy)
 *    plus a JPL outcome trail row. The evidence RULES themselves (what grade a
 *    respawn/realcheck proves) belong to their owning components — this module
 *    only enforces the write-integrity contract.
 *
 * Gating (§5.7/FD6): `provenance.uniformSeam.enabled` resolves via
 * `resolveDevAgentGate` (LIVE on a development agent, DARK on the fleet;
 * omit-required — never seeded). `dryRun` defaults TRUE: metadata-only
 * would-write log lines (component, decisionPoint, byte sizes — NEVER context
 * content), with BOTH durable writes suppressed (§5.2).
 */

import type { DecisionSettlement, DecisionQualityRecorder } from './decisionQualityTypes.js';
import { setDecisionQualityRecorder } from './decisionQualityTypes.js';
import type { FeatureMetricsLedger, DecisionGrade, GradingRung, EvidenceStrength } from '../monitoring/FeatureMetricsLedger.js';
import type { JudgmentProvenanceLog, DecisionRowInput } from './JudgmentProvenanceLog.js';
import {
  clampServedVerdictClass,
  clampServedPromptId,
  fnv1aSampleBucket,
  CONTEXT_HEAD_CLAMP,
} from './JudgmentProvenanceLog.js';
import { getCensusEntry, getVolumeClass, getRule } from '../data/provenanceCoverage.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { scrubString } from './CredentialAuditEmit.js';

/** Outcome evidence-note hard bound (§5.2/§5.5 — clamped at annotate time, before storage). */
export const EVIDENCE_NOTE_CLAMP = 500;

/* ── Rejection counters (§5.5 — served by class on GET /decision-quality) ────
 * Module-level (the decisionQualityTypes counter idiom) so P10's route reads
 * them without holding the recorder instance. `unknownDecisionPoint` has TWO
 * feeders serving ONE class (DC r7): the §5.1.4 settlement-write census miss
 * AND an annotation claiming an unknown decision point. */

export interface DecisionAnnotationRejectionCounters {
  /** Annotations whose grade failed the FD3 enum (right|wrong|unknown). */
  enumInvalid: number;
  /** Unregistered ruleId, or a claimed rung disagreeing with the registry (§5.4.2). */
  rungMismatch: number;
  /** gradedBy.component ≠ the ruleId's registered owning component (ADV r5). */
  ownerMismatch: number;
  /** Census misses: settlement writes for undeclared points + annotations claiming one (§5.1.4/DC r7). */
  unknownDecisionPoint: number;
}

const _rejectionCounters: DecisionAnnotationRejectionCounters = {
  enumInvalid: 0,
  rungMismatch: 0,
  ownerMismatch: 0,
  unknownDecisionPoint: 0,
};

/** The four §5.5 rejection-class counters (P10's route surface). */
export function getDecisionAnnotationRejectionCounters(): Readonly<DecisionAnnotationRejectionCounters> {
  return { ..._rejectionCounters };
}

/** Test-only seam (the _resetDecisionQualityForTest precedent). */
export function _resetDecisionAnnotationRejectionCountersForTest(): void {
  _rejectionCounters.enumInvalid = 0;
  _rejectionCounters.rungMismatch = 0;
  _rejectionCounters.ownerMismatch = 0;
  _rejectionCounters.unknownDecisionPoint = 0;
}

/* ── Annotate chokepoint types ──────────────────────────────────────────── */

export type AnnotationRejectionClass =
  | 'enum-invalid'
  | 'rung-mismatch'
  | 'owner-mismatch'
  | 'unknown-decision-point';

export interface DecisionOutcomeAnnotationInput {
  /** The §5.1 correlation id the outcome joins its decision on (§5.4.1). */
  correlationId: string;
  /** Registered, immutable, versioned evidence-rule id (§5.4.5). */
  ruleId: string;
  /** The grading component — MUST be the ruleId's registered owner (ADV r5). */
  gradedBy: { component: string };
  /** FD3 grade — validated against the closed enum at the chokepoint. */
  grade: string;
  /**
   * Optional rung CLAIM. The effective rung is ALWAYS derived from the
   * registry; a supplied claim that disagrees is rejected (§5.4.2 — "an
   * annotation claiming a ruleId whose registered rung disagrees").
   */
  claimedRung?: string;
  /** ≤500 scrubbed chars, pointer-disciplined; NEVER served by /decision-quality. */
  evidenceNote?: string;
  /** Structured evidence (ids/hashes/enums) for the JPL outcome trail row. */
  evidence?: Record<string, unknown>;
  /**
   * Orphan-attribution hint (FD10) — the census decision point this outcome
   * belongs to. If supplied it must exist in the census (unknown → rejected
   * + counted).
   */
  decisionPoint?: string;
  /** Defaults to the recorder clock. */
  ts?: number;
}

export interface DecisionOutcomeAnnotationResult {
  /** True = the outcome row landed durably (orphan or not). */
  applied: boolean;
  rejected?: AnnotationRejectionClass;
  /** True = no decision_quality parent on this machine (FD10 — counted, never an error). */
  orphan?: boolean;
  /** True = validated clean but suppressed by the §5.2 dry-run stage. */
  dryRun?: boolean;
  /** True = the seam resolves DARK on this agent (nothing counted, nothing written). */
  disabled?: boolean;
}

/* ── The recorder ───────────────────────────────────────────────────────── */

/** The config slice the recorder resolves its gates from (§5.7). */
export interface DecisionQualityRecorderConfig {
  developmentAgent?: boolean;
  provenance?: {
    uniformSeam?: { enabled?: boolean; dryRun?: boolean };
  };
}

/** The census lookups the recorder consumes (§5.6 — defaults to the real PROVENANCE_COVERAGE module). */
export interface DecisionQualityCensus {
  getCensusEntry: typeof getCensusEntry;
  getVolumeClass: typeof getVolumeClass;
}

/** The evidence-rule registry lookup the annotate chokepoint consumes (§5.4.2 — defaults to RULE_REGISTRY). */
export interface DecisionQualityRules {
  getRule: typeof getRule;
}

export interface DecisionQualityRecorderImplOptions {
  /** The quality substrate (decision_quality/decision_outcomes/rollup). Null = degraded (no SQLite writes). */
  ledger: FeatureMetricsLedger | null;
  /** The provenance JSONL store (FD9 — constructed unconditionally). Null = degraded (no JSONL rows). */
  judgmentProvenance?: JudgmentProvenanceLog | null;
  config: DecisionQualityRecorderConfig;
  /** Census lookups — the typed PROVENANCE_COVERAGE module by default (test seam). */
  census?: DecisionQualityCensus;
  /** Rule-registry lookup — RULE_REGISTRY by default (test seam). */
  rules?: DecisionQualityRules;
  log?: (msg: string) => void;
  now?: () => number;
}

type JsonlDisposition = 'write' | 'sampled-out' | 'budget-dropped' | 'no-volume-class';

export class DecisionQualityRecorderImpl implements DecisionQualityRecorder {
  private readonly ledger: FeatureMetricsLedger | null;
  private readonly jpl: JudgmentProvenanceLog | null;
  private readonly census: DecisionQualityCensus;
  private readonly rules: DecisionQualityRules;
  private readonly enabled: boolean;
  private readonly dryRun: boolean;
  private readonly log: (msg: string) => void;
  private readonly nowFn: () => number;

  constructor(opts: DecisionQualityRecorderImplOptions) {
    this.ledger = opts.ledger ?? null;
    this.jpl = opts.judgmentProvenance ?? null;
    this.census = opts.census ?? { getCensusEntry, getVolumeClass };
    this.rules = opts.rules ?? { getRule };
    // §5.7/FD6: omit-required dev gate — LIVE on a development agent, DARK on
    // the fleet; an explicit config value always wins. dryRun defaults TRUE.
    this.enabled = resolveDevAgentGate(opts.config.provenance?.uniformSeam?.enabled, opts.config);
    this.dryRun = opts.config.provenance?.uniformSeam?.dryRun !== false;
    this.log = opts.log ?? (() => {});
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /** The resolved gate state (wiring-integrity/status surface). */
  gateState(): { enabled: boolean; dryRun: boolean } {
    return { enabled: this.enabled, dryRun: this.dryRun };
  }

  /**
   * The router-settlement write (§5.1.5/FD7 — exactly one call per settled
   * decision, isolated by the router; this method additionally never throws).
   */
  recordSettlement(s: DecisionSettlement): void {
    try {
      if (!this.enabled) return;
      if (!s.enrolled || !s.provenance) return; // Layer A only — nothing enrolled to write
      const decisionPoint = typeof s.provenance.decisionPoint === 'string' ? s.provenance.decisionPoint : '';
      if (!decisionPoint) return; // keyless enrollment = unjoinable noise
      const entry = this.census.getCensusEntry(decisionPoint);
      // §5.1.4: validate decisionPoint ∈ census; unknowns are COUNTED but the
      // decision_quality row is still written with the raw point id — counts
      // must be complete (DC2-M3).
      if (!entry) _rejectionCounters.unknownDecisionPoint++;
      const volumeClass = this.census.getVolumeClass(decisionPoint); // undefined unless census-wired

      // Bounded served labels (§5.2) — the SAME clamp helpers the JPL envelope
      // applies, so the SQLite row and the JSONL row can never disagree.
      const verdict = clampServedVerdictClass(s.verdictClass);
      const prompt = clampServedPromptId(s.provenance.promptId);

      const qualityRecord = {
        correlationId: s.correlationId,
        decisionPoint,
        feature: entry?.component,
        verdictClass: verdict.value,
        mintedBy: s.mintedBy,
        volumeClass,
        contentClass: entry?.contentClass,
        machineId: machineIdSegmentOf(s.correlationId) ?? undefined,
        model: s.settledAttempt.model,
        framework: s.settledAttempt.framework,
        promptId: prompt.value,
        ts: s.settledAtMs,
      };

      // Context assembly (§5.1.3/§5.1.5): callerRef relocates INSIDE context
      // (FD8); a raw-response head enters SCRUBBED + 300-clamped — never the
      // served decision field; an errored settlement carries its error class.
      const context: Record<string, unknown> = {
        ...(s.provenance.context ?? {}),
        ...(s.callerRef !== undefined ? { callerRef: scrubString(String(s.callerRef)).slice(0, 128) } : {}),
        ...(s.rawResponseHead !== undefined
          ? { rawResponseHead: scrubString(s.rawResponseHead).slice(0, CONTEXT_HEAD_CLAMP) }
          : {}),
        ...(s.errorClass !== undefined ? { errorClass: String(s.errorClass).slice(0, 128) } : {}),
      };
      const jplInput: DecisionRowInput = {
        component: entry?.component ?? 'unlabeled',
        decisionPoint,
        context,
        optionsPresented: s.provenance.optionsPresented ?? [],
        decision: s.verdictClass, // JPL applies the §5.2 clamp on seam rows
        reason: 'router-settlement',
        floor: 'observe-only settlement seam',
        fallbackRung: 'llm',
        // FD4: the always-write (arbiter-bypass) invariant is RESERVED for
        // full-class points. (Seam rows bypass the JPL's global sampling knob
        // regardless — the census volume valve below is their ONE valve.)
        arbiter: volumeClass === 'full',
        model: s.settledAttempt.model,
        tokensIn: s.settledAttempt.usage?.inputTokens,
        tokensOut: s.settledAttempt.usage?.outputTokens,
        latencyMs: Math.max(0, s.settledAtMs - s.mintedAtMs),
        correlationId: s.correlationId,
        promptId: s.provenance.promptId, // JPL applies the §5.2 clamp
        contentClass: entry?.contentClass,
        mintedBy: s.mintedBy,
      };

      if (this.dryRun) {
        // §5.2 dry-run stage: metadata-only would-write lines — component,
        // decisionPoint, byte sizes, volume-class disposition. NEVER context
        // content (that would violate the very posture the 0700/0600 store
        // exists to contain). BOTH durable writes are suppressed.
        const disposition = this.resolveJsonlDisposition(volumeClass, s, { selfAlreadyCounted: false });
        this.log(
          `[decision-quality] dryRun would-write: decisionPoint=${safeLabel(decisionPoint)} ` +
            `component=${safeLabel(entry?.component ?? 'unknown')} census=${entry ? entry.status : 'unknown'} ` +
            `volumeClass=${volumeClass ?? 'none'} verdictClass=${safeLabel(verdict.value)} jsonl=${disposition} ` +
            `qualityRowBytes=${byteLength(qualityRecord)} provenanceRowBytes=${byteLength(jplInput)}`,
        );
        return;
      }

      // 1. The content-free decision_quality row — EVERY enrolled settlement,
      //    REGARDLESS of volume class (§5.5/DC2-M3).
      this.ledger?.recordDecision(qualityRecord);

      // 2. The provenance JSONL row — governed by the census volume valve (§5.6).
      const disposition = this.resolveJsonlDisposition(volumeClass, s, { selfAlreadyCounted: true });
      if (disposition === 'write') {
        this.jpl?.recordDecision(jplInput);
      } else if (disposition === 'budget-dropped') {
        // Loud, never silent (§5.6/FD4).
        this.ledger?.bumpQualityCounter(decisionPoint, 'droppedByBudget', { ts: s.settledAtMs });
      }
    } catch (err) {
      // @silent-fallback-ok: observability must never break the decision path
      // it observes (§5.1.7) — the router additionally isolates this call.
      this.log(`[decision-quality] settlement write failed (observability only): ${(err as Error).message}`);
    }
  }

  /**
   * Volume-class disposition for the provenance JSONL row (§5.6):
   *  - `full` → always write (the FD4 always-write reservation);
   *  - `sampled:<rate>` → deterministic FNV-1a bucket on the CORRELATION id
   *    (the log's own sampling convention — a decision samples identically on
   *    replay); malformed rate → write (the ratchet owns format; the seam
   *    fails toward observability);
   *  - `budget:<rows/day>` → indexed COUNT of decision_quality rows since
   *    UTC-day start (restart-safe, no new state). An unverifiable count
   *    (substrate degraded) → write, honestly logged by the ledger's own
   *    degradation — never a fabricated drop;
   *  - no class (unknown/pending/exempt point) → no JSONL row (an undeclared
   *    point gets counts, never a provenance archive the census hasn't valved).
   */
  private resolveJsonlDisposition(
    volumeClass: string | undefined,
    s: DecisionSettlement,
    opts: { selfAlreadyCounted: boolean },
  ): JsonlDisposition {
    if (!volumeClass) return 'no-volume-class';
    if (volumeClass === 'full') return 'write';
    if (volumeClass.startsWith('sampled:')) {
      const rate = Number(volumeClass.slice('sampled:'.length));
      if (!Number.isFinite(rate)) return 'write';
      const clamped = Math.min(1, Math.max(0, rate));
      return fnv1aSampleBucket(s.correlationId) < clamped ? 'write' : 'sampled-out';
    }
    if (volumeClass.startsWith('budget:')) {
      const budget = Number.parseInt(volumeClass.slice('budget:'.length), 10);
      if (!Number.isFinite(budget) || budget <= 0) return 'write';
      const d = new Date(s.settledAtMs);
      const utcDayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const counted = this.ledger?.countDecisionsSince(s.provenance?.decisionPoint ?? '', utcDayStart) ?? null;
      if (counted === null) return 'write'; // budget unverifiable — fail toward observability
      const todayIncludingSelf = counted + (opts.selfAlreadyCounted ? 0 : 1);
      return todayIncludingSelf <= budget ? 'write' : 'budget-dropped';
    }
    return 'write';
  }

  /**
   * The §5.4 outcome-annotation write-integrity chokepoint. Callsites (the
   * hog sentinel's grade-on-supersede/scan-tick rules, the completion
   * realcheck arm, the grading endpoint) reach it via
   * `annotateDecisionOutcome()` below — never `ledger.upsertOutcome` directly.
   */
  annotateOutcome(a: DecisionOutcomeAnnotationInput): DecisionOutcomeAnnotationResult {
    try {
      if (!this.enabled) return { applied: false, disabled: true };
      // FD3 grade enum — validated first (§5.4.4).
      if (a.grade !== 'right' && a.grade !== 'wrong' && a.grade !== 'unknown') {
        _rejectionCounters.enumInvalid++;
        return { applied: false, rejected: 'enum-invalid' };
      }
      // Rung is DERIVED from the registry, never caller-supplied (§5.4.2). An
      // unregistered ruleId buckets under rung-mismatch (DC r7).
      const rule = this.rules.getRule(a.ruleId);
      if (!rule) {
        _rejectionCounters.rungMismatch++;
        return { applied: false, rejected: 'rung-mismatch' };
      }
      if (a.claimedRung !== undefined && a.claimedRung !== rule.rung) {
        _rejectionCounters.rungMismatch++;
        return { applied: false, rejected: 'rung-mismatch' };
      }
      // Owner check (ADV r5): a confused in-process annotator cannot inherit
      // another rule's rung/precedence by claiming its id.
      if (a.gradedBy?.component !== rule.owningComponent) {
        _rejectionCounters.ownerMismatch++;
        return { applied: false, rejected: 'owner-mismatch' };
      }
      // A supplied decision-point hint must exist in the census (§5.1.4/DC r7).
      if (a.decisionPoint !== undefined && !this.census.getCensusEntry(a.decisionPoint)) {
        _rejectionCounters.unknownDecisionPoint++;
        return { applied: false, rejected: 'unknown-decision-point' };
      }
      const ts = a.ts ?? this.nowFn();
      // Evidence note: scrubbed + ≤500-clamped BEFORE storage (§5.2/§5.5);
      // never served by /decision-quality.
      const evidenceNote =
        a.evidenceNote !== undefined ? scrubString(String(a.evidenceNote)).slice(0, EVIDENCE_NOTE_CLAMP) : undefined;

      if (this.dryRun) {
        // §5.2: while dryRun holds, the SQLite outcome write is suppressed too.
        this.log(
          `[decision-quality] dryRun would-annotate: correlationId=${safeLabel(a.correlationId)} ` +
            `ruleId=${safeLabel(a.ruleId)} rung=${rule.rung} grade=${a.grade} gradedBy=${safeLabel(a.gradedBy.component)}` +
            (evidenceNote !== undefined ? ` evidenceNoteBytes=${Buffer.byteLength(evidenceNote, 'utf8')}` : ''),
        );
        return { applied: false, dryRun: true };
      }

      const res = this.ledger?.upsertOutcome({
        correlationId: a.correlationId,
        gradedBy: a.gradedBy.component,
        ruleId: a.ruleId,
        rung: rule.rung as GradingRung,
        evidenceStrength: rule.evidenceStrength as EvidenceStrength,
        grade: a.grade as DecisionGrade,
        effectiveWindowMs: rule.windowMs,
        evidenceNote,
        decisionPoint: a.decisionPoint,
        ts,
      });
      if (!res?.applied) return { applied: false };
      // The JPL outcome trail row (§5.4.1 correlation keying) — structured
      // evidence + the effective window (§5.4.5); grade re-validated at the
      // JPL write by its own FD3 enum guard.
      this.jpl?.annotateOutcome(
        a.correlationId,
        a.gradedBy.component,
        {
          ...(a.evidence ?? {}),
          ...(rule.windowMs !== undefined ? { windowMs: rule.windowMs } : {}),
          ...(evidenceNote !== undefined ? { note: evidenceNote } : {}),
          evidenceStrength: rule.evidenceStrength,
        },
        { grade: a.grade, gradedBy: a.gradedBy.component, ruleId: a.ruleId },
      );
      return { applied: true, orphan: res.orphan };
    } catch (err) {
      // @silent-fallback-ok: annotation is observability — a failed write is
      // repaired by idempotent re-runs (upserts converge), never a throw.
      this.log(`[decision-quality] outcome annotation failed (observability only): ${(err as Error).message}`);
      return { applied: false };
    }
  }
}

/* ── Module singleton wiring (the setFeatureMetricsRecorder pattern) ──────── */

let _activeAnnotator: DecisionQualityRecorderImpl | null = null;

/**
 * Install the recorder at AgentServer construction: registers it as BOTH the
 * router's settlement recorder (P2's `setDecisionQualityRecorder` singleton)
 * AND the module-level annotate-chokepoint target. Pass null to uninstall.
 */
export function installDecisionQualityRecorder(impl: DecisionQualityRecorderImpl | null): void {
  setDecisionQualityRecorder(impl);
  _activeAnnotator = impl;
}

/**
 * The module-level annotate entry (§5.4) — what the hog/completion wiring and
 * the grading endpoint call. No recorder installed (CLI without a server) →
 * a clean no-op result.
 */
export function annotateDecisionOutcome(a: DecisionOutcomeAnnotationInput): DecisionOutcomeAnnotationResult {
  if (!_activeAnnotator) return { applied: false, disabled: true };
  return _activeAnnotator.annotateOutcome(a);
}

/* ── Small helpers ──────────────────────────────────────────────────────── */

/** Log-hygiene clamp for identifiers interpolated into would-write lines. */
function safeLabel(v: string): string {
  return String(v).replace(/[^\w./:<>-]/g, '_').slice(0, 64);
}

function byteLength(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
  } catch {
    // @silent-fallback-ok: byte sizing feeds a dry-run log line only — an
    // unserializable payload reports -1 rather than failing the settlement.
    return -1;
  }
}

/**
 * Parse the machineId segment out of a §5.1 correlation id
 * (`d-<machineId8>-<uuid>` / `d-<uuid>`): the id itself is the carrier the
 * FD10 routing follow-up reads. A bare-uuid id (single-machine mint) → null.
 */
export function machineIdSegmentOf(correlationId: string): string | null {
  const m = /^[db]-(.+)$/.exec(correlationId);
  if (!m) return null;
  const rest = m[1];
  // A plain uuid (8-4-4-4-12 hex) means no machine segment.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rest)) return null;
  const dash = rest.indexOf('-');
  if (dash <= 0) return null;
  return rest.slice(0, dash);
}
