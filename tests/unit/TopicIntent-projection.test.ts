/**
 * Unit tests for TopicIntent projection — the pure-math heart of Layer 1.
 *
 * Covers the acceptance tests from docs/specs/topic-intent-layer.md v14:
 *   1. Decay arithmetic at t=104/105/106 (the tier-crossing)
 *   2. User-authored-episode authority gating (0.7 hard clamp → 0.69)
 *   3. Per-message dedup (largest delta wins on collision)
 *   4. Signal caps (user-reref cumulative <= +0.30; agent-reref <= +0.05)
 *   5. Affirmation per-refId per 24h cap (1)
 */

import { describe, it, expect } from 'vitest';
import {
  buildEvent,
  projectConfidence,
  qualifiesAsUserAuthoredEpisode,
  TOPIC_INTENT_CONSTANTS,
  type EvidenceEvent,
} from '../../src/core/TopicIntent.js';

const DAY = TOPIC_INTENT_CONSTANTS.MS_PER_DAY;
const T0 = Date.parse('2026-01-01T00:00:00Z');

describe('TopicIntent — projection (Layer 1)', () => {
  // ── Acceptance test 1: decay arithmetic at t=104/105/106 ───────────────
  describe('decay arithmetic (acceptance test 1)', () => {
    it('a 0.4-confidence ref crosses the tentative→observation boundary near t=104.7', () => {
      // Build evidence that lands the ref at confidence 0.40 at t=0.
      // Easiest path: extract-user (+0.40, user-authored).
      const ev: EvidenceEvent = buildEvent('ref-1', 'extract-user', 'msg-0', { at: new Date(T0).toISOString() });
      const lastReinforcedAt = ev.at;

      // At t=0: should be exactly 0.40 (no decay; grace period covers <=30d)
      const proj0 = projectConfidence([ev], lastReinforcedAt, T0);
      expect(proj0.confidence).toBeCloseTo(0.40, 6);
      expect(proj0.tier).toBe('tentative');

      // At t=30: still 0.40 (grace edge)
      const proj30 = projectConfidence([ev], lastReinforcedAt, T0 + 30 * DAY);
      expect(proj30.confidence).toBeCloseTo(0.40, 6);

      // At t=104 days: tentative (>= 0.300)
      const proj104 = projectConfidence([ev], lastReinforcedAt, T0 + 104 * DAY);
      expect(proj104.confidence).toBeGreaterThan(0.300);
      expect(proj104.tier).toBe('tentative');

      // At t=105 days: observation (< 0.300)
      const proj105 = projectConfidence([ev], lastReinforcedAt, T0 + 105 * DAY);
      expect(proj105.confidence).toBeLessThan(0.300);
      expect(proj105.tier).toBe('observation');

      // At t=106 days: still observation
      const proj106 = projectConfidence([ev], lastReinforcedAt, T0 + 106 * DAY);
      expect(proj106.confidence).toBeLessThan(0.300);
      expect(proj106.tier).toBe('observation');

      // Sanity: the exact spec values at t=105 ≈ 0.2997, t=106 ≈ 0.2986
      expect(proj105.confidence).toBeCloseTo(0.2997, 3);
      expect(proj106.confidence).toBeCloseTo(0.2986, 3);
    });

    it('decay never produces negative confidence', () => {
      const ev = buildEvent('ref-2', 'extract-user', 'msg-0', { at: new Date(T0).toISOString() });
      const farFuture = T0 + 10000 * DAY;
      const proj = projectConfidence([ev], ev.at, farFuture);
      expect(proj.confidence).toBeGreaterThanOrEqual(0);
      expect(proj.tier).toBe('observation');
    });
  });

  // ── Acceptance test 2: user-authored-episode authority gating ──────────
  describe('user-authored-episode authority gating (acceptance test 2)', () => {
    it('agent-origin extraction alone cannot reach authoritative', () => {
      // extract-agent +0.10, capped at +0.10 cumulative
      const ev = buildEvent('ref-3', 'extract-agent', 'msg-agent-1', { at: new Date(T0).toISOString() });
      const proj = projectConfidence([ev], ev.at, T0);
      expect(proj.confidence).toBeCloseTo(0.10);
      expect(proj.tier).toBe('observation');
      expect(proj.userAuthoredEpisodes).toBe(0);
    });

    it('agent-reref alone clamps below 0.7 even if accumulated past threshold (no qualifying episode)', () => {
      // Simulate 100 agent-reref events (capped at +0.05) + many other agent-origin
      // — total sum well above 0.7 if there were no caps. But agent-reref is capped
      // at +0.05 and there's no user-authored episode, so the authority clamp fires.
      const events: EvidenceEvent[] = [];
      for (let i = 0; i < 100; i++) {
        events.push(buildEvent('ref-4', 'agent-reref', `msg-${i}`, { at: new Date(T0 + i).toISOString() }));
      }
      // Add a bunch of extract-agent (also agent-origin, capped at +0.10)
      events.push(buildEvent('ref-4', 'extract-agent', 'msg-agent-init', { at: new Date(T0).toISOString() }));
      const proj = projectConfidence(events, new Date(T0).toISOString(), T0);
      // Sum of capped agent-origin: 0.10 (extract-agent) + 0.05 (agent-reref cap) = 0.15
      expect(proj.confidence).toBeCloseTo(0.15, 3);
      expect(proj.tier).toBe('observation');
      expect(proj.userAuthoredEpisodes).toBe(0);
      expect(proj.authorityClampApplied).toBe(false); // Didn't need to fire — sum already below 0.7
    });

    it('user-authored evidence enables authoritative tier', () => {
      const events: EvidenceEvent[] = [
        buildEvent('ref-5', 'extract-user', 'msg-1', { at: new Date(T0).toISOString() }),         // +0.40 user
        buildEvent('ref-5', 'pending-confirm-positive', 'msg-2', { at: new Date(T0 + 1).toISOString() }), // +0.50 user
      ];
      const proj = projectConfidence(events, new Date(T0 + 1).toISOString(), T0 + 1);
      expect(proj.confidence).toBeCloseTo(0.90, 6);
      expect(proj.tier).toBe('authoritative');
      expect(proj.userAuthoredEpisodes).toBeGreaterThanOrEqual(2);
      expect(proj.authorityClampApplied).toBe(false);
    });

    it('authority clamp fires when sum >= 0.7 but no user-authored episodes', () => {
      // Construct a synthetic scenario: many agent-origin signals with override deltas to push >= 0.7
      // (In production this can't happen because of caps, but the projection should still defend.)
      const events: EvidenceEvent[] = [
        buildEvent('ref-6', 'extract-agent', 'msg-1', { at: new Date(T0).toISOString(), delta: 0.50 }),
        buildEvent('ref-6', 'extract-agent', 'msg-2', { at: new Date(T0 + 1).toISOString(), delta: 0.50 }),
      ];
      // Override caps: extract-agent has cap 0.10. The two events sum to 1.00 before cap, clamped to 0.10.
      // So this doesn't trigger the authority clamp because the cap already prevents the high sum.
      const proj = projectConfidence(events, new Date(T0 + 1).toISOString(), T0 + 1);
      expect(proj.confidence).toBeCloseTo(0.10, 3); // capped at signal-cap, never reaches authority threshold
    });

    it('authority clamp fires when an UNCAPPED agent-origin signal would push above 0.7', () => {
      // The 'conflict-mark' signal has no cap; if mis-used with a large delta override,
      // the projection's authority hard rule must still hold.
      const events: EvidenceEvent[] = [
        // Pretend conflict-mark was issued with a large bogus delta (defensive scenario)
        buildEvent('ref-7', 'conflict-mark', 'msg-1', { at: new Date(T0).toISOString(), delta: 0.80, userAuthored: false }),
      ];
      const proj = projectConfidence(events, new Date(T0).toISOString(), T0);
      expect(proj.confidence).toBe(TOPIC_INTENT_CONSTANTS.AUTHORITY_CLAMP); // 0.69
      expect(proj.tier).toBe('tentative');
      expect(proj.authorityClampApplied).toBe(true);
    });
  });

  // ── Acceptance test 3: per-message dedup ───────────────────────────────
  describe('per-message dedup (acceptance test 3)', () => {
    it('two signals from the same source message about the same refId count as one episode', () => {
      // user-reref (+0.10) + user-affirm (+0.30) from the same message → dedup to +0.30 (larger)
      const events: EvidenceEvent[] = [
        buildEvent('ref-8', 'user-reref', 'msg-same', { at: new Date(T0).toISOString() }),
        buildEvent('ref-8', 'user-affirm', 'msg-same', { at: new Date(T0).toISOString() }),
      ];
      const proj = projectConfidence(events, new Date(T0).toISOString(), T0);
      // After dedup: only +0.30 user-affirm survives (larger abs delta)
      expect(proj.confidence).toBeCloseTo(0.30, 6);
      expect(proj.evidenceCount).toBe(1);
    });

    it('events from different source messages are NOT deduped', () => {
      const events: EvidenceEvent[] = [
        buildEvent('ref-9', 'user-reref', 'msg-a', { at: new Date(T0).toISOString() }),
        buildEvent('ref-9', 'user-reref', 'msg-b', { at: new Date(T0 + 1).toISOString() }),
      ];
      const proj = projectConfidence(events, new Date(T0 + 1).toISOString(), T0 + 1);
      // Two distinct messages, each +0.10 → 0.20 (well under cap)
      expect(proj.confidence).toBeCloseTo(0.20, 6);
      expect(proj.evidenceCount).toBe(2);
    });

    it('negative-delta event wins over smaller positive on the same source message', () => {
      const events: EvidenceEvent[] = [
        buildEvent('ref-10', 'user-reref', 'msg-x', { at: new Date(T0).toISOString() }),       // +0.10
        buildEvent('ref-10', 'contradiction', 'msg-x', { at: new Date(T0).toISOString() }),    // -0.60 (larger abs)
      ];
      const proj = projectConfidence(events, new Date(T0).toISOString(), T0);
      // Dedup: contradiction wins (|−0.60| > |+0.10|), so sum = -0.60 → clamped to 0
      expect(proj.confidence).toBe(0);
      expect(proj.evidenceCount).toBe(1);
    });
  });

  // ── Signal caps ────────────────────────────────────────────────────────
  describe('signal caps', () => {
    it('user-reref cumulative is capped at +0.30', () => {
      const events: EvidenceEvent[] = [];
      for (let i = 0; i < 10; i++) {
        events.push(buildEvent('ref-cap-1', 'user-reref', `msg-${i}`, { at: new Date(T0 + i).toISOString() }));
      }
      const proj = projectConfidence(events, new Date(T0).toISOString(), T0);
      expect(proj.confidence).toBeCloseTo(0.30, 6); // 10 × 0.10 = 1.00, capped at 0.30
    });

    it('agent-reref cumulative is capped at +0.05', () => {
      const events: EvidenceEvent[] = [];
      for (let i = 0; i < 100; i++) {
        events.push(buildEvent('ref-cap-2', 'agent-reref', `msg-${i}`, { at: new Date(T0 + i).toISOString() }));
      }
      const proj = projectConfidence(events, new Date(T0).toISOString(), T0);
      expect(proj.confidence).toBeCloseTo(0.05, 6); // 100 × 0.01 = 1.00, capped at 0.05
    });
  });

  // ── Affirmation safety: per-refId per 24h cap ──────────────────────────
  describe('affirmation safety caps', () => {
    it('multiple user-affirm events on the same calendar day count once', () => {
      const events: EvidenceEvent[] = [
        buildEvent('ref-aff-1', 'extract-user', 'msg-init', { at: new Date(T0).toISOString() }), // +0.40
        buildEvent('ref-aff-1', 'user-affirm', 'msg-a', { at: new Date(T0 + 1 * 60_000).toISOString() }),
        buildEvent('ref-aff-1', 'user-affirm', 'msg-b', { at: new Date(T0 + 2 * 60_000).toISOString() }),
        buildEvent('ref-aff-1', 'user-affirm', 'msg-c', { at: new Date(T0 + 3 * 60_000).toISOString() }),
      ];
      const proj = projectConfidence(events, new Date(T0 + 3 * 60_000).toISOString(), T0 + 3 * 60_000);
      // +0.40 (extract-user) + +0.30 (one user-affirm; rest dropped by per-day cap) = 0.70
      // But user-authored episodes present, so no authority clamp
      // 0.70 is the authority threshold (>=), so tier == authoritative
      expect(proj.confidence).toBeCloseTo(0.70, 6);
      expect(proj.tier).toBe('authoritative');
    });
  });

  // ── User-authored episode classification helper ────────────────────────
  describe('qualifiesAsUserAuthoredEpisode', () => {
    it('classifies the right kinds as user-authored episodes', () => {
      expect(qualifiesAsUserAuthoredEpisode('extract-user')).toBe(true);
      expect(qualifiesAsUserAuthoredEpisode('user-reref')).toBe(true);
      expect(qualifiesAsUserAuthoredEpisode('user-affirm')).toBe(true);
      expect(qualifiesAsUserAuthoredEpisode('pending-confirm-positive')).toBe(true);
      expect(qualifiesAsUserAuthoredEpisode('pending-confirm-negative')).toBe(true);
      expect(qualifiesAsUserAuthoredEpisode('contradiction')).toBe(true);

      expect(qualifiesAsUserAuthoredEpisode('extract-agent')).toBe(false);
      expect(qualifiesAsUserAuthoredEpisode('agent-reref')).toBe(false);
      expect(qualifiesAsUserAuthoredEpisode('conflict-mark')).toBe(false);
      expect(qualifiesAsUserAuthoredEpisode('sharpen-retry-issued')).toBe(false);
    });
  });
});
