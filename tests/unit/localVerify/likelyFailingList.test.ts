// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The likely-failing list (spec docs/specs/local-verify-likely-failing-first.md, section B):
 * counting, ranking by different pull requests, the 7-day window, the 500-file bound, ties, and
 * the stale, oversized and unreadable cases. Real fs in a temp dir.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { FIRST_PART_LIMITS } from '../../../src/localVerify/firstPart.js';
import {
  LikelyFailingStore, addLikelyFailures, emptyLikelyFailing, likelyFailingFor, parseLikelyFailing, rankLikelyFailing, type LikelyFailingState,
} from '../../../src/localVerify/likelyFailingList.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const f = (n: number) => `tests/unit/f${n}.test.ts`;

function build(failures: Array<{ pr: number; files: string[]; at: number }>, now = NOW): LikelyFailingState {
  let s = emptyLikelyFailing();
  for (const x of failures) s = addLikelyFailures(s, x, now).state;
  return s;
}

describe('counting', () => {
  it('each failed file gets the pull request number and the time of the failure', () => {
    const r = addLikelyFailures(emptyLikelyFailing(), { pr: 7, files: [f(1), f(2)], at: NOW - 1000 }, NOW);
    expect(r.changed).toBe(true);
    expect(r.state.files).toEqual({ [f(1)]: [{ pr: 7, at: NOW - 1000 }], [f(2)]: [{ pr: 7, at: NOW - 1000 }] });
    expect(r.state.updatedAt).toBe(NOW);
    expect(r.state.oldestFailureAt).toBe(NOW - 1000);
  });

  it('the same failure is never counted twice', () => {
    const one = addLikelyFailures(emptyLikelyFailing(), { pr: 7, files: [f(1)], at: NOW - 1000 }, NOW).state;
    const again = addLikelyFailures(one, { pr: 7, files: [f(1)], at: NOW - 1000 }, NOW + 5);
    expect(again.changed).toBe(false);
    expect(again.state).toBe(one);
  });

  it('a file keeps ONE entry per pull request, its latest failure; an older report never moves it back', () => {
    const s = build([{ pr: 7, files: [f(1)], at: NOW - 2000 }, { pr: 7, files: [f(1)], at: NOW - 1000 }]);
    expect(s.files[f(1)]).toEqual([{ pr: 7, at: NOW - 1000 }]);
    const older = addLikelyFailures(s, { pr: 7, files: [f(1)], at: NOW - 5000 }, NOW);
    expect(older.changed).toBe(false);
    expect(older.state.files[f(1)]).toEqual([{ pr: 7, at: NOW - 1000 }]);
  });

  it('one pull request failing the same file many times cannot push other pull requests out of the 40 kept', () => {
    let s = emptyLikelyFailing();
    for (let k = 0; k < 39; k++) s = addLikelyFailures(s, { pr: 100 + k, files: [f(1)], at: NOW - 100_000 + k }, NOW).state;
    for (let k = 0; k < 60; k++) s = addLikelyFailures(s, { pr: 7, files: [f(1)], at: NOW - 1000 + k }, NOW).state;
    expect(s.files[f(1)]).toHaveLength(40);
    expect(new Set(s.files[f(1)].map((x) => x.pr)).size).toBe(40);
    expect(rankLikelyFailing(s, 999, NOW)[0]).toMatchObject({ file: f(1), prs: 40 });
  });

  it('a failure dated more than a few minutes in the future is not counted', () => {
    expect(addLikelyFailures(emptyLikelyFailing(), { pr: 7, files: [f(1)], at: NOW + 6 * 60_000 }, NOW).changed).toBe(false);
    expect(addLikelyFailures(emptyLikelyFailing(), { pr: 7, files: [f(1)], at: NOW + 60_000 }, NOW).changed).toBe(true); // clock skew between two machines
  });

  it('nothing to count changes nothing', () => {
    expect(addLikelyFailures(emptyLikelyFailing(), { pr: 7, files: [], at: NOW }, NOW).changed).toBe(false);
    expect(addLikelyFailures(emptyLikelyFailing(), { pr: 0, files: [f(1)], at: NOW }, NOW).changed).toBe(false);
  });
});

