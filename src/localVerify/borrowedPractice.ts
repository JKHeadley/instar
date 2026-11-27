/**
 * The practice record's rules (docs/specs/local-verify-borrowed-slices-count.md, F: "The evidence
 * that ends practice", "The decision to count", "One rule decides admission", "Counting lapses",
 * "More than five disagreements in one verify", "Spot re-runs").
 *
 * Everything here is PURE: a lane's record goes in, a new lane's record and the events it caused
 * come out. The file, the routes and the notices live elsewhere (borrowedState.ts,
 * BorrowedRunMachine.ts, borrowedNotices.ts). The verify's lane flow (borrowedLaneFlow.ts) reads
 * `mayCount`, `spotRateOneIn` and the helper-level state through the server; nothing here is
 * imported by the verifier's own code.
 */

const DAY_MS = 24 * 60 * 60_000;

/** Fixed limits (spec "Fixed limits"). Each is revisited by the practice report and the 7-day review. */
export const PRACTICE_LIMITS = Object.freeze({
  /** Spread: comparisons from at least 5 separate verifies, at least 3 of waiting changes. */
  spreadVerifies: 5,
  spreadWaiting: 3,
  /** The failing direction: at least 5 comparisons, from at least 3 files and 2 verifies. */
  failingComparisons: 5,
  failingFiles: 3,
  failingVerifies: 2,
  /** Under a recorded 7-day exception: 3 comparisons, from at least 2 files and 2 verifies. Nothing else is relaxed. */
  exceptionFailingComparisons: 3,
  exceptionFailingFiles: 2,
  exceptionFailingVerifies: 2,
  /** The exception admits only once the current practice period is at least this old. */
  exceptionAfterMs: 7 * DAY_MS,
  /** The check slice must be exactly right in each of the last 20 verifies that carried one. */
  checkHistory: 20,
  /** No confirmed wrong pass in the helper's last 500 file comparisons on the lane. */
  wrongPassWindow: 500,
  /** Invalid answers: three in a row, or 5 of the last 20. */
  invalidInARow: 3,
  invalidOfLast: 5,
  invalidWindow: 20,
  /** Confirmed wrong passes on two different changes within 24 hours. */
  wrongPassChangesWindowMs: DAY_MS,
  wrongPassChanges: 2,
  /** No agreeing comparison for 7 days. */
  staleAgreeMs: 7 * DAY_MS,
  /** MORE than five disagreements in one verify is one event of unknown cause. */
  massDisagreement: 5,
  /** Spot re-runs: each helper-passed file with probability 1 in 20; 1 in 5 for the helper's next 50 verifies after any disagreement. */
  spotOneIn: 20,
  spotRaisedOneIn: 5,
  spotRaisedVerifies: 50,
  /** Bounds of the stored lists. */
  coverageFilesMax: 20_000,
  failingKept: 200,
  lapsesKept: 50,
  /** The owner hears of a helper that lapsed for a fault three times in 7 days. */
  ownerFaultLapses: 3,
  ownerFaultWindowMs: 7 * DAY_MS,
});

export const PRACTICE_LANES = Object.freeze(['unit', 'integration', 'e2e'] as const);
export type PracticeLane = typeof PRACTICE_LANES[number];

/**
 * Why counting ended. The first four are FAULTS (the helper, or an answer of its, was wrong); the
 * last three are ordinary events and never count toward the owner's notice.
 */
export type LapseReason =
  | 'wrong-pass-compare-only' | 'wrong-pass-two-changes' | 'invalid-answers' | 'suspension-followup'
  | 'image-changed' | 'runner-version-changed' | 'no-agreeing-comparison';

export const FAULT_LAPSES: readonly LapseReason[] = Object.freeze(['wrong-pass-compare-only', 'wrong-pass-two-changes', 'invalid-answers', 'suspension-followup']);
export const isFaultLapse = (r: LapseReason): boolean => FAULT_LAPSES.includes(r);

const LAPSE_REASONS: readonly LapseReason[] = Object.freeze([...FAULT_LAPSES, 'image-changed', 'runner-version-changed', 'no-agreeing-comparison']);

