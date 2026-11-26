/**
 * Tier-1: the practice record's rules (docs/specs/local-verify-borrowed-slices-count.md, F): each of
 * the four evidence items on both sides of its bound, the one admission rule and its 7-day
 * exception on day 6 and day 7, every lapse event, the suspension transitions (with a restart in
 * between), the reset keys after a lapse, and the spot re-run rate.
 */
import { describe, expect, it } from 'vitest';
import {
  PRACTICE_LIMITS, admission, applyVerifyOutcome, checkSliceComplete, coverageComplete, evidenceProgress, failingDirectionComplete, freshLane,
  isFaultLapse, lapse, mayCount, noteIdentity, noteSpotVerify, noteTime, parseLane, recordDecision, recordDryRun, spotRateOneIn, spreadComplete,
  wrongPassWindowClear, type LaneRecord, type LaneVerifyOutcome,
} from '../../../src/localVerify/borrowedPractice.js';

const DAY = 24 * 60 * 60_000;
const T0 = Date.parse('2026-11-19T08:00:00.000Z');
const DIGEST = 'a'.repeat(64);
const file = (n: number) => `tests/integration/f${n}.test.ts`;

function outcome(over: Partial<LaneVerifyOutcome> = {}): LaneVerifyOutcome {
  return {
    verifyId: 'v1', kind: 'waiting', change: '3501', compareOnly: false, assigned: 'counting', sent: 10, finished: 10,
    agreed: [], digestDiffersBothPass: [], helperFailedLocalPassed: [], confirmedWrongPasses: [], failingAgreed: [], environmentDifferences: 0,
    check: null, answers: ['valid'], ...over,
  };
}

/** A lane with every item complete: 2 files covered, 5 verifies (3 waiting), 5 failing comparisons from 3 files and 2 verifies, a right check slice. */
function complete(now = T0): LaneRecord {
  let l = recordDryRun(freshLane(now), { eligible: [file(1), file(2)], compared: [file(1)], eligibleDigest: DIGEST }, now);
  const steps: Array<Partial<LaneVerifyOutcome>> = [
    { verifyId: 'v1', kind: 'waiting', agreed: [file(1), file(2)], failingAgreed: [file(7), file(8), file(9)], check: 'right' },
    { verifyId: 'v2', kind: 'waiting', agreed: [file(1)], failingAgreed: [file(7), file(8)], check: 'right' },
    { verifyId: 'v3', kind: 'waiting', agreed: [file(1)], check: 'right' },
    { verifyId: 'v4', kind: 'main', change: null, compareOnly: true, assigned: 'compare-only', agreed: [file(1)], check: 'right' },
    { verifyId: 'v5', kind: 'main', change: null, compareOnly: true, assigned: 'compare-only', agreed: [file(2)], check: 'right' },
  ];
  for (const s of steps) l = applyVerifyOutcome(l, outcome(s), now).lane;
  return l;
}

const counting = (now = T0): LaneRecord => {
  const r = recordDecision(complete(now), { reason: 'practice report reviewed', sevenDayException: false, by: 'echo-increasing-throughput' }, now);
  if (!r.ok) throw new Error(`not admitted: ${r.code} ${r.admission.missing.join(',')}`);
  return r.lane;
};

