/**
 * ApprovalLedger — the durable, signed, append-only record of every operator
 * approval decision, and the per-class agreement ratios computed from it.
 *
 * This is Phase 2 of the approved "Approval-as-Data" spec
 * (`docs/specs/AUTONOMOUS-OPERATION-JUDGMENT-AND-APPROVAL-AS-DATA-SPEC.md`, Part B):
 * an approval stops being a one-shot "approved" with no memory and becomes data —
 * recorded as `approved-as-is` vs `approved-with-change` vs `rejected`, with the
 * WHY of each divergence, so we can (a) see per decision-class where the operator
 * agrees with the agent's recommendation as-is vs revises it, (b) trend toward
 * approved-as-is by folding recurring divergences back into design guidance, and
 * (c) — once a class's ratio holds — pilot auto-approval for that class (Phase 3).
 *
 * SCOPE (operator extension, 2026-06-05): the original spec tracked only official
 * SPEC sign-offs. Justin extended it to track ALL approvals wherever they occur —
 * a spec sign-off, a decision presented and approved in chat, or any other surface.
 * Hence `subject`/`decisionClass`/`surface` (general) rather than `specSlug`/
 * `specClass`, and the spec-only fields (`reviewIterations`/`commitSha`/`evidenceRef`)
 * are optional — a chat approval simply omits them.
 *
 * Mirrors `SessionPoolE2EResultStore` exactly (signed, append-only, tamper-evident,
 * torn-line-tolerant). The store is signer-agnostic — `sign`/`verifySig` are injected
 * — so tests use an Ed25519 keypair and production uses an HMAC over the state secret.
 *
 * AUTHORITY INVARIANT (spec B1, load-bearing for correctness — NOT just integrity):
 * for a MANUAL decision the OPERATOR is the authoritative source of `mode` and
 * `divergences`. The agent must NEVER self-classify the operator's intent. The
 * writer passes the operator-sourced classification (from the approve control / an
 * explicit "as-is" vs "with changes: …"); this store records it faithfully. HMAC/
 * signature guarantees integrity, not correctness — the authoritative-source rule
 * is what prevents an agent inflating its own agreement ratio. An operator can
 * dispute and CORRECT any row: a correction is itself an appended, signed row
 * (`corrects` set), never an in-place edit — history preserved.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ApprovalMode = 'approved-as-is' | 'approved-with-change' | 'rejected';

/** Where the approval happened (operator-extension axis — "wherever they occur"). */
export type ApprovalSurface = 'spec' | 'chat' | 'other';

export const APPROVAL_SURFACES: readonly ApprovalSurface[] = ['spec', 'chat', 'other'] as const;

/** Divergence taxonomy (spec B2). `missing-principle` is a candidate trigger to
 *  propose a new design principle — a PROPOSAL only, never auto-merged (Part C). */
export type DivergenceCategory =
  | 'missing-principle'
  | 'risk-reduction'
  | 'scope-correction'
  | 'efficiency'
  | 'new-information'
  | 'style';

export const DIVERGENCE_CATEGORIES: readonly DivergenceCategory[] = [
  'missing-principle', 'risk-reduction', 'scope-correction',
  'efficiency', 'new-information', 'style',
] as const;

export interface Divergence {
  category: DivergenceCategory;
  /** One-line what-changed. */
  summary: string;
  /** Why the operator changed it — the signal we fold back into design guidance. */
  why: string;
}

export interface ApprovalRecord {
  /** What was approved — a spec slug, or a stable id for a chat recommendation. */
  subject: string;
  /** The bucket the ratio is computed per (e.g. 'governance-safety', 'design-decision'). */
  decisionClass: string;
  /** Where the approval occurred. */
  surface: ApprovalSurface;
  decidedAt: string;
  /** 'justin' for a manual decision; 'auto' for an auto-approval (Phase 3). */
  approver: string;
  mode: ApprovalMode;
  /** Empty when approved-as-is; one entry per operator-stated change otherwise. */
  divergences: Divergence[];
  /** Spec-context fields — optional (a chat approval omits them). */
  reviewIterations?: number;
  commitSha?: string;
  evidenceRef?: string;
  /** Set when this row CORRECTS a prior row (operator dispute) — the prior subject+decidedAt. */
  corrects?: string;
  signature: string;
}

