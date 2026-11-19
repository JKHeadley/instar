// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The trial of first parts (spec docs/specs/local-verify-likely-failing-first.md, section E
 * `alternate`, measure 5): the assignment of pull requests and minutes per change.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { FIRST_PART_LIMITS } from '../../../src/localVerify/firstPart.js';
import {
  FirstPartGroups, minutesPerChange, type ChangeVerify,
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


it('derived passes add no minutes; pilot entrants and first derived results are not enrolled', () => {
  const day = 86400000; const start = Date.parse('2026-11-01T00:00:00Z');
  const v = (pr: number, at: number, outcome: ChangeVerify['outcome'], derived = false): ChangeVerify => ({ pr,
    startedAt: new Date(start + at * day).toISOString(), finishedAt: new Date(start + at * day + 60000).toISOString(), outcome, derived });
  const result = minutesPerChange([v(1, -1, 'failure'), v(1, 1, 'success'), v(2, 13, 'failure'), v(2, 19, 'success', true),
    v(3, 19, 'success'), v(4, 2, 'success', true)], () => 'with', { from: start, to: start + 14 * day });
  expect(result.with).toEqual({ enrolled: 1, minutesPerChange: 1, reachedPass: 1 });
});