describe('the 7-day window', () => {
  it('a failure older than 7 days is dropped when the list is next updated, and never ranked meanwhile', () => {
    const s = build([{ pr: 1, files: [f(1)], at: NOW - 6 * DAY }, { pr: 2, files: [f(2)], at: NOW - DAY }], NOW - DAY);
    // Two days later f1's failure is 8 days old.
    const later = NOW + 2 * DAY;
    expect(rankLikelyFailing({ ...s, updatedAt: later }, null, later).map((r) => r.file)).toEqual([f(2)]);
    const next = addLikelyFailures(s, { pr: 3, files: [f(3)], at: later }, later).state;
    expect(Object.keys(next.files).sort()).toEqual([f(2), f(3)]);
    expect(next.oldestFailureAt).toBe(NOW - DAY);
  });

  it('a failure reported more than 7 days late is not counted', () => {
    expect(addLikelyFailures(emptyLikelyFailing(), { pr: 1, files: [f(1)], at: NOW - 8 * DAY }, NOW).changed).toBe(false);
  });

  it('a list not updated for 7 days is treated as empty', () => {
    const s = build([{ pr: 1, files: [f(1)], at: NOW }]);
    expect(likelyFailingFor(s, 99, NOW + 7 * DAY)).toEqual([f(1)]);
    expect(likelyFailingFor(s, 99, NOW + 7 * DAY + 1)).toEqual([]);
    expect(likelyFailingFor(emptyLikelyFailing(), 99, NOW)).toEqual([]);
  });
});

describe('ranking', () => {
  it('by the number of DIFFERENT pull requests, not by count: one change verified ten times cannot lift its own file', () => {
    const tenTimes = Array.from({ length: 10 }, (_, k) => ({ pr: 1, files: [f(1)], at: NOW - 10_000 + k }));
    const s = build([...tenTimes, { pr: 2, files: [f(2)], at: NOW - 50_000 }, { pr: 3, files: [f(2)], at: NOW - 40_000 }]);
    expect(likelyFailingFor(s, 99, NOW)).toEqual([f(2), f(1)]);
    expect(rankLikelyFailing(s, 99, NOW)).toEqual([{ file: f(2), prs: 2, last: NOW - 40_000 }, { file: f(1), prs: 1, last: NOW - 9991 }]);
  });

  it('ties go to the most recent failure, then to the path', () => {
    const s = build([{ pr: 1, files: [f(1)], at: NOW - 3000 }, { pr: 2, files: [f(2)], at: NOW - 1000 }, { pr: 3, files: [f(4), f(3)], at: NOW - 2000 }]);
    expect(likelyFailingFor(s, 99, NOW)).toEqual([f(2), f(3), f(4), f(1)]);
  });

  it("the list for a verify excludes that pull request's own failures", () => {
    const s = build([{ pr: 1, files: [f(1), f(2)], at: NOW - 1000 }, { pr: 2, files: [f(2)], at: NOW - 2000 }]);
    expect(likelyFailingFor(s, 1, NOW)).toEqual([f(2)]); // f1 failed only for PR 1; f2 still listed through PR 2
    expect(likelyFailingFor(s, 2, NOW)).toEqual([f(1), f(2)]); // one other pull request each, same time: the path decides
    expect(likelyFailingFor(s, 3, NOW)).toEqual([f(2), f(1)]);
  });

  it('there is no minimum: a file that failed for one pull request is listed', () => {
    expect(likelyFailingFor(build([{ pr: 1, files: [f(1)], at: NOW }]), 2, NOW)).toEqual([f(1)]);
  });

  it('at most 90 files are used', () => {
    const s = build(Array.from({ length: 130 }, (_, k) => ({ pr: 1000 + k, files: [f(k)], at: NOW - k })));
    const used = likelyFailingFor(s, 1, NOW);
    expect(used).toHaveLength(FIRST_PART_LIMITS.listUsed);
    expect(used[0]).toBe(f(0)); // the most recent
    expect(used).not.toContain(f(90));
  });
});