describe('the four evidence items, each on both sides of its bound', () => {
  it('1. coverage: needs a dry run, and every file eligible then compared at least once (the dry run\'s comparisons count)', () => {
    const none = freshLane(T0);
    expect(coverageComplete(evidenceProgress(none))).toBe(false); // no dry run at all
    const one = recordDryRun(none, { eligible: [file(1), file(2)], compared: [file(1)], eligibleDigest: DIGEST }, T0);
    expect(evidenceProgress(one).coverage).toEqual({ dryRunDone: true, eligible: 2, uncovered: 1 });
    expect(coverageComplete(evidenceProgress(one))).toBe(false);
    // A comparison of any kind on the same tree covers a file; a file not eligible at the dry run changes nothing.
    const other = applyVerifyOutcome(one, outcome({ agreed: [file(3)] }), T0).lane;
    expect(coverageComplete(evidenceProgress(other))).toBe(false);
    const both = applyVerifyOutcome(one, outcome({ helperFailedLocalPassed: [file(2)] }), T0).lane;
    expect(coverageComplete(evidenceProgress(both))).toBe(true);
    // The dry run alone can complete it.
    expect(coverageComplete(evidenceProgress(recordDryRun(none, { eligible: [file(1)], compared: [file(1)], eligibleDigest: DIGEST }, T0)))).toBe(true);
  });

  it('2. spread: 5 separate verifies, at least 3 of waiting changes', () => {
    const run = (kinds: Array<'main' | 'waiting'>) => kinds.reduce((l, k, i) => applyVerifyOutcome(l, outcome({ verifyId: `s${i}`, kind: k, agreed: [file(1)] }), T0).lane, freshLane(T0));
    expect(spreadComplete(evidenceProgress(run(['waiting', 'waiting', 'waiting', 'main'])))).toBe(false); // 4 verifies
    expect(spreadComplete(evidenceProgress(run(['waiting', 'waiting', 'main', 'main', 'main'])))).toBe(false); // 5, only 2 waiting
    expect(spreadComplete(evidenceProgress(run(['waiting', 'waiting', 'waiting', 'main', 'main'])))).toBe(true);
    // A verify with no comparison (the helper finished nothing, or only refusals) is not one of the five.
    const l = applyVerifyOutcome(run(['waiting', 'waiting', 'waiting', 'main']), outcome({ verifyId: 'x', finished: 0, sent: 5 }), T0).lane;
    expect(evidenceProgress(l).spread.verifies).toBe(4);
  });

  it('3. the failing direction: 5 comparisons from at least 3 files and 2 verifies; one comparison is one file in one verify', () => {
    const p = (entries: Array<[string, string]>) => {
      let l = freshLane(T0);
      const byVerify = new Map<string, string[]>();
      for (const [f, v] of entries) byVerify.set(v, [...(byVerify.get(v) ?? []), f]);
      for (const [v, fs] of byVerify) l = applyVerifyOutcome(l, outcome({ verifyId: v, agreed: [file(1)], failingAgreed: fs }), T0).lane;
      return evidenceProgress(l);
    };
    expect(failingDirectionComplete(p([[file(1), 'a'], [file(2), 'a'], [file(3), 'a'], [file(1), 'b']]), false)).toBe(false); // 4 comparisons
    expect(failingDirectionComplete(p([[file(1), 'a'], [file(2), 'a'], [file(1), 'b'], [file(2), 'b'], [file(1), 'c']]), false)).toBe(false); // 2 files
    expect(failingDirectionComplete(p([[file(1), 'a'], [file(2), 'a'], [file(3), 'a'], [file(4), 'a'], [file(5), 'a']]), false)).toBe(false); // 1 verify
    expect(failingDirectionComplete(p([[file(1), 'a'], [file(2), 'a'], [file(3), 'a'], [file(1), 'b'], [file(2), 'b']]), false)).toBe(true);
    // The same file listed twice in one verify is one comparison.
    expect(p([[file(1), 'a'], [file(1), 'a']]).failing.comparisons).toBe(1);
    // An environment difference is recorded separately and never counts.
    const env = evidenceProgress(applyVerifyOutcome(freshLane(T0), outcome({ agreed: [file(1)], environmentDifferences: 3 }), T0).lane);
    expect(env.failing).toMatchObject({ comparisons: 0, environmentDifferences: 3 });
  });

  it('3. the check slice: right in each of the last 20 verifies that carried one', () => {
    const checks = (list: Array<'right' | 'wrong' | null>) => evidenceProgress(list.reduce((l, c, i) => applyVerifyOutcome(l, outcome({ verifyId: `c${i}`, agreed: [file(1)], check: c }), T0).lane, freshLane(T0)));
    expect(checkSliceComplete(checks([null, null]))).toBe(false); // none carried one
    expect(checkSliceComplete(checks(['right', null, 'right']))).toBe(true);
    expect(checkSliceComplete(checks(['right', 'wrong', 'right']))).toBe(false);
    // A wrong one falls out of the window after 20 right ones.
    expect(checkSliceComplete(checks(['wrong', ...Array<'right'>(19).fill('right')]))).toBe(false);
    expect(checkSliceComplete(checks(['wrong', ...Array<'right'>(20).fill('right')]))).toBe(true);
  });

  it('4. no confirmed wrong pass in the last 500 comparisons', () => {
    let l = applyVerifyOutcome(freshLane(T0), outcome({ verifyId: 'w', confirmedWrongPasses: [file(9)] }), T0).lane;
    expect(wrongPassWindowClear(evidenceProgress(l))).toBe(false);
    const many = (n: number, id: string) => outcome({ verifyId: id, agreed: Array.from({ length: n }, (_, i) => file(1000 + i)) });
    l = applyVerifyOutcome(l, many(PRACTICE_LIMITS.wrongPassWindow - 1, 'm1'), T0).lane;
    expect(evidenceProgress(l).wrongPass).toEqual({ comparisons: 500, inWindow: 1 }); // the wrong pass is still the 500th from the end
    l = applyVerifyOutcome(l, many(1, 'm2'), T0).lane;
    expect(wrongPassWindowClear(evidenceProgress(l))).toBe(true);
  });

  it('a verify in which the helper finished nothing is not counted and resets nothing', () => {
    const before = complete();
    const after = applyVerifyOutcome(before, outcome({ verifyId: 'idle', sent: 40, finished: 0, agreed: [file(1)], confirmedWrongPasses: [file(2)], check: 'wrong' }), T0 + 1000);
    expect(after.events).toEqual([]);
    expect(evidenceProgress(after.lane)).toEqual(evidenceProgress(before));
    expect(after.lane.last).toMatchObject({ verifyId: 'idle', sent: 40, finished: 0 });
  });
});

