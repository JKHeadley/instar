/**
 * benchmarkDivergenceCore — the pure, deterministic logic of the
 * Benchmark-Divergence Detector (docs/specs/benchmark-divergence-detector.md,
 * Increment A of the benchmark-feedback loop).
 *
 * Everything here is a pure function over clamped inputs: the FD3 Wilson-aware
 * divergence test, the FD4 verdict ladder (precondition-first, direction-split),
 * the FD8 chronic union counter, the FD9 untrusted-input clamps for peer +
 * mirror data, and the static ranked-question text (regenerated locally from
 * the verdict enum — free text NEVER crosses the pool, FD9).
 *
 * Observe-only by construction: nothing in this module gates, blocks, or
 * routes — every finding is stamped `advisory: true` (FD10; Signal vs.
 * Authority). The stateful engine lives in BenchmarkDivergenceAnalyzer.ts.
 */

/* ── Enums (FD4 — frozen) ─────────────────────────────────────────────────── */

export const DIVERGENCE_VERDICTS = [
  'divergent-worse',
  'divergent-better',
  'aligned',
  'insufficient-evidence',
  'no-benched-baseline',
  'precondition-failed',
  'partial',
] as const;
export type DivergenceVerdict = (typeof DIVERGENCE_VERDICTS)[number];

export const PRECONDITION_REASONS = [
  'prompt-drifted',
  'prompt-drifted-within-window',
  'hash-unverifiable',
  'stale-mirror',
] as const;
export type PreconditionReason = (typeof PRECONDITION_REASONS)[number];

/** FD8: the chronic streak RESETS only on an actionable verdict. */
export const ACTIONABLE_VERDICTS: ReadonlySet<DivergenceVerdict> = new Set([
  'divergent-worse',
  'divergent-better',
  'aligned',
]);

/** FD8: the streak INCREMENTS on any of these (union semantics, enumerated). */
export const STREAK_INCREMENT_VERDICTS: ReadonlySet<DivergenceVerdict> = new Set([
  'partial',
  'insufficient-evidence',
  'precondition-failed',
]);

/** Reserved model-id sentinels (never compared against a benched baseline). */
export const MODEL_MISSING = '__missing__';
export const PROMPT_MIXED = '__mixed__';

/* ── FD3: Wilson 95% half-width ───────────────────────────────────────────── */

const Z95 = 1.959963984540054;

/**
 * Half-width of the 95% Wilson score interval for `successes/n`. Returns
 * Infinity for n <= 0 (an empty sample can never clear a divergence test —
 * the conservative direction). Deterministic; no dependencies (FD3).
 */