describe('bounds', () => {
  it('eviction at 501 files drops the file whose most recent failure is oldest', () => {
    let s = emptyLikelyFailing();
    for (let k = 0; k < 500; k++) s = addLikelyFailures(s, { pr: k + 1, files: [f(k)], at: NOW - 100_000 + k }, NOW).state;
    // f0 is the oldest; give it a newer failure so f1 becomes the file whose most recent failure is oldest.
    s = addLikelyFailures(s, { pr: 900, files: [f(0)], at: NOW - 10 }, NOW).state;
    expect(Object.keys(s.files)).toHaveLength(500);
    const r = addLikelyFailures(s, { pr: 901, files: [f(9999)], at: NOW }, NOW);
    expect(r.evicted).toEqual([f(1)]);
    expect(Object.keys(r.state.files)).toHaveLength(500);
    expect(r.state.files[f(0)]).toBeDefined();
    expect(r.state.files[f(9999)]).toBeDefined();
    expect(r.state.files[f(1)]).toBeUndefined();
  });

  it('a file keeps its newest 40 failures', () => {
    let s = emptyLikelyFailing();
    for (let k = 0; k < 45; k++) s = addLikelyFailures(s, { pr: k + 1, files: [f(1)], at: NOW - 1000 + k }, NOW).state;
    expect(s.files[f(1)]).toHaveLength(FIRST_PART_LIMITS.failuresPerFile);
    expect(s.files[f(1)][0]).toEqual({ pr: 6, at: NOW - 1000 + 5 });
  });

  it('a full list of 500 files with 40 failures each stays under the 1 MB that is read', () => {
    const files: LikelyFailingState['files'] = {};
    for (let k = 0; k < 500; k++) files[`tests/unit/some/quite/long/directory/name/for-a-test-file-${k}.test.ts`] = Array.from({ length: 40 }, (_, j) => ({ pr: 30_000 + j, at: NOW - j }));
    expect(Buffer.byteLength(JSON.stringify({ v: 1, updatedAt: NOW, oldestFailureAt: NOW, files }))).toBeLessThan(FIRST_PART_LIMITS.listMaxBytes);
  });
});

describe('parseLikelyFailing', () => {
  it('reads what the store writes and refuses anything else', () => {
    const s = build([{ pr: 1, files: [f(1)], at: NOW - 5 }]);
    expect(parseLikelyFailing(JSON.stringify(s))).toEqual(s);
    for (const bad of ['', 'not json', '[]', '{}', '{"v":2,"updatedAt":1,"files":{}}', '{"v":1,"updatedAt":"x","files":{}}', '{"v":1,"updatedAt":1,"files":[]}',
      '{"v":1,"updatedAt":1,"files":{"a":"x"}}', '{"v":1,"updatedAt":1,"files":{"a":[{"pr":"1","at":1}]}}', '{"v":1,"updatedAt":1,"files":{"a":[{"pr":1}]}}']) {
      expect(parseLikelyFailing(bad)).toBeNull();
    }
  });
});

describe('a doctored file', () => {
  it('a failure time (or an update time) in the future makes the file invalid, so it cannot pin a file at the top', () => {
    const good = build([{ pr: 1, files: [f(1)], at: NOW - 5 }]);
    expect(parseLikelyFailing(JSON.stringify(good), NOW)).toEqual(good);
    const pinned = { ...good, files: { ...good.files, [f(2)]: [{ pr: 2, at: NOW + 365 * DAY }] } };
    expect(parseLikelyFailing(JSON.stringify(pinned), NOW)).toBeNull();
    expect(parseLikelyFailing(JSON.stringify({ ...good, updatedAt: NOW + DAY }), NOW)).toBeNull();
    // A few minutes ahead is clock skew, not a doctored file.
    const skew = { ...good, updatedAt: NOW + 60_000, files: { [f(1)]: [{ pr: 1, at: NOW + 60_000 }] } };
    expect(parseLikelyFailing(JSON.stringify(skew), NOW)).not.toBeNull();
  });
});

