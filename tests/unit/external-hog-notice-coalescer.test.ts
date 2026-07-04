import { describe, it, expect } from 'vitest';
import { coalesceNotices, type Notice } from '../../src/monitoring/ExternalHogNoticeCoalescer.js';

/**
 * ExternalHogNoticeCoalescer — P17 notification bounding (CMT-1901, §6). One coalescing
 * chokepoint over all notice classes: per-signature dedup, per-window budget, severity order
 * on exhaustion, and live kills always pierce the budget.
 */
const n = (cls: Notice['cls'], signature: string): Notice => ({ cls, signature, text: `${cls}:${signature}` });

describe('coalesceNotices — per-signature dedup', () => {
  it('collapses duplicate (class, signature) within the batch to one', () => {
    const r = coalesceNotices([n('hog-left-alive', 's1'), n('hog-left-alive', 's1')], { budgetPerWindow: 4 });
    expect(r.emitted).toHaveLength(1);
  });
  it('dedups against signatures already emitted this window', () => {
    const r = coalesceNotices([n('hog-left-alive', 's1')], {
      budgetPerWindow: 4,
      alreadyEmittedSignatures: new Set(['hog-left-alive::s1']),
    });
    expect(r.emitted).toHaveLength(0);
  });
  it('the SAME signature in DIFFERENT classes is not deduped (different notices)', () => {
    const r = coalesceNotices([n('kill', 's1'), n('hog-left-alive', 's1')], { budgetPerWindow: 4 });
    expect(r.emitted).toHaveLength(2);
  });
});

describe('coalesceNotices — budget + severity ordering on exhaustion', () => {
  it('keeps at most budget non-kill notices, highest-severity first', () => {
    const r = coalesceNotices(
      [n('hog-left-alive', 'a'), n('floor-veto-downgrade', 'b'), n('decider-unavailable', 'c'), n('hog-left-alive', 'd')],
      { budgetPerWindow: 2 },
    );
    expect(r.emitted).toHaveLength(2);
    // Highest severity kept: decider-unavailable (2) + floor-veto-downgrade (1).
    const classes = r.emitted.map((e) => e.cls).sort();
    expect(classes).toEqual(['decider-unavailable', 'floor-veto-downgrade']);
    expect(r.droppedTotal).toBe(2);
    expect(r.droppedByClass['hog-left-alive']).toBe(2);
  });
});

describe('coalesceNotices — live kills ALWAYS pierce the budget', () => {
  it('all kills are emitted even beyond the budget', () => {
    const r = coalesceNotices(
      [n('kill', 'k1'), n('kill', 'k2'), n('kill', 'k3'), n('hog-left-alive', 'h1')],
      { budgetPerWindow: 1 },
    );
    // 3 kills all kept (pierce budget); budget=1 already exhausted by kills, so the hog notice drops.
    expect(r.emitted.filter((e) => e.cls === 'kill')).toHaveLength(3);
    expect(r.emitted.some((e) => e.cls === 'hog-left-alive')).toBe(false);
    expect(r.droppedByClass['hog-left-alive']).toBe(1);
  });
  it('kills + remaining budget still admits some non-kills', () => {
    const r = coalesceNotices([n('kill', 'k1'), n('decider-unavailable', 'd1')], { budgetPerWindow: 4 });
    expect(r.emitted).toHaveLength(2);
  });
});

describe('coalesceNotices — robustness', () => {
  it('a zero/negative/non-finite budget still emits all kills, drops all non-kills', () => {
    const r = coalesceNotices([n('kill', 'k1'), n('hog-left-alive', 'h1')], { budgetPerWindow: 0 });
    expect(r.emitted).toEqual([expect.objectContaining({ cls: 'kill' })]);
    expect(r.droppedTotal).toBe(1);
    const r2 = coalesceNotices([n('kill', 'k1'), n('hog-left-alive', 'h1')], { budgetPerWindow: NaN });
    expect(r2.emitted.filter((e) => e.cls === 'kill')).toHaveLength(1);
  });
  it('ignores malformed notices (unknown class)', () => {
    const bad = { cls: 'bogus', signature: 's', text: 't' } as unknown as Notice;
    const r = coalesceNotices([bad, n('kill', 'k1')], { budgetPerWindow: 4 });
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]!.cls).toBe('kill');
  });
  it('an empty batch emits nothing', () => {
    const r = coalesceNotices([], { budgetPerWindow: 4 });
    expect(r.emitted).toHaveLength(0);
    expect(r.droppedTotal).toBe(0);
  });
});
