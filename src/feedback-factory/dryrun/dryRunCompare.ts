/**
 * dryRunCompare.ts — the Phase-1/3 dry-run/compare runner.
 *
 * docs/specs/feedback-factory-migration.md §2.5: the ported Instar processor runs
 * read-only against Portal's LIVE canonical DB and its decisions are compared to
 * Portal's over the order-independent invariants (parity.ts). Portal stays the SOLE
 * writer through cutover (the ReadOnlyShadowStore guard guarantees Instar never
 * mutates the curated history). This runner drives that comparison and emits a
 * durable JSONL audit trail; `result.divergent` is the structural signal that
 * blocks Phase 4 cutover.
 *
 * Two seams keep it buildable + testable today while the live pieces are
 * credentials-gated:
 *   - {@link ParitySource} is the read-only window source. In production it's a
 *     thin Prisma adapter over Portal's read-only Postgres (built once Dawn hands
 *     off read-credentials, via `prisma db pull` so it matches the live schema
 *     exactly). In tests it's {@link InMemoryParitySource} seeded with a corpus.
 *   - Invariant 1 (fingerprint) is fully live-ready: it recomputes each Portal
 *     cluster's fingerprint and diffs against the stored value — pure, no replay.
 *     Invariants 2 & 3 (status/recurrence) compare two outcome lists; Instar's side
 *     requires a faithful replay from window-START cluster state, which a
 *     current-state read cannot supply — so the runner accepts those outcome lists
 *     as inputs (supplied from a snapshot / full-history export) rather than
 *     deriving them from a point-in-time read. This is a documented data dependency,
 *     not an omission: the comparator and emit path handle all three invariants.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  compareInvariants,
  type ClusterOutcome,
  type ParityResult,
  type PortalCluster,
} from '../processor/parity.js';

/** Read-only window source for the dry-run. Production = Prisma over Portal's DB. */
export interface ParitySource {
  /** Portal's active clusters (with stored fingerprint, status, recurrence) — invariant 1. */
  readPortalClusters(): PortalCluster[];
}

/** Options for one dry-run/compare pass. */
export interface DryRunOptions {
  /** Where to append JSONL compare records. Omit to skip the audit trail (return-only). */
  outPath?: string;
  /** ISO timestamp for the summary record (injected for deterministic tests). */
  now?: string;
  /**
   * Optional cluster-outcome lists for invariants 2 & 3 (status + recurrence).
   * Supplied from a window-start snapshot / full-history replay; omit for a
   * fingerprint-only pass (the always-available live gate).
   */
  instarOutcomes?: ClusterOutcome[];
  portalOutcomes?: ClusterOutcome[];
}

/** One line in the JSONL audit trail. */
export type DryRunRecord =
  | { kind: 'fingerprint-divergence'; clusterId: string; instar: string; portal: string }
  | {
      kind: 'outcome-divergence';
      fingerprint: string;
      divergence: 'status' | 'recurrence' | 'missing-instar' | 'missing-portal';
      instar?: string | number;
      portal?: string | number;
    }
  | {
      kind: 'summary';
      at: string;
      clustersCompared: number;
      outcomesCompared: number;
      fingerprintDivergences: number;
      outcomeDivergences: number;
      divergent: boolean;
    };

/** Flatten a {@link ParityResult} into the JSONL record stream (divergences then summary). */
export function toRecords(result: ParityResult, now: string): DryRunRecord[] {
  const records: DryRunRecord[] = [];
  for (const d of result.fingerprintDivergences) {
    records.push({ kind: 'fingerprint-divergence', clusterId: d.clusterId, instar: d.instar, portal: d.portal });
  }
  for (const d of result.outcomeDivergences) {
    records.push({
      kind: 'outcome-divergence',
      fingerprint: d.fingerprint,
      divergence: d.kind,
      instar: d.instar,
      portal: d.portal,
    });
  }
  records.push({
    kind: 'summary',
    at: now,
    clustersCompared: result.clustersCompared,
    outcomesCompared: result.outcomesCompared,
    fingerprintDivergences: result.fingerprintDivergences.length,
    outcomeDivergences: result.outcomeDivergences.length,
    divergent: result.divergent,
  });
  return records;
}

/**
 * Run one dry-run/compare pass: read Portal's clusters, compare invariants, append
 * the JSONL audit trail, and return the verdict. NEVER writes to Portal's DB — the
 * source is read-only and the runner only reads + compares + appends a local log.
 */
export function runDryRunCompare(source: ParitySource, opts: DryRunOptions = {}): ParityResult {
  const now = opts.now ?? new Date().toISOString();
  const portalClusters = source.readPortalClusters();

  const result = compareInvariants({
    portalClusters,
    instarOutcomes: opts.instarOutcomes,
    portalOutcomes: opts.portalOutcomes,
  });

  if (opts.outPath) {
    const lines = toRecords(result, now)
      .map((r) => JSON.stringify(r))
      .join('\n');
    mkdirSync(dirname(opts.outPath), { recursive: true });
    appendFileSync(opts.outPath, lines + '\n');
  }

  return result;
}

/** In-memory ParitySource — the test implementation + the shape the Prisma adapter mirrors. */
export class InMemoryParitySource implements ParitySource {
  constructor(private readonly clusters: PortalCluster[]) {}
  readPortalClusters(): PortalCluster[] {
    return this.clusters.map((c) => ({ ...c }));
  }
}
