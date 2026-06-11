/**
 * FeatureMetricsLedger — feature×model breakdown, usage coverage, unlabeled
 * shares, tokensCached (token-audit-completeness, Slice 2).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';

let ledger: FeatureMetricsLedger | null = null;
function newLedger(now?: () => number): FeatureMetricsLedger {
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:', now });
  return ledger;
}

afterEach(() => {
  ledger?.close();
  ledger = null;
});

describe('byFeatureModel', () => {
  it('partitions by feature×model×framework with token + outcome counts', () => {
    const l = newLedger();
    l.record({ feature: 'GateA', outcome: 'noop', tokensIn: 100, tokensOut: 10, tokensCached: 40, model: 'haiku', framework: 'claude-code' });
    l.record({ feature: 'GateA', outcome: 'fired', tokensIn: 200, tokensOut: 20, tokensCached: 80, model: 'haiku', framework: 'claude-code' });
    l.record({ feature: 'GateA', outcome: 'noop', tokensIn: 50, tokensOut: 5, model: 'gpt-5.4-mini', framework: 'codex-cli' });
    l.record({ feature: 'GateB', outcome: 'noop', tokensIn: 7, tokensOut: 3, model: 'haiku', framework: 'claude-code' });

    const rows = l.byFeatureModel();
    const aHaiku = rows.find((r) => r.feature === 'GateA' && r.model === 'haiku')!;
    expect(aHaiku.framework).toBe('claude-code');
    expect(aHaiku.calls).toBe(2);
    expect(aHaiku.tokensIn).toBe(300);
    expect(aHaiku.tokensOut).toBe(30);
    expect(aHaiku.tokensCached).toBe(120);
    expect(aHaiku.fired).toBe(1);
    expect(aHaiku.noop).toBe(1);
    expect(aHaiku.successRowsWithUsage).toBe(2);

    const aCodex = rows.find((r) => r.feature === 'GateA' && r.model === 'gpt-5.4-mini')!;
    expect(aCodex.framework).toBe('codex-cli');
    expect(aCodex.tokensCached).toBe(0);
  });

  it('renders NULL model/framework as "unknown" and respects window bounds', () => {
    let t = 1_000_000;
    const l = newLedger(() => t);
    l.record({ feature: 'Old', outcome: 'noop', tokensIn: 1, ts: t - 10 * 3_600_000, model: 'm', framework: 'f' });
    l.record({ feature: 'NullModel', outcome: 'noop', tokensIn: 5, tokensOut: 1 });
    const rows = l.byFeatureModel({ sinceHours: 1 });
    expect(rows.find((r) => r.feature === 'Old')).toBeUndefined();
    const nm = rows.find((r) => r.feature === 'NullModel')!;
    expect(nm.model).toBe('unknown');
    expect(nm.framework).toBe('unknown');
  });

  it('usage presence is a NULL test, not a SUM — a recorded 0 counts as reported', () => {
    const l = newLedger();
    l.record({ feature: 'ZeroUse', outcome: 'noop', tokensIn: 0, tokensOut: 0, model: 'm', framework: 'codex-cli' });
    l.record({ feature: 'ZeroUse', outcome: 'noop', model: 'm', framework: 'codex-cli' }); // null usage
    const row = l.byFeatureModel().find((r) => r.feature === 'ZeroUse')!;
    expect(row.successRowsWithUsage).toBe(1); // the 0-token row counts; the null row doesn't
  });

  it('error rows with usage are surfaced separately (error-path recording)', () => {
    const l = newLedger();
    l.record({ feature: 'Flaky', outcome: 'error', tokensIn: 500, tokensOut: 100, model: 'm', framework: 'codex-cli' });
    l.record({ feature: 'Flaky', outcome: 'error', model: 'm', framework: 'codex-cli' });
    const row = l.byFeatureModel().find((r) => r.feature === 'Flaky')!;
    expect(row.errors).toBe(2);
    expect(row.errorRowsWithUsage).toBe(1);
  });

  it('excludes event-kind rows (per-model is an llm dimension)', () => {
    const l = newLedger();
    l.recordEvent('ProgrammaticGuard', 'fired');
    expect(l.byFeatureModel().find((r) => r.feature === 'ProgrammaticGuard')).toBeUndefined();
  });
});

describe('summary() enrichment', () => {
  it('derives per-feature byModel + frameworks/models from ONE partition (scan-neutral)', () => {
    const l = newLedger();
    l.record({ feature: 'GateA', outcome: 'noop', tokensIn: 10, tokensOut: 1, model: 'haiku', framework: 'claude-code' });
    l.record({ feature: 'GateA', outcome: 'noop', tokensIn: 20, tokensOut: 2, model: 'gpt-5.4-mini', framework: 'codex-cli' });
    const s = l.summary();
    const a = s.features.find((f) => f.feature === 'GateA')!;
    expect(a.byModel).toHaveLength(2);
    expect(a.frameworks).toEqual(['claude-code', 'codex-cli']);
    expect(a.models).toEqual(['gpt-5.4-mini', 'haiku']);
    expect(a.tokensCached).toBe(0);
  });

  it('totals.byModel aggregates the partition across features', () => {
    const l = newLedger();
    l.record({ feature: 'A', outcome: 'noop', tokensIn: 10, tokensOut: 1, tokensCached: 4, model: 'haiku', framework: 'claude-code' });
    l.record({ feature: 'B', outcome: 'fired', tokensIn: 30, tokensOut: 3, tokensCached: 6, model: 'haiku', framework: 'claude-code' });
    const s = l.summary();
    const haiku = s.totals.byModel.find((m) => m.model === 'haiku')!;
    expect(haiku.calls).toBe(2);
    expect(haiku.tokensIn).toBe(40);
    expect(haiku.tokensCached).toBe(10);
    expect(haiku.fired).toBe(1);
    expect(s.totals.tokensCached).toBe(10);
  });

  it('usageCoverage uses the success-only denominator and reports error rows alongside', () => {
    const l = newLedger();
    l.record({ feature: 'A', outcome: 'noop', tokensIn: 10, tokensOut: 1, model: 'm', framework: 'codex-cli' });
    l.record({ feature: 'A', outcome: 'noop', model: 'm', framework: 'codex-cli' }); // success, no usage
    l.record({ feature: 'A', outcome: 'error', model: 'm', framework: 'codex-cli' }); // error w/o usage — NOT in denominator
    l.record({ feature: 'A', outcome: 'error', tokensIn: 5, tokensOut: 1, model: 'm', framework: 'codex-cli' });
    const cov = l.summary().totals.usageCoverage.find((c) => c.framework === 'codex-cli')!;
    expect(cov.successRows).toBe(2);
    expect(cov.successRowsWithUsage).toBe(1);
    expect(cov.coverage).toBeCloseTo(0.5, 5);
    expect(cov.errorRows).toBe(2);
    expect(cov.errorRowsWithUsage).toBe(1);
    expect(cov.exempt).toBe(false);
  });

  it('excludes interactive-pool rows from the claude-code denominator', () => {
    const l = newLedger();
    l.record({ feature: 'A', outcome: 'noop', tokensIn: 10, tokensOut: 1, model: 'claude-haiku', framework: 'claude-code' });
    l.record({ feature: 'B', outcome: 'noop', model: 'interactive-pool', framework: 'claude-code' });
    l.record({ feature: 'B', outcome: 'noop', model: 'interactive-pool', framework: 'claude-code' });
    const cov = l.summary().totals.usageCoverage.find((c) => c.framework === 'claude-code')!;
    expect(cov.successRows).toBe(1);
    expect(cov.coverage).toBeCloseTo(1.0, 5);
    expect(cov.excludedRows).toBe(2);
  });

  it('marks gemini-cli exempt; pi-cli and codex-cli are NOT exempt', () => {
    const l = newLedger();
    l.record({ feature: 'A', outcome: 'noop', model: 'g', framework: 'gemini-cli' });
    l.record({ feature: 'A', outcome: 'noop', tokensIn: 1, tokensOut: 1, model: 'p', framework: 'pi-cli' });
    l.record({ feature: 'A', outcome: 'noop', tokensIn: 1, tokensOut: 1, model: 'c', framework: 'codex-cli' });
    const cov = l.summary().totals.usageCoverage;
    expect(cov.find((c) => c.framework === 'gemini-cli')!.exempt).toBe(true);
    expect(cov.find((c) => c.framework === 'pi-cli')!.exempt).toBe(false);
    expect(cov.find((c) => c.framework === 'codex-cli')!.exempt).toBe(false);
  });

  it('buckets NULL-framework rows under "unknown" in coverage', () => {
    const l = newLedger();
    l.record({ feature: 'A', outcome: 'noop', tokensIn: 1, tokensOut: 1, model: 'm' });
    const cov = l.summary().totals.usageCoverage.find((c) => c.framework === 'unknown')!;
    expect(cov.successRows).toBe(1);
    expect(cov.exempt).toBe(false);
  });

  it('computes both unlabeled shares; zero denominators → 0', () => {
    const empty = newLedger();
    let s = empty.summary();
    expect(s.totals.unlabeledTokenShare).toBe(0);
    expect(s.totals.unlabeledCallShare).toBe(0);
    empty.close();

    const l = newLedger();
    l.record({ feature: 'Tagged', outcome: 'noop', tokensIn: 600, tokensOut: 200, model: 'm', framework: 'claude-code' });
    // Token-blind unlabeled call: 0 tokens but real traffic — the call share catches it.
    l.record({ feature: 'unlabeled', outcome: 'noop', model: 'm', framework: 'codex-cli' });
    l.record({ feature: 'unlabeled', outcome: 'noop', tokensIn: 100, tokensOut: 100, model: 'm', framework: 'claude-code' });
    s = l.summary();
    expect(s.totals.unlabeledTokenShare).toBeCloseTo(200 / 1000, 5);
    expect(s.totals.unlabeledCallShare).toBeCloseTo(2 / 3, 5);
  });

  it('tokensCached rides record() through to byFeature rollups', () => {
    const l = newLedger();
    l.record({ feature: 'A', outcome: 'noop', tokensIn: 100, tokensOut: 10, tokensCached: 60, model: 'm', framework: 'claude-code' });
    const f = l.byFeature().find((r) => r.feature === 'A')!;
    expect(f.tokensCached).toBe(60);
    expect(f.tokensCached).toBeLessThanOrEqual(f.tokensIn); // subset invariant
  });
});
