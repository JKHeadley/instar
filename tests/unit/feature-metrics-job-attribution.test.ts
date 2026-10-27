/**
 * Job-cost attribution passthrough (docs/specs/job-cost-reduction.md §9.1): a call
 * whose attribution carries jobSlug/machineId/runId lands on the feature-metrics row,
 * and FeatureMetricsLedger.byJobSlug totals it (shed rows excluded).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CircuitBreakingIntelligenceProvider, setFeatureMetricsRecorder } from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';

let fm: FeatureMetricsLedger | null = null;
afterEach(() => { setFeatureMetricsRecorder(null); fm?.close(); fm = null; });

describe('job attribution on feature metrics', () => {
  it('the funnel stamps jobSlug/machineId/runId from options.attribution', async () => {
    fm = new FeatureMetricsLedger({ dbPath: ':memory:' });
    setFeatureMetricsRecorder(fm);
    const inner = { evaluate: async (_p: string, o?: any) => { o?.onUsage?.({ inputTokens: 30, outputTokens: 4, cachedTokens: 10 }); o?.onModel?.({ model: 'claude-haiku-4-5', framework: 'claude-code' }); return 'ok'; } };
    const p = new CircuitBreakingIntelligenceProvider(inner as any);
    await p.evaluate('x', { attribution: { component: 'JobAnomalyNarrator', jobSlug: 'health-check', machineId: 'm1', runId: 'ep-1' } });
    await p.evaluate('x', { attribution: { component: 'Unrelated' } });
    const rows = fm.byJobSlug({ sinceMs: 0 });
    expect(rows).toEqual([{ jobSlug: 'health-check', feature: 'JobAnomalyNarrator', framework: 'claude-code', model: 'claude-haiku-4-5', calls: 1, tokensIn: 30, tokensOut: 4, tokensCached: 10 }]);
    expect(fm.byJobSlug({ sinceMs: 0, machineId: 'm2' })).toEqual([]);
  });

  it('byJobSlug excludes shed rows and honours the window', () => {
    fm = new FeatureMetricsLedger({ dbPath: ':memory:' });
    fm.record({ feature: 'F', outcome: 'shed', jobSlug: 'j', ts: 100 });
    fm.record({ feature: 'F', outcome: 'error', tokensIn: 5, jobSlug: 'j', ts: 200 });
    fm.record({ feature: 'F', outcome: 'fired', tokensIn: 5, jobSlug: 'j', ts: 900 });
    expect(fm.byJobSlug({ sinceMs: 0, untilMs: 500 })).toEqual([expect.objectContaining({ calls: 1, tokensIn: 5 })]);
    expect(fm.byJobSlug({ sinceMs: 0 })[0].calls).toBe(2);
  });
});