describe('the one admission rule', () => {
  it('admits on all four items, and names each missing item', () => {
    const p = evidenceProgress(complete());
    expect(admission(p, { sevenDayException: false }, T0, T0)).toEqual({ admitted: true, missing: [], usedException: false, exceptionTooEarly: false });
    expect(admission(evidenceProgress(freshLane(T0)), { sevenDayException: false }, T0, T0).missing).toEqual(['coverage', 'spread', 'failing-direction', 'check-slice']);
  });

  /** Every item complete except the failing direction, which has 3 comparisons from 2 files and 2 verifies. */
  function threeFailing(): LaneRecord {
    let l = recordDryRun(freshLane(T0), { eligible: [file(1)], compared: [file(1)], eligibleDigest: DIGEST }, T0);
    const steps: Array<Partial<LaneVerifyOutcome>> = [
      { verifyId: 'v1', agreed: [file(1)], failingAgreed: [file(7), file(8)], check: 'right' },
      { verifyId: 'v2', agreed: [file(1)], failingAgreed: [file(7)], check: 'right' },
      { verifyId: 'v3', agreed: [file(1)] }, { verifyId: 'v4', agreed: [file(1)] }, { verifyId: 'v5', agreed: [file(1)] },
    ];
    for (const s of steps) l = applyVerifyOutcome(l, outcome(s), T0).lane;
    return l;
  }

  it('the 7-day exception is refused on day 6 and admitted on day 7, with 3 failing comparisons from 2 files and 2 verifies', () => {
    const l = threeFailing();
    const p = evidenceProgress(l);
    expect(p.failing).toMatchObject({ comparisons: 3, files: 2, verifies: 2 });
    // Without the exception: never.
    expect(admission(p, { sevenDayException: false }, T0, T0 + 30 * DAY).missing).toEqual(['failing-direction']);
    // Day 6 (one millisecond short of 7 days): refused, and said to be too early.
    const day6 = admission(p, { sevenDayException: true }, T0, T0 + 7 * DAY - 1);
    expect(day6).toMatchObject({ admitted: false, missing: ['failing-direction'], exceptionTooEarly: true });
    // Day 7: admitted, by the exception.
    expect(admission(p, { sevenDayException: true }, T0, T0 + 7 * DAY)).toEqual({ admitted: true, missing: [], usedException: true, exceptionTooEarly: false });
    // The route's refusal codes follow.
    expect(recordDecision(l, { reason: 'r', sevenDayException: true, by: null }, T0 + 6 * DAY)).toMatchObject({ ok: false, code: 'exception-too-early' });
    const ok = recordDecision(l, { reason: 'r', sevenDayException: true, by: null }, T0 + 7 * DAY);
    expect(ok).toMatchObject({ ok: true, admission: { usedException: true } });
  });

  it('the exception lowers only the failing-direction number: 2 comparisons, 1 file or 1 verify still refuse, and nothing else is relaxed', () => {
    const at = T0 + 8 * DAY;
    const base = evidenceProgress(threeFailing());
    const ex = { sevenDayException: true };
    expect(admission({ ...base, failing: { ...base.failing, comparisons: 2 } }, ex, T0, at).missing).toEqual(['failing-direction']);
    expect(admission({ ...base, failing: { ...base.failing, files: 1 } }, ex, T0, at).missing).toEqual(['failing-direction']);
    expect(admission({ ...base, failing: { ...base.failing, verifies: 1 } }, ex, T0, at).missing).toEqual(['failing-direction']);
    expect(admission({ ...base, coverage: { ...base.coverage, uncovered: 1 } }, ex, T0, at).missing).toEqual(['coverage']);
    expect(admission({ ...base, spread: { verifies: 5, waiting: 2 } }, ex, T0, at).missing).toEqual(['spread']);
    expect(admission({ ...base, failing: { ...base.failing, checksRight: base.failing.checksSeen - 1 } }, ex, T0, at).missing).toEqual(['check-slice']);
    expect(admission({ ...base, wrongPass: { comparisons: 10, inWindow: 1 } }, ex, T0, at).missing).toEqual(['wrong-pass-window']);
    // A complete lane that asks for the exception did not need it.
    expect(admission(evidenceProgress(complete()), ex, T0, at).usedException).toBe(false);
  });

  it('a decision is refused on incomplete evidence, while suspended, and when already counting', () => {
    expect(recordDecision(freshLane(T0), { reason: 'r', sevenDayException: false, by: null }, T0)).toMatchObject({ ok: false, code: 'evidence-incomplete' });
    const c = counting();
    expect(recordDecision(c, { reason: 'again', sevenDayException: false, by: null }, T0)).toMatchObject({ ok: false, code: 'already-counting' });
    const s = applyVerifyOutcome(complete(), outcome({ verifyId: 'mass', helperFailedLocalPassed: [1, 2, 3, 4, 5, 6].map(file) }), T0).lane;
    expect(recordDecision(s, { reason: 'r', sevenDayException: false, by: null }, T0)).toMatchObject({ ok: false, code: 'suspended' });
  });

  it('mayCount: the mode alone admits nothing; it needs counting, a decision of the current period, and the rule holding on the decision\'s evidence', () => {
    const c = counting();
    expect(mayCount(c, 'count')).toBe(true);
    expect(mayCount(c, 'practice')).toBe(false);
    expect(mayCount(c, 'off')).toBe(false);
    expect(mayCount(complete(), 'count')).toBe(false); // complete evidence, no recorded decision
    expect(mayCount(null, 'count')).toBe(false);
    // A decision from another practice period admits nothing.
    expect(mayCount({ ...c, practiceStartedAt: c.practiceStartedAt + 1 }, 'count')).toBe(false);
    // A decision whose recorded evidence does not satisfy the rule behaves as practice.
    const thin = { ...c, decision: { ...c.decision!, evidence: { ...c.decision!.evidence, spread: { verifies: 4, waiting: 4 } } } };
    expect(mayCount(thin, 'count')).toBe(false);
    // After the decision the items are not re-evaluated: a later wrong check slice ends nothing by itself.
    const later = applyVerifyOutcome(c, outcome({ verifyId: 'late', agreed: [file(1)], check: 'wrong' }), T0 + 1000).lane;
    expect(later.state).toBe('counting');
    expect(mayCount(later, 'count')).toBe(true);
  });
});

