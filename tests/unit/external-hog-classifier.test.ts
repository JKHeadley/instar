import { describe, it, expect } from 'vitest';
import {
  parseClassifierVerdict,
  selectForClassification,
  cacheGet,
  cacheSet,
  tupleKey,
  EMPTY_VERDICT_CACHE,
  type IdentityTuple,
  type CandidateForClass,
} from '../../src/monitoring/ExternalHogClassifier.js';

/**
 * ExternalHogClassifier — pure classifier orchestration (CMT-1901, §5). Verdict parse
 * (fail-safe to null→alert), worst-CPU-first selection under the cap, identity-tuple TTL+LRU
 * cache.
 */
const tup = (pid: number, hash = 'h'): IdentityTuple => ({ pid, startTime: `S${pid}`, commandHash: hash });
const cand = (pid: number, core: number): CandidateForClass => ({ tuple: tup(pid), coreEquivalents: core });

describe('parseClassifierVerdict — bounded enum, fail-safe', () => {
  it('parses a bare enum word', () => {
    expect(parseClassifierVerdict('kill')).toBe('kill');
    expect(parseClassifierVerdict('leave')).toBe('leave');
    expect(parseClassifierVerdict('alert')).toBe('alert');
  });
  it('parses the { action } JSON contract', () => {
    expect(parseClassifierVerdict('{"action":"kill","reason":"orphan"}')).toBe('kill');
    expect(parseClassifierVerdict({ action: 'leave' })).toBe('leave');
  });
  it('anything unparseable/absent → null (→ decider-unavailable → alert, never kill)', () => {
    expect(parseClassifierVerdict('destroy')).toBeNull();
    expect(parseClassifierVerdict('{"action":"KILL NOW pid 1"}')).toBeNull();
    expect(parseClassifierVerdict('')).toBeNull();
    expect(parseClassifierVerdict(null)).toBeNull();
    expect(parseClassifierVerdict(42)).toBeNull();
    expect(parseClassifierVerdict({ action: 'kill; rm -rf' })).toBeNull();
  });
  it('never extracts a pid/target from output (only the enum matters)', () => {
    // Even valid JSON carrying a pid yields only the enum; the pid is ignored.
    expect(parseClassifierVerdict('{"action":"kill","pid":9999}')).toBe('kill');
  });
});

describe('selectForClassification — worst-CPU-first under the cap', () => {
  it('keeps the top `cap` by descending coreEquivalents; degrades the rest', () => {
    const r = selectForClassification([cand(1, 1.6), cand(2, 5.0), cand(3, 2.0), cand(4, 3.0)], 2);
    expect(r.toClassify.map((c) => c.tuple.pid)).toEqual([2, 4]); // 5.0, 3.0
    expect(r.degradedToAlert.map((c) => c.tuple.pid).sort()).toEqual([1, 3]);
  });
  it('a flood of low-severity decoys cannot starve the real hog out of a slot', () => {
    const decoys = [cand(10, 1.5), cand(11, 1.5), cand(12, 1.5), cand(13, 1.5)];
    const realHog = cand(99, 8.0);
    const r = selectForClassification([...decoys, realHog], 1);
    expect(r.toClassify.map((c) => c.tuple.pid)).toEqual([99]); // the hog wins the single slot
  });
  it('equal-CPU ties break deterministically (non-attacker-controllable)', () => {
    const r = selectForClassification([cand(2, 1.5), cand(1, 1.5)], 1);
    expect(r.toClassify).toHaveLength(1); // deterministic; stable by tupleKey
  });
  it('a non-positive/non-finite cap classifies NONE (all degrade to alert)', () => {
    expect(selectForClassification([cand(1, 5)], 0).toClassify).toHaveLength(0);
    expect(selectForClassification([cand(1, 5)], NaN).degradedToAlert).toHaveLength(1);
  });
});

describe('verdict cache — TTL + LRU, keyed on the full identity tuple', () => {
  it('a fresh entry hits; an expired one misses', () => {
    const c = cacheSet(EMPTY_VERDICT_CACHE, tup(1), 'leave', 1000, 300, 256);
    expect(cacheGet(c, tup(1), 1200, 300)).toBe('leave'); // within TTL
    expect(cacheGet(c, tup(1), 1400, 300)).toBeNull(); // expired
  });
  it('a reused pid (new start-time / command-hash) does NOT inherit the prior verdict', () => {
    const c = cacheSet(EMPTY_VERDICT_CACHE, tup(1, 'hashA'), 'kill', 1000, 300, 256);
    // Same pid, different command-hash → different tuple key → cache miss.
    expect(cacheGet(c, tup(1, 'hashB'), 1100, 300)).toBeNull();
    expect(cacheGet(c, { pid: 1, startTime: 'DIFFERENT', commandHash: 'hashA' }, 1100, 300)).toBeNull();
  });
  it('enforces the max-entries cap by evicting the oldest', () => {
    let c = EMPTY_VERDICT_CACHE;
    c = cacheSet(c, tup(1), 'leave', 100, 100_000, 2);
    c = cacheSet(c, tup(2), 'leave', 200, 100_000, 2);
    c = cacheSet(c, tup(3), 'leave', 300, 100_000, 2); // exceeds cap 2 → evict oldest (pid 1)
    expect(cacheGet(c, tup(1), 350, 100_000)).toBeNull(); // evicted
    expect(cacheGet(c, tup(2), 350, 100_000)).toBe('leave');
    expect(cacheGet(c, tup(3), 350, 100_000)).toBe('leave');
  });
  it('a non-finite now/ttl fails toward a MISS (advisory cache never bypasses the kill-time re-check)', () => {
    const c = cacheSet(EMPTY_VERDICT_CACHE, tup(1), 'kill', 1000, 300, 256);
    expect(cacheGet(c, tup(1), NaN, 300)).toBeNull();
  });
  it('tupleKey distinguishes all three fields', () => {
    expect(tupleKey(tup(1, 'a'))).not.toBe(tupleKey(tup(1, 'b')));
  });
});