export function wilsonHalfWidth95(successes: number, n: number): number {
  if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY;
  const s = Math.min(Math.max(0, successes), n);
  const p = s / n;
  const z2 = Z95 * Z95;
  return (Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/* ── FD8: chronic union counter ───────────────────────────────────────────── */

/**
 * The next chronic streak after a verdict (FD8, enumerated union semantics):
 * increments on partial / insufficient-evidence / precondition-failed; resets
 * ONLY on an actionable verdict (divergent-worse / divergent-better / aligned);
 * `no-benched-baseline` neither increments nor resets (a coverage gap is not a
 * conclusion attempt).
 */
export function nextChronicStreak(prevStreak: number, verdict: DivergenceVerdict): number {
  const prev = Number.isFinite(prevStreak) && prevStreak > 0 ? Math.floor(prevStreak) : 0;
  if (ACTIONABLE_VERDICTS.has(verdict)) return 0;
  if (STREAK_INCREMENT_VERDICTS.has(verdict)) return prev + 1;
  return prev; // no-benched-baseline
}

/* ── The ranked questions (static, deterministic — regenerated locally, FD9) ── */

/**
 * Static ranked-question text per verdict/direction. A PURE function of the
 * verdict enum so a pool merge can DROP peer-authored question text and
 * regenerate it locally, losslessly (FD9). Question 1 answers by POINTERS into
 * the meter's own surfaces (correlation ids on GET /decision-quality) — the
 * findings surface itself never inlines raw decision context (FD10).
 */
export function questionsFor(verdict: DivergenceVerdict): string[] {
  if (verdict === 'divergent-worse') {
    return [
      'Q1 — Did the model get enough context? Inspect the window\'s graded decisions by their correlation ids through the meter\'s own provenance surfaces (GET /decision-quality) — pointers, never inlined context.',
      'Q2 — Is production running the right prompt? Compare this finding\'s benchedPromptHash against the live template hash (the Q0 precondition already verified template identity; drift routes to Increment B).',
      'Q3 — Does the benchmark battery actually represent this scenario? Route to the representative-cases feed (Increment C, ACT-1195 family).',
    ];
  }
  if (verdict === 'divergent-better') {
    return [
      'Q1 — Is this grade-rate inflated? Check the evidence rules feeding the grades (too lenient / recurrence-suppressible / denominator) via the meter\'s evidence-strength breakdown on GET /decision-quality.',
      'Q2 — Is the battery too hard or unrepresentative for this scenario?',
      'Q3 — Only after Q1–Q2 are excluded: treat as genuine improvement — never as "promote this model" on this signal alone.',
    ];
  }
  return [];
}

/* ── FD2/FD3/FD4: the verdict ladder ─────────────────────────────────────── */

export interface VerdictInput {
  /** FD5 normalization result: the battery model id, or null = unmapped. */
  normalizedModel: string | null;
  /** Mirror file state (FD1/FD4). */
  mirrorPresent: boolean;
  /** Mirror age in days; null when mirrorPresent is false or unstamped. */
  mirrorStaleDays: number | null;
  mirrorStalenessMaxDays: number;
  /** Benched prediction for (task, normalizedModel); null = not in the mirror. */
  bench: { passRate: number; passes: number; deterministic: number } | null;
  /** Benched template hash from the mirror (null = absent → unverifiable). */
  benchedPromptHash: string | null;
  /** Live template hash from the FD6 static registry (null = uncomputable). */
  liveHash: string | null;
  /** FD6: mirror benchedPromptSource must match the registry's annotation. */
  registrySourceMatches: boolean;
  /** Distinct recorded prompt ids across the window's contributing buckets. */
  windowPromptIds: readonly string[];
  /** Settled-grade counts over the pool-merged matured window (FD2). */
  rightN: number;
  wrongN: number;
  /** ALL recorded decisions in the window (the correlation spine, FD2). */
  decidedTotal: number;
  /** Pool-merged orphan share for the decision point (FD9). */
  orphanShare: number;
  /** FD8: every known machine reported for the window. */
  coverageComplete: boolean;
  thresholds: {
    divergenceThreshold: number;
    minSample: number;
    maxUnknownShare: number;
    maxOrphanShare: number;
  };
}

export interface VerdictResult {
  verdict: DivergenceVerdict;
  preconditionReason?: PreconditionReason;
  unmapped?: boolean;
  orphanTainted: boolean;
  realGradeRate: number | null;
  predictedRate: number | null;
  delta: number | null;
  gradedN: number;
  unknownShare: number | null;
  ciHalfWidth: number | null;
  benchN: number | null;
  benchCiHalfWidth: number | null;
}

/**
 * The FD4 verdict ladder — precondition-first, fail-closed, direction-split.
 * A deliberately conservative product HEURISTIC, not a formal two-proportion
 * test (FD3, stated honestly). Order:
 *   1. mirror missing/stale  → precondition-failed / stale-mirror (stale wins
 *      over drift: refresh the mirror first — FD4);
 *   2. live hash uncomputable / benched hash absent / registry-source mismatch
 *      → precondition-failed / hash-unverifiable (never assumed faithful);
 *   3. benched hash ≠ live hash → precondition-failed / prompt-drifted
 *      (suppresses divergent AND aligned — a benchmark bug, never a model verdict);
 *   4. window mixed prompt identities → precondition-failed /
 *      prompt-drifted-within-window (P20 — the decisions RAN on different prompts);
 *   5. unmapped model → no-benched-baseline (unmapped: true, fail-closed FD5);
 *   6. model not in the mirror's perModel → no-benched-baseline (unmapped: false);
 *   7. coverage incomplete → partial; pool-merged orphan share over bound →
 *      partial + orphanTainted (FD2/FD8);
 *   8. gradedN under floor or unknownShare over bound → insufficient-evidence;
 *   9. the FD3 CI-aware two-sided divergence test → divergent-worse /
 *      divergent-better / aligned.
 */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const gradedN = Math.max(0, input.rightN) + Math.max(0, input.wrongN);
  const decided = Math.max(0, input.decidedTotal);
  const unknownShare = decided > 0 ? 1 - gradedN / decided : null;
  const realGradeRate = gradedN > 0 ? input.rightN / gradedN : null;
  const bench = input.bench;
  const predictedRate = bench ? bench.passRate : null;
  const ciHalfWidth = gradedN > 0 ? wilsonHalfWidth95(input.rightN, gradedN) : null;
  const benchN = bench ? bench.deterministic : null;
  const benchCiHalfWidth = bench ? wilsonHalfWidth95(bench.passes, bench.deterministic) : null;

  const base: Omit<VerdictResult, 'verdict'> = {
    orphanTainted: false,
    realGradeRate,
    predictedRate,
    delta: realGradeRate !== null && predictedRate !== null ? realGradeRate - predictedRate : null,
    gradedN,
    unknownShare,
    ciHalfWidth,
    benchN,
    benchCiHalfWidth,
  };

  // 1. Mirror missing or stale — an operational failure is NEVER misreported
  //    as no-benched-baseline; staleness SUPPRESSES actionable verdicts (FD4).
  if (!input.mirrorPresent) return { ...base, verdict: 'precondition-failed', preconditionReason: 'stale-mirror' };
  if (input.mirrorStaleDays !== null && input.mirrorStaleDays > input.mirrorStalenessMaxDays) {
    return { ...base, verdict: 'precondition-failed', preconditionReason: 'stale-mirror' };
  }

  // 2. Q0 hash unverifiable — a live hash we cannot compute, a benched hash
  //    the mirror does not carry, or a registry-vs-mirror source mismatch is
  //    never treated as faithful (FD6).
  if (input.liveHash === null || input.benchedPromptHash === null || !input.registrySourceMatches) {
    return { ...base, verdict: 'precondition-failed', preconditionReason: 'hash-unverifiable' };
  }

  // 3. Q0 template drift — a benchmark bug routed to Increment B, NEVER a
  //    model verdict; suppresses divergent AND aligned.
  if (input.benchedPromptHash !== input.liveHash) {
    return { ...base, verdict: 'precondition-failed', preconditionReason: 'prompt-drifted' };
  }

  // 4. Window prompt-identity uniformity (P20 verify-the-state): any '__mixed__'
  //    bucket, or differing recorded ids across the window.
  const distinctPrompts = new Set(input.windowPromptIds.filter((p) => p !== ''));
  if (distinctPrompts.has(PROMPT_MIXED) || distinctPrompts.size > 1) {
    return { ...base, verdict: 'precondition-failed', preconditionReason: 'prompt-drifted-within-window' };
  }

  // 5/6. Model join — exact-match, fail-closed (FD5); a genuinely-unbenched
  //      model is distinguished from a mapping miss.
  if (input.normalizedModel === null) return { ...base, verdict: 'no-benched-baseline', unmapped: true };
  if (!bench || !Number.isFinite(bench.passRate) || bench.deterministic <= 0) {
    return { ...base, verdict: 'no-benched-baseline', unmapped: false };
  }

  // 7. Coverage + orphan honesty gates (R2 applies to the honesty gates too).
  const orphanTainted = input.orphanShare > input.thresholds.maxOrphanShare;
  if (!input.coverageComplete) return { ...base, verdict: 'partial', orphanTainted };
  if (orphanTainted) return { ...base, verdict: 'partial', orphanTainted: true };

  // 8. Evidence floors (FD2): settled-grades denominator; the unsettled-stream
  //    gate reads decided_total (ALL decisions), so a point-day with a few
  //    settled grades atop hundreds of ungraded decisions cannot sail through.
  if (gradedN < input.thresholds.minSample) return { ...base, verdict: 'insufficient-evidence' };
  if (unknownShare !== null && unknownShare > input.thresholds.maxUnknownShare) {
    return { ...base, verdict: 'insufficient-evidence' };
  }

  // 9. FD3: two-sided CI-aware divergence test — BOTH proportions carry
  //    sampling noise; a 10-case battery cannot manufacture divergence.
  const real = realGradeRate as number;
  const predicted = predictedRate as number;
  const bound = Math.max(
    input.thresholds.divergenceThreshold,
    wilsonHalfWidth95(input.rightN, gradedN),
    wilsonHalfWidth95(bench.passes, bench.deterministic),
  );
  const delta = real - predicted;
  if (Math.abs(delta) > bound) {
    return { ...base, verdict: delta < 0 ? 'divergent-worse' : 'divergent-better' };
  }
  return { ...base, verdict: 'aligned' };
}

/* ── FD9: untrusted peer/mirror input clamps ─────────────────────────────── */

/** FD9 id charset clamp. */
export const FD9_ID_RE = /^[A-Za-z0-9._/-]{1,128}$/;
/** FD9 strict day form (semantic validity checked separately). */
export const FD9_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Counts above this are implausible for a per-day per-model bucket (FD9). */
export const FD9_MAX_PLAUSIBLE_COUNT = 10_000_000;

/** True iff `day` is a strict, calendar-valid YYYY-MM-DD, not in the future,
 *  and within `maxAgeDays` of `todayDay` (FD9). */
export function isValidAggregateDay(day: string, todayDay: string, maxAgeDays: number): boolean {
  if (!FD9_DAY_RE.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return false;
  // Round-trip: rejects e.g. 2026-02-31 (Date.parse normalizes it).
  if (new Date(ms).toISOString().slice(0, 10) !== day) return false;
  if (day > todayDay) return false; // not in the future
  const todayMs = Date.parse(`${todayDay}T00:00:00.000Z`);
  return todayMs - ms <= maxAgeDays * 86_400_000;
}

/** One per-(point, model, day) aggregate bucket as it crosses the pool (FD9). */
export interface AggregateBucketRow {
  decisionPointId: string;
  model: string;
  day: string;
  rightN: number;
  wrongN: number;
  unknownN: number;
  decidedTotal: number;
  /** Recorded prompt identity when uniform in the bucket, else '__mixed__'. */
  promptId: string;
}

/** Per-(point, day) orphan-count row (from the meter's rollup, through the same clamps). */
export interface OrphanCountRow {
  decisionPointId: string;
  day: string;
  orphanOutcomes: number;
}

export interface PeerAggregateEnvelope {
  machineId: string;
  retentionEdgeDay: string | null;
  rows: AggregateBucketRow[];
  orphanRows: OrphanCountRow[];
}

export interface ClampResult {
  envelope: PeerAggregateEnvelope;
  /** Normalized enum reasons — NEVER raw peer text (FD9). */
  suspectReasons: string[];
  truncated: boolean;
}

function clampCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
  if (v > FD9_MAX_PLAUSIBLE_COUNT) return null;
  return v;
}

function clampId(v: unknown): string | null {
  if (typeof v !== 'string' || !FD9_ID_RE.test(v)) return null;
  return v;
}

/** The bounded model-id set FD9 admits: the id charset OR the reserved sentinels. */
function clampModelId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v === MODEL_MISSING || v === PROMPT_MIXED) return v;
  return clampId(v);
}

