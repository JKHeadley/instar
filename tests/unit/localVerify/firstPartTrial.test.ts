// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The trial of first parts (spec docs/specs/local-verify-likely-failing-first.md, section E
 * `alternate`, measures 5 and 6): the assignment of pull requests, the comparison of a verify
 * with its comparison run, the counts that bound the comparisons, and minutes per change.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { FIRST_PART_LIMITS, type FirstPartSummary } from '../../../src/localVerify/firstPart.js';
import {
  COMPARE_KINDS, FirstPartGroups, FirstPartTrialState, compareFirstPartRuns, compareKind, mayStartCompare, minutesPerChange,
  type ChangeVerify, type TrialCounts,
} from '../../../src/localVerify/firstPartTrial.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'firstPartTrial.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-trial-'))); dirs.push(d); return d; };

describe('the assignment of pull requests', () => {
  it('is drawn once at random and kept: every later ask gives the same group, also after a restart', () => {
    const file = path.join(tmp(), 'state', 'first-part-groups.json');
    const audit: Array<Record<string, unknown>> = [];
    const draws = [0.1, 0.9, 0.1, 0.9];
    const g = new FirstPartGroups(file, () => 1000, (e) => { audit.push(e); }, () => draws.shift()!);
    expect(g.get(7)).toBeNull();
    expect(g.assign(7)).toBe('with');
    expect(g.assign(8)).toBe('without');
    // Asked again (a retry, a moved head, a hand-off to the peer): no new draw.
    expect(g.assign(7)).toBe('with');
    expect(g.assign(8)).toBe('without');
    expect(draws).toHaveLength(2);
    expect(audit.filter((e) => e.event === 'first-part-assigned')).toEqual([
      { event: 'first-part-assigned', pr: 7, group: 'with' }, { event: 'first-part-assigned', pr: 8, group: 'without' },
    ]);
    // A new process reads the file: the opposite draw would be made now, and is not.
    const again = new FirstPartGroups(file, () => 2000, () => {}, () => 0.9);
    expect(again.get(7)).toBe('with');
    expect(again.assign(7)).toBe('with');
    expect(again.assign(8)).toBe('without');
  });

  it('about half of the pull requests fall in each group', () => {
    const g = new FirstPartGroups(path.join(tmp(), 'g.json'), () => 1, () => {});
    let withs = 0;
    for (let pr = 1; pr <= 400; pr++) if (g.assign(pr) === 'with') withs++;
    expect(withs).toBeGreaterThan(140);
    expect(withs).toBeLessThan(260);
  });

  it('an unreadable file starts empty and says so once', () => {
    const file = path.join(tmp(), 'g.json');
    fs.writeFileSync(file, 'not json');
    const audit: Array<Record<string, unknown>> = [];
    const g = new FirstPartGroups(file, () => 1, (e) => { audit.push(e); }, () => 0.1);
    expect(g.get(1)).toBeNull();
    expect(g.assign(1)).toBe('with');
    expect(audit.filter((e) => e.event === 'first-part-groups-unreadable')).toHaveLength(1);
  });

  it('remembers the newest 5000 pull requests', () => {
    let t = 0;
    const g = new FirstPartGroups(path.join(tmp(), 'g.json'), () => ++t, () => {}, () => 0.1);
    // Seed the file directly at the cap, then add one: the oldest goes.
    const file = g.file;
    const prs: Record<string, { group: string; at: number }> = {};
    for (let pr = 1; pr <= FIRST_PART_LIMITS.groupsKept; pr++) prs[String(pr)] = { group: 'without', at: pr };
    fs.writeFileSync(file, JSON.stringify({ v: 1, prs }));
    t = FIRST_PART_LIMITS.groupsKept + 10;
    expect(g.assign(999_999)).toBe('with');
    expect(g.get(1)).toBeNull();
    expect(g.get(2)).toBe('without');
    expect(g.get(999_999)).toBe('with');
  });
});

