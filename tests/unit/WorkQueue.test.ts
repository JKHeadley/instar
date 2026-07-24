import { describe, expect, it } from 'vitest';
import { normalizeAndRank, scoreWorkItem, WorkQueueRegistry, type WorkItem } from '../../src/core/WorkQueue.js';

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'CMT-1', source: 'commitment', sourceRef: '1', title: 'Fix delivery', kind: 'defect',
  goalAlignment: [], urgency: 0, ageDays: 0, userDirected: false, status: 'open', assignee: null, ...over,
});

describe('WorkQueue', () => {
  it('ranks explicit priority, user direction, and age deterministically', () => {
    expect(scoreWorkItem(item({ priority: 'critical', userDirected: true, ageDays: 10 }))).toBeGreaterThan(scoreWorkItem(item()));
  });
  it('deduplicates cross-source overlap and excludes terminal work', () => {
    const ranked = normalizeAndRank([item(), item({ id: 'ACT-9', source: 'evolution-action' }), item({ id: 'CMT-2', status: 'completed' })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].id).toBe('CMT-1');
  });
  it('rescoring reads all four adapters', () => {
    const registry = new WorkQueueRegistry({ commitments: () => [item()], evolutionActions: () => [], feedback: () => [], topics: () => [] });
    expect(registry.list()).toHaveLength(1);
  });
});
