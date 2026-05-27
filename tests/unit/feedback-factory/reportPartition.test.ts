/**
 * Unit tests (Tier 1) — scar (d) report lifecycle partitioning + re-report guard.
 *
 * Equivalence by faithful transcription + both-sides-of-boundary tests (the
 * decision is embedded in a Telegram-rendering function in the reference).
 */

import { describe, it, expect } from 'vitest';
import { partitionClustersForReport } from '../../../src/feedback-factory/processor/reportPartition.js';
import type { Cluster } from '../../../src/feedback-factory/processor/types.js';

const NOW = '2026-05-27T00:00:00.000Z';
const c = (id: string, status: string, extra: Partial<Cluster> = {}): Cluster =>
  ({ clusterId: id, title: id, description: 'd', status, ...extra });

describe('partitionClustersForReport', () => {
  it('separates newly-open from already-reported open issues', () => {
    const clusters = [c('o1', 'open'), c('o2', 'open')];
    const p = partitionClustersForReport(clusters, { lastReportAt: '2026-05-26T00:00:00Z', reportedOpenIds: ['o1'] }, NOW);
    expect(p.newIssues.map(x => x.clusterId)).toEqual(['o2']);
    expect(p.continuingOpen.map(x => x.clusterId)).toEqual(['o1']);
  });

  it('separates new vs continuing investigating', () => {
    const clusters = [c('i1', 'investigating'), c('i2', 'investigating')];
    const p = partitionClustersForReport(clusters, { lastReportAt: '2026-05-26T00:00:00Z', reportedInvestigatingIds: ['i2'] }, NOW);
    expect(p.newInvestigating.map(x => x.clusterId)).toEqual(['i1']);
    expect(p.continuingInvestigating.map(x => x.clusterId)).toEqual(['i2']);
  });

  it('sorts new issues by severity (critical → low)', () => {
    const clusters = [c('low', 'open', { severity: 'low' }), c('crit', 'open', { severity: 'critical' }), c('med', 'open', { severity: 'medium' })];
    const p = partitionClustersForReport(clusters, { lastReportAt: '2026-05-26T00:00:00Z' }, NOW);
    expect(p.newIssues.map(x => x.clusterId)).toEqual(['crit', 'med', 'low']);
  });

  it('re-report guard: a fix is announced once (updatedAt after last report, not previously fixed)', () => {
    const clusters = [
      c('f-new', 'fixed', { updatedAt: '2026-05-26T12:00:00Z' }), // after lastReport → announce
      c('f-old', 'fixed', { updatedAt: '2026-05-25T00:00:00Z' }), // before lastReport → skip
      c('f-already', 'fixed', { updatedAt: '2026-05-26T12:00:00Z' }), // after, but already announced → skip
    ];
    const p = partitionClustersForReport(clusters, { lastReportAt: '2026-05-26T00:00:00Z', reportedFixedIds: ['f-already'] }, NOW);
    expect(p.fixedNew.map(x => x.clusterId)).toEqual(['f-new']);
  });

  it('first run (no lastReportAt) only surfaces fixes from the last 4 hours', () => {
    const clusters = [
      c('f-recent', 'fixed', { updatedAt: '2026-05-26T22:00:00Z' }), // within 4h of NOW(00:00) → yes
      c('f-stale', 'fixed', { updatedAt: '2026-05-26T10:00:00Z' }),  // >4h ago → no
    ];
    const p = partitionClustersForReport(clusters, {}, NOW);
    expect(p.fixedNew.map(x => x.clusterId)).toEqual(['f-recent']);
  });

  it('shouldSkip is true only when there is nothing new (no new issues / investigating / fixes)', () => {
    const onlyContinuing = partitionClustersForReport([c('o1', 'open')], { lastReportAt: '2026-05-26T00:00:00Z', reportedOpenIds: ['o1'] }, NOW);
    expect(onlyContinuing.shouldSkip).toBe(true);
    const hasNew = partitionClustersForReport([c('o2', 'open')], { lastReportAt: '2026-05-26T00:00:00Z' }, NOW);
    expect(hasNew.shouldSkip).toBe(false);
  });
});
