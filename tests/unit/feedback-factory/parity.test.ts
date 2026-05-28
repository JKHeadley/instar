/**
 * Unit tests (Tier 1) — Phase-3 parity invariant comparator.
 *
 * Both-sides-of-boundary for all three order-independent invariants (spec §2.3):
 *   1. per-cluster fingerprint  — match vs real (Python↔JS) divergence
 *   2. terminal status          — match vs divergence
 *   3. recurrence count         — match vs divergence
 * Plus the missing-on-one-side cases. The "correct" stored fingerprints are
 * computed with the real `clusterFingerprint`, so the test stays valid if the
 * fingerprint logic legitimately changes (the recorded-corpus harness pins the
 * exact bytes).
 */

import { describe, it, expect } from 'vitest';
import {
  clusterFingerprint,
  compareClusterFingerprints,
  compareClusterOutcomes,
  compareInvariants,
  type PortalCluster,
  type ClusterOutcome,
} from '../../../src/feedback-factory/processor/parity.js';

const cluster = (clusterId: string, type: string, title: string, extra: Partial<PortalCluster> = {}): PortalCluster => ({
  clusterId,
  type,
  title,
  fingerprint: clusterFingerprint({ type, title }), // correct by construction
  ...extra,
});

describe('compareClusterFingerprints (invariant 1)', () => {
  it('no divergence when stored fingerprints match the recomputed ones', () => {
    const clusters = [
      cluster('c1', 'bug', 'gitsync.pull fails on rebase'),
      cluster('c2', 'bug', 'telegram relay drops message'),
      cluster('c3', 'feature', 'add dark mode toggle'),
    ];
    expect(compareClusterFingerprints(clusters)).toEqual([]);
  });

  it('flags a cluster whose stored fingerprint diverges (the silent history-fork hazard)', () => {
    const good = cluster('c1', 'bug', 'gitsync.pull fails');
    const bad: PortalCluster = { ...cluster('c2', 'bug', 'telegram relay drops message'), fingerprint: 'STALE_OR_PYTHON_ONLY_VALUE' };
    const divergences = compareClusterFingerprints([good, bad]);
    expect(divergences).toHaveLength(1);
    expect(divergences[0].clusterId).toBe('c2');
    expect(divergences[0].portal).toBe('STALE_OR_PYTHON_ONLY_VALUE');
    expect(divergences[0].instar).toBe(clusterFingerprint({ type: 'bug', title: 'telegram relay drops message' }));
  });

  it('skips clusters with no stored fingerprint (no false positives pre-backfill)', () => {
    const noFp: PortalCluster = { clusterId: 'c1', type: 'bug', title: 't', fingerprint: '' };
    expect(compareClusterFingerprints([noFp])).toEqual([]);
  });
});

describe('compareClusterOutcomes (invariants 2 & 3)', () => {
  const base: ClusterOutcome[] = [
    { fingerprint: 'fp-a', status: 'resolved', recurrenceCount: 0 },
    { fingerprint: 'fp-b', status: 'investigating', recurrenceCount: 3 },
  ];

  it('no divergence when status + recurrence match (keyed by fingerprint, not clusterId)', () => {
    expect(compareClusterOutcomes(base, [...base])).toEqual([]);
  });

  it('flags a terminal-status divergence', () => {
    const instar: ClusterOutcome[] = [{ fingerprint: 'fp-a', status: 'investigating', recurrenceCount: 0 }, base[1]];
    const out = compareClusterOutcomes(instar, base);
    expect(out).toEqual([{ fingerprint: 'fp-a', kind: 'status', instar: 'investigating', portal: 'resolved' }]);
  });

  it('flags a recurrence-count divergence', () => {
    const instar: ClusterOutcome[] = [base[0], { fingerprint: 'fp-b', status: 'investigating', recurrenceCount: 5 }];
    const out = compareClusterOutcomes(instar, base);
    expect(out).toEqual([{ fingerprint: 'fp-b', kind: 'recurrence', instar: 5, portal: 3 }]);
  });

  it('flags clusters present on only one side', () => {
    const instar: ClusterOutcome[] = [base[0], { fingerprint: 'fp-c', status: 'new', recurrenceCount: 0 }];
    const portal: ClusterOutcome[] = [base[0], base[1]];
    const out = compareClusterOutcomes(instar, portal);
    expect(out).toContainEqual({ fingerprint: 'fp-b', kind: 'missing-instar', portal: 'investigating' });
    expect(out).toContainEqual({ fingerprint: 'fp-c', kind: 'missing-portal', instar: 'new' });
  });
});

describe('compareInvariants (full verdict)', () => {
  it('divergent=false when all invariants hold', () => {
    const clusters = [cluster('c1', 'bug', 'gitsync.pull fails')];
    const outcomes: ClusterOutcome[] = [{ fingerprint: 'fp-a', status: 'resolved', recurrenceCount: 0 }];
    const r = compareInvariants({ portalClusters: clusters, instarOutcomes: outcomes, portalOutcomes: outcomes });
    expect(r.divergent).toBe(false);
    expect(r.clustersCompared).toBe(1);
    expect(r.outcomesCompared).toBe(1);
  });

  it('divergent=true on any fingerprint divergence (fingerprint-only pass, no outcomes)', () => {
    const bad: PortalCluster = { clusterId: 'c1', type: 'bug', title: 't', fingerprint: 'WRONG' };
    const r = compareInvariants({ portalClusters: [bad] });
    expect(r.divergent).toBe(true);
    expect(r.fingerprintDivergences).toHaveLength(1);
    expect(r.outcomeDivergences).toEqual([]);
  });

  it('skips outcome comparison when only one outcome list is supplied', () => {
    const clusters = [cluster('c1', 'bug', 'ok title')];
    const r = compareInvariants({ portalClusters: clusters, instarOutcomes: [{ fingerprint: 'x', status: 'new', recurrenceCount: 0 }] });
    expect(r.outcomeDivergences).toEqual([]);
    expect(r.divergent).toBe(false);
  });
});