describe('which kind a verify is', () => {
  const s = (over: Partial<FirstPartSummary> = {}): FirstPartSummary => ({
    setting: 'alternate', group: 'with', active: true, endedInFirstPart: false,
    lanes: [{ lane: 'unit', files: 3, fromChange: 1, fromPrevious: 0, fromList: 2, partners: 0, ms: 4000, endedHere: false }], ...over,
  });
  it('ended in a first part, failed later, or passed', () => {
    expect(compareKind('failure', s({ endedInFirstPart: true }))).toBe('ended-first');
    expect(compareKind('failure', s())).toBe('failed-later');
    expect(compareKind('success', s())).toBe('passed');
  });
  it('is none of them for an error, for a verify without first parts, and when no first part ran', () => {
    expect(compareKind('error', s())).toBeNull();
    expect(compareKind('success', undefined)).toBeNull();
    expect(compareKind('success', s({ active: false }))).toBeNull();
    expect(compareKind('success', s({ lanes: [] }))).toBeNull();
    expect(compareKind('success', s({ lanes: [{ lane: 'unit', files: 0, fromChange: 0, fromPrevious: 0, fromList: 0, partners: 0, ms: null, endedHere: false }] }))).toBeNull();
    // A first part was planned but a set-up failure came first: nothing ran.
    expect(compareKind('failure', s({ lanes: [{ lane: 'unit', files: 3, fromChange: 3, fromPrevious: 0, fromList: 0, partners: 0, ms: null, endedHere: false }] }))).toBeNull();
  });
});

describe('compareFirstPartRuns', () => {
  const A = 'tests/unit/a.test.ts';
  const B = 'tests/unit/b.test.ts';
  const C = 'tests/e2e/c.test.ts';
  const none = new Set<string>();

  it('the same verdict and the same outcome for every file that ran in both: no difference', () => {
    const c = compareFirstPartRuns({ outcome: 'success', files: { [A]: 'passed', [B]: 'passed' } }, { outcome: 'success', files: { [A]: 'passed', [B]: 'passed' } }, none);
    expect(c).toMatchObject({ verdictDiffers: false, ranInBoth: 2, bothPassed: 2, differing: [], difference: false, inconclusive: false });
  });

  it('a file that passed in one run and failed in the other is a difference', () => {
    const c = compareFirstPartRuns({ outcome: 'failure', files: { [A]: 'passed', [B]: 'failed' } }, { outcome: 'success', files: { [A]: 'passed', [B]: 'passed' } }, none);
    expect(c.difference).toBe(true);
    expect(c.verdictDiffers).toBe(true);
    expect(c.differing).toEqual([{ file: B, first: 'failed', compare: 'passed', known: false }]);
  });

  it('a change with one fault in each part: the full run sees both, the first run stopped after one. Not a difference', () => {
    // With first parts: A failed in the first part, the verify ended there, B and C never ran.
    // The comparison ran everything: A and B both fail.
    const c = compareFirstPartRuns({ outcome: 'failure', files: { [A]: 'failed' } }, { outcome: 'failure', files: { [A]: 'failed', [B]: 'failed', [C]: 'passed' } }, none);
    expect(c.difference).toBe(false);
    expect(c.verdictDiffers).toBe(false);
    expect(c.bothFailed).toEqual([A]);
    expect(c.onlyCompareReached).toEqual([B]);
    expect(c.onlyFirstReached).toEqual([]);
    expect(c.ranInBoth).toBe(1);
  });

  it('a failure only the first run reached (the comparison was stopped by its own fail-fast first) is listed separately', () => {
    const c = compareFirstPartRuns({ outcome: 'failure', files: { [A]: 'failed', [B]: 'failed' } }, { outcome: 'failure', files: { [A]: 'failed' } }, none);
    expect(c.onlyFirstReached).toEqual([B]);
    expect(c.difference).toBe(false);
  });

  it('a difference on a file already known to be unreliable is recorded and does not count', () => {
    const first = { outcome: 'success' as const, files: { [A]: 'passed' as const, [B]: 'passed' as const } };
    const second = { outcome: 'failure' as const, files: { [A]: 'passed' as const, [B]: 'failed' as const } };
    const c = compareFirstPartRuns(first, second, new Set([B]));
    expect(c.differing).toEqual([{ file: B, first: 'passed', compare: 'failed', known: true }]);
    expect(c.verdictDiffers).toBe(true);
    expect(c.difference).toBe(false);
    // The same two runs with the file NOT known: a difference.
    expect(compareFirstPartRuns(first, second, none).difference).toBe(true);
  });

  it('a file that failed and then passed alone in either run is known to be unreliable by that run itself', () => {
    const c = compareFirstPartRuns({ outcome: 'success', files: { [A]: 'flaky' } }, { outcome: 'failure', files: { [A]: 'failed' } }, none);
    expect(c.differing).toEqual([{ file: A, first: 'flaky', compare: 'failed', known: true }]);
    expect(c.difference).toBe(false);
    const d = compareFirstPartRuns({ outcome: 'success', files: { [A]: 'flaky' } }, { outcome: 'success', files: { [A]: 'passed' } }, none);
    expect(d).toMatchObject({ differing: [], flakyInEither: [A], difference: false });
  });

  it('one known and one unknown differing file: still a difference', () => {
    const c = compareFirstPartRuns({ outcome: 'success', files: { [A]: 'passed', [B]: 'passed' } }, { outcome: 'failure', files: { [A]: 'failed', [B]: 'failed' } }, new Set([A]));
    expect(c.difference).toBe(true);
  });

  it('verdicts that differ with nothing in the files to explain it are a difference', () => {
    // e.g. a dirty tree or an unhandled error in one run only.
    const c = compareFirstPartRuns({ outcome: 'success', files: { [A]: 'passed' } }, { outcome: 'failure', files: { [A]: 'passed' } }, none);
    expect(c.difference).toBe(true);
  });

  it('a comparison that ended as an infrastructure error concludes nothing', () => {
    const c = compareFirstPartRuns({ outcome: 'failure', files: { [A]: 'failed' } }, { outcome: 'error', files: {} }, none);
    expect(c.inconclusive).toBe(true);
    expect(c.difference).toBe(false);
  });
});

