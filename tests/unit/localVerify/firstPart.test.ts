/**
 * The first part of a lane: which files go first, the per-machine setting, and the bounded
 * request field that carries the list to a peer (spec
 * docs/specs/local-verify-likely-failing-first.md, sections A, B and E). Pure functions only.
 */

import { describe, expect, it } from 'vitest';
import {
  FIRST_PART_LIMITS, boundLikelyFailingWire, firstPartActive, hasWildcard, parseFirstPartSetting, parseLikelyFailingWire, selectFirstPart,
} from '../../../src/localVerify/firstPart.js';
import { parsePeerRunRequest, type PeerRunRequest } from '../../../src/localVerify/peer.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';

const unit = (n: number) => `tests/unit/f${String(n).padStart(3, '0')}.test.ts`;
const integ = (n: number) => `tests/integration/i${String(n).padStart(3, '0')}.test.ts`;
const e2e = (n: number) => `tests/e2e/e${String(n).padStart(3, '0')}.test.ts`;
const range = (n: number, f: (k: number) => string) => Array.from({ length: n }, (_, k) => f(k));

describe('the setting', () => {
  it('is off unless it is exactly on or alternate', () => {
    expect(parseFirstPartSetting('on')).toBe('on');
    expect(parseFirstPartSetting('alternate')).toBe('alternate');
    for (const v of [undefined, null, 'off', true, 'ON', 'yes', 1, {}]) expect(parseFirstPartSetting(v)).toBe('off');
  });

  it('a verify uses first parts when on, or when alternate and the pull request is assigned with; never a main verify', () => {
    const base = { previous: [], list: [] };
    expect(firstPartActive(undefined, undefined)).toBe(false);
    expect(firstPartActive({ setting: 'on', ...base }, undefined)).toBe(true);
    expect(firstPartActive({ setting: 'on', group: 'without', ...base }, undefined)).toBe(true);
    expect(firstPartActive({ setting: 'alternate', group: 'with', ...base }, undefined)).toBe(true);
    expect(firstPartActive({ setting: 'alternate', group: 'without', ...base }, undefined)).toBe(false);
    // No assignment sent (an older coordinator): the pull request counts as without.
    expect(firstPartActive({ setting: 'alternate', ...base }, undefined)).toBe(false);
    expect(firstPartActive({ setting: 'on', ...base }, 'main')).toBe(false);
  });
});

describe('selectFirstPart — composition', () => {
  const laneFiles = range(200, unit);

  it("fills in order: the change's own files, then its previous failures, then the list, each counted by its source", () => {
    const s = selectFirstPart({
      lane: 'unit', laneFiles, changed: new Set([unit(5), unit(3), 'src/x.ts']),
      previous: [unit(9)], list: [unit(20), unit(21), unit(3)], durations: {},
    });
    expect(s.files).toEqual([unit(3), unit(5), unit(9), unit(20), unit(21)]);
    expect(s).toMatchObject({ fromChange: 2, fromPrevious: 1, fromList: 2, partners: 0, ms: null });
  });

  it('when the limit is reached, the order decides who is in: the change first, the list last', () => {
    const changed = new Set(range(70, unit));
    const previous = [unit(100), unit(101), unit(102)];
    const list = range(60, (k) => unit(120 + k));
    const s = selectFirstPart({ lane: 'unit', laneFiles, changed, previous, list, durations: {} });
    expect(s.files).toHaveLength(FIRST_PART_LIMITS.files.unit);
    expect(s).toMatchObject({ fromChange: 70, fromPrevious: 3, fromList: 7 });
    expect(s.files).toContain(unit(126));
    expect(s.files).not.toContain(unit(127));
  });

  it('only files of the lane are ever chosen: a deleted file, a non-test file and another lane’s file drop out', () => {
    const s = selectFirstPart({
      lane: 'integration', laneFiles: range(5, integ), changed: new Set([unit(1), 'tests/integration/deleted.test.ts', 'README.md', integ(2)]),
      previous: [unit(2), e2e(1)], list: [unit(3), integ(4), 'tests/integration/not-in-tree.test.ts'], durations: {},
    });
    expect(s.files).toEqual([integ(2), integ(4)]);
  });

  it('unreadable changed paths (null) mean none; the previous failures and the list still go first', () => {
    const s = selectFirstPart({ lane: 'unit', laneFiles, changed: null, previous: [unit(9)], list: [unit(20)], durations: {} });
    expect(s.files).toEqual([unit(9), unit(20)]);
    expect(s.fromChange).toBe(0);
  });

  it('nothing to put first gives an empty first part', () => {
    expect(selectFirstPart({ lane: 'unit', laneFiles, changed: new Set(['src/x.ts']), previous: [], list: [], durations: {} }).files).toEqual([]);
    expect(selectFirstPart({ lane: 'unit', laneFiles: [], changed: new Set([unit(1)]), previous: [unit(1)], list: [unit(1)], durations: {} }).files).toEqual([]);
  });

  it('a file named twice (changed and listed) is chosen once, under its first source', () => {
    const s = selectFirstPart({ lane: 'unit', laneFiles, changed: new Set([unit(1)]), previous: [unit(1)], list: [unit(1), unit(2)], durations: {} });
    expect(s.files).toEqual([unit(1), unit(2)]);
    expect(s).toMatchObject({ fromChange: 1, fromPrevious: 0, fromList: 1 });
  });
});

