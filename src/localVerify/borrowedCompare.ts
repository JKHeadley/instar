/**
 * The shadow comparison (docs/specs/local-verify-borrowed-unit-slices.md, F "When the unit lane ends").
 *
 * Shadow mode has exactly one use for a helper result: comparison with this machine's own unit
 * lane, AFTER that lane's record is written. Nothing here returns anything a verdict reads; the
 * output feeds only the `borrowed-shadow` audit row, the helper's learned list and the report.
 *
 *  - Answer validity first: the answer must carry the request's attemptId, runAttemptId, lane,
 *    baseSha, headSha and exact requestedFiles, signed by the helper; its perFile lists each
 *    requested file exactly once. Otherwise `invalid-answer`, compared not at all, never fed to
 *    the learned list. The answer's `treeHash` is compared with this machine's merge tree by the
 *    digest comparison (BorrowedShadow.mainVerifyOutcome and the lane flow), which alone feeds the
 *    practice record and the learned list; this count comparison fills the `borrowed-shadow` audit row.
 *  - A file agrees when its passed, failed, skipped and todo counts are equal and `collected` holds.
 *  - Slice-level problems (a nonzero exit its failed files do not explain, or unhandled errors) are
 *    judged once per slice as a `slice-error`; they do not turn passing files into disagreements.
 *  - Each disagreement records its direction.
 *
 * Pure.
 */
import type { FileCounts } from './laneReport.js';
import type { CanaryExpectation } from './borrowedCanary.js';
import type { HelperSliceAnswer, HelperSliceRequest, LearnedObservation } from './helper/helperProtocol.js';

export type Direction = 'helper-red/local-green' | 'helper-green/local-red' | 'skip-difference';

export interface SentSlice {
  request: HelperSliceRequest;
  canary: boolean;
  /** The parsed answer, or null when none came back (transport failure, timeout). */
  answer: HelperSliceAnswer | null;
  /** Why the answer's signature did not verify (null = verified). */
  sigRefusal: string | null;
  /** A refusal body (`{ state: 'refused', reason }`) when the helper refused before running. */
  refusedReason?: string;
}

/** Why an answer cannot be compared, or null. */
export function answerInvalid(s: SentSlice): string | null {
  const a = s.answer;
  if (!a) return 'no-answer';
  if (s.sigRefusal) return `sig:${s.sigRefusal}`;
  const r = s.request;
  if (a.attemptId !== r.attemptId || a.runAttemptId !== r.runAttemptId || a.lane !== r.lane || a.baseSha !== r.baseSha || a.headSha !== r.headSha) return 'ids';
  if (a.requestedFiles.length !== r.files.length || a.requestedFiles.some((f, i) => f !== r.files[i])) return 'requested-files';
  if (a.state === 'done' && !a.resultOversize) {
    const seen = new Set<string>();
    for (const p of a.perFile) {
      if (!r.files.includes(p.file) || seen.has(p.file)) return 'per-file';
      seen.add(p.file);
    }
    if (seen.size !== r.files.length) return 'per-file';
  }
  return null;
}

export interface ShadowComparison {
  slicesSent: number;
  done: number;
  handedBack: number;
  busy: number;
  ownerBusy: number;
  refused: Record<string, number>;
  invalidAnswers: number;
  badSignatures: number;
  agree: number;
  uncollected: number;
  disagree: Array<{ file: string; direction: Direction }>;
  sliceErrors: number;
  resultOversize: Array<{ attemptId: string; bytesSeen: number }>;
  localMissing: number;
  /** Locally failing files compared (on `main` nearly every local result is a pass; reported separately). */
  localRedCompared: number;
  helperMs: number;
  localMs: number;
  handBackMs: number[];
  ownerCoresMax: number | null;
  vitestStartMs: number[];
  canary: { compared: number; falseGreen: number; falseRed: number };
  /** Learned-list observations for the helper (never from an invalid answer). */
  observations: LearnedObservation[];
}

const same = (a: { passed: number; failed: number; skipped: number; todo: number }, b: { passed: number; failed: number; skipped: number; todo: number }) =>
  a.passed === b.passed && a.failed === b.failed && a.skipped === b.skipped && a.todo === b.todo;

export function directionOf(helper: { failed: number }, local: { failed: number }): Direction {
  if (helper.failed > 0 && local.failed === 0) return 'helper-red/local-green';
  if (helper.failed === 0 && local.failed > 0) return 'helper-green/local-red';
  return 'skip-difference';
}

