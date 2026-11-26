import { describe, expect, it } from 'vitest';
import { assessChiefDecisionFrontier } from '../../src/core/ChiefDecisionFrontier.js';

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