describe('the bound on comparison runs', () => {
  const counts = (over: Partial<TrialCounts> = {}): TrialCounts => ({ done: { 'ended-first': 0, 'failed-later': 0, passed: 0 }, started: { 'ended-first': 0, 'failed-later': 0, passed: 0 }, switchedOff: null, ...over });

  it('the first 5 of each of the three kinds: 15 per machine', () => {
    expect(COMPARE_KINDS).toEqual(['ended-first', 'failed-later', 'passed']);
    const c = counts();
    let started = 0;
    for (let round = 0; round < 50; round++) {
      for (const k of COMPARE_KINDS) {
        if (!mayStartCompare(c, k)) continue;
        c.started[k]++; c.done[k]++; started++;
      }
    }
    expect(started).toBe(15);
    expect(c.done).toEqual({ 'ended-first': 5, 'failed-later': 5, passed: 5 });
  });

  it('comparisons that never finish still stop: at most 10 started per kind', () => {
    const c = counts();
    let started = 0;
    for (let round = 0; round < 50; round++) for (const k of COMPARE_KINDS) if (mayStartCompare(c, k)) { c.started[k]++; started++; }
    expect(started).toBe(30);
  });

  it('nothing starts once a difference has switched the setting off', () => {
    expect(mayStartCompare(counts({ switchedOff: { at: 'x', pr: 1, headSha: 'a' } }), 'passed')).toBe(false);
  });

  it('the counts survive a restart, and an unreadable counts file holds every comparison', () => {
    const file = path.join(tmp(), 'state', 'first-part-trial.json');
    const a = new FirstPartTrialState(file, () => {});
    expect(a.mayStart('passed')).toBe(true);
    for (let k = 0; k < 5; k++) { expect(a.noteStarted('passed')).toBe(true); a.noteDone('passed'); }
    expect(a.mayStart('passed')).toBe(false);
    expect(a.mayStart('ended-first')).toBe(true);
    const b = new FirstPartTrialState(file, () => {});
    expect(b.get().done.passed).toBe(5);
    expect(b.mayStart('passed')).toBe(false);
    fs.writeFileSync(file, '{ broken');
    const audit: Array<Record<string, unknown>> = [];
    const c = new FirstPartTrialState(file, (e) => { audit.push(e); });
    for (const k of COMPARE_KINDS) expect(c.mayStart(k)).toBe(false);
    expect(audit.filter((e) => e.event === 'first-part-trial-unreadable')).toHaveLength(1);
  });

  it('a start that cannot be counted durably is refused', () => {
    const dir = tmp();
    const blocker = path.join(dir, 'state');
    fs.writeFileSync(blocker, 'a file where the folder should be');
    const audit: Array<Record<string, unknown>> = [];
    const s = new FirstPartTrialState(path.join(blocker, 'first-part-trial.json'), (e) => { audit.push(e); });
    expect(s.noteStarted('passed')).toBe(false);
    expect(s.get().started.passed).toBe(0);
    expect(audit.some((e) => e.event === 'first-part-trial-write-failed')).toBe(true);
  });

  it('switched off is remembered; removing the file starts the trial again without a restart', () => {
    const file = path.join(tmp(), 'first-part-trial.json');
    const s = new FirstPartTrialState(file, () => {});
    s.noteSwitchedOff('2026-11-19T00:00:00.000Z', 12, 'a'.repeat(40));
    expect(s.get().switchedOff).toEqual({ at: '2026-11-19T00:00:00.000Z', pr: 12, headSha: 'a'.repeat(40) });
    expect(new FirstPartTrialState(file, () => {}).get().switchedOff).not.toBeNull();
    for (const k of COMPARE_KINDS) expect(s.mayStart(k)).toBe(false);
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'firstPartTrial.test.ts' });
    expect(s.get().switchedOff).toBeNull();
    expect(s.mayStart('passed')).toBe(true);
  });
});