describe('selectFirstPart — limits', () => {
  it('by count: unit 80, integration 20, end-to-end 12', () => {
    expect(selectFirstPart({ lane: 'unit', laneFiles: range(300, unit), changed: null, previous: [], list: range(300, unit), durations: {} }).files).toHaveLength(80);
    const fast = (files: string[]) => Object.fromEntries(files.map((f) => [f, 100]));
    const ints = range(100, integ);
    expect(selectFirstPart({ lane: 'integration', laneFiles: ints, changed: null, previous: [], list: ints, durations: fast(ints) }).files).toHaveLength(20);
    const es = range(100, e2e);
    expect(selectFirstPart({ lane: 'e2e', laneFiles: es, changed: null, previous: [], list: es, durations: fast(es) }).files).toHaveLength(12);
  });

  it('the two slower lanes are also held to 60 s of recorded time; a file with no recorded time counts as 10 s', () => {
    const ints = range(40, integ);
    // No recorded times: six files of 10 s each fill the minute.
    const untimed = selectFirstPart({ lane: 'integration', laneFiles: ints, changed: null, previous: [], list: ints, durations: {} });
    expect(untimed.files).toHaveLength(6);
    expect(untimed.ms).toBe(60_000);
    // Recorded: 25 s + 25 s fit; the third 25 s file would pass 60 s and stays in the rest; a later 5 s file still fits.
    const d = { [integ(0)]: 25_000, [integ(1)]: 25_000, [integ(2)]: 25_000, [integ(3)]: 5_000 };
    const timed = selectFirstPart({ lane: 'integration', laneFiles: ints, changed: null, previous: [], list: [integ(0), integ(1), integ(2), integ(3)], durations: d });
    expect(timed.files).toEqual([integ(0), integ(1), integ(3)]);
    expect(timed.ms).toBe(55_000);
  });

  it('a single file longer than a minute never goes first in a slower lane, even when the change edits it', () => {
    const s = selectFirstPart({ lane: 'e2e', laneFiles: range(5, e2e), changed: new Set([e2e(1)]), previous: [], list: [], durations: { [e2e(1)]: 61_000 } });
    expect(s.files).toEqual([]);
  });

  it('the unit lane has no time limit (its files run side by side)', () => {
    const files = range(100, unit);
    const s = selectFirstPart({ lane: 'unit', laneFiles: files, changed: null, previous: [], list: files, durations: Object.fromEntries(files.map((f) => [f, 120_000])) });
    expect(s.files).toHaveLength(80);
    expect(s.ms).toBeNull();
  });
});