describe('lapse events (counting lapses, back to practice)', () => {
  it('a confirmed wrong pass on a compare-only verify, five files or fewer, lapses (a fault)', () => {
    const t = applyVerifyOutcome(counting(), outcome({ verifyId: 'cmp', compareOnly: true, assigned: 'compare-only', agreed: [file(1)], confirmedWrongPasses: [file(2)] }), T0 + 1000);
    expect(t.lane.state).toBe('lapsed: wrong-pass-compare-only');
    expect(t.events).toEqual([{ kind: 'wrong-pass', file: file(2), verifyId: 'cmp', change: '3501' }, { kind: 'lapse', reason: 'wrong-pass-compare-only', fault: true }]);
    expect(mayCount(t.lane, 'count')).toBe(false);
    // The same wrong pass while still practising is recorded in the window and lapses nothing.
    const p = applyVerifyOutcome(complete(), outcome({ verifyId: 'cmp', compareOnly: true, confirmedWrongPasses: [file(2)] }), T0 + 1000);
    expect(p.lane.state).toBe('practice');
    expect(p.events.map((e) => e.kind)).toEqual(['wrong-pass']);
    expect(wrongPassWindowClear(evidenceProgress(p.lane))).toBe(false);
  });

  it('confirmed wrong passes on two different changes within 24 hours lapse; the same change twice, or 24 hours apart, does not', () => {
    const wp = (l: LaneRecord, change: string, at: number, id: string) => applyVerifyOutcome(l, outcome({ verifyId: id, change, confirmedWrongPasses: [file(2)] }), at);
    const first = wp(counting(), '3501', T0 + 1000, 'a');
    expect(first.lane.state).toBe('counting'); // one counted verify with a wrong pass: the verify fails locally, counting goes on
    expect(wp(first.lane, '3501', T0 + 2000, 'b').lane.state).toBe('counting'); // the same change again
    expect(wp(first.lane, '3502', T0 + 1000 + DAY + 1, 'c').lane.state).toBe('counting'); // a second change, more than 24 h later
    const second = wp(first.lane, '3502', T0 + 1000 + DAY, 'd');
    expect(second.lane.state).toBe('lapsed: wrong-pass-two-changes');
    expect(second.events.at(-1)).toEqual({ kind: 'lapse', reason: 'wrong-pass-two-changes', fault: true });
  });

  it('three invalid answers in a row lapse; two do not; 5 of the last 20 lapse even when alternating; a content discard is not an invalid answer', () => {
    const ans = (l: LaneRecord, answers: Array<'valid' | 'invalid'>, id: string) => applyVerifyOutcome(l, outcome({ verifyId: id, answers, agreed: [file(1)] }), T0 + 1000);
    expect(ans(counting(), ['invalid', 'invalid'], 'a').lane.state).toBe('counting');
    const three = ans(counting(), ['invalid', 'invalid', 'invalid'], 'b');
    expect(three.lane.state).toBe('lapsed: invalid-answers');
    expect(three.events).toEqual([{ kind: 'lapse', reason: 'invalid-answers', fault: true }]);
    // Alternating good and bad: the 5th invalid answer within 20 lapses, the 4th does not.
    const alt = (n: number) => Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? 'valid' : 'invalid') as 'valid' | 'invalid');
    expect(ans(counting(), alt(4), 'c').lane.state).toBe('counting');
    expect(ans(counting(), alt(5), 'd').lane.state).toBe('lapsed: invalid-answers');
    // Across verifies too, and with nothing finished.
    let l = counting();
    for (let i = 0; i < 2; i++) l = applyVerifyOutcome(l, outcome({ verifyId: `i${i}`, answers: ['invalid'], finished: 0 }), T0 + 1000).lane;
    expect(l.state).toBe('counting');
    expect(applyVerifyOutcome(l, outcome({ verifyId: 'i2', answers: ['invalid'], finished: 0 }), T0 + 1000).lane.state).toBe('lapsed: invalid-answers');
    // A slice discarded for its content is reported as a valid answer by the caller: any number of them lapses nothing.
    expect(ans(counting(), Array<'valid'>(30).fill('valid'), 'e').lane.state).toBe('counting');
    // In practice the history is kept but nothing lapses.
    expect(ans(complete(), ['invalid', 'invalid', 'invalid'], 'f').lane.state).toBe('practice');
  });

  it('a changed image lapses and drops coverage; a changed runner version lapses and keeps it; the same identity changes nothing', () => {
    const id = { image: 'sha256:img1:set1', runnerVersion: 'hr1:one' };
    const seen = noteIdentity(counting(), id, T0);
    expect(seen.events).toEqual([]); // the first identity is only recorded
    expect(noteIdentity(seen.lane, { ...id }, T0 + 5).lane).toBe(seen.lane);
    const img = noteIdentity(seen.lane, { ...id, image: 'sha256:img2:set1' }, T0 + 1000);
    expect(img.lane).toMatchObject({ state: 'lapsed: image-changed', coverage: null, decision: null, practiceStartedAt: T0 + 1000 });
    expect(img.events).toEqual([{ kind: 'lapse', reason: 'image-changed', fault: false }]);
    const ver = noteIdentity(seen.lane, { ...id, runnerVersion: 'hr1:two' }, T0 + 1000);
    expect(ver.lane.state).toBe('lapsed: runner-version-changed');
    expect(ver.lane.coverage).toEqual(seen.lane.coverage);
    expect(ver.lane.identity).toEqual({ ...id, runnerVersion: 'hr1:two' });
    // While still practising the evidence starts again the same way, with no lapse entry.
    const practising = noteIdentity(noteIdentity(complete(), id, T0).lane, { ...id, runnerVersion: 'hr1:two' }, T0 + 1000);
    expect(practising.lane.state).toBe('practice');
    expect(practising.lane.lapses).toEqual([]);
    expect(practising.events).toEqual([{ kind: 'identity-reset', reason: 'runner-version-changed' }]);
    expect(evidenceProgress(practising.lane)).toMatchObject({ spread: { verifies: 0, waiting: 0 }, failing: { comparisons: 0, checksSeen: 0 }, coverage: { dryRunDone: true } });
  });

  it('no agreeing comparison for 7 days lapses; one millisecond less does not; an agreeing comparison restarts the clock', () => {
    const c = counting(T0);
    expect(noteTime(c, T0 + 7 * DAY - 1).lane.state).toBe('counting');
    const stale = noteTime(c, T0 + 7 * DAY);
    expect(stale.lane.state).toBe('lapsed: no-agreeing-comparison');
    expect(stale.events).toEqual([{ kind: 'lapse', reason: 'no-agreeing-comparison', fault: false }]);
    const fresh = applyVerifyOutcome(c, outcome({ verifyId: 'agree', agreed: [file(1)] }), T0 + 6 * DAY).lane;
    expect(noteTime(fresh, T0 + 12 * DAY).lane.state).toBe('counting');
    expect(noteTime(fresh, T0 + 13 * DAY).lane.state).toBe('lapsed: no-agreeing-comparison');
    // A lane in practice has nothing to lapse.
    expect(noteTime(complete(T0), T0 + 30 * DAY).events).toEqual([]);
  });

  it('after a lapse items 2, 3 and 4 start again and coverage is kept; the first three reasons are faults, the last two ordinary', () => {
    const before = counting();
    const l = lapse(before, 'invalid-answers', T0 + 5000).lane;
    expect(evidenceProgress(l)).toEqual({
      coverage: evidenceProgress(before).coverage,
      spread: { verifies: 0, waiting: 0 },
      failing: { comparisons: 0, files: 0, verifies: 0, checksSeen: 0, checksRight: 0, environmentDifferences: 0 },
      wrongPass: { comparisons: 0, inWindow: 0 },
    });
    expect(l).toMatchObject({ decision: null, practiceStartedAt: T0 + 5000, lapses: [{ at: T0 + 5000, reason: 'invalid-answers', fault: true }] });
    // Counting again needs the evidence again AND a new decision.
    expect(recordDecision(l, { reason: 'r', sevenDayException: false, by: null }, T0 + 6000)).toMatchObject({ ok: false, code: 'evidence-incomplete' });
    expect(['wrong-pass-compare-only', 'wrong-pass-two-changes', 'invalid-answers', 'suspension-followup'].map((r) => isFaultLapse(r as never))).toEqual([true, true, true, true]);
    expect(['image-changed', 'runner-version-changed', 'no-agreeing-comparison'].map((r) => isFaultLapse(r as never))).toEqual([false, false, false]);
    expect(lapse(before, 'image-changed', T0).lane.coverage).toBeNull();
  });
});

