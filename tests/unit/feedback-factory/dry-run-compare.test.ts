/**
 * Unit tests (Tier 1) — dry-run/compare runner.
 *
 * End-to-end against InMemoryParitySource: reads Portal clusters, compares
 * invariants, emits a JSONL audit trail, returns the verdict. Covers the clean
 * (no-divergence) path, a divergent corpus, the outcome-invariant path, and the
 * never-writes-to-source guarantee.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDryRunCompare,
  toRecords,
  InMemoryParitySource,
  type DryRunRecord,
} from '../../../src/feedback-factory/dryrun/dryRunCompare.js';
import { clusterFingerprint, type PortalCluster, type ClusterOutcome } from '../../../src/feedback-factory/processor/parity.js';

const cluster = (clusterId: string, type: string, title: string, extra: Partial<PortalCluster> = {}): PortalCluster => ({
  clusterId,
  type,
  title,
  fingerprint: clusterFingerprint({ type, title }),
  ...extra,
});

const readJsonl = (path: string): DryRunRecord[] =>
  readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('runDryRunCompare', () => {
  it('returns divergent=false and emits a clean summary when fingerprints match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dryrun-'));
    const out = join(dir, 'logs', 'compare.jsonl');
    const source = new InMemoryParitySource([
      cluster('c1', 'bug', 'gitsync.pull fails on rebase'),
      cluster('c2', 'feature', 'add dark mode toggle'),
    ]);

    const result = runDryRunCompare(source, { outPath: out, now: '2026-05-27T00:00:00Z' });

    expect(result.divergent).toBe(false);
    expect(result.clustersCompared).toBe(2);
    const records = readJsonl(out);
    expect(records).toHaveLength(1); // just the summary
    expect(records[0]).toMatchObject({ kind: 'summary', divergent: false, clustersCompared: 2, fingerprintDivergences: 0 });
  });

  it('detects a fingerprint divergence, sets divergent=true, and logs the divergence + summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dryrun-'));
    const out = join(dir, 'compare.jsonl');
    const source = new InMemoryParitySource([
      cluster('c1', 'bug', 'good title'),
      { clusterId: 'c2', type: 'bug', title: 'diverging title', fingerprint: 'PYTHON_ONLY_VALUE' },
    ]);

    const result = runDryRunCompare(source, { outPath: out, now: '2026-05-27T00:00:00Z' });

    expect(result.divergent).toBe(true);
    expect(result.fingerprintDivergences).toHaveLength(1);
    expect(result.fingerprintDivergences[0].clusterId).toBe('c2');

    const records = readJsonl(out);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: 'fingerprint-divergence', clusterId: 'c2', portal: 'PYTHON_ONLY_VALUE' });
    expect(records[1]).toMatchObject({ kind: 'summary', divergent: true, fingerprintDivergences: 1 });
  });

  it('compares outcome invariants when both outcome lists are supplied', () => {
    const source = new InMemoryParitySource([cluster('c1', 'bug', 'title')]);
    const portalOutcomes: ClusterOutcome[] = [{ fingerprint: 'fp-a', status: 'resolved', recurrenceCount: 1 }];
    const instarOutcomes: ClusterOutcome[] = [{ fingerprint: 'fp-a', status: 'investigating', recurrenceCount: 1 }];

    const result = runDryRunCompare(source, { instarOutcomes, portalOutcomes, now: '2026-05-27T00:00:00Z' });

    expect(result.divergent).toBe(true);
    expect(result.outcomeDivergences).toEqual([{ fingerprint: 'fp-a', kind: 'status', instar: 'investigating', portal: 'resolved' }]);
  });

  it('does not write any audit trail when outPath is omitted', () => {
    const source = new InMemoryParitySource([cluster('c1', 'bug', 'title')]);
    const result = runDryRunCompare(source);
    expect(result.divergent).toBe(false); // return-only mode still works
  });

  it('never mutates the source (read-only guarantee)', () => {
    const clusters = [cluster('c1', 'bug', 'title')];
    const source = new InMemoryParitySource(clusters);
    const before = JSON.stringify(source.readPortalClusters());
    runDryRunCompare(source, { now: '2026-05-27T00:00:00Z' });
    expect(JSON.stringify(source.readPortalClusters())).toBe(before);
  });
});

describe('toRecords', () => {
  it('orders divergences before the summary and stamps the timestamp', () => {
    const records = toRecords(
      {
        clustersCompared: 1,
        outcomesCompared: 0,
        fingerprintDivergences: [{ clusterId: 'c1', instar: 'a', portal: 'b' }],
        outcomeDivergences: [],
        divergent: true,
      },
      '2026-05-27T12:00:00Z',
    );
    expect(records[0].kind).toBe('fingerprint-divergence');
    expect(records[records.length - 1]).toMatchObject({ kind: 'summary', at: '2026-05-27T12:00:00Z', divergent: true });
  });
});