describe('selectFirstPart — path filters', () => {
  // The test runner matches a named file by case-insensitive substring: these two overlap.
  const SHORT = 'tests/unit/auth.test.ts';
  const LONG = 'tests/unit/sub/tests/unit/AUTH.test.ts';
  const other = range(10, unit);

  it('an overlap group selected from its shorter path enters whole', () => {
    const s = selectFirstPart({ lane: 'unit', laneFiles: [SHORT, LONG, ...other], changed: null, previous: [], list: [SHORT], durations: {} });
    expect(s.files).toEqual([SHORT, LONG].sort());
    expect(s).toMatchObject({ fromList: 1, partners: 1 });
  });

  it('an overlap group selected from its longer path enters whole', () => {
    const s = selectFirstPart({ lane: 'unit', laneFiles: [SHORT, LONG, ...other], changed: new Set([LONG]), previous: [], list: [], durations: {} });
    expect(s.files).toEqual([SHORT, LONG].sort());
    expect(s).toMatchObject({ fromChange: 1, partners: 1 });
  });

  it('a chain of overlaps is one group', () => {
    const a = 'tests/unit/a.test.ts';
    const b = 'tests/unit/x/tests/unit/a.test.ts';
    const c = 'tests/unit/y/tests/unit/x/tests/unit/a.test.ts';
    const s = selectFirstPart({ lane: 'unit', laneFiles: [a, b, c, ...other], changed: null, previous: [], list: [b], durations: {} });
    expect(s.files).toEqual([a, b, c].sort());
  });

  it('a group that would pass the limit stays in the rest whole; a later single file still fits', () => {
    const es = range(11, e2e);
    const short = 'tests/e2e/pair.test.ts';
    const long = 'tests/e2e/more/tests/e2e/pair.test.ts';
    const laneFiles = [...es, short, long, 'tests/e2e/last.test.ts'];
    const durations = Object.fromEntries(laneFiles.map((f) => [f, 1000]));
    const s = selectFirstPart({ lane: 'e2e', laneFiles, changed: null, previous: [], list: [...es, short, 'tests/e2e/last.test.ts'], durations });
    expect(s.files).toHaveLength(12);
    expect(s.files).not.toContain(short);
    expect(s.files).not.toContain(long);
    expect(s.files).toContain('tests/e2e/last.test.ts');
  });

  it('a group over the time limit stays in the rest whole', () => {
    const short = 'tests/integration/pair.test.ts';
    const long = 'tests/integration/more/tests/integration/pair.test.ts';
    const s = selectFirstPart({ lane: 'integration', laneFiles: [short, long, integ(1)], changed: null, previous: [], list: [short, integ(1)], durations: { [short]: 20_000, [long]: 45_000, [integ(1)]: 1000 } });
    expect(s.files).toEqual([integ(1)]);
  });

  it('a path with a wildcard character is left out, and so is its whole group', () => {
    for (const ch of ['*', '?', '[', ']', '{', '}', '(', ')', '!', '+', '@', '|', ',', '\\']) expect(hasWildcard(`tests/unit/a${ch}b.test.ts`)).toBe(true);
    expect(hasWildcard('tests/unit/plain-name_1.test.ts')).toBe(false);
    const wild = 'tests/unit/[id].test.ts';
    const plain = 'tests/unit/x/tests/unit/[id].test.ts';
    const s = selectFirstPart({ lane: 'unit', laneFiles: [wild, plain, ...other], changed: new Set([wild]), previous: [plain], list: [unit(1)], durations: {} });
    expect(s.files).toEqual([unit(1)]);
  });

  it('a first part is closed under overlap: no file left in the rest overlaps a chosen file', () => {
    const laneFiles = ['tests/unit/a.test.ts', 'tests/unit/z/tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/unit/q/TESTS/UNIT/B.test.ts', ...other];
    const s = selectFirstPart({ lane: 'unit', laneFiles, changed: new Set(['tests/unit/b.test.ts']), previous: [], list: ['tests/unit/z/tests/unit/a.test.ts'], durations: {} });
    const chosen = new Set(s.files);
    for (const rest of laneFiles.filter((f) => !chosen.has(f))) {
      for (const c of s.files) {
        expect(rest.toLowerCase().includes(c.toLowerCase())).toBe(false);
        expect(c.toLowerCase().includes(rest.toLowerCase())).toBe(false);
      }
    }
  });
});