export type ApprovalRecordInput =
  Omit<ApprovalRecord, 'signature' | 'decidedAt' | 'divergences'>
  & { decidedAt?: string; divergences?: Divergence[] };

export interface ApprovalLedgerDeps {
  /** Absolute path to the append-only ledger file. */
  filePath: string;
  /** Sign the canonical (signature-excluded) row. Production: HMAC over the state secret. */
  sign: (canonical: string) => string;
  /** Verify a signature against the canonical row. */
  verifySig: (canonical: string, signature: string) => boolean;
  now?: () => number;
}

/** Eligibility knobs for `autoApprovalEligible` (a read-only SIGNAL; never gates here). */
export interface EligibilityPolicy {
  /** Minimum approved-as-is ratio for a class to be auto-approval-eligible. */
  minRatio: number;
  /** Minimum CURRENT consecutive approved-as-is streak. */
  minStreak: number;
  /** Minimum total decisions in the class (don't qualify on a tiny sample). */
  minTotal: number;
}

export const DEFAULT_ELIGIBILITY: EligibilityPolicy = { minRatio: 0.9, minStreak: 5, minTotal: 5 };

export interface ClassSummary {
  decisionClass: string;
  total: number;
  approvedAsIs: number;
  approvedWithChange: number;
  rejected: number;
  /** approvedAsIs / total (0 when total is 0). */
  ratio: number;
  /** CURRENT consecutive approved-as-is run (most recent rows), reset to 0 by any
   *  approved-with-change or rejected (spec B3). */
  streak: number;
  autoApprovalEligible: boolean;
  /** Aggregate divergence-category counts for the class (drives the Phase-3 digest). */
  divergenceCounts: Record<DivergenceCategory, number>;
}

/** Canonical bytes a row's signature covers — field-ordered, signature EXCLUDED.
 *  Optional fields are normalized so a present-vs-absent field is unambiguous, and
 *  divergences are flattened deterministically so reordering is detectable. */
export function canonicalApprovalRow(r: Omit<ApprovalRecord, 'signature'>): string {
  return JSON.stringify([
    r.subject,
    r.decisionClass,
    r.surface,
    r.decidedAt,
    r.approver,
    r.mode,
    r.divergences.map((d) => [d.category, d.summary, d.why]),
    r.reviewIterations ?? null,
    r.commitSha ?? '',
    r.evidenceRef ?? '',
    r.corrects ?? '',
  ]);
}

function emptyDivergenceCounts(): Record<DivergenceCategory, number> {
  return {
    'missing-principle': 0, 'risk-reduction': 0, 'scope-correction': 0,
    'efficiency': 0, 'new-information': 0, 'style': 0,
  };
}

export class ApprovalLedger {
  private readonly d: ApprovalLedgerDeps;
  constructor(deps: ApprovalLedgerDeps) {
    this.d = deps;
  }