export function compareShadow(slices: readonly SentSlice[], local: ReadonlyMap<string, FileCounts> | null, canary: Readonly<Record<string, CanaryExpectation>>, opts: { source?: 'paired' | 'dry-run' } = {}): ShadowComparison {
  const out: ShadowComparison = {
    slicesSent: slices.length, done: 0, handedBack: 0, busy: 0, ownerBusy: 0, refused: {}, invalidAnswers: 0, badSignatures: 0,
    agree: 0, uncollected: 0, disagree: [], sliceErrors: 0, resultOversize: [], localMissing: 0, localRedCompared: 0,
    helperMs: 0, localMs: 0, handBackMs: [], ownerCoresMax: null, vitestStartMs: [],
    canary: { compared: 0, falseGreen: 0, falseRed: 0 }, observations: [],
  };
  for (const s of slices) {
    if (s.refusedReason) { out.refused[s.refusedReason] = (out.refused[s.refusedReason] ?? 0) + 1; continue; }
    const bad = answerInvalid(s);
    if (bad) {
      out.invalidAnswers++;
      if (bad.startsWith('sig:')) out.badSignatures++;
      continue;
    }
    const a = s.answer!;
    if (a.ownerCoresMax !== null) out.ownerCoresMax = Math.max(out.ownerCoresMax ?? 0, a.ownerCoresMax);
    if (a.state === 'busy') { out.busy++; continue; }
    if (a.state === 'owner-busy') { out.ownerBusy++; continue; }
    if (a.state === 'handed-back' || a.state === 'cancelled' || a.state === 'prep-stopped') { out.handedBack++; if (a.handBackMs !== null) out.handBackMs.push(a.handBackMs); continue; }
    if (a.state === 'refused') { const r = String(a.reason ?? 'unknown'); out.refused[r] = (out.refused[r] ?? 0) + 1; continue; }
    if (a.state !== 'done') continue;
    out.done++;
    if (a.resultOversize) { out.resultOversize.push({ attemptId: a.attemptId, bytesSeen: a.resultOversize.bytesSeen }); continue; }
    const slice = a.slice ?? { exitCode: null, unhandledErrors: 0, collected: false, vitestStartMs: null };
    if (slice.vitestStartMs !== null) out.vitestStartMs.push(slice.vitestStartMs);
    const failedFiles = a.perFile.filter((p) => p.failed > 0).length;
    // No readable report (a crashed or unparseable run collects nothing): one slice error, judged once;
    // no file becomes a disagreement and nothing feeds the learned list.
    if (!slice.collected && a.perFile.every((p) => p.tests === 0)) { out.sliceErrors++; continue; }
    if ((slice.exitCode !== 0 && failedFiles === 0) || slice.unhandledErrors > 0) out.sliceErrors++;
    for (const p of a.perFile) out.helperMs += p.ms;
    if (s.canary) {
      for (const p of a.perFile) {
        const exp = canary[p.file];
        if (!exp) continue;
        out.canary.compared++;
        if (exp.failed > 0 && p.failed === 0) out.canary.falseGreen++;
        if (exp.failed === 0 && p.failed > 0) out.canary.falseRed++;
      }
      continue;
    }
    for (const p of a.perFile) {
      const l = local?.get(p.file);
      if (!l) { out.localMissing++; continue; }
      out.localMs += l.ms ?? 0;
      if (l.failed > 0) out.localRedCompared++;
      if (same(p, l)) {
        if (slice.collected) {
          out.agree++;
          // The audit row's count view; the learned list is fed from the digest comparison.
          if (s.request.retrial) out.observations.push({ file: p.file, kind: 'agree' });
        } else out.uncollected++;
        continue;
      }
      const direction = directionOf(p, l);
      out.disagree.push({ file: p.file, direction });
      // Learned list: the file failed, or skipped differently, on the helper while passing locally.
      // Only from a slice that collected every file: an uncollected slice never feeds the list.
      // The count view's mapping onto the amended kinds (audit only): the helper failed where the run
      // machine passed, or both passed with different skips (a names-and-outcomes difference).
      if (slice.collected && l.failed === 0 && direction === 'helper-red/local-green') out.observations.push({ file: p.file, kind: 'helper-failed-local-passed' });
      else if (slice.collected && l.failed === 0 && p.failed === 0 && direction === 'skip-difference') out.observations.push({ file: p.file, kind: 'digest-differs-both-pass' });
    }
  }
  return out;
}
