/**
 * The design review ledger — what the review driver ran and what each reviewer
 * concluded (docs/specs/frontier-design-review-standard.md §3).
 *
 * File: `<stateDir>/design-review-runs.jsonl`, append-only, one JSON object per
 * recorded run. The server is the only writer. This module owns the row shape,
 * the tolerant reader (an unparseable line — a torn last line after a crash is
 * normal — is skipped and counted), and the plan-evidence read the spawn route
 * uses to decide whether an account may launch on the design model (§2 "Plan").
 */

import fs from 'node:fs';
import path from 'node:path';

export const DESIGN_REVIEW_LEDGER_FILE = 'design-review-runs.jsonl';

export type ReviewPassStatus = 'ok' | 'degraded' | 'unavailable';
export type ReviewVerdict = 'CLEAN' | 'MINOR ISSUES' | 'SERIOUS ISSUES' | 'UNKNOWN';
export type ReviewModelBasis = 'reported' | 'requested';

/** The closed reason list (§3). The first four are durable, the last three transient. */
export const DURABLE_REVIEW_REASONS = ['not-installed', 'not-signed-in', 'disabled', 'not-on-plan'] as const;
export const TRANSIENT_REVIEW_REASONS = ['limit-reached', 'timed-out', 'call-failed'] as const;
export type ReviewReason = typeof DURABLE_REVIEW_REASONS[number] | typeof TRANSIENT_REVIEW_REASONS[number];

export interface ReviewAttempt {
  askedModel: string;
  outcome: 'ok' | 'refused' | 'failed';
  reason?: ReviewReason;
}

export interface ReviewPass {
  family: string;
  door: string;
  attempts: ReviewAttempt[];
  model: string | null;
  modelBasis: ReviewModelBasis;
  status: ReviewPassStatus;
  reason?: ReviewReason;
  verdict?: ReviewVerdict;
}

export interface DesignReviewRun {
  v: 1;
  runId: string;
  machineId: string;
  recordedAt: string;
  /** The reviewed file's real path. */
  path: string;
  fingerprint: string;
  title: string;
  sessionId: string | null;
  /** The pool's internal account id the reporting session ran under; null = the default login. Never rendered. */
  account: string | null;
  passes: ReviewPass[];
  /** Writes to the file found in stored hook events at this run (§3 "Which sessions wrote it"). */
  writes?: DesignWriteEntry[];
}

/** One stored `Write`/`Edit` to the reviewed file: who, when, and the model on record either side of it. */
export interface DesignWriteEntry {
  sessionId: string;
  at: string;
  model: string | null;
}

export interface LedgerRead {
  runs: DesignReviewRun[];
  /** Lines that did not parse or did not look like a run. */
  skipped: number;
  /** The file exists but could not be read at all. */
  unreadable: boolean;
}

export function designReviewLedgerPath(stateDir: string): string {
  return path.join(stateDir, DESIGN_REVIEW_LEDGER_FILE);
}

function looksLikeRun(x: unknown): x is DesignReviewRun {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.runId === 'string' && typeof r.machineId === 'string' && typeof r.path === 'string'
    && typeof r.fingerprint === 'string' && typeof r.recordedAt === 'string' && Array.isArray(r.passes);
}

/** Read every run. A missing file is an empty ledger; an unreadable one says so. */
export function readDesignReviewLedger(stateDir: string): LedgerRead {
  const file = designReviewLedgerPath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // @silent-fallback-ok: a ledger that was never written is an empty ledger.
    if (code === 'ENOENT') return { runs: [], skipped: 0, unreadable: false };
    return { runs: [], skipped: 0, unreadable: true };
  }
  const runs: DesignReviewRun[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (looksLikeRun(parsed)) runs.push(parsed);
      else skipped++;
    } catch {
      // @silent-fallback-ok: a torn or corrupt line is skipped and counted (§3).
      skipped++;
    }
  }
  return { runs, skipped, unreadable: false };
}

/** The key an account is known by in plan evidence: its pool id, or `default` for the default login. */
export function accountEvidenceKey(account: string | null | undefined): string {
  return typeof account === 'string' && account.length > 0 ? account : 'default';
}

export type PlanEvidence = 'confirmed' | 'not-on-plan';

/**
 * Plan evidence for one door's design model, per account, from THIS machine's
 * rows only (an account is a login on this disk). An account is `confirmed` when
 * its latest same-door attempt on `model` answered ok, `not-on-plan` when the
 * latest such attempt was refused for that reason; an account with no attempt on
 * record is absent. Transient failures say nothing about the plan and are ignored.
 */
export function planEvidenceByAccount(
  runs: readonly DesignReviewRun[],
  opts: { machineId: string; door: string; model: string },
): Map<string, PlanEvidence> {
  const ordered = runs
    .filter((r) => r.machineId === opts.machineId)
    .slice()
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const out = new Map<string, PlanEvidence>();
  for (const run of ordered) {
    const key = accountEvidenceKey(run.account);
    for (const pass of run.passes ?? []) {
      if (!pass || pass.door !== opts.door || !Array.isArray(pass.attempts)) continue;
      for (const attempt of pass.attempts) {
        if (!attempt || attempt.askedModel !== opts.model) continue;
        if (attempt.outcome === 'ok') out.set(key, 'confirmed');
        else if (attempt.reason === 'not-on-plan') out.set(key, 'not-on-plan');
      }
    }
  }
  return out;
}

/**
 * The machine id stamped on this machine's ledger rows and used to select them:
 * the mesh id when the agent runs on more than one machine, else `local`.
 */
export function designReviewMachineId(meshSelfId: string | null | undefined): string {
  return typeof meshSelfId === 'string' && meshSelfId.length > 0 ? meshSelfId : 'local';
}