/** `practice`, `counting`, `suspended`, or `lapsed: <reason>` (practising again after counting ended). */
export type PracticeState = 'practice' | 'counting' | 'suspended' | `lapsed: ${LapseReason}`;

export function isPracticeState(v: unknown): v is PracticeState {
  if (v === 'practice' || v === 'counting' || v === 'suspended') return true;
  return typeof v === 'string' && v.startsWith('lapsed: ') && (LAPSE_REASONS as readonly string[]).includes(v.slice('lapsed: '.length));
}

/** The sandbox image and runner version a lane's evidence belongs to. */
export interface HelperIdentity { image: string; runnerVersion: string }

/** Each evidence item's progress, as numbers: what `GET /local-verify` shows and what the admission rule reads. */
export interface EvidenceProgress {
  coverage: { dryRunDone: boolean; eligible: number; uncovered: number };
  spread: { verifies: number; waiting: number };
  failing: { comparisons: number; files: number; verifies: number; checksSeen: number; checksRight: number; environmentDifferences: number };
  wrongPass: { comparisons: number; inWindow: number };
}

export interface CountDecision {
  at: number;
  reason: string;
  sevenDayException: boolean;
  by: string | null;
  /** The practice period this decision belongs to: it admits nothing in any other period. */
  periodStartedAt: number;
  /** The evidence as it stood when the decision was recorded: the admission rule is re-checked on it by every verify. */
  evidence: EvidenceProgress;
}

export interface LaneShare { verifyId: string; at: number; assigned: 'counting' | 'compare-only'; sent: number; finished: number }

export interface LaneRecord {
  state: PracticeState;
  /** What `suspended` returns to when the follow-up verify agrees. */
  suspendedFrom: Exclude<PracticeState, 'suspended'> | null;
  /** The image and runner version the evidence belongs to; null until the helper's status first names them. */
  identity: HelperIdentity | null;
  /** Start of the current practice period (the first one, or the last lapse). */
  practiceStartedAt: number;
  /** Item 1. Null until a dry run recorded the files eligible then. `uncovered` shrinks with every comparison. */
  coverage: { dryRunAt: number; eligible: number; eligibleDigest: string; uncovered: string[]; proven?: boolean } | null;
  /** Item 2, counted from the period's start. */
  spread: { verifies: number; waiting: number };
  /** Item 3: one entry per (file, verify) where both sides failed at least one same test. */
  failing: Array<{ file: string; verifyId: string; at: number }>;
  environmentDifferences: number;
  /** Item 3, second half: the last 20 verifies that carried a check slice (true = exactly right). */
  checks: boolean[];
  /** Item 4: comparisons counted from the period's start, and the count at which each confirmed wrong pass fell. */
  comparisons: number;
  wrongPassAt: number[];
  /** The last 20 answers (true = invalid: wrong ids, signature, file list or tree hash). */
  answers: boolean[];
  /** Confirmed wrong passes by change, for the "two different changes within 24 hours" rule. */
  wrongPassChanges: Array<{ change: string; at: number }>;
  lastAgreeAt: number | null;
  decision: CountDecision | null;
  lapses: Array<{ at: number; reason: LapseReason; fault: boolean }>;
  /** The last verify's share of this lane and how much of it the helper finished. */
  last: LaneShare | null;
}