/**
 * FD9: type-clamped allowlist admission for one peer's aggregate envelope.
 * Unknown fields are dropped (explicit field picks, never a spread); malformed
 * rows are dropped and counted; volume over `maxRows` truncates AND classifies
 * the peer `suspect`; implausible values classify `suspect` and the row is
 * excluded — never silently merged. All emitted strings passed the charset
 * clamp; reasons are normalized enums (free text never crosses, FD9).
 */
export function clampPeerAggregates(
  raw: unknown,
  opts: { machineId: string; todayDay: string; maxAgeDays: number; maxRows: number },
): ClampResult {
  const suspectReasons = new Set<string>();
  const out: PeerAggregateEnvelope = {
    machineId: opts.machineId,
    retentionEdgeDay: null,
    rows: [],
    orphanRows: [],
  };
  let truncated = false;

  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!body) {
    return { envelope: out, suspectReasons: ['malformed-envelope'], truncated: false };
  }

  const edge = body.retentionEdgeDay;
  // FD9: not-in-the-future applies to the edge day too — a hostile/buggy peer
  // advertising e.g. 9999-12-31 must not blank the intersected analysis window.
  if (typeof edge === 'string' && FD9_DAY_RE.test(edge) && edge <= opts.todayDay) {
    out.retentionEdgeDay = edge;
  } else if (typeof edge === 'string' && FD9_DAY_RE.test(edge)) {
    suspectReasons.add('future-retention-edge');
  }

  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (rawRows.length > opts.maxRows) {
    suspectReasons.add('row-volume-exceeded');
    truncated = true;
  }
  for (const r of rawRows.slice(0, opts.maxRows)) {
    if (!r || typeof r !== 'object') {
      suspectReasons.add('malformed-row');
      continue;
    }
    const row = r as Record<string, unknown>;
    const decisionPointId = clampId(row.decisionPointId);
    const model = clampModelId(row.model);
    const day = typeof row.day === 'string' ? row.day : '';
    const rightN = clampCount(row.rightN);
    const wrongN = clampCount(row.wrongN);
    const unknownN = clampCount(row.unknownN);
    const decidedTotal = clampCount(row.decidedTotal);
    const promptId = clampModelId(row.promptId) ?? '';
    if (
      decisionPointId === null || model === null || rightN === null || wrongN === null ||
      unknownN === null || decidedTotal === null || !isValidAggregateDay(day, opts.todayDay, opts.maxAgeDays)
    ) {
      suspectReasons.add('implausible-row');
      continue;
    }
    // Internal-consistency plausibility: grades cannot exceed decisions.
    if (rightN + wrongN > decidedTotal) {
      suspectReasons.add('implausible-row');
      continue;
    }
    out.rows.push({ decisionPointId, model, day, rightN, wrongN, unknownN, decidedTotal, promptId });
  }

  const rawOrphans = Array.isArray(body.orphanRows) ? body.orphanRows : [];
  if (rawOrphans.length > opts.maxRows) {
    suspectReasons.add('row-volume-exceeded');
    truncated = true;
  }
  for (const r of rawOrphans.slice(0, opts.maxRows)) {
    if (!r || typeof r !== 'object') {
      suspectReasons.add('malformed-row');
      continue;
    }
    const row = r as Record<string, unknown>;
    const decisionPointId = clampId(row.decisionPointId);
    const day = typeof row.day === 'string' ? row.day : '';
    const orphanOutcomes = clampCount(row.orphanOutcomes);
    if (decisionPointId === null || orphanOutcomes === null || !isValidAggregateDay(day, opts.todayDay, opts.maxAgeDays)) {
      suspectReasons.add('implausible-row');
      continue;
    }
    out.orphanRows.push({ decisionPointId, day, orphanOutcomes });
  }

  return { envelope: out, suspectReasons: Array.from(suspectReasons).sort(), truncated };
}

