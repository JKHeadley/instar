/**
 * The shadow-fold record (context-budget-layered-summaries §16 Phase 2 exit,
 * §11 measurement; Phase 2, the runner's output).
 *
 * One JSONL row per shadow fold attempt (completed, skipped or aborted), so the
 * Phase 2 exit — "at least 40 shadow folds with the would-be `lost` rate and
 * the measured per-fold cost term" — is read from data, never asserted. The
 * log is append-only with one rotated segment (the DeltaShadowLog pattern):
 * 0700 directory, 0600 files, under the never-served layer root. Rows carry
 * counts, grades, costs and reasons; never the conversation's words.
 */
import fs from 'node:fs';
import path from 'node:path';
import { contextLayersRoot } from './clearSeedPointer.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export const FOLD_SHADOW_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** §16 Phase 2 exit: the shadow-fold count the rung review needs. */
export const PHASE2_EXIT_FOLDS = 40;

export type ShadowFoldOutcome =
  | 'graded'         // a full shadow fold: handoff, packet, probe, answerer, grades
  | 'skipped'        // the ask was not made (brakes, not clean, below the floor, estimator unknown)
  | 'declined'       // the session's handoff or the audit ended it (fold-declined: audit, unparseable handoff…)
  | 'aborted';       // a step failed (no-judge, packet refused, answerer failed…)

export interface ShadowFoldRow {
  t: 'shadow-fold';
  at: number;
  topicKey: string;
  foldId: string | null;
  engine: string;
  outcome: ShadowFoldOutcome;
  reason: string | null;
  estimate?: { breakEvenTurns: number; expectedRemainingTurns: number; cost: number; savingPerTurn: number } | null;
  handoff?: { deficiencies: string[]; relabels: number; sendBacks: number; demoted: number } | null;
  packet?: { bytes: number; problems: string[] } | null;
  probe?: { questions: number; byType: Record<string, number>; independent: number; coverage: { entries: number; represented: number } } | null;
  grades?: { retained: number; retrievable: number; lost: number; ungraded: number; lostRate: number | null; wouldBe: string; protectedLost: boolean } | null;
  /** Wall-clock per step, ms. */
  durations?: Record<string, number>;
  /** Model calls per component (FoldAudit, FoldProbe) and answerer turns. */
  calls?: Record<string, number>;
}

export function foldShadowLogDir(stateDir: string): string { return path.join(contextLayersRoot(stateDir), '_fold-shadow'); }
const logFile = (stateDir: string) => path.join(foldShadowLogDir(stateDir), 'folds.jsonl');
const rotatedFile = (stateDir: string) => path.join(foldShadowLogDir(stateDir), 'folds.jsonl.1');

/** A code token: what a reason, deficiency or problem may be in the log (never free text). */
/** A code is a hyphenated token (span-overlap, not-clean, no-judge), or one of the few known single-word codes. */
const CODE_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const SINGLE_WORD_CODES: ReadonlySet<string> = new Set(['backoff', 'oversize', 'redacted', 'schema', 'empty']);
const isCode = (x: string) => x.length <= 64 && (CODE_SHAPE.test(x) || SINGLE_WORD_CODES.has(x));
const SUB_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * "Counts only, never words", enforced at the one writer: a reason keeps its
 * leading code (and one hyphenated sub-code after ": "), and every list keeps
 * only code tokens. Anything else (a detail string, which can carry
 * conversation text) is dropped before the row is written.
 */
export function codesOnly(row: Omit<ShadowFoldRow, 't'>): Omit<ShadowFoldRow, 't'> {
  const reason = (() => {
    if (row.reason === null || row.reason === undefined) return null;
    const [head, sub] = String(row.reason).split(/:\s*/, 2);
    if (!isCode(head)) return 'redacted';
    const subCode = sub?.trim().split(/\s+/)[0];
    // A sub-code is a hyphenated code token (mid-turn, not-json, no-judge): a plain word is never kept.
    return subCode && SUB_CODE.test(subCode) ? `${head}: ${subCode}` : head;
  })();
  const codes = (xs: readonly string[] | undefined) => (xs ?? []).filter(isCode);
  return {
    ...row, reason,
    ...(row.handoff ? { handoff: { ...row.handoff, deficiencies: codes(row.handoff.deficiencies) } } : {}),
    ...(row.packet ? { packet: { ...row.packet, problems: codes(row.packet.problems) } } : {}),
  };
}