export function freshLane(now: number): LaneRecord {
  return {
    state: 'practice', suspendedFrom: null, identity: null, practiceStartedAt: now, coverage: null,
    spread: { verifies: 0, waiting: 0 }, failing: [], environmentDifferences: 0, checks: [], comparisons: 0, wrongPassAt: [],
    answers: [], wrongPassChanges: [], lastAgreeAt: null, decision: null, lapses: [], last: null,
  };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── the four evidence items ────────────────────────────────────────────

export function evidenceProgress(lane: LaneRecord): EvidenceProgress {
  const from = lane.comparisons - PRACTICE_LIMITS.wrongPassWindow;
  return {
    coverage: { dryRunDone: lane.coverage !== null, eligible: lane.coverage?.eligible ?? 0, uncovered: lane.coverage?.uncovered.length ?? 0 },
    spread: { verifies: lane.spread.verifies, waiting: lane.spread.waiting },
    failing: {
      comparisons: lane.failing.length,
      files: new Set(lane.failing.map((f) => f.file)).size,
      verifies: new Set(lane.failing.map((f) => f.verifyId)).size,
      checksSeen: lane.checks.length,
      checksRight: lane.checks.filter(Boolean).length,
      environmentDifferences: lane.environmentDifferences,
    },
    // A wrong pass recorded as comparison number n is inside the window while n > comparisons - 500.
    wrongPass: { comparisons: lane.comparisons, inWindow: lane.wrongPassAt.filter((n) => n > from).length },
  };
}

export type EvidenceItem = 'coverage' | 'spread' | 'failing-direction' | 'check-slice' | 'wrong-pass-window';

/** Item 1: a dry run recorded the eligible files and every one of them has since been compared. */
export const coverageComplete = (p: EvidenceProgress): boolean => p.coverage.dryRunDone && p.coverage.uncovered === 0;
/** Item 2. */
export const spreadComplete = (p: EvidenceProgress): boolean => p.spread.verifies >= PRACTICE_LIMITS.spreadVerifies && p.spread.waiting >= PRACTICE_LIMITS.spreadWaiting;
/** Item 3, first half, with the numbers the decision allows. */
export function failingDirectionComplete(p: EvidenceProgress, exception: boolean): boolean {
  const L = PRACTICE_LIMITS;
  return exception
    ? p.failing.comparisons >= L.exceptionFailingComparisons && p.failing.files >= L.exceptionFailingFiles && p.failing.verifies >= L.exceptionFailingVerifies
    : p.failing.comparisons >= L.failingComparisons && p.failing.files >= L.failingFiles && p.failing.verifies >= L.failingVerifies;
}
/** Item 3, second half: at least one verify carried a check slice, and each of the last 20 that did was exactly right. */
export const checkSliceComplete = (p: EvidenceProgress): boolean => p.failing.checksSeen >= 1 && p.failing.checksRight === p.failing.checksSeen;
/** Item 4. */
export const wrongPassWindowClear = (p: EvidenceProgress): boolean => p.wrongPass.inWindow === 0;

export interface AdmissionResult { admitted: boolean; missing: EvidenceItem[]; usedException: boolean; exceptionTooEarly: boolean }

/**
 * THE ONE ADMISSION RULE (spec "One rule decides admission"). Both the route that records the
 * decision and the verify use it:
 *  - all four items as written; or
 *  - when the decision says "7-day exception" AND at least 7 days have passed since the current
 *    practice period began: the same four items, with item 3's number lowered from 5 comparisons
 *    to 3, from at least 2 files and 2 verifies.
 * Nothing else is relaxed: coverage, spread, the check slice's history and the wrong-pass window
 * all still apply.
 *
 * `at` is the moment the items are evaluated: now for the route, the decision's own time for a
 * verify (the items are evaluated when the decision is recorded; afterwards only lapses end counting).
 */
export function admission(p: EvidenceProgress, d: { sevenDayException: boolean }, practiceStartedAt: number, at: number): AdmissionResult {
  const oldEnough = at - practiceStartedAt >= PRACTICE_LIMITS.exceptionAfterMs;
  const exception = d.sevenDayException === true && oldEnough;
  const missing: EvidenceItem[] = [];
  if (!coverageComplete(p)) missing.push('coverage');
  if (!spreadComplete(p)) missing.push('spread');
  if (!failingDirectionComplete(p, exception)) missing.push('failing-direction');
  if (!checkSliceComplete(p)) missing.push('check-slice');
  if (!wrongPassWindowClear(p)) missing.push('wrong-pass-window');
  const usedException = missing.length === 0 && exception && !failingDirectionComplete(p, false);
  return { admitted: missing.length === 0, missing, usedException, exceptionTooEarly: d.sevenDayException === true && !oldEnough };
}

/**
 * Whether a helper's pass may count on this lane (spec decision point "Whether a helper's pass
 * counts", the facts the practice record holds): mode `count`; the state `counting`; a recorded
 * decision for the current practice period; and the admission rule holding on the evidence that
 * decision recorded. The mode alone admits nothing, and a decision with incomplete evidence
 * behaves as practice. The remaining facts (signed answer, tree hash, the pass definition, the
 * check slice, not a main verify) belong to the verify's lane flow.
 */
export function mayCount(lane: LaneRecord | null | undefined, mode: 'off' | 'practice' | 'count'): boolean {
  if (mode !== 'count' || !lane || lane.state !== 'counting' || !lane.decision) return false;
  const d = lane.decision;
  if (d.periodStartedAt !== lane.practiceStartedAt) return false;
  return admission(d.evidence, d, d.periodStartedAt, d.at).admitted;
}

// ── events ─────────────────────────────────────────────────────────────

export type LaneEvent =
  | { kind: 'wrong-pass'; file: string; verifyId: string; change: string | null }
  | { kind: 'lapse'; reason: LapseReason; fault: boolean }
  | { kind: 'suspended'; disagreements: number }
  | { kind: 'resumed' }
  | { kind: 'identity-reset'; reason: 'image-changed' | 'runner-version-changed' };

export interface Transition { lane: LaneRecord; events: LaneEvent[]; /** Any disagreement: raises the helper's spot re-run rate. */ disagreed: boolean }

/**
 * A lapse, back to practice: items 2, 3 and 4 are required again, counted from the lapse. Coverage
 * is kept unless the image changed, in which case the dry run is repeated.
 */
function lapsed(l: LaneRecord, reason: LapseReason, now: number): LaneRecord {
  const fault = isFaultLapse(reason);
  return {
    ...l,
    state: `lapsed: ${reason}`, suspendedFrom: null, practiceStartedAt: now, decision: null,
    coverage: reason === 'image-changed' ? null : l.coverage,
    spread: { verifies: 0, waiting: 0 }, failing: [], environmentDifferences: 0, checks: [], comparisons: 0, wrongPassAt: [],
    answers: [], wrongPassChanges: [], lastAgreeAt: null,
    lapses: [...l.lapses, { at: now, reason, fault }].slice(-PRACTICE_LIMITS.lapsesKept),
  };
}

/** Exported for tests of the reset keys. */
export function lapse(lane: LaneRecord, reason: LapseReason, now: number): Transition {
  return { lane: lapsed(clone(lane), reason, now), events: [{ kind: 'lapse', reason, fault: isFaultLapse(reason) }], disagreed: false };
}

/** What one verify showed about one helper on one lane, as the server learns it after the verify. */
export interface LaneVerifyOutcome {
  /** Unique per verify (its attempt token, or the observer's run id). */
  verifyId: string;
  kind: 'main' | 'waiting';
  /** The change (its PR number as text); null on a main verify. */
  change: string | null;
  /** A main verify, or the one in ten: the run machine ran every file itself. */
  compareOnly: boolean;
  assigned: 'counting' | 'compare-only';
  /** Files sent and files the helper finished (a valid last answer listed them). */
  sent: number;
  finished: number;
  /** Same-tree comparisons, each file in at most one list. */
  agreed: string[];
  digestDiffersBothPass: string[];
  helperFailedLocalPassed: string[];
  /** The run machine's final result (after its re-run alone) is a failure where the helper passed. */
  confirmedWrongPasses: string[];
  /** Real test files whose final local result failed and where the helper reported at least one of the same tests failing. */
  failingAgreed: string[];
  /** Failed locally; the helper could not collect the file, or failed it only on tests that passed locally. */
  environmentDifferences: number;
  /** The check slice: exactly right, wrong, or not carried / not answered (null). */
  check: 'right' | 'wrong' | null;
  /** Every answer of the verify in order: valid, or invalid (wrong ids, signature, file list or tree hash). */
  answers: Array<'valid' | 'invalid'>;
  /** Disagreements across every lane of the verify (the mass rule is the verify's, not the lane's). Absent: this lane's own. */
  verifyDisagreements?: number;
}

function invalidLapseDue(answers: readonly boolean[]): boolean {
  const L = PRACTICE_LIMITS;
  const tail = answers.slice(-L.invalidInARow);
  if (tail.length === L.invalidInARow && tail.every(Boolean)) return true;
  return answers.slice(-L.invalidWindow).filter(Boolean).length >= L.invalidOfLast;
}

/**
 * Apply one verify's outcome to a lane (spec F: evidence, suspension, lapses). In order:
 *  1. every answer joins the invalid-answer history; three invalid in a row, or 5 of the last 20,
 *     lapse a counting lane;
 *  2. a verify in which the helper finished nothing is not counted and resets nothing;
 *  3. more than five disagreements: no evidence is taken from the verify. A lane already suspended
 *     lapses (a mass disagreement again); any other lane is suspended at once;
 *  4. a suspended lane's next compare-only verify: a confirmed wrong pass lapses it; otherwise
 *     (agreement, or only digest differences with both sides passing) it returns to the state and
 *     evidence it had. A verify that is not compare-only leaves a suspended lane as it is;
 *  5. confirmed wrong passes (five or fewer disagreements): recorded in the window; on a counting
 *     lane, one on a compare-only verify lapses, and so do two different changes within 24 hours;
 *  6. the comparisons feed the four evidence items.
 */
export function applyVerifyOutcome(input: LaneRecord, o: LaneVerifyOutcome, now: number): Transition {
  let l = clone(input);
  const events: LaneEvent[] = [];
  const L = PRACTICE_LIMITS;
  l.last = { verifyId: o.verifyId, at: now, assigned: o.assigned, sent: o.sent, finished: o.finished };

  // 1. invalid answers
  l.answers = [...l.answers, ...o.answers.map((a) => a === 'invalid')].slice(-L.invalidWindow);
  if (l.state === 'counting' && o.answers.includes('invalid') && invalidLapseDue(l.answers)) {
    const last = l.last;
    l = lapsed(l, 'invalid-answers', now);
    l.last = last;
    return { lane: l, events: [{ kind: 'lapse', reason: 'invalid-answers', fault: true }], disagreed: false };
  }

  // 2. nothing finished
  if (o.finished <= 0) return { lane: l, events, disagreed: false };

  const laneDisagreements = o.digestDiffersBothPass.length + o.helperFailedLocalPassed.length + o.confirmedWrongPasses.length;
  const disagreed = laneDisagreements > 0;
  // "More than five disagreements in one verify": counted across the verify's lanes.
  const disagreements = Math.max(laneDisagreements, o.verifyDisagreements ?? 0);

  // 3. mass disagreement
  if (disagreements > L.massDisagreement) {
    if (l.state === 'suspended') {
      const last = l.last;
      l = lapsed(l, 'suspension-followup', now);
      l.last = last;
      return { lane: l, events: [{ kind: 'lapse', reason: 'suspension-followup', fault: true }], disagreed };
    }
    l.suspendedFrom = l.state as Exclude<PracticeState, 'suspended'>;
    l.state = 'suspended';
    return { lane: l, events: [{ kind: 'suspended', disagreements }], disagreed };
  }

  // 4. the follow-up of a suspension
  if (l.state === 'suspended') {
    if (!o.compareOnly) return { lane: l, events, disagreed };
    if (o.confirmedWrongPasses.length > 0) {
      for (const file of o.confirmedWrongPasses) events.push({ kind: 'wrong-pass', file, verifyId: o.verifyId, change: o.change });
      const last = l.last;
      l = lapsed(l, 'suspension-followup', now);
      l.last = last;
      events.push({ kind: 'lapse', reason: 'suspension-followup', fault: true });
      return { lane: l, events, disagreed };
    }
    l.state = l.suspendedFrom ?? 'practice';
    l.suspendedFrom = null;
    events.push({ kind: 'resumed' });
  }

  // 6. the evidence (before the lapse checks of 5, so a lapse resets what it must)
  const compared = [...o.agreed, ...o.digestDiffersBothPass, ...o.helperFailedLocalPassed, ...o.confirmedWrongPasses];
  if (compared.length > 0) {
    l.spread = { verifies: l.spread.verifies + 1, waiting: l.spread.waiting + (o.kind === 'waiting' ? 1 : 0) };
    if (l.coverage && l.coverage.uncovered.length > 0) {
      const seen = new Set(compared);
      l.coverage = { ...l.coverage, uncovered: l.coverage.uncovered.filter((f) => !seen.has(f)) };
    }
  }
  const wrong = new Set(o.confirmedWrongPasses);
  for (const file of compared) {
    l.comparisons++;
    if (wrong.has(file)) l.wrongPassAt.push(l.comparisons);
  }
  l.wrongPassAt = l.wrongPassAt.filter((n) => n > l.comparisons - L.wrongPassWindow);
  for (const file of o.failingAgreed) {
    if (!l.failing.some((f) => f.file === file && f.verifyId === o.verifyId)) l.failing.push({ file, verifyId: o.verifyId, at: now });
  }
  l.failing = l.failing.slice(-L.failingKept);
  l.environmentDifferences += Math.max(0, o.environmentDifferences);
  if (o.check !== null) l.checks = [...l.checks, o.check === 'right'].slice(-L.checkHistory);
  if (o.agreed.length > 0) l.lastAgreeAt = now;

  // 5. confirmed wrong passes
  if (o.confirmedWrongPasses.length > 0) {
    for (const file of o.confirmedWrongPasses) events.push({ kind: 'wrong-pass', file, verifyId: o.verifyId, change: o.change });
    if (o.change !== null) {
      l.wrongPassChanges = [...l.wrongPassChanges.filter((c) => c.change !== o.change), { change: o.change, at: now }]
        .filter((c) => now - c.at <= L.wrongPassChangesWindowMs).slice(-20);
    }
    if (l.state === 'counting') {
      const reason: LapseReason | null = o.compareOnly ? 'wrong-pass-compare-only'
        : l.wrongPassChanges.length >= L.wrongPassChanges ? 'wrong-pass-two-changes' : null;
      if (reason) {
        const last = l.last;
        l = lapsed(l, reason, now);
        l.last = last;
        events.push({ kind: 'lapse', reason, fault: true });
      }
    }
  }
  return { lane: l, events, disagreed };
}

/**
 * The image or the runner version the helper names now. A change on a counting lane is a lapse
 * (ordinary); on a lane still in practice the evidence starts again the same way, without a lapse
 * entry. Coverage is kept unless the image changed. The first identity seen is only recorded.
 */
export function noteIdentity(input: LaneRecord, id: HelperIdentity, now: number): Transition {
  const cur = input.identity;
  if (cur && cur.image === id.image && cur.runnerVersion === id.runnerVersion) return { lane: input, events: [], disagreed: false };
  let l = clone(input);
  if (!cur) { l.identity = { ...id }; return { lane: l, events: [], disagreed: false }; }
  const reason = cur.image !== id.image ? 'image-changed' as const : 'runner-version-changed' as const;
  if (l.state === 'counting' || l.state === 'suspended') {
    l = lapsed(l, reason, now);
    l.identity = { ...id };
    return { lane: l, events: [{ kind: 'lapse', reason, fault: false }], disagreed: false };
  }
  // Still practising: the evidence belongs to the old image or version, so it starts again.
  const keptState = l.state;
  const keptLapses = l.lapses;
  l = lapsed(l, reason, now);
  l.state = keptState;
  l.lapses = keptLapses;
  l.identity = { ...id };
  return { lane: l, events: [{ kind: 'identity-reset', reason }], disagreed: false };
}

/** A counting lane with no agreeing comparison for 7 days (counted from the decision when none came since) lapses. */
export function noteTime(input: LaneRecord, now: number): Transition {
  if (input.state !== 'counting' || !input.decision) return { lane: input, events: [], disagreed: false };
  const since = Math.max(input.lastAgreeAt ?? 0, input.decision.at);
  if (now - since < PRACTICE_LIMITS.staleAgreeMs) return { lane: input, events: [], disagreed: false };
  return lapse(input, 'no-agreeing-comparison', now);
}

/** The dry run's result for a lane (borrowedDryRun.ts writes it): the files eligible then, those it compared, and whether it proved the lane. */
export function recordDryRun(input: LaneRecord, r: { eligible: readonly string[]; compared: readonly string[]; eligibleDigest: string; proven?: boolean }, now: number): LaneRecord {
  const l = clone(input);
  const done = new Set(r.compared);
  const eligible = [...new Set(r.eligible)].slice(0, PRACTICE_LIMITS.coverageFilesMax);
  l.coverage = { dryRunAt: now, eligible: eligible.length, eligibleDigest: r.eligibleDigest, uncovered: eligible.filter((f) => !done.has(f)).sort(), ...(r.proven !== undefined ? { proven: r.proven } : {}) };
  return l;
}

/**
 * A lane is "proven" for a helper (spec D) when its dry run finished it with files worth at least
 * half of the lane's time passing. A dry run recorded without that figure (stage 4's route) is
 * read as proven; no dry run is not proven. Pure.
 */
export const laneProven = (l: LaneRecord | null | undefined): boolean => !!l?.coverage && l.coverage.proven !== false;

export type DecisionRefusal = 'already-counting' | 'suspended' | 'evidence-incomplete' | 'exception-too-early';

/**
 * Record the throughput session's decision to count. Refused when the admission rule does not
 * hold: a decision can never be recorded on incomplete evidence.
 */
export function recordDecision(
  input: LaneRecord, d: { reason: string; sevenDayException: boolean; by: string | null }, now: number,
): { ok: true; lane: LaneRecord; admission: AdmissionResult } | { ok: false; code: DecisionRefusal; admission: AdmissionResult } {
  const progress = evidenceProgress(input);
  const a = admission(progress, d, input.practiceStartedAt, now);
  if (input.state === 'counting') return { ok: false, code: 'already-counting', admission: a };
  if (input.state === 'suspended') return { ok: false, code: 'suspended', admission: a };
  if (!a.admitted) return { ok: false, code: a.exceptionTooEarly && a.missing.length === 1 && a.missing[0] === 'failing-direction' && failingDirectionComplete(progress, true) ? 'exception-too-early' : 'evidence-incomplete', admission: a };
  const l = clone(input);
  l.state = 'counting';
  l.decision = { at: now, reason: d.reason.slice(0, 500), sevenDayException: d.sevenDayException, by: d.by, periodStartedAt: l.practiceStartedAt, evidence: progress };
  return { ok: true, lane: l, admission: a };
}

// ── spot re-runs (helper level) ────────────────────────────────────────

/** How many of the helper's next verifies still run at the raised rate. */
export interface SpotState { raisedVerifiesLeft: number }

/** One in how many helper-passed files the run machine re-runs: 20, or 5 while the raised period runs. */
export function spotRateOneIn(s: SpotState): number {
  return s.raisedVerifiesLeft > 0 ? PRACTICE_LIMITS.spotRaisedOneIn : PRACTICE_LIMITS.spotOneIn;
}

/** After one verify the helper served: any disagreement (re)starts the 50-verify raised period; otherwise it runs down by one. */
export function noteSpotVerify(s: SpotState, disagreed: boolean): SpotState {
  if (disagreed) return { raisedVerifiesLeft: PRACTICE_LIMITS.spotRaisedVerifies };
  return { raisedVerifiesLeft: Math.max(0, s.raisedVerifiesLeft - 1) };
}

// ── reading a stored lane ──────────────────────────────────────────────

const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const isFile = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 300;
const isProgress = (v: unknown): v is EvidenceProgress => {
  const p = v as EvidenceProgress | null;
  return !!p && typeof p === 'object'
    && !!p.coverage && typeof p.coverage.dryRunDone === 'boolean' && isCount(p.coverage.eligible) && isCount(p.coverage.uncovered)
    && !!p.spread && isCount(p.spread.verifies) && isCount(p.spread.waiting)
    && !!p.failing && isCount(p.failing.comparisons) && isCount(p.failing.files) && isCount(p.failing.verifies) && isCount(p.failing.checksSeen) && isCount(p.failing.checksRight) && isCount(p.failing.environmentDifferences)
    && !!p.wrongPass && isCount(p.wrongPass.comparisons) && isCount(p.wrongPass.inWindow);
};

/**
 * A stored lane, strictly: any field that is missing or malformed makes the WHOLE lane unreadable
 * (null), which the store reads as practice from the start. Never a partial trust.
 */
export function parseLane(v: unknown): LaneRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  if (!isPracticeState(x.state)) return null;
  if (!(x.suspendedFrom === null || (isPracticeState(x.suspendedFrom) && x.suspendedFrom !== 'suspended'))) return null;
  if ((x.state === 'suspended') !== (x.suspendedFrom !== null)) return null;
  const id = x.identity as HelperIdentity | null;
  if (!(id === null || (!!id && typeof id === 'object' && typeof id.image === 'string' && id.image.length <= 300 && typeof id.runnerVersion === 'string' && id.runnerVersion.length <= 200))) return null;
  if (!isCount(x.practiceStartedAt)) return null;
  const cov = x.coverage as LaneRecord['coverage'];
  if (!(cov === null || (!!cov && typeof cov === 'object' && isCount(cov.dryRunAt) && isCount(cov.eligible, PRACTICE_LIMITS.coverageFilesMax)
    && typeof cov.eligibleDigest === 'string' && /^[0-9a-f]{64}$/.test(cov.eligibleDigest)
    && Array.isArray(cov.uncovered) && cov.uncovered.length <= cov.eligible && cov.uncovered.every(isFile)
    && (cov.proven === undefined || typeof cov.proven === 'boolean')))) return null;
  const sp = x.spread as LaneRecord['spread'] | null;
  if (!sp || !isCount(sp.verifies) || !isCount(sp.waiting) || sp.waiting > sp.verifies) return null;
  if (!Array.isArray(x.failing) || x.failing.length > PRACTICE_LIMITS.failingKept
    || !x.failing.every((f) => !!f && isFile((f as { file?: unknown }).file) && typeof (f as { verifyId?: unknown }).verifyId === 'string' && ((f as { verifyId: string }).verifyId.length <= 100) && isCount((f as { at?: unknown }).at))) return null;
  if (!isCount(x.environmentDifferences) || !isCount(x.comparisons)) return null;
  const bools = (a: unknown, max: number): a is boolean[] => Array.isArray(a) && a.length <= max && a.every((b) => typeof b === 'boolean');
  if (!bools(x.checks, PRACTICE_LIMITS.checkHistory) || !bools(x.answers, PRACTICE_LIMITS.invalidWindow)) return null;
  if (!Array.isArray(x.wrongPassAt) || x.wrongPassAt.length > PRACTICE_LIMITS.wrongPassWindow || !x.wrongPassAt.every((n) => isCount(n) && n <= (x.comparisons as number))) return null;
  if (!Array.isArray(x.wrongPassChanges) || x.wrongPassChanges.length > 20
    || !x.wrongPassChanges.every((c) => !!c && typeof (c as { change?: unknown }).change === 'string' && (c as { change: string }).change.length <= 100 && isCount((c as { at?: unknown }).at))) return null;
  if (!(x.lastAgreeAt === null || isCount(x.lastAgreeAt))) return null;
  const d = x.decision as CountDecision | null;
  if (!(d === null || (!!d && typeof d === 'object' && isCount(d.at) && typeof d.reason === 'string' && d.reason.length <= 500 && typeof d.sevenDayException === 'boolean'
    && (d.by === null || (typeof d.by === 'string' && d.by.length <= 200)) && isCount(d.periodStartedAt) && isProgress(d.evidence)))) return null;
  // `counting` without a decision is not a state this code ever writes.
  if (x.state === 'counting' && d === null) return null;
  if (!Array.isArray(x.lapses) || x.lapses.length > PRACTICE_LIMITS.lapsesKept
    || !x.lapses.every((p) => !!p && isCount((p as { at?: unknown }).at) && (LAPSE_REASONS as readonly unknown[]).includes((p as { reason?: unknown }).reason) && typeof (p as { fault?: unknown }).fault === 'boolean')) return null;
  const last = x.last as LaneShare | null;
  if (!(last === null || (!!last && typeof last === 'object' && typeof last.verifyId === 'string' && last.verifyId.length <= 100 && isCount(last.at)
    && (last.assigned === 'counting' || last.assigned === 'compare-only') && isCount(last.sent) && isCount(last.finished)))) return null;
  return clone({
    state: x.state, suspendedFrom: x.suspendedFrom, identity: id, practiceStartedAt: x.practiceStartedAt, coverage: cov, spread: sp,
    failing: x.failing, environmentDifferences: x.environmentDifferences, checks: x.checks, comparisons: x.comparisons, wrongPassAt: x.wrongPassAt,
    answers: x.answers, wrongPassChanges: x.wrongPassChanges, lastAgreeAt: x.lastAgreeAt, decision: d, lapses: x.lapses, last,
  } as LaneRecord);
}
