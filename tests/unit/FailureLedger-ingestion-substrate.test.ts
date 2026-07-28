/**
 * Unit tests for the ingestion-sources shared substrate (spec §5/§6.1/§7):
 * new categories survive, the occurrence forensic-log is bounded, the open()
 * upsert increments rather than drops, and the analyzer excludes resolved
 * records from active clustering.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import { FailureAttributionEngine } from '../../src/monitoring/FailureAttributionEngine.js';
import { FailureAnalyzer, DEFAULT_GATES } from '../../src/monitoring/FailureAnalyzer.js';
import type { OpenFailureInput } from '../../src/monitoring/FailureLedger.js';

function input(over: Partial<OpenFailureInput> = {}): OpenFailureInput {
  return {
    filedBy: 'source:ci', source: 'ci', severity: 'medium',
    summary: 's', detail: { redacted: 'r', full: 'f' },
    category: 'build-failure', causeCommitOid: 'c1', attribution: 'automatic', attributionConfidence: 0.9,
    ...over,
  };
}

describe('§7 new categories survive coerceCategory', () => {
  it('build-failure / test-failure / regression are not clamped to unknown', () => {
    for (const c of ['build-failure', 'test-failure', 'regression'] as const) {
      expect(FailureAttributionEngine.coerceCategory(c)).toBe(c);
    }
    expect(FailureAttributionEngine.coerceCategory('made-up')).toBe('unknown');
  });
});

describe('§5 occurrence forensic-log is bounded per dedupeKey', () => {
  let ledger: FailureLedger;
  beforeEach(() => { ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb', maxOccurrencesPerKey: 5 }); });
  afterEach(() => ledger.close());

  it('a hot dedupeKey does not grow failure_occurrences without bound', () => {
    // Same source+causeCommitOid+category → same dedupeKey → 30 opens, cap 5.
    for (let i = 0; i < 30; i++) ledger.open(input());
    const key = FailureLedger.dedupeKey('ci', 'c1', 'build-failure');
    expect(ledger.countOccurrences(key)).toBeLessThanOrEqual(5);
    // The record itself deduped to one with the full occurrence_count.
    const recs = ledger.list({ source: 'ci' as never });
    expect(recs).toHaveLength(1);
    expect(recs[0].occurrenceCount).toBe(30);
  });
});

describe('§5 open() upsert increments, never drops', () => {
  let ledger: FailureLedger;
  beforeEach(() => { ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' }); });
  afterEach(() => ledger.close());

  it('two opens of the same dedupeKey → one record, occurrence_count 2', () => {
    ledger.open(input());
    ledger.open(input());
    const recs = ledger.list({ source: 'ci' as never });
    expect(recs).toHaveLength(1);
    expect(recs[0].occurrenceCount).toBe(2);
  });
});

describe('§6.1 analyzer excludes resolved records from active clustering', () => {
  let ledger: FailureLedger;
  beforeEach(() => { ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' }); });
  afterEach(() => ledger.close());

  function seedCluster(status: 'open' | 'resolved') {
    // A diverse 'regression' cluster: 4 records, 4 sessions, 4 cause-commits → crosses the gate.
    for (const s of ['sA', 'sB', 'sC', 'sD']) {
      const rec = ledger.open(input({
        category: 'regression', source: 'agent-diagnosed', attribution: 'one-tap',
        filedBy: s, causeCommitOid: `c-${s}`, summary: 'regression cluster',
      }))!;
      if (status === 'resolved') {
        const fresh = ledger.get(rec.id)!;
        ledger.update(rec.id, { status: 'resolved' }, fresh.version);
      }
    }
  }

  it('open records cross the gate; the same records resolved are excluded', () => {
    seedCluster('open');
    const analyzer = new FailureAnalyzer(ledger, DEFAULT_GATES);
    expect(analyzer.analyze().insightsDiscovered.length).toBeGreaterThanOrEqual(1);
  });

  it('a resolved cluster yields no insight (excluded from active clustering)', () => {
    seedCluster('resolved');
    const analyzer = new FailureAnalyzer(ledger, DEFAULT_GATES);
    expect(analyzer.analyze().insightsDiscovered).toHaveLength(0);
  });
});
