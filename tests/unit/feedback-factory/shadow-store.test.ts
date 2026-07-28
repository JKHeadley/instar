/**
 * Unit tests (Tier 1) — ReadOnlyShadowStore (dry-run write-guard).
 *
 * Both-sides-of-boundary: every READ delegates to the wrapped store; every WRITE
 * throws ShadowStoreWriteError. This is the structural guarantee that the dry-run
 * processor can never mutate Portal's canonical feedback DB (spec §2.5).
 */

import { describe, it, expect } from 'vitest';
import { InMemoryFeedbackStore } from '../../../src/feedback-factory/store/FeedbackStore.js';
import {
  ReadOnlyShadowStore,
  ShadowStoreWriteError,
} from '../../../src/feedback-factory/store/ReadOnlyShadowStore.js';
import type { FeedbackItem, Cluster } from '../../../src/feedback-factory/processor/types.js';

const seedFeedback: FeedbackItem[] = [
  { feedbackId: 'fb-1', title: 'gitsync.pull fails', description: 'pull throws', type: 'bug', receivedAt: '2026-01-01T00:00:00Z' },
];
const seedClusters: Cluster[] = [
  { clusterId: 'cluster-gitsync-pull', title: 'gitsync.pull fails', description: 'pull throws', type: 'bug', status: 'investigating', fingerprint: 'abc123', recurrenceCount: 2 },
];

function makeStores() {
  const inner = new InMemoryFeedbackStore({ feedback: seedFeedback, clusters: seedClusters });
  const shadow = new ReadOnlyShadowStore(inner);
  return { inner, shadow };
}

describe('ReadOnlyShadowStore — reads delegate', () => {
  it('getUnprocessedFeedback returns the wrapped store\'s data', () => {
    const { inner, shadow } = makeStores();
    expect(shadow.getUnprocessedFeedback()).toEqual(inner.getUnprocessedFeedback());
    expect(shadow.getUnprocessedFeedback().map((f) => f.feedbackId)).toEqual(['fb-1']);
  });

  it('getActiveClusters / getCluster delegate', () => {
    const { shadow } = makeStores();
    expect(shadow.getActiveClusters().map((c) => c.clusterId)).toEqual(['cluster-gitsync-pull']);
    expect(shadow.getCluster('cluster-gitsync-pull')?.fingerprint).toBe('abc123');
    expect(shadow.getCluster('missing')).toBeUndefined();
  });

  it('hasFeedback / metrics / listDispatches / findDispatchByTitle delegate', () => {
    const { shadow } = makeStores();
    expect(shadow.hasFeedback('fb-1')).toBe(true);
    expect(shadow.hasFeedback('nope')).toBe(false);
    expect(shadow.metrics()).toEqual({ captured: 0, created: 0, merged: 0, reopened: 0 });
    expect(shadow.listDispatches()).toEqual([]);
    expect(shadow.findDispatchByTitle('anything')).toBeUndefined();
  });
});

describe('ReadOnlyShadowStore — writes throw', () => {
  const item: FeedbackItem = { feedbackId: 'fb-x', title: 't', description: 'd', type: 'bug' };

  it('upsertClusterFromItem throws and does NOT mutate the inner store', () => {
    const { inner, shadow } = makeStores();
    expect(() => shadow.upsertClusterFromItem('c', item)).toThrow(ShadowStoreWriteError);
    // inner store is untouched
    expect(inner.getActiveClusters()).toHaveLength(1);
  });

  it('every mutating method throws ShadowStoreWriteError with the method name', () => {
    const { shadow } = makeStores();
    const calls: Array<[string, () => void]> = [
      ['upsertClusterFromItem', () => shadow.upsertClusterFromItem('c', item)],
      ['mergeIntoCluster', () => shadow.mergeIntoCluster('c', item)],
      ['applyReopen', () => shadow.applyReopen('c', { newStatus: 'new', bumpRecurrence: false, annotateField: 'researchNotes', noteTag: 'AGED-REOPEN', note: 'n' })],
      ['markProcessed', () => shadow.markProcessed('fb-1', 'c')],
      ['addFeedback', () => shadow.addFeedback(item)],
      ['createDispatch', () => shadow.createDispatch({ dispatchId: 'd', title: 't', type: 'bug', content: 'c' })],
    ];
    for (const [method, fn] of calls) {
      try {
        fn();
        throw new Error(`expected ${method} to throw`);
      } catch (e) {
        expect(e).toBeInstanceOf(ShadowStoreWriteError);
        expect((e as ShadowStoreWriteError).method).toBe(method);
      }
    }
  });
});
