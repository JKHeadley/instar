/**
 * Main-red hold (CMT-1033, amendment to docs/specs/local-verify-merge-authority.md §2
 * "Post-merge verify of `main`"): while `main` is failing a known check, a PR verify
 * that cannot be the repair is a doomed run — it fails the same check by construction
 * (the verify tests the PR's MERGE with `main`). On 2026-10-26 the queue ran eight of
 * them (18 minutes each) after `main` went red on one file, and three sessions wrote
 * the same fix because nothing named the PR already fixing it.
 *
 * The rule, all deterministic and all over data the server already holds:
 *   - The hold is ACTIVE while `main` has a failed head (`main-suspect` after a first
 *     failure, or `main-red`) AND the failing files of that head are known from its
 *     run-detail. A failure that named no file holds nothing: there is nothing to
 *     match a repair against, so the queue behaves as before. An unknown-origin
 *     suspect (boot, lease move) keeps the watermark's red head, so the hold stays
 *     active there only when the recorded failure is for that same head.
 *   - A queued PR is a REPAIR CANDIDATE when its diff touches a failing file, or its
 *     title/body names one (the path, the file name, or the file's stem — the 2026-10-26
 *     repairs touched `src/` files and named `no-silent-fallbacks` in their text; a
 *     rule on the diff alone would have held both real repairs). A REVERT is also a
 *     candidate (title starting "Revert", or GitHub's "Reverts owner/repo#N" body
 *     line): the commonest repair undoes the breaking source change, touching and
 *     naming no test file, and holding it could keep `main` red with nothing able
 *     to turn it green.
 *   - Candidates run first (in queue order, with the usual main/PR fair share); every
 *     other PR entry is HELD — it keeps its place and starts once `main` is green or
 *     it becomes a candidate (a head push that names the check). A `main` verify is
 *     never held.
 *   - A PR whose file list could not be read is held unless its text names the check
 *     (the restrictive direction; the hold reason says so).
 *
 * This decides which verify spends the single slot NEXT, never whether a PR merges:
 * a candidate still has to pass its full verify. Pure functions; the service drives
 * them (and the kill switch `monitoring.localVerify.mainRedHold: false` disables the
 * whole rule live).
 */

import path from 'node:path';
import type { MainHealthSnapshot } from './mainHealth.js';

/** The last failed `main` verify's failing files (from its run-detail), kept for the hold. */
export interface MainFailureDetail {
  headSha: string;
  /** Repo-relative test files that failed (bounded; unique; from `failures[].file`). */
  files: string[];
  /** The run's bounded reasons (`lane-failed:unit:1`, `file-failed:<path>:1`, …). */
  reasons: string[];
  /** The first failure message per file, clipped (for the notice text). */
  messages: Record<string, string>;
  recordedAt: string;
}

/** Caps for what travels with the hold (bounded notices + bounded state file). */
export const MAIN_RED_HOLD_LIMITS = Object.freeze({
  maxFiles: 30,
  maxReasons: 40,
  messageChars: 200,
  /** PR title + body are matched as one lowercased string of at most this length. */
  textChars: 8000,
  /** A file stem shorter than this is not matched on its own (too generic: `index`, `app`). */
  minStemChars: 6,
});

/** Build the detail kept for the hold from a failed `main` run-detail (pure; bounded). */
export function mainFailureFromRunDetail(
  headSha: string,
  run: { reasons?: readonly string[]; failures?: ReadonlyArray<{ file: string; message?: string }> } | undefined,
  nowIso: string,
): MainFailureDetail {
  const files: string[] = [];
  const messages: Record<string, string> = {};
  for (const f of run?.failures ?? []) {
    if (typeof f?.file !== 'string' || f.file.length === 0 || files.includes(f.file)) continue;
    if (files.length >= MAIN_RED_HOLD_LIMITS.maxFiles) break;
    files.push(f.file);
    if (typeof f.message === 'string' && f.message.length > 0) messages[f.file] = f.message.split('\n')[0].slice(0, MAIN_RED_HOLD_LIMITS.messageChars);
  }
  return { headSha, files, reasons: (run?.reasons ?? []).slice(0, MAIN_RED_HOLD_LIMITS.maxReasons), messages, recordedAt: nowIso };
}

/** Normalize a PR's title + body for matching (lowercased, bounded). */
export function prMatchText(title: string | null | undefined, body: string | null | undefined): string {
  return `${title ?? ''}\n${body ?? ''}`.toLowerCase().slice(0, MAIN_RED_HOLD_LIMITS.textChars);
}

/** The names a failing file can be referred to by: its path, its basename, and its stem (`no-silent-fallbacks`). */
export function failingFileNames(file: string): string[] {
  const base = path.posix.basename(file);
  const stem = base.replace(/\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/, '').replace(/\.(ts|tsx|js|mjs|cjs|json|md)$/, '');
  const names = [file.toLowerCase(), base.toLowerCase()];
  if (stem.length >= MAIN_RED_HOLD_LIMITS.minStemChars && stem !== base) names.push(stem.toLowerCase());
  return [...new Set(names)];
}

export interface RepairInput {
  /** Repo-relative files the PR changes; null = could not be read. */
  files: readonly string[] | null;
  /** `prMatchText(title, body)`. */
  text: string;
}

export type RepairVerdict =
  | { candidate: true; by: 'touches-file' | 'names-file' | 'reverts'; file: string }
  | { candidate: false; reason: 'no-overlap' | 'files-unknown' };