describe('LikelyFailingStore — the file', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'likelyFailingList.test.ts' }); });
  function store(prepare?: (file: string) => void) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-likely-')));
    dirs.push(dir);
    const file = path.join(dir, 'state', 'local-verify', 'likely-failing.json');
    if (prepare) { fs.mkdirSync(path.dirname(file), { recursive: true }); prepare(file); }
    const audit: Array<Record<string, unknown>> = [];
    let now = NOW;
    const make = () => new LikelyFailingStore(file, () => now, (e) => { audit.push(e); });
    return { file, audit, make, s: make(), advance: (ms: number) => { now += ms; } };
  }

  it('an absent file is an empty list with no audit row; the first failure writes the file whole', () => {
    const h = store();
    expect(h.s.listFor(1)).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(h.s.record({ pr: 5, files: [f(1)], at: NOW })).toBe(true);
    expect(parseLikelyFailing(fs.readFileSync(h.file, 'utf-8'))!.files[f(1)]).toEqual([{ pr: 5, at: NOW }]);
    expect(fs.existsSync(`${h.file}.tmp`)).toBe(false); // written whole and replaced
    expect(h.audit).toEqual([expect.objectContaining({ event: 'likely-failing-updated', pr: 5, files: 1 })]);
    // A second store on the same file (after a restart) reads it back.
    expect(h.make().listFor(2)).toEqual([f(1)]);
    expect(h.make().listFor(5)).toEqual([]);
  });

  it('an unparseable file is an empty list and ONE audit row, however often the list is read', () => {
    const h = store((file) => fs.writeFileSync(file, '{ not json'));
    expect(h.s.listFor(1)).toEqual([]);
    expect(h.s.listFor(2)).toEqual([]);
    expect(h.s.info().problem).toBe('unparseable');
    expect(h.audit.filter((e) => e.event === 'likely-failing-unreadable')).toEqual([expect.objectContaining({ reason: 'unparseable' })]);
    // It rebuilds as verifies are recorded.
    h.s.record({ pr: 5, files: [f(1)], at: NOW });
    expect(h.s.listFor(1)).toEqual([f(1)]);
    expect(h.s.info().problem).toBeNull();
    expect(parseLikelyFailing(fs.readFileSync(h.file, 'utf-8'))).not.toBeNull();
  });

  it('a file holding a failure dated in the future is not used: empty list, one audit row', () => {
    const h = store((file) => fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: NOW, oldestFailureAt: NOW, files: { [f(1)]: [{ pr: 1, at: NOW + 30 * DAY }] } })));
    expect(h.s.listFor(2)).toEqual([]);
    expect(h.audit).toEqual([expect.objectContaining({ event: 'likely-failing-unreadable', reason: 'unparseable' })]);
  });

  it('a file over 1 MB is never read: empty list, one audit row naming the size', () => {
    const h = store((file) => {
      // A VALID list padded past the bound: it would parse if it were read.
      const big = { v: 1, updatedAt: NOW, oldestFailureAt: NOW, files: { [f(1)]: [{ pr: 1, at: NOW }] }, pad: 'x'.repeat(FIRST_PART_LIMITS.listMaxBytes) };
      fs.writeFileSync(file, JSON.stringify(big));
    });
    expect(h.s.listFor(2)).toEqual([]);
    expect(h.audit).toEqual([expect.objectContaining({ event: 'likely-failing-unreadable', reason: 'oversized' })]);
    expect(h.audit[0].bytes as number).toBeGreaterThan(FIRST_PART_LIMITS.listMaxBytes);
  });

  it('an unreadable path (a directory where the file should be) is an empty list and one audit row', () => {
    const h = store((file) => fs.mkdirSync(file));
    expect(h.s.listFor(1)).toEqual([]);
    expect(h.s.listFor(1)).toEqual([]);
    expect(h.audit.filter((e) => e.event === 'likely-failing-unreadable')).toHaveLength(1);
    // A write that cannot land is audited and changes nothing.
    expect(h.s.record({ pr: 5, files: [f(1)], at: NOW })).toBe(false);
    expect(h.audit.some((e) => e.event === 'likely-failing-write-failed')).toBe(true);
    expect(h.s.listFor(1)).toEqual([]);
  });

  it('info() gives the size, the age, the oldest failure and the top files', () => {
    const h = store();
    h.s.record({ pr: 5, files: [f(1), f(2)], at: NOW - 5000 });
    h.s.record({ pr: 6, files: [f(2)], at: NOW - 1000 });
    const info = h.s.info();
    expect(info).toMatchObject({ files: 2, updatedAt: new Date(NOW).toISOString(), oldestFailureAt: new Date(NOW - 5000).toISOString(), stale: false, problem: null });
    expect(info.top).toEqual([{ file: f(2), prs: 2, last: new Date(NOW - 1000).toISOString() }, { file: f(1), prs: 1, last: new Date(NOW - 5000).toISOString() }]);
    h.advance(8 * DAY);
    expect(h.s.info().stale).toBe(true);
    expect(h.s.info().top).toEqual([]);
    expect(h.s.listFor(1)).toEqual([]);
  });
});