describe('the request field sent to a peer', () => {
  const list = range(90, unit);

  it('carries the previous failures and the list, at most 100 paths', () => {
    const { field, dropped } = boundLikelyFailingWire(list, [unit(200), unit(201), unit(202)]);
    expect(dropped).toEqual([]);
    expect(field!.previous).toEqual([unit(200), unit(201), unit(202)]);
    expect(field!.list).toHaveLength(90);
    expect(parseLikelyFailingWire(field)).toEqual(field);
    const big = boundLikelyFailingWire(range(300, unit), range(10, (k) => unit(400 + k)));
    expect(big.field!.previous).toHaveLength(3);
    expect(big.field!.list.length + big.field!.previous.length).toBeLessThanOrEqual(FIRST_PART_LIMITS.wirePaths);
  });

  it('is omitted when there is nothing to send', () => {
    expect(boundLikelyFailingWire([], [])).toEqual({ field: null, dropped: [] });
  });

  it('a path over 300 characters is left out and reported, never sent: it cannot refuse the request', () => {
    const long = `tests/unit/${'x'.repeat(300)}.test.ts`;
    const { field, dropped } = boundLikelyFailingWire([unit(1), long, unit(2)], [long]);
    expect(dropped).toEqual([long, long]);
    expect(field).toEqual({ list: [unit(1), unit(2)], previous: [] });
    expect(parseLikelyFailingWire(field)).not.toBeNull();
  });

  it('a malformed field is refused whole', () => {
    const good = { list: [unit(1)], previous: [] };
    expect(parseLikelyFailingWire(good)).toEqual(good);
    for (const bad of [
      null, 'x', [], { list: [unit(1)] }, { previous: [] }, { list: 'x', previous: [] }, { list: [1], previous: [] }, { list: [''], previous: [] },
      { list: ['x'.repeat(301)], previous: [] }, { list: [unit(1)], previous: [], extra: 1 }, { list: range(101, unit), previous: [] },
      { list: range(98, unit), previous: range(3, (k) => unit(200 + k)) }, { list: [], previous: range(4, unit) }, { list: [], previous: [] },
    ]) expect(parseLikelyFailingWire(bad)).toBeNull();
  });

  it('parsePeerRunRequest accepts the two new fields on a pull request verify and refuses the whole request when one is malformed', () => {
    const req = (over: Record<string, unknown> = {}): unknown => ({
      attemptId: 'a'.repeat(32), pr: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRefName: 'main', verifierVersion: '1.0.0',
      policyHash: computePolicyHash(), coordinatorMachineId: 'coord', leaseEpoch: 7, ...over,
    });
    expect(parsePeerRunRequest(req())).not.toBeNull(); // both omitted: as before
    const parsed = parsePeerRunRequest(req({ likelyFailing: { list: [unit(1)], previous: [unit(2)] }, firstPartGroup: 'with' })) as PeerRunRequest;
    expect(parsed.likelyFailing).toEqual({ list: [unit(1)], previous: [unit(2)] });
    expect(parsed.firstPartGroup).toBe('with');
    expect(parsePeerRunRequest(req({ firstPartGroup: 'without' }))).not.toBeNull();
    expect(parsePeerRunRequest(req({ firstPartGroup: 'maybe' }))).toBeNull();
    expect(parsePeerRunRequest(req({ likelyFailing: { list: ['x'.repeat(301)], previous: [] } }))).toBeNull();
    expect(parsePeerRunRequest(req({ likelyFailing: { list: range(101, unit), previous: [] } }))).toBeNull();
    expect(parsePeerRunRequest(req({ likelyFailing: { list: [], previous: [] } }))).toBeNull();
    expect(parsePeerRunRequest(req({ likelyFailing: { list: [unit(1)], previous: [], more: true } }))).toBeNull();
    // A main verify never carries them.
    const main = { pr: 0, headSha: 'a'.repeat(40), baseSha: 'a'.repeat(40), kind: 'main' };
    expect(parsePeerRunRequest(req(main))).not.toBeNull();
    expect(parsePeerRunRequest(req({ ...main, firstPartGroup: 'with' }))).toBeNull();
    expect(parsePeerRunRequest(req({ ...main, likelyFailing: { list: [unit(1)], previous: [] } }))).toBeNull();
  });
});
