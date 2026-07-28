/**
 * Unit tests for ParallelWorkSentinel (Parallel-Work Awareness Phase B — the proactive
 * overlap councilor). Spec: docs/specs/parallel-activity-coherence.md (Part 2).
 *
 * Drives the stateful dedup/cooldown/hysteresis with an injected getActivities seam +
 * explicit nowMs (no real timers) — exhaustive coverage of "nudge once, don't re-nag".
 */
import { describe, it, expect, vi } from 'vitest';
import { ParallelWorkSentinel } from '../../src/monitoring/ParallelWorkSentinel.js';
import type { OverlapCandidate } from '../../src/monitoring/ParallelWorkOverlap.js';

const T0 = Date.parse('2026-06-04T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function activitiesWith(tagsByTopic: Record<number, string[]>, nowMs: number): OverlapCandidate[] {
  return Object.entries(tagsByTopic).map(([id, tags]) => ({
    topicId: Number(id), tags, updatedAt: nowMs - 5 * 60 * 1000, running: true,
  }));
}

describe('ParallelWorkSentinel', () => {
  it('emits one overlap nudge for a fresh overlap', () => {
    const onOverlap = vi.fn();
    const s = new ParallelWorkSentinel({
      getActivities: (now) => activitiesWith({ 1: ['cpu-sampling', 'resourceledger'], 2: ['cpu-sampling', 'reaper'] }, now),
    });
    s.on('overlap', onOverlap);
    const fired = s.tick(T0);
    expect(fired).toHaveLength(1);
    expect(onOverlap).toHaveBeenCalledTimes(1);
    expect(fired[0].pair.sharedTags).toEqual(['cpu-sampling']);
    expect(fired[0].message).toMatch(/topics 1 and 2/);
  });

  it('does NOT re-nudge the same overlap within the cooldown (no re-nag)', () => {
    const s = new ParallelWorkSentinel({
      getActivities: (now) => activitiesWith({ 1: ['cpu-sampling'], 2: ['cpu-sampling'] }, now),
      nudgeCooldownMs: 1 * HOUR,
    });
    expect(s.tick(T0)).toHaveLength(1);
    expect(s.tick(T0 + 5 * 60 * 1000)).toHaveLength(0);  // 5 min later — silent
    expect(s.tick(T0 + 30 * 60 * 1000)).toHaveLength(0); // 30 min later — silent
  });

  it('re-nudges after the cooldown passes', () => {
    const s = new ParallelWorkSentinel({
      getActivities: (now) => activitiesWith({ 1: ['cpu-sampling'], 2: ['cpu-sampling'] }, now),
      nudgeCooldownMs: 1 * HOUR,
    });
    expect(s.tick(T0)).toHaveLength(1);
    expect(s.tick(T0 + 90 * 60 * 1000)).toHaveLength(1); // 90 min later — past cooldown, fires again
  });

  it('hysteresis: a small focus tweak (same overlap) does NOT re-nudge within cooldown', () => {
    let tags = { 1: ['cpu-sampling', 'a', 'b', 'c'], 2: ['cpu-sampling', 'a', 'b', 'c'] };
    const s = new ParallelWorkSentinel({
      getActivities: (now) => activitiesWith(tags, now),
      nudgeCooldownMs: 4 * HOUR,
    });
    expect(s.tick(T0)).toHaveLength(1);
    // one shared tag changes (cpu-sampling,a,b,c → cpu-sampling,a,b,d): Jaccard 3/5=0.6, not material
    tags = { 1: ['cpu-sampling', 'a', 'b', 'd'], 2: ['cpu-sampling', 'a', 'b', 'd'] };
    expect(s.tick(T0 + 10 * 60 * 1000)).toHaveLength(0);
  });

  it('tracks one dedup entry per pair; audits transitions', () => {
    const audit = vi.fn();
    const s = new ParallelWorkSentinel({
      getActivities: (now) => activitiesWith({ 1: ['cpu-sampling'], 2: ['cpu-sampling'] }, now),
      nudgeCooldownMs: 4 * HOUR,
      audit,
    });
    s.tick(T0);
    s.tick(T0 + 60 * 1000);
    expect(s.trackedPairCount()).toBe(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'nudged' }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'deduped-hysteresis' }));
  });

  it('no overlap ⇒ no nudge', () => {
    const onOverlap = vi.fn();
    const s = new ParallelWorkSentinel({
      getActivities: (now) => activitiesWith({ 1: ['resourceledger'], 2: ['telegram'] }, now),
    });
    s.on('overlap', onOverlap);
    expect(s.tick(T0)).toEqual([]);
    expect(onOverlap).not.toHaveBeenCalled();
  });
});
