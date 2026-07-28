/**
 * Unit — CorrectionAnalyzer 3-pronged recurrence gate (spec §3.5).
 *
 * Pins: below-vs-at threshold on each prong; the code-determined provenance
 * filter EXCLUDES LLM-only-confident records; llm_confidence alone NEVER
 * satisfies the gate; noise records are never considered.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { CorrectionAnalyzer, DEFAULT_CORRECTION_GATES } from '../../src/monitoring/CorrectionAnalyzer.js';

describe('CorrectionAnalyzer — 3-pronged gate', () => {
  let ledger: CorrectionLedger | null = null;
  afterEach(() => { ledger?.close(); ledger = null; });

  function fresh(): CorrectionLedger {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'test', maxOccurrencesPerKey: 200 });
    return ledger;
  }

  /** Record N occurrences of one preference across `days` distinct days + `topics` topics, all at the given weight. */
  function seedPreference(l: CorrectionLedger, opts: { count: number; days: number; topics: number; weight: number }) {
    for (let i = 0; i < opts.count; i++) {
      const day = (i % opts.days) + 1;
      const topic = (i % opts.topics) + 1;
      l.record({
        kind: 'user-preference',
        learning: 'lead with the action',
        scrubbedSummary: 'action-first',
        deterministicWeight: opts.weight,
        topicId: topic,
        detectedAt: `2026-05-0${day}T10:00:00Z`,
      });
    }
  }

  describe('preference path: minSupport AND minDistinctDays(2) AND minDistinctTopics(2)', () => {
    it('crosses when all three prongs are met', () => {
      const l = fresh();
      seedPreference(l, { count: 4, days: 2, topics: 2, weight: 3 });
      const result = new CorrectionAnalyzer(l).analyze();
      expect(result.crossed.length).toBe(1);
      expect(result.crossed[0].record.kind).toBe('user-preference');
    });

    it('does NOT cross when support is below minSupport (3 < 4)', () => {
      const l = fresh();
      seedPreference(l, { count: 3, days: 2, topics: 2, weight: 3 });
      const result = new CorrectionAnalyzer(l).analyze();
      expect(result.crossed.length).toBe(0);
      expect(result.belowThreshold).toBe(1);
    });

    it('does NOT cross when only one distinct day (days prong fails)', () => {
      const l = fresh();
      seedPreference(l, { count: 5, days: 1, topics: 2, weight: 3 });
      const result = new CorrectionAnalyzer(l).analyze();
      expect(result.crossed.length).toBe(0);
    });

    it('does NOT cross when only one distinct topic (second prong fails)', () => {
      const l = fresh();
      seedPreference(l, { count: 5, days: 2, topics: 1, weight: 3 });
      const result = new CorrectionAnalyzer(l).analyze();
      expect(result.crossed.length).toBe(0);
    });
  });

  describe('code-determined provenance filter (poison resistance)', () => {
    it('LLM-only-confident records (deterministicWeight below threshold) NEVER satisfy the gate', () => {
      const l = fresh();
      // 6 occurrences across 3 days / 3 topics — would EASILY cross — but every
      // occurrence is weight 1 (below DETERMINISTIC_THRESHOLD=3) with max LLM
      // confidence. The provenance filter excludes them all.
      for (let i = 0; i < 6; i++) {
        l.record({
          kind: 'user-preference',
          learning: 'poisoned learning',
          scrubbedSummary: 's',
          deterministicWeight: 1,        // below threshold
          llmConfidence: 1.0,            // advisory — must NOT alone admit it
          topicId: (i % 3) + 1,
          detectedAt: `2026-05-0${(i % 3) + 1}T10:00:00Z`,
        });
      }
      const result = new CorrectionAnalyzer(l).analyze();
      expect(result.crossed.length).toBe(0);
    });

    it('mixed: only the qualifying (weight>=threshold) occurrences count toward the gate', () => {
      const l = fresh();
      // 4 weight-3 occurrences across 2 days/2 topics (qualifies) + noise of
      // weight-1 rows that must not inflate anything.
      for (let i = 0; i < 4; i++) {
        l.record({ kind: 'user-preference', learning: 'real pref', scrubbedSummary: 's', deterministicWeight: 3, topicId: (i % 2) + 1, detectedAt: `2026-05-0${(i % 2) + 1}T10:00:00Z` });
      }
      for (let i = 0; i < 3; i++) {
        l.record({ kind: 'user-preference', learning: 'real pref', scrubbedSummary: 's', deterministicWeight: 1, topicId: 9, detectedAt: '2026-05-09T10:00:00Z' });
      }
      const result = new CorrectionAnalyzer(l).analyze();
      expect(result.crossed.length).toBe(1);
    });
  });

  describe('infra-gap path: minSupport AND minDistinctDays(3)', () => {
    it('crosses at 4 support across 3 distinct days', () => {
      const l = fresh();
      for (let i = 0; i < 4; i++) {
        l.record({ kind: 'infra-gap', learning: 'force push nag', scrubbedSummary: 'nag', deterministicWeight: 3, topicId: 1, detectedAt: `2026-05-0${(i % 3) + 1}T10:00:00Z` });
      }
      const result = new CorrectionAnalyzer(l).analyze();
      expect(result.crossed.length).toBe(1);
      expect(result.crossed[0].record.kind).toBe('infra-gap');
    });

    it('does NOT cross at only 2 distinct days (infra-gap needs 3)', () => {
      const l = fresh();
      for (let i = 0; i < 5; i++) {
        l.record({ kind: 'infra-gap', learning: 'force push nag', scrubbedSummary: 'nag', deterministicWeight: 3, topicId: 1, detectedAt: `2026-05-0${(i % 2) + 1}T10:00:00Z` });
      }
      const result = new CorrectionAnalyzer(l).analyze();
      expect(result.crossed.length).toBe(0);
    });
  });

  it('noise records are never gate-considered', () => {
    const l = fresh();
    for (let i = 0; i < 10; i++) {
      l.record({ kind: 'noise', learning: 'nothing', scrubbedSummary: 'n', deterministicWeight: 3, topicId: (i % 5) + 1, detectedAt: `2026-05-0${(i % 5) + 1}T10:00:00Z` });
    }
    const result = new CorrectionAnalyzer(l).analyze();
    expect(result.considered).toBe(0);
    expect(result.crossed.length).toBe(0);
  });

  it('DEFAULT_CORRECTION_GATES match the spec §9 defaults', () => {
    expect(DEFAULT_CORRECTION_GATES.minSupport).toBe(4);
    expect(DEFAULT_CORRECTION_GATES.minDistinctDaysInfraGap).toBe(3);
    expect(DEFAULT_CORRECTION_GATES.minDistinctDaysPreference).toBe(2);
    expect(DEFAULT_CORRECTION_GATES.minDistinctTopicsPreference).toBe(2);
  });
});