/* ── FD9/FD10: pool-merge finding allowlist ──────────────────────────────── */

/** The frozen FD10 FINDING envelope, as served and as pool-merged. */
export interface FindingView {
  taskId: string;
  decisionPointId: string;
  model: string;
  verdict: DivergenceVerdict;
  preconditionReason?: PreconditionReason;
  realGradeRate: number | null;
  predictedRate: number | null;
  delta: number | null;
  gradedN: number;
  unknownShare: number | null;
  ciHalfWidth: number | null;
  benchN: number | null;
  benchCiHalfWidth: number | null;
  orphanTainted: boolean;
  chronic: boolean;
  chronicStreak: number;
  chronicReason?: string;
  coverage: { machinesReporting: number; machinesKnown: number; byMachine: Record<string, number> };
  dominantMachineShare: number | null;
  unmapped?: boolean;
  benchedPromptHash: string | null;
  mirrorCapturedAt: string | null;
  analysisWindow: { fromDay: string; toDay: string };
  firstSeenAt: number;
  lastSeenAt: number;
  advisory: true;
  questions: string[];
}

const CHRONIC_REASON_ENUM: ReadonlySet<string> = new Set([
  'machine-persistently-offline',
  'graded-n-stuck',
  'mirror-stale',
  'precondition-persistent',
]);

function clampNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * FD9 pool-merge admission for ONE peer finding row: explicit field allowlist
 * (never a spread), enum/type/charset clamps, peer `questions` DROPPED and
 * regenerated locally from the verdict enum, chronicReason clamped to the
 * normalized enum (any other value dropped). Returns null when the row's key
 * or verdict fails the clamp — a hostile row is excluded, never partially
 * merged.
 */
export function clampPeerFinding(raw: unknown, opts: { todayDay: string; maxAgeDays: number }): FindingView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const taskId = clampId(r.taskId);
  const decisionPointId = clampId(r.decisionPointId);
  const model = clampModelId(r.model) ?? clampFloodModel(r.model);
  const verdict = typeof r.verdict === 'string' && (DIVERGENCE_VERDICTS as readonly string[]).includes(r.verdict)
    ? (r.verdict as DivergenceVerdict)
    : null;
  if (!taskId || !decisionPointId || !model || !verdict) return null;

  const preconditionReason =
    typeof r.preconditionReason === 'string' && (PRECONDITION_REASONS as readonly string[]).includes(r.preconditionReason)
      ? (r.preconditionReason as PreconditionReason)
      : undefined;

  const win = r.analysisWindow && typeof r.analysisWindow === 'object' ? (r.analysisWindow as Record<string, unknown>) : {};
  const fromDay = typeof win.fromDay === 'string' && isValidAggregateDay(win.fromDay, opts.todayDay, opts.maxAgeDays) ? win.fromDay : '';
  const toDay = typeof win.toDay === 'string' && isValidAggregateDay(win.toDay, opts.todayDay, opts.maxAgeDays) ? win.toDay : '';

  const cov = r.coverage && typeof r.coverage === 'object' ? (r.coverage as Record<string, unknown>) : {};
  const byMachineRaw = cov.byMachine && typeof cov.byMachine === 'object' ? (cov.byMachine as Record<string, unknown>) : {};
  const byMachine: Record<string, number> = {};
  for (const [k, v] of Object.entries(byMachineRaw).slice(0, 32)) {
    const key = clampId(k);
    const n = clampCount(v);
    if (key !== null && n !== null) byMachine[key] = n;
  }

  const chronicStreak = clampCount(r.chronicStreak) ?? 0;
  const chronicReason =
    typeof r.chronicReason === 'string' && CHRONIC_REASON_ENUM.has(r.chronicReason) ? r.chronicReason : undefined;

  return {
    taskId,
    decisionPointId,
    model,
    verdict,
    ...(preconditionReason !== undefined ? { preconditionReason } : {}),
    realGradeRate: clampNum(r.realGradeRate),
    predictedRate: clampNum(r.predictedRate),
    delta: clampNum(r.delta),
    gradedN: clampCount(r.gradedN) ?? 0,
    unknownShare: clampNum(r.unknownShare),
    ciHalfWidth: clampNum(r.ciHalfWidth),
    benchN: clampCount(r.benchN),
    benchCiHalfWidth: clampNum(r.benchCiHalfWidth),
    orphanTainted: r.orphanTainted === true,
    chronic: r.chronic === true,
    chronicStreak,
    ...(chronicReason !== undefined ? { chronicReason } : {}),
    coverage: {
      machinesReporting: clampCount(cov.machinesReporting) ?? 0,
      machinesKnown: clampCount(cov.machinesKnown) ?? 0,
      byMachine,
    },
    dominantMachineShare: clampNum(r.dominantMachineShare),
    ...(r.unmapped === true || r.unmapped === false ? { unmapped: r.unmapped as boolean } : {}),
    // FD9 tight clamps (not just length): the hash must be sha256 hex, the
    // capture stamp a parseable date — an authenticated peer cannot float
    // arbitrary text through the pool merge in these fields.
    benchedPromptHash:
      typeof r.benchedPromptHash === 'string' && /^[0-9a-f]{64}$/.test(r.benchedPromptHash)
        ? r.benchedPromptHash
        : null,
    mirrorCapturedAt:
      typeof r.mirrorCapturedAt === 'string' && r.mirrorCapturedAt.length <= 40 &&
      Number.isFinite(Date.parse(r.mirrorCapturedAt))
        ? r.mirrorCapturedAt
        : null,
    analysisWindow: { fromDay, toDay },
    firstSeenAt: clampCount(r.firstSeenAt) ?? 0,
    lastSeenAt: clampCount(r.lastSeenAt) ?? 0,
    advisory: true,
    // FD9: peer question text is DROPPED — regenerated locally, losslessly.
    questions: questionsFor(verdict),
  };
}

