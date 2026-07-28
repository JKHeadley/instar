/**
 * Unit — CorrectionLedger (Correction & Preference Learning Sentinel, spec §3.4).
 *
 * Pins: dedupe-upsert collapses recurrences to one record; the normalizedLearning
 * hash is STABLE across phrasings (the unit-tested invariant); occurrence prune-
 * in-transaction; distinct-days/topics + the deterministic-weight provenance
 * filter; toApiView strips the raw `learning`; countRecords health metric.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';

describe('CorrectionLedger', () => {
  let ledger: CorrectionLedger | null = null;

  afterEach(() => {
    ledger?.close();
    ledger = null;
  });

  function fresh(): CorrectionLedger {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'test', maxOccurrencesPerKey: 5 });
    return ledger;
  }

  describe('normalizedLearningHash stability (the unit-tested invariant)', () => {
    it('collapses semantically-identical learnings phrased differently to one hash', () => {
      const a = CorrectionLedger.normalizedLearningHash('Lead with the one action, no preamble.');
      const b = CorrectionLedger.normalizedLearningHash('no preamble — lead with the one action');
      const c = CorrectionLedger.normalizedLearningHash('Always lead with the one action and no preamble');
      expect(a).toBe(b);
      expect(a).toBe(c);
    });

    it('distinguishes genuinely-different learnings', () => {
      const a = CorrectionLedger.normalizedLearningHash('lead with the one action');
      const b = CorrectionLedger.normalizedLearningHash('use plain language, no jargon');
      expect(a).not.toBe(b);
    });

    it('dedupeKey is kind:hash and differs by kind for the same learning', () => {
      const pref = CorrectionLedger.dedupeKey('user-preference', 'keep it plain');
      const infra = CorrectionLedger.dedupeKey('infra-gap', 'keep it plain');
      expect(pref.startsWith('user-preference:')).toBe(true);
      expect(infra.startsWith('infra-gap:')).toBe(true);
      expect(pref).not.toBe(infra);
    });
  });

  describe('dedupe-upsert', () => {
    it('a repeat increments occurrenceCount, never duplicates', () => {
      const l = fresh();
      const r1 = l.record({ kind: 'user-preference', learning: 'lead with the action', scrubbedSummary: 'prefers action-first', deterministicWeight: 3 });
      const r2 = l.record({ kind: 'user-preference', learning: 'lead with the action', scrubbedSummary: 'prefers action-first', deterministicWeight: 3 });
      expect(r1!.id).toBe(r2!.id);
      expect(r2!.occurrenceCount).toBe(2);
      expect(l.countRecords()).toBe(1);
    });

    it('keeps the strongest deterministic weight + max confidence on upsert', () => {
      const l = fresh();
      l.record({ kind: 'user-preference', learning: 'x', scrubbedSummary: 'x', deterministicWeight: 2, llmConfidence: 0.5 });
      const r = l.record({ kind: 'user-preference', learning: 'x', scrubbedSummary: 'x', deterministicWeight: 5, llmConfidence: 0.9 });
      expect(r!.deterministicWeight).toBe(5);
      expect(r!.llmConfidence).toBeCloseTo(0.9, 5);
    });
  });

  describe('occurrence prune-in-transaction', () => {
    it('caps forensic occurrence rows per dedupeKey at maxOccurrencesPerKey', () => {
      const l = fresh(); // cap 5
      for (let i = 0; i < 12; i++) {
        l.record({ kind: 'infra-gap', learning: 'force push nag', scrubbedSummary: 'nag', deterministicWeight: 3 });
      }
      const key = CorrectionLedger.dedupeKey('infra-gap', 'force push nag');
      expect(l.countOccurrences(key)).toBe(5);
      // The record's occurrenceCount still reflects ALL 12 (monotonic).
      expect(l.getByDedupeKey(key)!.occurrenceCount).toBe(12);
    });
  });

  describe('distinctCounts (restart-proof days + topics + provenance filter)', () => {
    it('counts distinct UTC calendar days (not sessions)', () => {
      const l = fresh();
      l.record({ kind: 'user-preference', learning: 'plain', scrubbedSummary: 's', deterministicWeight: 3, topicId: 1, detectedAt: '2026-05-01T10:00:00Z' });
      l.record({ kind: 'user-preference', learning: 'plain', scrubbedSummary: 's', deterministicWeight: 3, topicId: 1, detectedAt: '2026-05-01T23:00:00Z' }); // same day
      l.record({ kind: 'user-preference', learning: 'plain', scrubbedSummary: 's', deterministicWeight: 3, topicId: 2, detectedAt: '2026-05-02T08:00:00Z' });
      const key = CorrectionLedger.dedupeKey('user-preference', 'plain');
      const c = l.distinctCounts(key);
      expect(c.distinctDays).toBe(2);   // 05-01 and 05-02
      expect(c.distinctTopics).toBe(2); // topics 1 and 2
      expect(c.qualifyingOccurrences).toBe(3);
    });

    it('the deterministic-weight filter EXCLUDES low-weight (LLM-only) occurrences', () => {
      const l = fresh();
      // 4 occurrences but only 2 at full deterministic weight.
      l.record({ kind: 'user-preference', learning: 'p', scrubbedSummary: 's', deterministicWeight: 3, topicId: 1, detectedAt: '2026-05-01T10:00:00Z' });
      l.record({ kind: 'user-preference', learning: 'p', scrubbedSummary: 's', deterministicWeight: 1, topicId: 2, detectedAt: '2026-05-02T10:00:00Z' });
      l.record({ kind: 'user-preference', learning: 'p', scrubbedSummary: 's', deterministicWeight: 0, topicId: 3, detectedAt: '2026-05-03T10:00:00Z' });
      l.record({ kind: 'user-preference', learning: 'p', scrubbedSummary: 's', deterministicWeight: 3, topicId: 4, detectedAt: '2026-05-04T10:00:00Z' });
      const key = CorrectionLedger.dedupeKey('user-preference', 'p');
      const all = l.distinctCounts(key, 0);
      const qualifying = l.distinctCounts(key, 3);
      expect(all.qualifyingOccurrences).toBe(4);
      expect(qualifying.qualifyingOccurrences).toBe(2); // only the weight-3 rows
      expect(qualifying.distinctDays).toBe(2);          // 05-01 and 05-04 only
    });
  });

  describe('distinct-days composite index (spec §10 Slice-2 NEW-4)', () => {
    it('creates idx_corr_dedupe_day backing the distinct-day count query', () => {
      const l = fresh();
      const indexes = l.listOccurrenceIndexes();
      expect(indexes).toContain('idx_corr_dedupe_day');
      // The single-column dedupe index is still present (we add the composite,
      // never remove the original).
      expect(indexes).toContain('idx_corr_dedupe');
    });

    it('distinctCounts still computes correct day counts with the composite index', () => {
      const l = fresh();
      l.record({ kind: 'user-preference', learning: 'q', scrubbedSummary: 's', deterministicWeight: 3, topicId: 1, detectedAt: '2026-05-10T10:00:00Z' });
      l.record({ kind: 'user-preference', learning: 'q', scrubbedSummary: 's', deterministicWeight: 3, topicId: 1, detectedAt: '2026-05-11T10:00:00Z' });
      l.record({ kind: 'user-preference', learning: 'q', scrubbedSummary: 's', deterministicWeight: 3, topicId: 1, detectedAt: '2026-05-11T20:00:00Z' }); // same day as #2
      const key = CorrectionLedger.dedupeKey('user-preference', 'q');
      expect(l.distinctCounts(key, 3).distinctDays).toBe(2);
    });
  });

  describe('toApiView', () => {
    it('strips the raw learning + sessionId; keeps scrubbed_summary + metadata', () => {
      const l = fresh();
      const rec = l.record({
        kind: 'user-preference',
        learning: 'SECRET-RAW-LEARNING-TEXT',
        scrubbedSummary: 'prefers plain language',
        deterministicWeight: 3,
        sessionId: 'session-secret',
        topicId: 7,
      })!;
      const view = CorrectionLedger.toApiView(rec);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain('SECRET-RAW-LEARNING-TEXT');
      expect(serialized).not.toContain('session-secret');
      expect(serialized).toContain('prefers plain language');
      expect((view as Record<string, unknown>).learning).toBeUndefined();
      expect(view.scrubbedSummary).toBe('prefers plain language');
      expect(view.topicId).toBe(7);
    });
  });

  describe('lifecycle update (OCC)', () => {
    it('updates status with ifMatch and bumps version', () => {
      const l = fresh();
      const rec = l.record({ kind: 'infra-gap', learning: 'x', scrubbedSummary: 'x', deterministicWeight: 3 })!;
      const res = l.update(rec.id, { status: 'acted-on', routedVia: 'feedback' }, rec.version);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.record.status).toBe('acted-on');
        expect(res.record.version).toBe(rec.version + 1);
      }
    });

    it('a stale ifMatch loses with conflict', () => {
      const l = fresh();
      const rec = l.record({ kind: 'infra-gap', learning: 'x', scrubbedSummary: 'x', deterministicWeight: 3 })!;
      const stale = l.update(rec.id, { status: 'verified' }, rec.version + 99);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.conflict).toBe(true);
    });
  });
});