  /**
   * Append a signed approval row. The `mode` + `divergences` MUST be operator-sourced
   * (the authority invariant above) — this method does not infer them.
   * Throws on an internally-inconsistent row so a malformed record can't pollute ratios.
   */
  recordApproval(input: ApprovalRecordInput): ApprovalRecord {
    const divergences = input.divergences ?? [];

    // Consistency guards (correctness, not just integrity).
    if (input.mode === 'approved-as-is' && divergences.length > 0) {
      throw new Error('ApprovalLedger: approved-as-is rows must have no divergences (spec B1).');
    }
    if (input.mode !== 'approved-as-is' && divergences.length === 0) {
      // A change/reject with no stated divergence loses the WHY we exist to capture.
      throw new Error(`ApprovalLedger: mode "${input.mode}" requires at least one divergence with a why.`);
    }
    if (!APPROVAL_SURFACES.includes(input.surface)) {
      throw new Error(`ApprovalLedger: unknown surface "${input.surface}".`);
    }
    for (const dv of divergences) {
      if (!DIVERGENCE_CATEGORIES.includes(dv.category)) {
        throw new Error(`ApprovalLedger: unknown divergence category "${dv.category}".`);
      }
      if (!dv.summary?.trim() || !dv.why?.trim()) {
        throw new Error('ApprovalLedger: each divergence needs a non-empty summary AND why.');
      }
    }

    const decidedAt = input.decidedAt
      ?? new Date(this.d.now ? this.d.now() : Date.now()).toISOString();
    const unsigned: Omit<ApprovalRecord, 'signature'> = {
      subject: input.subject,
      decisionClass: input.decisionClass,
      surface: input.surface,
      decidedAt,
      approver: input.approver,
      mode: input.mode,
      divergences,
      ...(input.reviewIterations != null ? { reviewIterations: input.reviewIterations } : {}),
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
      ...(input.corrects ? { corrects: input.corrects } : {}),
    };
    const row: ApprovalRecord = { ...unsigned, signature: this.d.sign(canonicalApprovalRow(unsigned)) };
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.appendFileSync(this.d.filePath, JSON.stringify(row) + '\n');
    return row;
  }

  /** All rows (oldest→newest). Tolerant of a missing file / a torn trailing line. */
  all(): ApprovalRecord[] {
    let content: string;
    try { content = fs.readFileSync(this.d.filePath, 'utf8'); } catch { /* @silent-fallback-ok — ledger file may not exist yet; empty history is the natural default */ return []; }
    const out: ApprovalRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as ApprovalRecord); } catch { /* @silent-fallback-ok — torn-trailing-line tolerance; a crash mid-append must not poison reads */ }
    }
    return out;
  }

  /** Verify a row's signature (tamper check). */
  verify(row: ApprovalRecord): boolean {
    const { signature, ...unsigned } = row;
    return this.d.verifySig(canonicalApprovalRow(unsigned), signature);
  }

  /** Per-class agreement summary. Read-only; never gates by itself (spec B3). */
  summarize(policy: EligibilityPolicy = DEFAULT_ELIGIBILITY): ClassSummary[] {
    const byClass = new Map<string, ApprovalRecord[]>();
    for (const r of this.all()) {
      const arr = byClass.get(r.decisionClass) ?? [];
      arr.push(r);
      byClass.set(r.decisionClass, arr);
    }
    const summaries: ClassSummary[] = [];
    for (const [decisionClass, rows] of byClass) {
      summaries.push(this.summarizeRows(decisionClass, rows, policy));
    }
    // Stable order: highest-total class first, then alphabetical.
    summaries.sort((a, b) => b.total - a.total || a.decisionClass.localeCompare(b.decisionClass));
    return summaries;
  }

  /** Summary for one class (returns a zeroed summary if the class has no rows). */
  summaryForClass(decisionClass: string, policy: EligibilityPolicy = DEFAULT_ELIGIBILITY): ClassSummary {
    const rows = this.all().filter((r) => r.decisionClass === decisionClass);
    return this.summarizeRows(decisionClass, rows, policy);
  }

  private summarizeRows(decisionClass: string, rows: ApprovalRecord[], policy: EligibilityPolicy): ClassSummary {
    let approvedAsIs = 0, approvedWithChange = 0, rejected = 0;
    const divergenceCounts = emptyDivergenceCounts();
    for (const r of rows) {
      if (r.mode === 'approved-as-is') approvedAsIs++;
      else if (r.mode === 'approved-with-change') approvedWithChange++;
      else rejected++;
      for (const dv of r.divergences) divergenceCounts[dv.category]++;
    }
    const total = rows.length;
    const ratio = total === 0 ? 0 : approvedAsIs / total;

    // CURRENT streak: trailing consecutive approved-as-is from the most-recent row.
    let streak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].mode === 'approved-as-is') streak++;
      else break;
    }

    const autoApprovalEligible =
      total >= policy.minTotal && ratio >= policy.minRatio && streak >= policy.minStreak;

    return { decisionClass, total, approvedAsIs, approvedWithChange, rejected, ratio, streak, autoApprovalEligible, divergenceCounts };
  }
}
