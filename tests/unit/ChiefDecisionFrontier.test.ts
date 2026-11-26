import { describe, expect, it, vi } from 'vitest';
import { assessChiefDecisionFrontier, prepareChiefDecision } from '../../src/core/ChiefDecisionFrontier.js';

const predecessor = { agent: 'echo', store: 'chief-of-staff', stream: 'chief-m1', incarnation: 'boot-1', writer: 'm1', leaseEpoch: 4 };
const digest = 'a'.repeat(64);
const seal = { ...predecessor, terminalSequence: 2, digest };
const prefix = { stream: seal.stream, incarnation: seal.incarnation, terminalSequence: 2, digest };

describe('Chief decision successor frontier', () => {
  it('requires an authenticated lease predecessor, seal and exact prefix', () => {
    expect(assessChiefDecisionFrontier(predecessor, seal, prefix)).toBe('current');
    expect(assessChiefDecisionFrontier(null, seal, prefix)).toBe('unavailable');
    expect(assessChiefDecisionFrontier(predecessor, null, prefix)).toBe('unavailable');
    expect(assessChiefDecisionFrontier(predecessor, seal, null)).toBe('unavailable');
  });

  it('refuses delayed rows, a mismatched digest or a different predecessor', () => {
    expect(assessChiefDecisionFrontier(predecessor, seal, { ...prefix, terminalSequence: 1 })).toBe('unavailable');
    expect(assessChiefDecisionFrontier(predecessor, seal, { ...prefix, digest: 'b'.repeat(64) })).toBe('unavailable');
    expect(assessChiefDecisionFrontier(predecessor, seal, { ...prefix, incarnation: 'other' })).toBe('unavailable');
    expect(assessChiefDecisionFrontier(predecessor, { ...seal, leaseEpoch: 3 }, prefix)).toBe('unavailable');
  });

  it('retains unknown append outcomes after complete delivery', () => {
    expect(assessChiefDecisionFrontier(predecessor, { ...seal, unresolvedOperationId: 'op-1' }, prefix)).toBe('pending');
  });
});

describe('Chief decision verified manifest consumer', () => {
  const activation = { generation: 8, manifestDigest: 'd'.repeat(64), successorWriter: 'm2',
    successorEpoch: 5, successorIncarnation: 'boot-2' };
  const snapshot = { activation, predecessor, seal, prefix, union: { currentBinding: 'revised' } };

  it('holds delayed prefix and only classifies the old binding after delivery', () => {
    const previouslyRequested = vi.fn((union: typeof snapshot.union) =>
      union.currentBinding === 'original' ? 'approval' : null);
    expect(prepareChiefDecision(activation, { ...snapshot, prefix: { ...prefix, terminalSequence: 1 } },
      previouslyRequested)).toEqual({ status: 'unavailable' });
    expect(previouslyRequested).not.toHaveBeenCalled();
    expect(prepareChiefDecision(activation, snapshot, previouslyRequested)).toEqual({ status: 'stale' });
    expect(prepareChiefDecision(activation, snapshot, (union) => union.currentBinding))
      .toEqual({ status: 'prepared', value: 'revised' });
  });

  it('refuses a cached manifest after takeover, restore or an authority outage', () => {
    const prepare = vi.fn(() => 'approval');
    for (const current of [null, { ...activation, generation: 9 }, { ...activation, successorEpoch: 6 },
      { ...activation, manifestDigest: 'e'.repeat(64) }, { ...activation, successorIncarnation: 'boot-3' }]) {
      expect(prepareChiefDecision(current, snapshot, prepare)).toEqual({ status: 'unavailable' });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps an uncertain predecessor operation pending after delivery', () => {
    const prepare = vi.fn(() => 'approval');
    expect(prepareChiefDecision(activation, { ...snapshot, seal: { ...seal, unresolvedOperationId: 'op-1' } }, prepare))
      .toEqual({ status: 'pending' });
    expect(prepare).not.toHaveBeenCalled();
  });
});