describe('more than five disagreements in one verify: suspension', () => {
  const mass = (n: number, over: Partial<LaneVerifyOutcome> = {}) => outcome({ verifyId: `mass${n}`, helperFailedLocalPassed: Array.from({ length: n }, (_, i) => file(50 + i)), ...over });

  it('five disagreements do not suspend; six do, at once, and the verify gives no evidence', () => {
    const five = applyVerifyOutcome(counting(), mass(5), T0 + 1000);
    expect(five.lane.state).toBe('counting');
    expect(five.disagreed).toBe(true);
    const before = counting();
    const six = applyVerifyOutcome(before, mass(6, { agreed: [file(1)], check: 'wrong' }), T0 + 1000);
    expect(six.lane).toMatchObject({ state: 'suspended', suspendedFrom: 'counting' });
    expect(six.events).toEqual([{ kind: 'suspended', disagreements: 6 }]);
    expect(evidenceProgress(six.lane)).toEqual(evidenceProgress(before));
    expect(mayCount(six.lane, 'count')).toBe(false); // nothing from it counts on any later verify
    expect(six.lane.decision).not.toBeNull(); // the practice period and its decision are kept
  });

  it('takes precedence over the single-event lapse: six disagreements that include wrong passes on a compare-only verify suspend, not lapse', () => {
    const t = applyVerifyOutcome(counting(), outcome({ verifyId: 'm', compareOnly: true, confirmedWrongPasses: [1, 2, 3, 4, 5, 6].map(file) }), T0 + 1000);
    expect(t.lane.state).toBe('suspended');
    expect(t.events.map((e) => e.kind)).toEqual(['suspended']);
  });

  it('the next compare-only verify that agrees (or shows only digest differences) resumes counting with the evidence it had, across a restart', () => {
    const suspended = applyVerifyOutcome(counting(), mass(6), T0 + 1000).lane;
    // A restart in between: the state is read back from the file.
    const restored = parseLane(JSON.parse(JSON.stringify(suspended)));
    expect(restored).toEqual(suspended);
    // A verify that is not compare-only leaves it suspended.
    const still = applyVerifyOutcome(restored!, outcome({ verifyId: 'counted', agreed: [file(1)] }), T0 + 2000);
    expect(still.lane.state).toBe('suspended');
    const resumed = applyVerifyOutcome(still.lane, outcome({ verifyId: 'follow', kind: 'main', change: null, compareOnly: true, assigned: 'compare-only', agreed: [file(1)], digestDiffersBothPass: [file(3)] }), T0 + 3000);
    expect(resumed.lane).toMatchObject({ state: 'counting', suspendedFrom: null });
    expect(resumed.events).toEqual([{ kind: 'resumed' }]);
    expect(mayCount(resumed.lane, 'count')).toBe(true);
    expect(resumed.lane.decision).toEqual(suspended.decision);
  });

  it('the follow-up lapses on any confirmed wrong pass, and on a mass disagreement again', () => {
    const suspended = parseLane(JSON.parse(JSON.stringify(applyVerifyOutcome(counting(), mass(6), T0 + 1000).lane)))!;
    const wrong = applyVerifyOutcome(suspended, outcome({ verifyId: 'f1', compareOnly: true, confirmedWrongPasses: [file(2)] }), T0 + 2000);
    expect(wrong.lane.state).toBe('lapsed: suspension-followup');
    expect(wrong.events.map((e) => e.kind)).toEqual(['wrong-pass', 'lapse']);
    const again = applyVerifyOutcome(suspended, mass(7, { compareOnly: true }), T0 + 2000);
    expect(again.lane.state).toBe('lapsed: suspension-followup');
    expect(again.events).toEqual([{ kind: 'lapse', reason: 'suspension-followup', fault: true }]);
  });

  it('a practising lane is suspended and resumed the same way, back to practice', () => {
    const s = applyVerifyOutcome(complete(), mass(6), T0 + 1000).lane;
    expect(s).toMatchObject({ state: 'suspended', suspendedFrom: 'practice' });
    expect(applyVerifyOutcome(s, outcome({ verifyId: 'f', compareOnly: true, agreed: [file(1)] }), T0 + 2000).lane.state).toBe('practice');
  });
});

