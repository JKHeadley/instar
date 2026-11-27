/**
 * How often a run machine asks its helper (docs/specs/local-verify-borrowed-slices-count.md, F
 * "Asking the helper"), and the assignment drawn before it is asked ("Verifies that hold nothing
 * back"). Pure.
 *
 * At the start of every verify the run machine sends one status request with a 2-second limit.
 * No answer means no helper for that verify. After 10 unanswered requests in a row it asks on
 * every 5th verify only. After 7 days without an answer it stops asking until the helper
 * announces itself with its signed "I am here", which restores asking on every verify at once.
 * This replaces the first design's back-off (up to 8 hours), which ignored a laptop that woke up.
 */
import crypto from 'node:crypto';

export const ASK_LIMITS = Object.freeze({
  /** One status request per verify, with this limit. */
  statusTimeoutMs: 2_000,
  /** After this many unanswered requests in a row… */
  slowAfterUnanswered: 10,
  /** …only every 5th verify asks. */
  slowEvery: 5,
  /** After this long without an answer the run machine stops asking until the helper announces itself. */
  stopAfterMs: 7 * 24 * 60 * 60_000,
  /** One verify in ten of a waiting change is compare-only. */
  compareOnlyOneIn: 10,
});

export interface AskState {
  /** Unanswered requests in a row. */
  unanswered: number;
  /** When the current silence began (the first unanswered request); null while the helper answers. */
  silentSince: number | null;
  /** Verifies passed over since the last request (only counted while asking is slowed). */
  skippedSinceAsk: number;
}

export const freshAsk = (): AskState => ({ unanswered: 0, silentSince: null, skippedSinceAsk: 0 });

export type AskDecision = 'ask' | 'skip' | 'stopped';

/** Whether this verify asks the helper. Pure: the state is not changed. */
export function askDecision(s: AskState, now: number): AskDecision {
  if (s.silentSince !== null && now - s.silentSince >= ASK_LIMITS.stopAfterMs) return 'stopped';
  if (s.unanswered >= ASK_LIMITS.slowAfterUnanswered) return s.skippedSinceAsk >= ASK_LIMITS.slowEvery - 1 ? 'ask' : 'skip';
  return 'ask';
}

/** The state after a verify that did not ask (`skip`); `stopped` changes nothing. */
export function noteSkipped(s: AskState): AskState {
  return { ...s, skippedSinceAsk: s.skippedSinceAsk + 1 };
}

/** The state after one request: an answer restores asking on every verify; silence counts. */
export function noteAsked(s: AskState, answered: boolean, now: number): AskState {
  if (answered) return freshAsk();
  return { unanswered: s.unanswered + 1, silentSince: s.silentSince ?? now, skippedSinceAsk: 0 };
}

/** The helper's verified "I am here": asking on every verify again, at once. */
export function noteHere(): AskState {
  return freshAsk();
}

export function parseAsk(v: unknown): AskState {
  const x = v as Partial<AskState> | null;
  const n = (k: unknown): k is number => typeof k === 'number' && Number.isSafeInteger(k) && k >= 0;
  if (!x || typeof x !== 'object' || !n(x.unanswered) || !n(x.skippedSinceAsk) || !(x.silentSince === null || n(x.silentSince))) return freshAsk();
  return { unanswered: x.unanswered, silentSince: x.silentSince, skippedSinceAsk: x.skippedSinceAsk };
}

/** What a verify of a waiting change may do with a helper's passes: use them, or hold nothing back. */
export type BorrowedAssignment = 'counting' | 'compare-only';

/**
 * One verify in ten is compare-only, chosen at random BEFORE the helper is asked (so the choice
 * cannot depend on whether or how the helper answers). `randomInt(n)` returns a whole number in
 * [0, n); production passes `crypto.randomInt`.
 */
export function drawAssignment(randomInt: (n: number) => number = (n) => crypto.randomInt(n)): BorrowedAssignment {
  return randomInt(ASK_LIMITS.compareOnlyOneIn) === 0 ? 'compare-only' : 'counting';
}

/**
 * The digest of a lane's helper file list for the record field `borrowed.lanes[].filesDigest`:
 * sha256 over the distinct paths, sorted by UTF-16 code unit, each ended by `\n`.
 */
export function borrowedFilesDigest(files: readonly string[]): string {
  const h = crypto.createHash('sha256');
  h.update('instar-lv-borrowed-files-v1\n', 'utf8');
  for (const f of [...new Set(files)].sort()) h.update(`${f}\n`, 'utf8');
  return h.digest('hex');
}
