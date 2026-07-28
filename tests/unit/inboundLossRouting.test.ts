/**
 * F3 (Inbound Delivery Is Sacred) — pure loss-routing tests (Tier 1).
 * Covers the decision boundary: a lost inbound message routes to its ORIGINATING
 * topic (sessionKey = topic id), and a message with no resolvable topic is
 * counted as `unresolved` (which the caller must surface loudly, never drop).
 * Spec: docs/specs/inbound-delivery-sacred.md.
 */
import { describe, it, expect } from 'vitest';
import { planInboundLossNotices } from '../../src/core/inboundLossRouting.js';

describe('planInboundLossNotices', () => {
  it('routes each loss to its originating topic (sessionKey = topic id)', () => {
    const plan = planInboundLossNotices([{ sessionKey: '28744' }, { sessionKey: '28744' }, { sessionKey: '100' }]);
    expect(plan.perTopic).toEqual([
      { topicId: 100, count: 1 },
      { topicId: 28744, count: 2 },
    ]);
    expect(plan.unresolved).toBe(0);
  });

  it('a non-numeric sessionKey is unresolved (never silently assigned to a topic)', () => {
    const plan = planInboundLossNotices([{ sessionKey: 'legacy-single-file' }, { sessionKey: '' }]);
    expect(plan.perTopic).toEqual([]);
    expect(plan.unresolved).toBe(2);
  });

  it('mixes resolvable + unresolved correctly', () => {
    const plan = planInboundLossNotices([{ sessionKey: '5' }, { sessionKey: 'x' }, { sessionKey: '5' }]);
    expect(plan.perTopic).toEqual([{ topicId: 5, count: 2 }]);
    expect(plan.unresolved).toBe(1);
  });

  it('zero/negative sessionKey is treated as unresolved (a topic id is positive)', () => {
    const plan = planInboundLossNotices([{ sessionKey: '0' }, { sessionKey: '-3' }]);
    expect(plan.perTopic).toEqual([]);
    expect(plan.unresolved).toBe(2);
  });

  it('empty input → empty plan', () => {
    const plan = planInboundLossNotices([]);
    expect(plan.perTopic).toEqual([]);
    expect(plan.unresolved).toBe(0);
  });

  it('per-topic order is deterministic (ascending topic id)', () => {
    const plan = planInboundLossNotices([{ sessionKey: '900' }, { sessionKey: '12' }, { sessionKey: '300' }]);
    expect(plan.perTopic.map((p) => p.topicId)).toEqual([12, 300, 900]);
  });
});