describe('the spot re-run rate', () => {
  it('is 1 in 20, 1 in 5 for the next 50 verifies after any disagreement, then 1 in 20 again', () => {
    let s = { raisedVerifiesLeft: 0 };
    expect(spotRateOneIn(s)).toBe(20);
    s = noteSpotVerify(s, false);
    expect(spotRateOneIn(s)).toBe(20);
    s = noteSpotVerify(s, true);
    expect(s).toEqual({ raisedVerifiesLeft: 50 });
    for (let i = 0; i < 49; i++) { expect(spotRateOneIn(s)).toBe(5); s = noteSpotVerify(s, false); }
    expect(spotRateOneIn(s)).toBe(5); // the 50th verify
    s = noteSpotVerify(s, false);
    expect(spotRateOneIn(s)).toBe(20);
    // A disagreement during the raised period starts the 50 again.
    expect(noteSpotVerify({ raisedVerifiesLeft: 3 }, true)).toEqual({ raisedVerifiesLeft: 50 });
  });
});

describe('reading a stored lane', () => {
  it('round-trips every state, and any malformed field makes the whole lane unreadable', () => {
    for (const l of [freshLane(T0), complete(), counting(), lapse(counting(), 'image-changed', T0).lane]) {
      expect(parseLane(JSON.parse(JSON.stringify(l)))).toEqual(l);
    }
    const c = JSON.parse(JSON.stringify(counting())) as Record<string, unknown>;
    expect(parseLane({ ...c, state: 'trusted' })).toBeNull();
    expect(parseLane({ ...c, decision: null })).toBeNull(); // counting without a decision
    expect(parseLane({ ...c, checks: ['yes'] })).toBeNull();
    expect(parseLane({ ...c, spread: { verifies: 1, waiting: 2 } })).toBeNull();
    expect(parseLane({ ...c, suspendedFrom: 'counting' })).toBeNull(); // not suspended
    expect(parseLane({ ...c, state: 'lapsed: because' })).toBeNull();
    expect(parseLane(null)).toBeNull();
    expect(parseLane([])).toBeNull();
  });
});
