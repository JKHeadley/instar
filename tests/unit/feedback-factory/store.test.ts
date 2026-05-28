/**
 * Unit tests (Tier 1) — InMemoryFeedbackStore data-access seam.
 *
 * Verifies the store's create/merge/reopen field mutations mirror the reference,
 * and the read filters (unprocessed-only, oldest-first; active = not resolved).
 */

import { describe, it, expect } from 'vitest';
import { InMemoryFeedbackStore } from '../../../src/feedback-factory/store/FeedbackStore.js';
import type { ReopenDecision } from '../../../src/feedback-factory/processor/reopen.js';

const item = (id: string, extra = {}) => ({ feedbackId: id, title: `t-${id}`, description: `d-${id}`, type: 'bug', ...extra });

describe('InMemoryFeedbackStore', () => {
  it('returns unprocessed feedback oldest-first, excluding processed', () => {
    const s = new InMemoryFeedbackStore({ feedback: [
      item('fb-2', { receivedAt: '2026-05-02T00:00:00Z' }),
      item('fb-1', { receivedAt: '2026-05-01T00:00:00Z' }),
      item('fb-done', { receivedAt: '2026-05-03T00:00:00Z', status: 'processing' }),
    ]});
    expect(s.getUnprocessedFeedback().map(f => f.feedbackId)).toEqual(['fb-1', 'fb-2']);
  });

  it('getActiveClusters excludes resolved', () => {
    const s = new InMemoryFeedbackStore({ clusters: [
      { clusterId: 'c-open', title: 'o', description: 'd', status: 'investigating' },
      { clusterId: 'c-res', title: 'r', description: 'd', status: 'resolved' },
    ]});
    expect(s.getActiveClusters().map(c => c.clusterId)).toEqual(['c-open']);
  });

  it('upsertClusterFromItem creates then bumps reportCount + created counter', () => {
    const s = new InMemoryFeedbackStore();
    s.upsertClusterFromItem('c1', item('fb-1'));
    expect(s.getCluster('c1')?.reportCount).toBe(1);
    expect(s.metrics().created).toBe(1);
    s.upsertClusterFromItem('c1', item('fb-2'));
    expect(s.getCluster('c1')?.reportCount).toBe(2);
    expect(s.metrics().created).toBe(1); // not created again
  });

  it('mergeIntoCluster bumps reportCount + merged counter', () => {
    const s = new InMemoryFeedbackStore({ clusters: [{ clusterId: 'c1', title: 't', description: 'd', reportCount: 3 }] });
    s.mergeIntoCluster('c1', item('fb-1'));
    expect(s.getCluster('c1')?.reportCount).toBe(4);
    expect(s.metrics().merged).toBe(1);
  });

  it('applyReopen sets status, bumps recurrence (when decided), appends the audit note', () => {
    const s = new InMemoryFeedbackStore({ clusters: [{ clusterId: 'c1', title: 't', description: 'd', status: 'fixed' }] });
    const decision: ReopenDecision = { newStatus: 'investigating', bumpRecurrence: true, annotateField: 'researchNotes', noteTag: 'REGRESSION', note: 'NOTE-A' };
    s.applyReopen('c1', decision);
    const c = s.getCluster('c1')!;
    expect(c.status).toBe('investigating');
    expect(c.recurrenceCount).toBe(1);
    expect(c.researchNotes).toBe('NOTE-A');
    expect(s.metrics().reopened).toBe(1);
    // second reopen appends with a blank-line separator
    s.applyReopen('c1', { ...decision, note: 'NOTE-B' });
    expect(c.researchNotes).toBe('NOTE-A\n\nNOTE-B');
    expect(c.recurrenceCount).toBe(2);
  });

  it('aged-reopen does not bump recurrence', () => {
    const s = new InMemoryFeedbackStore({ clusters: [{ clusterId: 'c1', title: 't', description: 'd', status: 'deferred' }] });
    s.applyReopen('c1', { newStatus: 'new', bumpRecurrence: false, annotateField: 'actionTaken', noteTag: 'AGED-REOPEN', note: 'N' });
    expect(s.getCluster('c1')?.recurrenceCount).toBeUndefined();
    expect(s.getCluster('c1')?.actionTaken).toBe('N');
  });

  it('addFeedback / hasFeedback (the receiver dedup seam)', () => {
    const s = new InMemoryFeedbackStore();
    expect(s.hasFeedback('fb-1')).toBe(false);
    s.addFeedback(item('fb-1'));
    expect(s.hasFeedback('fb-1')).toBe(true);
    // added feedback defaults to unprocessed → visible to the processor
    expect(s.getUnprocessedFeedback().map(f => f.feedbackId)).toContain('fb-1');
  });
});
