/**
 * parity.ts — the Phase-3 live-mirror invariant comparator.
 *
 * docs/specs/feedback-factory-migration.md §2.3/§2.5: the live dual-forward gate
 * compares ONLY order-independent invariants between Portal's processor and the
 * ported Instar processor — because clustering is order-dependent (a report merges
 * into whichever similar cluster already exists) and the two instances will NOT see
 * reports in identical order/timing, a raw cluster-membership diff would fail on
 * benign ordering noise and pressure us to weaken the gate. The spec pins three
 * invariants:
 *
 *   1. FINGERPRINT (per cluster)  — `computeFingerprint(cluster.type, cluster.title)`,
 *                                    exactly as the reference's cmd_backfill_fingerprints
 *                                    (:256) derives it. Recomputing it over Portal's
 *                                    LIVE clusters and diffing against the stored
 *                                    fingerprint is a pure cross-implementation
 *                                    equivalence check — fully order-independent and
 *                                    needs no replay. It is the highest-signal gate:
 *                                    it catches the byte-level Python↔JS divergence
 *                                    (Unicode regex classes, SHA encoding, tokenizer/
 *                                    case-fold) on REAL production titles the
 *                                    recorded adversarial corpus may not cover.
 *   2. terminal STATUS per group  — keyed by fingerprint (the stable cluster key),
 *                                    NOT raw clusterId (slug IDs differ across
 *                                    instances). Requires Instar's recomputed outcomes.
 *   3. RECURRENCE/cycling count    — keyed by fingerprint; chronic-regression
 *                                    accounting that should converge on the same set.
 *
 * This module is PURE. Invariant 1 needs only Portal's stored clusters (read-only).
 * Invariants 2 & 3 compare two pre-computed outcome lists; the runner
 * (dryrun/dryRunCompare.ts) supplies Instar's side from a throwaway replay — never
 * against Portal's DB (see ReadOnlyShadowStore). `divergent === true` is the
 * structural signal that BLOCKS Phase 4 cutover (spec §2.5 Phase 4/5).
 */

import { computeFingerprint } from './fingerprint.js';

/** The canonical fingerprint for a cluster: exactly the reference's per-cluster derivation. */
export function clusterFingerprint(cluster: { type: string; title: string }): string {
  return computeFingerprint(cluster.type, cluster.title);
}

/** A cluster as read from Portal's canonical DB (the dry-run reads these read-only). */
export interface PortalCluster {
  clusterId: string;
  type: string;
  title: string;
  /** The fingerprint Portal stored (the @unique dedup key). */
  fingerprint: string;
  status?: string;
  recurrenceCount?: number;
}

/** A cluster-level outcome, keyed by fingerprint (the order-independent cluster identity). */
export interface ClusterOutcome {
  fingerprint: string;
  /** Terminal lifecycle status (e.g. 'resolved', 'investigating', 'new'). */
  status: string;
  /** Chronic-regression recurrence count. */
  recurrenceCount: number;
}

/** One per-cluster fingerprint divergence. */
export interface FingerprintDivergence {
  clusterId: string;
  instar: string;
  portal: string;
}

/** One cluster-outcome divergence (status and/or recurrence), keyed by fingerprint. */
export interface OutcomeDivergence {
  fingerprint: string;
  kind: 'status' | 'recurrence' | 'missing-instar' | 'missing-portal';
  instar?: string | number;
  portal?: string | number;
}

/** The full parity verdict over a window. `divergent` gates Phase 4 cutover. */
export interface ParityResult {
  clustersCompared: number;
  outcomesCompared: number;
  fingerprintDivergences: FingerprintDivergence[];
  outcomeDivergences: OutcomeDivergence[];
  /** True iff ANY invariant diverged — the structural cutover block. */
  divergent: boolean;
}

/**
 * Invariant 1 (fingerprint) — pure, fully order-independent, no replay. Recomputes
 * each Portal cluster's fingerprint via the ported `computeFingerprint` and diffs
 * against the fingerprint Portal stored. Any mismatch is a REAL divergence (the
 * ported fingerprint logic differs from the Python reference on a real title) —
 * never benign ordering noise. This is the live extension of the recorded-corpus
 * fingerprint-parity harness.
 *
 * Clusters with no stored fingerprint (e.g. created before a backfill) are skipped
 * — there is nothing to compare against, and flagging them would be a false positive.
 */
export function compareClusterFingerprints(portalClusters: PortalCluster[]): FingerprintDivergence[] {
  const out: FingerprintDivergence[] = [];
  for (const c of portalClusters) {
    if (!c.fingerprint) continue;
    const instar = clusterFingerprint(c);
    if (instar !== c.fingerprint) {
      out.push({ clusterId: c.clusterId, instar, portal: c.fingerprint });
    }
  }
  return out;
}

/**
 * Invariants 2 & 3 (terminal status + recurrence) — keyed by fingerprint, NOT raw
 * clusterId. Compares Instar's recomputed cluster outcomes against Portal's actuals.
 * A fingerprint present on one side but not the other is itself a divergence (the
 * two instances grouped reports differently in a way that matters).
 */
export function compareClusterOutcomes(
  instar: ClusterOutcome[],
  portal: ClusterOutcome[],
): OutcomeDivergence[] {
  const out: OutcomeDivergence[] = [];
  const instarByFp = new Map(instar.map((c) => [c.fingerprint, c]));
  const portalByFp = new Map(portal.map((c) => [c.fingerprint, c]));

  for (const [fp, p] of portalByFp) {
    const i = instarByFp.get(fp);
    if (!i) {
      out.push({ fingerprint: fp, kind: 'missing-instar', portal: p.status });
      continue;
    }
    if (i.status !== p.status) {
      out.push({ fingerprint: fp, kind: 'status', instar: i.status, portal: p.status });
    }
    if (i.recurrenceCount !== p.recurrenceCount) {
      out.push({
        fingerprint: fp,
        kind: 'recurrence',
        instar: i.recurrenceCount,
        portal: p.recurrenceCount,
      });
    }
  }
  for (const [fp, i] of instarByFp) {
    if (!portalByFp.has(fp)) {
      out.push({ fingerprint: fp, kind: 'missing-portal', instar: i.status });
    }
  }
  return out;
}

/**
 * Full comparison over all three invariants → the cutover-gating verdict.
 * `instarOutcomes`/`portalOutcomes` are optional: the fingerprint invariant (1) is
 * always run over Portal's clusters; the outcome invariants (2 & 3) run only when
 * both outcome lists are supplied (they require Instar's throwaway replay, which
 * is order-dependent — see dryRunCompare).
 */
export function compareInvariants(args: {
  portalClusters: PortalCluster[];
  instarOutcomes?: ClusterOutcome[];
  portalOutcomes?: ClusterOutcome[];
}): ParityResult {
  const fingerprintDivergences = compareClusterFingerprints(args.portalClusters);
  const outcomeDivergences =
    args.instarOutcomes && args.portalOutcomes
      ? compareClusterOutcomes(args.instarOutcomes, args.portalOutcomes)
      : [];
  return {
    clustersCompared: args.portalClusters.length,
    outcomesCompared: args.portalOutcomes?.length ?? 0,
    fingerprintDivergences,
    outcomeDivergences,
    divergent: fingerprintDivergences.length > 0 || outcomeDivergences.length > 0,
  };
}
