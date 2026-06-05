/**
 * Unit tests (Tier 1) — the structural never-re-derive guard (spec §2.4).
 *
 * Covers both sides of every immutability boundary + the GuardedFeedbackStore decorator's
 * refuse-vs-delegate behavior, including the processor running over a guarded store: a
 * wrong-date backfill must be PHYSICALLY unable to overwrite curated state.
 */

import { describe, it, expect } from 'vitest';
import {
  hasGovernanceNotes,
  isClusterImmutable,
  GuardedFeedbackStore,
  GOVERNANCE_FIELDS,
} from '../../../src/feedback-factory/migration/immutableGuard.js';
import { InMemoryFeedbackStore } from '../../../src/feedback-factory/store/FeedbackStore.js';
import { processUnprocessed } from '../../../src/feedback-factory/processor/process.js';
import type { Cluster, FeedbackItem } from '../../../src/feedback-factory/processor/types.js';

const CUTOVER = '2026-06-05T00:00:00Z';
const cluster = (over: Partial<Cluster>): Cluster => ({ clusterId: 'c1', title: 't', description: 'd', ...over });

describe('hasGovernanceNotes', () => {
  it('is true when any governance field is non-empty', () => {
    for (const f of GOVERNANCE_FIELDS) {
      expect(hasGovernanceNotes(cluster({ [f]: 'a human decision' }))).toBe(true);
    }
  });
  it('is false when all governance fields are missing, null, or whitespace', () => {
    expect(hasGovernanceNotes(cluster({}))).toBe(false);
    expect(hasGovernanceNotes(cluster({ governanceNotes: '' }))).toBe(false);
    expect(hasGovernanceNotes(cluster({ processingNotes: '   ' }))).toBe(false);
    expect(hasGovernanceNotes(cluster({ actionTaken: null as unknown as string }))).toBe(false);
  });
});

describe('isClusterImmutable', () => {
  it('IMMUTABLE: governance notes present, regardless of a post-cutover date', () => {
    expect(isClusterImmutable(cluster({ createdAt: '2026-07-01T00:00:00Z', actionTaken: 'patched' }), CUTOVER)).toBe(true);
  });
  it('IMMUTABLE: createdAt strictly before cutover', () => {
    expect(isClusterImmutable(cluster({ createdAt: '2026-06-04T23:59:59Z' }), CUTOVER)).toBe(true);
  });
  it('MUTABLE: createdAt at/after cutover and no governance notes', () => {
    expect(isClusterImmutable(cluster({ createdAt: CUTOVER }), CUTOVER)).toBe(false);
    expect(isClusterImmutable(cluster({ createdAt: '2026-06-05T00:00:01Z' }), CUTOVER)).toBe(false);
  });
  it('IMMUTABLE (fail-safe): createdAt present but unparseable', () => {
    expect(isClusterImmutable(cluster({ createdAt: 'not-a-date' }), CUTOVER)).toBe(true);
  });
  it('MUTABLE: no createdAt and no governance notes (a fresh post-cutover cluster)', () => {
    expect(isClusterImmutable(cluster({}), CUTOVER)).toBe(false);
  });
});

