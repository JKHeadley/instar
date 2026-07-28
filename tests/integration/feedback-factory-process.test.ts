/**
 * Integration test (Tier 2) — feedback-factory processing composition.
 *
 * Exercises the assembled pipeline end-to-end over the real InMemoryFeedbackStore:
 * read unprocessed → clusterItems (decide) → apply (create/merge) → computeReopen
 * on regression → markProcessed → observability counters. The constituent decision
 * logic is each parity-verified against the reference (increments 4 + 8); this test
 * proves they COMPOSE correctly over the data-access seam.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryFeedbackStore } from '../../src/feedback-factory/store/FeedbackStore.js';
import { processUnprocessed } from '../../src/feedback-factory/processor/process.js';

const NOW = '2026-05-27T00:00:00.000Z';
const item = (id: string, title: string, description: string, receivedAt: string) =>
  ({ feedbackId: id, title, description, type: 'bug', receivedAt });

describe('processUnprocessed — full clustering + reopen pipeline over the store', () => {
  it('creates new clusters, merges duplicates, and counts them', () => {
    const store = new InMemoryFeedbackStore({
      feedback: [
        item('fb-1', 'gitsync pull fails intermittently', 'times out under load', '2026-05-01T00:00:00Z'),
        item('fb-2', 'gitsync pull fails intermittently', 'times out under load', '2026-05-01T01:00:00Z'),
        item('fb-3', 'totally separate telemetry export bug', 'csv drops a row', '2026-05-01T02:00:00Z'),
      ],
    });

    const { results, metrics } = processUnprocessed(store, NOW);

    expect(results[0].action).toBe('create'); // fb-1 → new cluster
    expect(results[1].action).toBe('merge');  // fb-2 → fb-1's cluster (order-dependent)
    expect(results[1].clusterId).toBe(results[0].clusterId);
    expect(results[2].action).toBe('create'); // fb-3 → its own cluster

    expect(metrics.created).toBe(2);
    expect(metrics.merged).toBe(1);
    expect(metrics.captured).toBe(3); // all three marked processed
    // every item is now processed
    expect(store.getUnprocessedFeedback()).toHaveLength(0);
  });

  it('auto-reopens a fixed cluster on a regression and bumps recurrence', () => {
    const store = new InMemoryFeedbackStore({
      clusters: [{ clusterId: 'c-auth', title: 'auth token refresh broken', description: 'returns 401 after expiry', status: 'fixed', fixedInVersion: '1.2.3' }],
      feedback: [item('fb-9', 'auth token refresh broken', 'returns 401 after expiry', '2026-05-02T00:00:00Z')],
    });

    const { results, metrics } = processUnprocessed(store, NOW);

    expect(results[0].action).toBe('merge');
    expect(results[0].note).toContain('possible regression');
    expect(metrics.reopened).toBe(1);

    const c = store.getCluster('c-auth')!;
    expect(c.status).toBe('investigating');       // reopened from 'fixed'
    expect(c.recurrenceCount).toBe(1);            // regression bumps recurrence
    expect(c.researchNotes).toContain('REGRESSION');
    expect(c.researchNotes).toContain('fb-9');
  });

  it('applies the 0.55 false-merge guard: a mid-similarity item does NOT merge into a fixed cluster', () => {
    const store = new InMemoryFeedbackStore({
      clusters: [{ clusterId: 'c-fixed', title: 'alpha beta gamma delta', description: '', status: 'fixed' }],
      feedback: [item('fb-1', 'alpha beta epsilon zeta', '', '2026-05-02T00:00:00Z')],
    });
    const { results, metrics } = processUnprocessed(store, NOW);
    expect(results[0].action).toBe('create');     // blocked by the higher fixed threshold
    expect(metrics.reopened).toBe(0);
  });

  it('is a no-op with empty input', () => {
    const store = new InMemoryFeedbackStore();
    const { results, metrics } = processUnprocessed(store, NOW);
    expect(results).toEqual([]);
    expect(metrics).toEqual({ captured: 0, created: 0, merged: 0, reopened: 0 });
  });
});
