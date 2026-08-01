import { describe, expect, it } from 'vitest';
import type { Initiative, InitiativeRound } from '../../src/core/InitiativeTracker.js';
import {
  deriveProjectRound,
  missingMergedEvidenceFields,
} from '../../src/core/ProjectRoundDerivation.js';

function item(id: string, overrides: Partial<Initiative> = {}): Initiative {
  return {
    id,
    title: id,
    description: 'fixture',
    status: 'active',
    phases: [{ id: 'p', name: 'p', status: 'pending' }],
    currentPhaseIndex: 0,
    lastTouchedAt: '2026-07-31T00:00:00.000Z',
    needsUser: false,
    blockers: [],
    links: [],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    kind: 'task',
    ...overrides,
  };
}

function round(itemIds: string[], status: InitiativeRound['status'] = 'pending'): InitiativeRound {
  return { name: 'round', itemIds, status };
}

const evidence = {
  prNumber: 1810,
  mergeCommitOid: 'abcdef1234567890',
  ciCheckedAt: '2026-07-31T00:00:00.000Z',
};

describe('deriveProjectRound', () => {
  it('earns complete from evidence-bearing merged members even when the cache says pending', () => {
    const children = new Map([
      ['a', item('a', { pipelineStage: 'merged', ...evidence })],
      ['b', item('b', { pipelineStage: 'merged', ...evidence, prNumber: 1811 })],
    ]);
    const derived = deriveProjectRound(round(['a', 'b']), children);
    expect(derived.terminalStatus).toBe('complete');
    expect(derived.effectiveStatus).toBe('complete');
  });

  it('refuses to derive completion from a merged label without its evidence', () => {
    const children = new Map([['a', item('a', { pipelineStage: 'merged' })]]);
    const derived = deriveProjectRound(round(['a']), children);
    expect(derived.terminalStatus).toBeUndefined();
    expect(derived.evidenceMissingByItem).toEqual({
      a: ['prNumber', 'mergeCommitOid', 'ciCheckedAt'],
    });
  });

  it('invalidates a cached terminal conclusion when members do not support it', () => {
    const children = new Map([['a', item('a', { pipelineStage: 'outline' })]]);
    const derived = deriveProjectRound(round(['a'], 'complete'), children);
    expect(derived.terminalStatus).toBeUndefined();
    expect(derived.effectiveStatus).toBe('regressed');
    expect(derived.incompleteItemIds).toEqual(['a']);
  });

  it('derives complete-with-skips from explicit terminal member states', () => {
    const children = new Map([
      ['a', item('a', { pipelineStage: 'merged', ...evidence })],
      ['b', item('b', { pipelineStage: 'skipped' })],
    ]);
    expect(deriveProjectRound(round(['a', 'b']), children).terminalStatus)
      .toBe('complete-with-skips');
  });

  it('does not let an empty round or a missing child vacuously complete', () => {
    expect(deriveProjectRound(round([]), new Map()).terminalStatus).toBeUndefined();
    const missing = deriveProjectRound(round(['gone']), new Map());
    expect(missing.terminalStatus).toBeUndefined();
    expect(missing.missingMemberIds).toEqual(['gone']);
  });
});

describe('missingMergedEvidenceFields', () => {
  it('requires a positive PR, a non-empty commit, and a real timestamp', () => {
    expect(missingMergedEvidenceFields({
      prNumber: 0,
      mergeCommitOid: 'not-a-sha',
      ciCheckedAt: 'not-a-date',
    })).toEqual(['prNumber', 'mergeCommitOid', 'ciCheckedAt']);
    expect(missingMergedEvidenceFields(evidence)).toEqual([]);
  });
});
