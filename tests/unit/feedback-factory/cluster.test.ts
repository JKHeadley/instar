/**
 * Unit tests (Tier 1) — feedback-factory clustering driver (cmd_cluster port).
 *
 * Behavioral + both-sides-of-boundary coverage in CI. Byte-exact equivalence to
 * the REAL reference cmd_cluster is proven by the local parity harness
 * (scripts/feedback-factory/clustering-parity.mjs).
 */

import { describe, it, expect } from 'vitest';
import { clusterItems, pyRound3 } from '../../../src/feedback-factory/processor/cluster.js';
import type { Cluster, FeedbackItem } from '../../../src/feedback-factory/processor/types.js';

const item = (feedbackId: string, title: string, description: string, type = 'bug'): FeedbackItem =>
  ({ feedbackId, title, description, type });

describe('pyRound3 (Python round-half-to-even)', () => {
  it('rounds to 3 decimals', () => {
    expect(pyRound3(0.6)).toBe(0.6);
    expect(pyRound3(1 / 3)).toBe(0.333);
    expect(pyRound3(2 / 3)).toBe(0.667);
    expect(pyRound3(0)).toBe(0);
  });
  it('rounds half to even (not half-up)', () => {
    // 0.0625 → 3 decimals: 0.062 (2 is even) under round-half-to-even.
    expect(pyRound3(0.0625)).toBe(0.062);
    // 0.0635 → 0.064 (4 is even, 3 is odd so round up to even).
    expect(pyRound3(0.0635)).toBe(0.064);
  });
});

describe('clusterItems', () => {
  it('creates a new cluster when nothing matches', () => {
    const res = clusterItems([item('fb-1', 'totally novel widget crash', 'the widget explodes')], []);
    expect(res).toHaveLength(1);
    expect(res[0].action).toBe('create');
    expect(res[0].clusterId).toBe('cluster-totally-novel-widget-crash');
    expect(res[0].similarity).toBe(0.0);
  });

  it('merges into an identical open cluster', () => {
    const clusters: Cluster[] = [{ clusterId: 'c1', title: 'gitsync pull fails', description: 'times out', status: 'investigating' }];
    const res = clusterItems([item('fb-1', 'gitsync pull fails', 'times out')], clusters);
    expect(res[0].action).toBe('merge');
    expect(res[0].clusterId).toBe('c1');
    expect(res[0].similarity).toBe(1.0);
  });

  it('applies the 0.55 false-merge guard to fixed clusters (mid-score → create, not merge)', () => {
    // Item shares ~half the tokens with a FIXED cluster: ≥0.35 but <0.55 → create.
    const clusters: Cluster[] = [{ clusterId: 'fixedc', title: 'alpha beta gamma delta', description: '', status: 'fixed' }];
    const res = clusterItems([item('fb-1', 'alpha beta epsilon zeta', '')], clusters);
    expect(res[0].action).toBe('create'); // blocked by the higher fixed threshold
  });

  it('merges into a fixed cluster (regression) when score clears 0.55, with the regression note', () => {
    const clusters: Cluster[] = [{ clusterId: 'fixedc', title: 'auth token refresh broken', description: 'returns 401', status: 'fixed' }];
    const res = clusterItems([item('fb-1', 'auth token refresh broken', 'returns 401')], clusters);
    expect(res[0].action).toBe('merge');
    expect(res[0].note).toContain('possible regression');
  });

  it('merges into a deferred cluster with the reopen note', () => {
    const clusters: Cluster[] = [{ clusterId: 'defc', title: 'pin rotation edge case', description: 'skips on concurrent login', status: 'deferred' }];
    const res = clusterItems([item('fb-1', 'pin rotation edge case', 'skips on concurrent login')], clusters);
    expect(res[0].action).toBe('merge');
    expect(res[0].note).toContain('reopening');
  });

  it('is order-dependent: a later item matches a cluster created for an earlier item', () => {
    const items = [
      item('fb-1', 'brand new flaky timer bug', 'the timer fires twice'),
      item('fb-2', 'brand new flaky timer bug', 'the timer fires twice'),
    ];
    const res = clusterItems(items, []);
    expect(res[0].action).toBe('create');
    expect(res[1].action).toBe('merge'); // matched fb-1's freshly-created cluster
    expect(res[1].clusterId).toBe(res[0].clusterId);
  });
});