/**
 * Is this PR a candidate repair for the failing files? Touching one of them wins;
 * otherwise naming one in the title/body. A PR with no readable file list and no
 * mention is `files-unknown` (held, the restrictive direction). Pure.
 */
export function repairVerdict(pr: RepairInput, failingFiles: readonly string[]): RepairVerdict {
  if (pr.files) {
    const set = new Set(pr.files);
    for (const f of failingFiles) if (set.has(f)) return { candidate: true, by: 'touches-file', file: f };
  }
  for (const f of failingFiles) {
    for (const name of failingFileNames(f)) if (name.length > 0 && pr.text.includes(name)) return { candidate: true, by: 'names-file', file: f };
  }
  if (failingFiles.length > 0 && isRevertText(pr.text)) return { candidate: true, by: 'reverts', file: failingFiles[0] };
  return { candidate: false, reason: pr.files ? 'no-overlap' : 'files-unknown' };
}

/**
 * A revert PR, from its `prMatchText`: the title starts with "revert" (GitHub's
 * button writes `Revert "<title>"`), or the body carries GitHub's
 * `Reverts owner/repo#N` line. Pure.
 */
export function isRevertText(text: string): boolean {
  return /^revert\b/.test(text) || /^reverts [\w.-]+\/[\w.-]+#\d+/m.test(text);
}

export interface HoldEntryInput extends RepairInput {
  pr: number;
  kind?: 'main';
}

export interface RepairCandidate { pr: number; by: 'touches-file' | 'names-file' | 'reverts'; file: string }

export type MainRedHoldDecision =
  | { active: false; reason: 'disabled' | 'main-healthy' | 'no-red-head' | 'failing-files-unknown' }
  | {
      active: true;
      state: MainHealthSnapshot['state'];
      redHead: string;
      failingFiles: string[];
      /**
       * The PRs fixing it: the running candidate first, then queued candidates in queue
       * order, then candidates remembered from earlier in this episode (already verified,
       * waiting to merge) — so "PR #N is already fixing it" holds until `main` is green.
       */
      repairPrs: RepairCandidate[];
      /** PR numbers held, in queue order, each with why. */
      heldPrs: Array<{ pr: number; reason: 'no-overlap' | 'files-unknown' }>;
    };

/**
 * The hold over the current queue: which PR entries may start now (the repair
 * candidates) and which wait. Pure; the service maps the answer back onto its queue.
 */
export function decideMainRedHold(i: {
  enabled: boolean;
  health: Pick<MainHealthSnapshot, 'state' | 'redHead'>;
  failure: MainFailureDetail | null;
  queue: ReadonlyArray<HoldEntryInput>;
  /** The PR verify running now, if any (a candidate is listed as fixing it; a non-candidate is never "held" — it is running). */
  inFlight?: HoldEntryInput | null;
  /** Candidates seen earlier in this red episode (kept by the caller until green). */
  remembered?: ReadonlyArray<RepairCandidate>;
}): MainRedHoldDecision {
  if (!i.enabled) return { active: false, reason: 'disabled' };
  if (i.health.state === 'healthy') return { active: false, reason: 'main-healthy' };
  if (!i.health.redHead) return { active: false, reason: 'no-red-head' };
  const f = i.failure;
  if (!f || f.headSha !== i.health.redHead || f.files.length === 0) return { active: false, reason: 'failing-files-unknown' };
  const repairPrs: RepairCandidate[] = [];
  const heldPrs: Array<{ pr: number; reason: 'no-overlap' | 'files-unknown' }> = [];
  const add = (c: RepairCandidate) => { if (!repairPrs.some((r) => r.pr === c.pr)) repairPrs.push(c); };
  if (i.inFlight && i.inFlight.kind !== 'main') {
    const v = repairVerdict(i.inFlight, f.files);
    if (v.candidate) add({ pr: i.inFlight.pr, by: v.by, file: v.file });
  }
  for (const e of i.queue) {
    if (e.kind === 'main') continue;
    const v = repairVerdict(e, f.files);
    if (v.candidate) add({ pr: e.pr, by: v.by, file: v.file });
    else heldPrs.push({ pr: e.pr, reason: v.reason });
  }
  // A remembered candidate whose CURRENT queued head no longer touches or names the check is held, not "fixing it".
  for (const r of i.remembered ?? []) if (!heldPrs.some((h) => h.pr === r.pr)) add(r);
  return { active: true, state: i.health.state, redHead: i.health.redHead, failingFiles: [...f.files], repairPrs, heldPrs };
}

/** The one-line, plain-words hold reason shown on GET /local-verify and in the POST answer. */
export function holdReasonText(d: Extract<MainRedHoldDecision, { active: true }>): string {
  const files = d.failingFiles.join(', ');
  const fixing = d.repairPrs.length > 0 ? `PR${d.repairPrs.length > 1 ? 's' : ''} ${d.repairPrs.map((r) => `#${r.pr}`).join(', ')} ${d.repairPrs.length > 1 ? 'are' : 'is'} already fixing it` : 'no queued PR is fixing it yet';
  return `main is ${d.state === 'main-red' ? 'red' : 'failing (re-run pending)'} on ${files}; ${fixing}. A PR that does not touch or name that file would fail the same check, so it waits until main is green. To run first, make the PR fix the check and name the failing file in its title or body. A revert of the breaking change also runs first.`;
}