describe('minutes per change to its first pass (measure 5)', () => {
  const T0 = Date.parse('2026-12-01T00:00:00.000Z');
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const v = (pr: number, startMin: number, minutes: number, outcome: ChangeVerify['outcome']): ChangeVerify =>
    ({ pr, startedAt: new Date(T0 + startMin * MIN).toISOString(), finishedAt: new Date(T0 + (startMin + minutes) * MIN).toISOString(), outcome });
  const window = { from: T0, to: T0 + 14 * DAY };

  it("groups a pull request by the draw made for its FIRST verify, whatever setting a later verify ran under", () => {
    // PR 1 was drawn `with`. Its later verifies (on either machine, whatever that machine's setting was) all count for `with`.
    const groupOf = (pr: number) => (pr === 1 ? 'with' as const : pr === 2 ? 'without' as const : null);
    const r = minutesPerChange([
      v(1, 0, 7, 'failure'), v(1, 60, 7, 'failure'), v(1, 120, 30, 'success'), v(1, 300, 30, 'success'), // after the first pass: not counted
      v(2, 10, 30, 'failure'), v(2, 100, 35, 'success'),
      v(3, 20, 30, 'success'), // no assignment: left out
    ], groupOf, window);
    expect(r.with).toEqual({ enrolled: 1, minutesPerChange: 44, reachedPass: 1 });
    expect(r.without).toEqual({ enrolled: 1, minutesPerChange: 65, reachedPass: 1 });
  });

  it('follows each pull request for the same 7 days from its first verify, so a late entrant is not cut short', () => {
    const groupOf = () => 'with' as const;
    const late = 13 * 24 * 60; // enrolled on day 13 of 14
    const r = minutesPerChange([
      v(1, late, 10, 'failure'), v(1, late + 6 * 24 * 60, 20, 'success'), // day 19: inside its own 7 days
      v(2, 0, 10, 'failure'), v(2, 8 * 24 * 60, 20, 'success'), // its pass came after its 7 days
      v(3, 15 * 24 * 60, 10, 'success'), // first verify after the enrolment window: not enrolled
    ], groupOf, window);
    expect(r.with).toEqual({ enrolled: 2, minutesPerChange: 20, reachedPass: 0.5 });
    expect(r.without).toEqual({ enrolled: 0, minutesPerChange: null, reachedPass: null });
  });

  it('two faults mean two verifies: minutes per verify fall while minutes per change show the cost', () => {
    const groupOf = (pr: number) => (pr === 1 ? 'with' as const : 'without' as const);
    const r = minutesPerChange([
      v(1, 0, 7, 'failure'), v(1, 30, 7, 'failure'), v(1, 60, 38, 'success'), // two early ends, then the pass
      v(2, 0, 30, 'failure'), v(2, 60, 38, 'success'), // one long failure that showed both faults
    ], groupOf, window);
    expect(r.with.minutesPerChange).toBe(52);
    expect(r.without.minutesPerChange).toBe(68);
  });
});