export function appendShadowFold(stateDir: string, row: Omit<ShadowFoldRow, 't'>, maxBytes = FOLD_SHADOW_LOG_MAX_BYTES): void {
  const dir = foldShadowLogDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = logFile(stateDir);
  try {
    if (fs.statSync(file).size > maxBytes) {
      SafeFsExecutor.safeRmSync(rotatedFile(stateDir), { force: true, operation: 'src/monitoring/foldShadowLog.ts:rotate' });
      fs.renameSync(file, rotatedFile(stateDir));
    }
  } catch { /* @silent-fallback-ok — no log yet: nothing to rotate */ }
  fs.appendFileSync(file, `${JSON.stringify({ t: 'shadow-fold', ...codesOnly(row) })}\n`, { mode: 0o600 });
}

/** Every row in the rotated and current segments, oldest first (torn lines skipped). */
export function readShadowFolds(stateDir: string): ShadowFoldRow[] {
  const out: ShadowFoldRow[] = [];
  for (const f of [rotatedFile(stateDir), logFile(stateDir)]) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf-8'); } catch { continue; } // @silent-fallback-ok — a segment that does not exist yet
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as ShadowFoldRow; if (r.t === 'shadow-fold') out.push(r); } catch { /* @silent-fallback-ok — a torn last line */ }
    }
  }
  return out;
}

export interface ShadowFoldSummary {
  graded: number;
  exit: { needed: number; reached: boolean };
  byOutcome: Record<ShadowFoldOutcome, number>;
  /** Reasons a fold did not complete, counted (skipped, declined, aborted). */
  reasons: Record<string, number>;
  /** Over graded folds: the would-be lost rate pooled across questions. */
  lostRate: number | null;
  /** Graded folds whose would-be outcome was a rollback. */
  wouldRollBack: number;
  protectedLost: number;
  medianDurationMs: number | null;
  byEngine: Record<string, number>;
}

export function summarizeShadowFolds(rows: readonly ShadowFoldRow[]): ShadowFoldSummary {
  const byOutcome: Record<ShadowFoldOutcome, number> = { graded: 0, skipped: 0, declined: 0, aborted: 0 };
  const reasons: Record<string, number> = {};
  const byEngine: Record<string, number> = {};
  let lost = 0; let graded = 0; let wouldRollBack = 0; let protectedLost = 0;
  const durations: number[] = [];
  for (const r of rows) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    if (r.outcome !== 'graded') { const k = r.reason ?? 'unknown'; reasons[k] = (reasons[k] ?? 0) + 1; continue; }
    byEngine[r.engine] = (byEngine[r.engine] ?? 0) + 1;
    if (r.grades) {
      lost += r.grades.lost;
      graded += r.grades.retained + r.grades.retrievable + r.grades.lost;
      if (r.grades.wouldBe === 'rollback') wouldRollBack++;
      if (r.grades.protectedLost) protectedLost++;
    }
    const total = r.durations ? Object.values(r.durations).reduce((a, b) => a + b, 0) : null;
    if (total !== null) durations.push(total);
  }
  durations.sort((a, b) => a - b);
  return {
    graded: byOutcome.graded,
    exit: { needed: PHASE2_EXIT_FOLDS, reached: byOutcome.graded >= PHASE2_EXIT_FOLDS },
    byOutcome, reasons,
    lostRate: graded > 0 ? +(lost / graded).toFixed(4) : null,
    wouldRollBack, protectedLost,
    medianDurationMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    byEngine,
  };
}
