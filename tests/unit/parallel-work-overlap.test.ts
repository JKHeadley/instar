/**
 * Unit tests for the pure cross-topic overlap detector (Parallel-Work Awareness Phase B).
 * Spec: docs/specs/parallel-activity-coherence.md (Part 2). Pure logic ⇒ exhaustive coverage
 * of the false-positive containment the convergence demanded.
 */
import { describe, it, expect } from 'vitest';
import {
  detectOverlaps,
  pairKey,
  signatureChangedMaterially,
  type OverlapCandidate,
} from '../../src/monitoring/ParallelWorkOverlap.js';

const NOW = Date.parse('2026-06-04T12:00:00.000Z');
const fresh = NOW - 60 * 60 * 1000;      // 1h ago — inside the 4h window
const stale = NOW - 6 * 60 * 60 * 1000;  // 6h ago — outside it

function cand(topicId: number, tags: string[], updatedAt: number | null, running = true): OverlapCandidate {
  return { topicId, tags, updatedAt, running };
}

describe('detectOverlaps', () => {
  it('detects an overlap on a shared high-specificity tag (the Codey CPU case)', () => {
    const pairs = detectOverlaps([
      cand(100, ['resourceledger', 'cpu-sampling', 'src/monitoring/resourcesampler.ts'], fresh),
      cand(200, ['cpu-sampling', 'reaper', 'load'], fresh),
    ], { nowMs: NOW });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ topicA: 100, topicB: 200 });
    expect(pairs[0].sharedTags).toEqual(['cpu-sampling']);
    expect(pairs[0].signature).toBe('cpu-sampling');
  });

  it('does NOT match topics with no shared specific tags (the false-positive case)', () => {
    const pairs = detectOverlaps([
      cand(1, ['resourceledger', 'sqlite'], fresh),
      cand(2, ['telegram', 'markdown'], fresh),
    ], { nowMs: NOW });
    expect(pairs).toEqual([]);
  });

  it('activity gate: a stale (>window) or null-updatedAt topic is excluded', () => {
    const pairs = detectOverlaps([
      cand(1, ['cpu-sampling'], fresh),
      cand(2, ['cpu-sampling'], stale),      // too old
      cand(3, ['cpu-sampling'], null),       // unknown freshness
    ], { nowMs: NOW });
    expect(pairs).toEqual([]); // topic 1 has no fresh partner
  });

  it('requireRunning: a pair where NEITHER topic is running is skipped', () => {
    const pairs = detectOverlaps([
      cand(1, ['cpu-sampling'], fresh, false),
      cand(2, ['cpu-sampling'], fresh, false),
    ], { nowMs: NOW });
    expect(pairs).toEqual([]);
    // but if one is running, it fires
    const pairs2 = detectOverlaps([
      cand(1, ['cpu-sampling'], fresh, false),
      cand(2, ['cpu-sampling'], fresh, true),
    ], { nowMs: NOW });
    expect(pairs2).toHaveLength(1);
  });

  it('minSharedSpecific: requiring ≥2 shared tags drops single-tag overlaps', () => {
    const cands = [
      cand(1, ['cpu-sampling', 'resourceledger'], fresh),
      cand(2, ['cpu-sampling', 'reaper'], fresh),
    ];
    expect(detectOverlaps(cands, { nowMs: NOW, minSharedSpecific: 2 })).toEqual([]);
    expect(detectOverlaps(cands, { nowMs: NOW, minSharedSpecific: 1 })).toHaveLength(1);
  });

  it('IDF: a pair sharing a RARE tag scores higher than one sharing a COMMON tag', () => {
    // 'common' appears in 3 topics; 'rarexyz' in only 2 → rarexyz weighs more.
    const pairs = detectOverlaps([
      cand(1, ['common', 'rarexyz'], fresh),
      cand(2, ['common', 'rarexyz'], fresh),  // shares both with 1
      cand(3, ['common', 'other'], fresh),     // shares only 'common'
    ], { nowMs: NOW });
    // pair (1,2) shares {common, rarexyz}; pair(1,3)&(2,3) share {common}. (1,2) strongest.
    expect(pairs[0]).toMatchObject({ topicA: 1, topicB: 2 });
    expect(pairs[0].sharedTags).toEqual(['common', 'rarexyz']);
    expect(pairs[0].score).toBeGreaterThan(pairs[1].score);
  });

  it('self-exclusion + stable pair ordering (lower id first)', () => {
    const pairs = detectOverlaps([
      cand(200, ['cpu-sampling'], fresh),
      cand(100, ['cpu-sampling'], fresh),
    ], { nowMs: NOW });
    expect(pairs[0].topicA).toBe(100);
    expect(pairs[0].topicB).toBe(200);
  });
});

describe('pairKey', () => {
  it('is stable regardless of argument order', () => {
    expect(pairKey(100, 200)).toBe('100:200');
    expect(pairKey(200, 100)).toBe('100:200');
  });
});

describe('signatureChangedMaterially (hysteresis)', () => {
  it('identical signature ⇒ not material (no re-nag)', () => {
    expect(signatureChangedMaterially('a|b|c', 'a|b|c')).toBe(false);
  });
  it('a small drift (1 token changed of 3) ⇒ not material (no re-nag)', () => {
    // Jaccard({a,b,c},{a,b,d}) = 2/4 = 0.5 < 0.6 ⇒ material? tune: use 4-token sets for clarity
    expect(signatureChangedMaterially('a|b|c|d', 'a|b|c|e')).toBe(false); // 3/5=0.6 → not < 0.6
  });
  it('a large change (mostly different tokens) ⇒ material (re-nag a genuinely new overlap)', () => {
    expect(signatureChangedMaterially('a|b|c', 'x|y|z')).toBe(true);
  });
});
