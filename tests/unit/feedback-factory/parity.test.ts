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

describe('compareClusterOutcomes — status normalization (the resolved→closed projection)', () => {
  // Portal still writes v1 literals while Instar emits the v2 lifecycle. The
  // comparison projects both sides into v2 space, so benign vocabulary skew is NOT
  // a cutover-blocking divergence — but a genuine lifecycle mismatch still is.
  const rc = 0;

  it('does NOT flag a status that differs only by vocabulary (each v1↔v2 pair)', () => {
    const pairs: Array<[string, string]> = [
      ['closed', 'resolved'], // instar v2 ↔ portal v1 (the headline case)
      ['new', 'open'], // open is the v1 birth-default literal
      ['fix_applied', 'fixed'],
      ['investigating', 'investigating'], // identity
      ['wontfix', 'wontfix'],
      ['duplicate', 'duplicate'],
    ];
    for (const [instarStatus, portalStatus] of pairs) {
      const instar: ClusterOutcome[] = [{ fingerprint: 'fp', status: instarStatus, recurrenceCount: rc }];
      const portal: ClusterOutcome[] = [{ fingerprint: 'fp', status: portalStatus, recurrenceCount: rc }];
      expect(compareClusterOutcomes(instar, portal)).toEqual([]);
    }
  });

  it('is direction-agnostic (portal v2 vs instar v1 also reconciles)', () => {
    const instar: ClusterOutcome[] = [{ fingerprint: 'fp', status: 'resolved', recurrenceCount: rc }];
    const portal: ClusterOutcome[] = [{ fingerprint: 'fp', status: 'closed', recurrenceCount: rc }];
    expect(compareClusterOutcomes(instar, portal)).toEqual([]);
  });

  it('STILL flags a genuine lifecycle divergence that survives normalization', () => {
    const instar: ClusterOutcome[] = [{ fingerprint: 'fp', status: 'investigating', recurrenceCount: rc }];
    const portal: ClusterOutcome[] = [{ fingerprint: 'fp', status: 'resolved', recurrenceCount: rc }];
    const out = compareClusterOutcomes(instar, portal);
    // 'investigating' vs normalize('resolved')='closed' → real divergence.
    // Reported values stay RAW so the operator sees each side's actual stored status.
    expect(out).toEqual([{ fingerprint: 'fp', kind: 'status', instar: 'investigating', portal: 'resolved' }]);
  });

  it('does not let normalization mask a recurrence divergence on a vocabulary-equivalent status', () => {
    const instar: ClusterOutcome[] = [{ fingerprint: 'fp', status: 'closed', recurrenceCount: 2 }];
    const portal: ClusterOutcome[] = [{ fingerprint: 'fp', status: 'resolved', recurrenceCount: 5 }];
    const out = compareClusterOutcomes(instar, portal);
    expect(out).toEqual([{ fingerprint: 'fp', kind: 'recurrence', instar: 2, portal: 5 }]);
  });
});

describe('compareInvariants — divergent=false across a vocabulary-skewed window', () => {
  it('green verdict when the only status differences are v1↔v2 projections', () => {
    const clusters = [cluster('c1', 'bug', 'gitsync.pull fails'), cluster('c2', 'feature', 'dark mode')];
    const instarOutcomes: ClusterOutcome[] = [
      { fingerprint: 'fp-1', status: 'closed', recurrenceCount: 0 },
      { fingerprint: 'fp-2', status: 'new', recurrenceCount: 1 },
    ];
    const portalOutcomes: ClusterOutcome[] = [
      { fingerprint: 'fp-1', status: 'resolved', recurrenceCount: 0 }, // v1 of closed
      { fingerprint: 'fp-2', status: 'open', recurrenceCount: 1 }, // v1 of new
    ];
    const r = compareInvariants({ portalClusters: clusters, instarOutcomes, portalOutcomes });
    expect(r.divergent).toBe(false);
    expect(r.outcomeDivergences).toEqual([]);
  });
});

describe('compareInvariants (full verdict)', () => {
  it('divergent=false when all invariants hold', () => {
    const clusters = [cluster('c1', 'bug', 'gitsync.pull fails')];
    const outcomes: ClusterOutcome[] = [{ fingerprint: 'fp-a', status: 'resolved', recurrenceCount: 0 }];
    const r = compareInvariants({ portalClusters: clusters, instarOutcomes: outcomes, portalOutcomes: outcomes });
    expect(r.divergent).toBe(false);
    expect(r.clustersCompared).toBe(1);
    expect(r.clustersWithFingerprint).toBe(1); // full coverage: every cluster carried a fingerprint
    expect(r.outcomesCompared).toBe(1);
  });

  it('reports a coverage gap — empty-fingerprint clusters count toward clustersCompared but NOT clustersWithFingerprint', () => {
    // The exact misread-as-100% hazard: a window where some clusters have no stored
    // fingerprint. Invariant 1 skips them, so the verdict is green — but it is green
    // over a SUBSET, not the whole window. The coverage numerator makes that explicit.
    const covered = cluster('c1', 'bug', 'has fingerprint');
    const preBackfill: PortalCluster = { clusterId: 'c2', type: 'bug', title: 'pre-backfill', fingerprint: '' };
    const r = compareInvariants({ portalClusters: [covered, preBackfill] });
    expect(r.divergent).toBe(false); // no divergence among the COVERED clusters
    expect(r.fingerprintDivergences).toEqual([]);
    expect(r.clustersCompared).toBe(2); // denominator: every cluster read
    expect(r.clustersWithFingerprint).toBe(1); // numerator: only the one with a fingerprint
  });

  it('clustersWithFingerprint counts every cluster when all carry a fingerprint', () => {
    const clusters = [cluster('c1', 'bug', 'a'), cluster('c2', 'feature', 'b'), cluster('c3', 'bug', 'c')];
    const r = compareInvariants({ portalClusters: clusters });
    expect(r.clustersCompared).toBe(3);
    expect(r.clustersWithFingerprint).toBe(3);
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
