/**
 * The LLM Activity collector must not report health it has not observed.
 *
 * Before this, with zero calls in the window the collector rendered
 * `Error rate: 0%` and asserted "Routing is healthy — 0 checks ran with no check
 * failing a meaningful share of its calls." — a sentence whose own denominator
 * contradicts its claim. An empty 24 hours was indistinguishable from a clean one.
 *
 * The file already declared `MIN_REAL_CALLS = 5` ("minimum real calls before an
 * error-rate is statistically meaningful") and the per-feature anomaly loop
 * honoured it; only the aggregate ignored it. These tests pin the aggregate to the
 * same discipline, and pin the asymmetry that matters: the floor withholds the
 * REASSURING conclusion only, never a warning.
 *
 * Refs ACT-1243 (no ratio without a denominator); convergence-towards-coherence Tier 1.
 */
import { describe, it, expect } from 'vitest';
import { buildLlmActivityCollector } from '../../src/monitoring/dashboardInsightCollectors.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';

function collect(seed: (l: FeatureMetricsLedger) => void) {
  const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  seed(ledger);
  return buildLlmActivityCollector(ledger)();
}
const metric = (snap: { metrics: readonly { label: string; value: string }[] }, label: string) =>
  snap.metrics.find((m) => m.label === label)?.value;

describe('LLM Activity collector — absence must not read as health', () => {
  it('reports NO RATE and claims no health when nothing has run at all', () => {
    const snap = collect(() => {});

    // Was `0%` — indistinguishable from a measured zero.
    expect(metric(snap, 'Error rate')).toBe('no calls yet');
    expect(metric(snap, 'LLM calls (24h)')).toBe('0'); // the denominator is still shown
    expect(metric(snap, 'Checks active')).toBe('0');

    const facts = snap.facts.join(' ');
    // The load-bearing assertion: it must NOT claim routing is healthy.
    expect(facts).not.toMatch(/healthy/i);
    expect(facts).toMatch(/nothing to judge yet/i);
    expect(snap.anomalies).toEqual([]);
  });

  it('does not claim health on a volume too low to support it, but still shows the real rate', () => {
    // 2 real calls, 1 an error. The 50% is honest data; the VERDICT is withheld
    // because 2 calls cannot support "healthy" (MIN_REAL_CALLS is 5).
    const snap = collect((l) => {
      l.record({ feature: 'TopicIntentExtractor', kind: 'llm', outcome: 'error' });
      l.record({ feature: 'TopicIntentExtractor', kind: 'llm', outcome: 'noop' });
    });

    expect(metric(snap, 'Error rate')).toBe('50%'); // the rate is reported honestly
    expect(metric(snap, 'LLM calls (24h)')).toBe('2');

    const facts = snap.facts.join(' ');
    expect(facts).toMatch(/too few to say/i);
    // Assert the absence of the AFFIRMATIVE claim, not of the words. The caveat
    // itself legitimately reads "too few to say whether routing is healthy", so a
    // loose /routing is healthy/i match fails on correct output — which is exactly
    // what it did on the first run of this test.
    expect(snap.facts.some((f) => /^Routing is healthy/.test(f))).toBe(false);
  });

  it('DOES claim health once enough calls support the claim (no false alarm)', () => {
    const snap = collect((l) => {
      for (let i = 0; i < 10; i++) l.record({ feature: 'MessageSentinel', kind: 'llm', outcome: 'noop' });
    });

    expect(metric(snap, 'Error rate')).toBe('0%'); // a MEASURED zero, over 10 calls
    expect(metric(snap, 'LLM calls (24h)')).toBe('10');
    expect(snap.facts.join(' ')).toMatch(/Routing is healthy/i);
  });

  it('a real failure is surfaced ahead of any evidence caveat — the floor never suppresses bad news', () => {
    // 6 calls, 3 errors: above the floor, and a genuine 50% failure.
    const snap = collect((l) => {
      for (let i = 0; i < 3; i++) l.record({ feature: 'TopicIntentExtractor', kind: 'llm', outcome: 'error' });
      for (let i = 0; i < 3; i++) l.record({ feature: 'TopicIntentExtractor', kind: 'llm', outcome: 'noop' });
    });

    expect(snap.anomalies.length).toBeGreaterThan(0);
    const facts = snap.facts.join(' ');
    expect(facts).toMatch(/failing more than usual/i);
    // Neither the "nothing to judge" nor the "too few" caveat may displace a warning.
    expect(facts).not.toMatch(/nothing to judge yet/i);
    expect(facts).not.toMatch(/too few to say/i);
    expect(snap.facts.some((f) => /^Routing is healthy/.test(f))).toBe(false);
  });
});