/** The one reserved key the unmapped-flood collapse finding uses (FD9). */
export const UNMAPPED_FLOOD_MODEL = '__unmapped-flood__';

function clampFloodModel(v: unknown): string | null {
  return v === UNMAPPED_FLOOD_MODEL ? UNMAPPED_FLOOD_MODEL : null;
}

/**
 * FD10 pool-merge ordering per key `(analysisWindow.toDay DESC, lastSeenAt
 * DESC)` — window recency wins, wall-clock breaks ties, so a stale-holder
 * catch-up pass can never shadow a fresher-window finding.
 */
export function mergeFindingsByKey(findings: readonly FindingView[]): FindingView[] {
  const byKey = new Map<string, FindingView>();
  for (const f of findings) {
    const key = `${f.taskId} ${f.decisionPointId} ${f.model}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, f);
      continue;
    }
    const a = f.analysisWindow.toDay;
    const b = cur.analysisWindow.toDay;
    if (a > b || (a === b && f.lastSeenAt > cur.lastSeenAt)) byKey.set(key, f);
  }
  return Array.from(byKey.values()).sort((x, y) => {
    if (x.analysisWindow.toDay !== y.analysisWindow.toDay) return x.analysisWindow.toDay < y.analysisWindow.toDay ? 1 : -1;
    if (x.lastSeenAt !== y.lastSeenAt) return y.lastSeenAt - x.lastSeenAt;
    const kx = `${x.taskId}/${x.decisionPointId}/${x.model}`;
    const ky = `${y.taskId}/${y.decisionPointId}/${y.model}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
}

/* ── Small day helpers (UTC day-key convention, shared with the ledger) ───── */

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return utcDayKey(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000);
}
