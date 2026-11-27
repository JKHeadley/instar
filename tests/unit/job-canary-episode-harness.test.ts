import { describe, expect, it } from 'vitest';
import type { JobDefinition } from '../../src/core/types.js';
import { verifyJobAnomalyEpisodes } from '../../src/scheduler/JobCanaryEpisodeHarness.js';

const job = {
  slug: 'health-check', name: 'Health check', description: '',
  schedule: '*/15 * * * *', priority: 'low', enabled: true,
  execute: { type: 'script' },
  anomalies: [
    { kind: 'disk-critical', class: 'critical' },
    { kind: 'disk-low', class: 'recoverable' },
  ],
} as unknown as JobDefinition;

describe('production anomaly episode canary', () => {
  it('checks real critical, calm, close, persistence, heal, and stale transitions without sends', async () => {
    let now = Date.parse('2026-10-26T12:00:00Z');
    const report = await verifyJobAnomalyEpisodes(job, 'canary-run-1', [
      { kind: 'disk-critical', class: 'critical', severity: 3, evidence: '2% free' },
      { kind: 'disk-low', class: 'recoverable', severity: 2, evidence: '8% free' },
    ], { now: () => now, advance: ms => { now += ms; } });
    expect(report).toEqual({ ok: true, failures: [] });
  });

  it('rejects a fixture missing either class before changing episode state', async () => {
    const report = await verifyJobAnomalyEpisodes(job, 'canary-run-2', [
      { kind: 'disk-low', class: 'recoverable', severity: 2, evidence: '8% free' },
    ], { now: () => 0, advance: () => {} });
    expect(report).toEqual({ ok: false, failures: ['fixture has no critical reason'] });
  });
});
