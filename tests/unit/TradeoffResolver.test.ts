/**
 * Unit tests — `TradeoffResolver`.
 *
 * Tier 1 of the Testing Integrity Standard for Phase 3. The resolver is pure
 * logic; these tests pin every branch of its decision tree so a future
 * refactor cannot silently change the behavior.
 */

import { describe, it, expect } from 'vitest';
import { resolveTradeoff } from '../../src/core/TradeoffResolver.js';

describe('TradeoffResolver — resolveTradeoff', () => {
  describe('pair-pattern matching', () => {
    it('honors explicit "X over Y" pattern (A wins)', () => {
      const r = resolveTradeoff({
        valueA: 'customer trust',
        valueB: 'speed',
        hierarchy: ['customer trust over speed', 'compliance over convenience'],
      });
      expect(r.winner).toBe('A');
      expect(r.basis).toBe('pair-pattern');
      expect(r.explanation).toContain('places "customer trust" over "speed"');
      expect(r.matchedIndexA).toBe(0);
      expect(r.matchedIndexB).toBe(0);
    });

    it('honors explicit "X over Y" pattern (B wins)', () => {
      const r = resolveTradeoff({
        valueA: 'speed',
        valueB: 'customer trust',
        hierarchy: ['customer trust over speed'],
      });
      expect(r.winner).toBe('B');
      expect(r.basis).toBe('pair-pattern');
    });

    it('honors "X before Y" pattern', () => {
      const r = resolveTradeoff({
        valueA: 'safety',
        valueB: 'iteration',
        hierarchy: ['safety before iteration'],
      });
      expect(r.winner).toBe('A');
      expect(r.basis).toBe('pair-pattern');
    });

    it('honors "X above Y" pattern', () => {
      const r = resolveTradeoff({
        valueA: 'ethics',
        valueB: 'profit',
        hierarchy: ['ethics above profit'],
      });
      expect(r.winner).toBe('A');
      expect(r.basis).toBe('pair-pattern');
    });

    it('honors "X trumps Y" pattern', () => {
      const r = resolveTradeoff({
        valueA: 'compliance',
        valueB: 'speed',
        hierarchy: ['compliance trumps speed'],
      });
      expect(r.winner).toBe('A');
      expect(r.basis).toBe('pair-pattern');
    });
  });

  describe('list-order matching (no pair pattern)', () => {
    it('returns A when only A appears in hierarchy', () => {
      const r = resolveTradeoff({
        valueA: 'quality',
        valueB: 'novelty',
        hierarchy: ['quality', 'reliability', 'maintainability'],
      });
      expect(r.winner).toBe('A');
      expect(r.basis).toBe('list-order');
      expect(r.explanation).toContain('"quality" appears in the hierarchy at position 1');
      expect(r.matchedIndexA).toBe(0);
      expect(r.matchedIndexB).toBe(-1);
    });

    it('returns B when only B appears in hierarchy', () => {
      const r = resolveTradeoff({
        valueA: 'novelty',
        valueB: 'quality',
        hierarchy: ['quality', 'reliability'],
      });
      expect(r.winner).toBe('B');
      expect(r.basis).toBe('list-order');
      expect(r.matchedIndexB).toBe(0);
    });

    it('returns the earlier-indexed value when both appear', () => {
      const r = resolveTradeoff({
        valueA: 'speed',
        valueB: 'quality',
        hierarchy: ['quality', 'reliability', 'speed'],
      });
      expect(r.winner).toBe('B');
      expect(r.basis).toBe('list-order');
      expect(r.matchedIndexA).toBe(2);
      expect(r.matchedIndexB).toBe(0);
      expect(r.explanation).toContain('Earlier entry wins');
    });

    it('handles case-insensitive substring matches', () => {
      const r = resolveTradeoff({
        valueA: 'TRUST',
        valueB: 'speed',
        hierarchy: ['customer trust matters', 'execution speed'],
      });
      expect(r.winner).toBe('A');
      expect(r.basis).toBe('list-order');
    });
  });

  describe('tie / no-match', () => {
    it('returns tie when both values appear in the same hierarchy entry without a pair pattern', () => {
      const r = resolveTradeoff({
        valueA: 'speed',
        valueB: 'quality',
        hierarchy: ['balance speed and quality carefully'],
      });
      expect(r.winner).toBe(null);
      expect(r.basis).toBe('tie');
      expect(r.explanation).toContain('cannot decide');
    });

    it('returns no-match when neither value appears', () => {
      const r = resolveTradeoff({
        valueA: 'foo',
        valueB: 'bar',
        hierarchy: ['customer trust', 'speed'],
      });
      expect(r.winner).toBe(null);
      expect(r.basis).toBe('no-match');
      expect(r.explanation).toContain('escalate to value-alignment review');
    });

    it('returns no-match with empty hierarchy', () => {
      const r = resolveTradeoff({
        valueA: 'a',
        valueB: 'b',
        hierarchy: [],
      });
      expect(r.winner).toBe(null);
      expect(r.basis).toBe('no-match');
      expect(r.explanation).toContain('No tradeoff hierarchy defined');
    });
  });

  describe('input validation', () => {
    it('returns no-match when valueA is empty', () => {
      const r = resolveTradeoff({
        valueA: '',
        valueB: 'b',
        hierarchy: ['a'],
      });
      expect(r.winner).toBe(null);
      expect(r.basis).toBe('no-match');
      expect(r.explanation).toContain('both valueA and valueB are required');
    });

    it('returns no-match when valueB is empty', () => {
      const r = resolveTradeoff({
        valueA: 'a',
        valueB: '',
        hierarchy: ['a'],
      });
      expect(r.winner).toBe(null);
      expect(r.basis).toBe('no-match');
    });
  });

  describe('mixed format hierarchies', () => {
    it('prefers pair-pattern over list-order when both match', () => {
      // "speed over quality" pair pattern (rare org choice) should win even
      // though quality appears at index 0 of the list-order scan.
      const r = resolveTradeoff({
        valueA: 'speed',
        valueB: 'quality',
        hierarchy: ['quality matters', 'speed over quality'],
      });
      expect(r.winner).toBe('A');
      expect(r.basis).toBe('pair-pattern');
    });

    it('falls through to list-order when pair-pattern entry mentions only one value', () => {
      const r = resolveTradeoff({
        valueA: 'compliance',
        valueB: 'flexibility',
        hierarchy: ['compliance over convenience', 'agility', 'flexibility'],
      });
      // "compliance over convenience" doesn't match "compliance vs flexibility"
      // since loser "convenience" doesn't include "flexibility". Fall to list-order.
      expect(r.basis).toBe('list-order');
      expect(r.winner).toBe('A');
      expect(r.matchedIndexA).toBe(0);
      expect(r.matchedIndexB).toBe(2);
    });
  });
});