describe('GuardedFeedbackStore — refuse vs delegate', () => {
  const preCutover = cluster({ clusterId: 'curated', createdAt: '2026-01-01T00:00:00Z', reportCount: 5 });
  const postCutover = cluster({ clusterId: 'fresh', createdAt: '2026-06-05T12:00:00Z', reportCount: 1 });
  const governed = cluster({ clusterId: 'governed', createdAt: '2026-07-01T00:00:00Z', actionTaken: 'shipped', reportCount: 3 });
  const item: FeedbackItem = { feedbackId: 'f1', title: 't', description: 'd', type: 'bug' };

  const mk = () => {
    const inner = new InMemoryFeedbackStore({ clusters: [{ ...preCutover }, { ...postCutover }, { ...governed }] });
    const guard = new GuardedFeedbackStore(inner, { cutoverTimestamp: CUTOVER, now: () => 'NOW' });
    return { inner, guard };
  };

  it('REFUSES merge into a pre-cutover cluster (inner untouched, violation recorded)', () => {
    const { inner, guard } = mk();
    guard.mergeIntoCluster('curated', item);
    expect(inner.getCluster('curated')!.reportCount).toBe(5); // not bumped
    expect(guard.violations).toEqual([{ clusterId: 'curated', operation: 'merge', reason: 'pre-cutover', feedbackId: 'f1', at: 'NOW' }]);
  });

  it('REFUSES merge into a governance-noted cluster (reason: governance-notes)', () => {
    const { inner, guard } = mk();
    guard.mergeIntoCluster('governed', item);
    expect(inner.getCluster('governed')!.reportCount).toBe(3);
    expect(guard.violations[0].reason).toBe('governance-notes');
  });

  it('DELEGATES merge into a post-cutover cluster (inner mutated, no violation)', () => {
    const { inner, guard } = mk();
    guard.mergeIntoCluster('fresh', item);
    expect(inner.getCluster('fresh')!.reportCount).toBe(2); // bumped
    expect(guard.violations).toHaveLength(0);
  });

  it('REFUSES applyReopen on an immutable cluster but DELEGATES on a mutable one', () => {
    const { inner, guard } = mk();
    const decision = { newStatus: 'reopened', bumpRecurrence: true, annotateField: 'processingNotes' as const, note: 'x' };
    guard.applyReopen('curated', decision);
    expect(inner.getCluster('curated')!.status).toBeUndefined(); // refused
    guard.applyReopen('fresh', decision);
    expect(inner.getCluster('fresh')!.status).toBe('reopened'); // delegated
  });

  it('REFUSES upsert onto an existing immutable cluster, but DELEGATES creating a new cluster', () => {
    const { inner, guard } = mk();
    guard.upsertClusterFromItem('curated', item); // existing + immutable → refuse
    expect(inner.getCluster('curated')!.reportCount).toBe(5);
    guard.upsertClusterFromItem('brand-new', item); // does not exist → create
    expect(inner.getCluster('brand-new')).toBeDefined();
    expect(guard.violations).toHaveLength(1);
  });

  it('passes reads + non-curated writes straight through', () => {
    const { inner, guard } = mk();
    expect(guard.getActiveClusters().length).toBe(inner.getActiveClusters().length);
    guard.addFeedback(item);
    expect(inner.hasFeedback('f1')).toBe(true);
  });

  it('a throwing onViolation sink never breaks the store (still refuses, still records)', () => {
    const inner = new InMemoryFeedbackStore({ clusters: [{ ...preCutover }] });
    const guard = new GuardedFeedbackStore(inner, {
      cutoverTimestamp: CUTOVER,
      now: () => 'NOW',
      onViolation: () => { throw new Error('audit sink down'); },
    });
    expect(() => guard.mergeIntoCluster('curated', item)).not.toThrow();
    expect(inner.getCluster('curated')!.reportCount).toBe(5);
    expect(guard.violations).toHaveLength(1);
  });
});

describe('GuardedFeedbackStore — processor cannot re-derive curated state', () => {
  it('processUnprocessed over a guarded store leaves a curated cluster untouched', () => {
    // A curated, pre-cutover cluster whose title would otherwise attract a near-duplicate report.
    const curated = cluster({
      clusterId: 'login-bug',
      title: 'Login button unresponsive on mobile',
      description: 'Tapping login does nothing on iOS Safari',
      fingerprint: 'fp-login',
      createdAt: '2026-02-01T00:00:00Z',
      status: 'triaged',
      reportCount: 9,
      actionTaken: 'Assigned to platform team',
    });
    const newReport: FeedbackItem = {
      feedbackId: 'r-new',
      title: 'Login button unresponsive on mobile',
      description: 'Tapping login does nothing on iOS Safari',
      type: 'bug',
      status: 'unprocessed',
      receivedAt: '2026-06-05T10:00:00Z',
    };
    const inner = new InMemoryFeedbackStore({ clusters: [curated], feedback: [newReport] });
    const guard = new GuardedFeedbackStore(inner, { cutoverTimestamp: CUTOVER });

    processUnprocessed(guard, '2026-06-05T10:05:00Z');

    const after = inner.getCluster('login-bug')!;
    expect(after.reportCount).toBe(9); // curated count preserved — NOT bumped
    expect(after.status).toBe('triaged'); // lifecycle preserved
    expect(after.actionTaken).toBe('Assigned to platform team'); // governance note preserved
    expect(guard.violations.length).toBeGreaterThan(0); // the attempted mutation was caught
  });
});
