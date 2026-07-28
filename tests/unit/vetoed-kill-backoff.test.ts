/**
 * VetoedKillBackoff — the generalized per-session veto-backoff ledger
 * (session-respawn-thrash Fix A). Covers the value-shape seam (L1), the
 * reason-key-aware stale-reprieve (R3-2), firstOfEpisode / episodeCount, the
 * cooldownMs:0 enabled-but-no-cooldown contract (R4-5), map-bounding, and the
 * exhaustive normalizeReasonKey behavior (R4-4). Also verifies the 2-arg
 * age-gate callsites still compile + behave.
 */

import { describe, it, expect } from 'vitest';
import {
  VetoedKillBackoff,
  DEFAULT_VETOED_KILL_BACKOFF,
  normalizeReasonKey,
  KNOWN_REAP_KEEP_REASONS,
} from '../../src/core/VetoedKillBackoff.js';

const MIN = 60_000;

describe('VetoedKillBackoff', () => {
  describe('value-shape seam (L1: number → { until, reasonKey, logged, episodeCount })', () => {
    it('remainingMs reads .until for a mid-cooldown entry', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 1_000_000;
      b.recordVeto('s1', now, 'open-commitment');
      expect(b.remainingMs('s1', now)).toBe(10 * MIN);
      expect(b.remainingMs('s1', now + 3 * MIN)).toBe(7 * MIN);
    });

    it('remainingMs returns 0 for an expired entry (never NaN from object compare)', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 2_000_000;
      b.recordVeto('s1', now, 'open-commitment');
      expect(b.remainingMs('s1', now + 11 * MIN)).toBe(0);
    });

    it('shouldRequest compares against .until, not the object', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 3_000_000;
      b.recordVeto('s1', now, 'open-commitment');
      expect(b.shouldRequest('s1', now, 'open-commitment')).toBe(false);
      expect(b.shouldRequest('s1', now + 10 * MIN, 'open-commitment')).toBe(true);
    });
  });

  describe('reason-key stale-reprieve (R3-2)', () => {
    it('a CHANGED reason key invalidates the cooldown and allows a fresh eval', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 4_000_000;
      b.recordVeto('s1', now, 'open-commitment');
      expect(b.shouldRequest('s1', now, 'open-commitment')).toBe(false); // same key → suppressed
      // The protection changed (a different keep-reason now vetoes) → re-check now.
      expect(b.shouldRequest('s1', now, 'recent-user-message')).toBe(true);
      // and the entry was invalidated
      expect(b.trackedCount).toBe(0);
    });

    it('the SAME reason key keeps today\'s cooldown behavior', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 5_000_000;
      b.recordVeto('s1', now, 'open-commitment');
      expect(b.shouldRequest('s1', now + 5_000, 'open-commitment')).toBe(false);
    });

    it('an OMITTED key (2-arg age-gate callsite) never triggers the reprieve', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 6_000_000;
      b.recordVeto('s1', now); // no key → stored null
      expect(b.shouldRequest('s1', now + 5_000)).toBe(false); // suppressed, today's behavior
      // A supplied key when the stored key is null does NOT reprieve (null stored).
      expect(b.shouldRequest('s1', now + 5_000, 'open-commitment')).toBe(false);
    });
  });

  describe('recordVeto firstOfEpisode + episodeCount', () => {
    it('returns true once per episode, false thereafter (same reason)', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 7_000_000;
      expect(b.recordVeto('s1', now, 'open-commitment')).toBe(true);      // first
      expect(b.recordVeto('s1', now + 5_000, 'open-commitment')).toBe(false); // same episode
      expect(b.recordVeto('s1', now + 10_000, 'open-commitment')).toBe(false);
      expect(b.episodeCount('s1')).toBe(3);
    });

    it('a NEW reason key starts a NEW episode → firstOfEpisode true again + count resets', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 8_000_000;
      expect(b.recordVeto('s1', now, 'open-commitment')).toBe(true);
      expect(b.recordVeto('s1', now, 'open-commitment')).toBe(false);
      expect(b.recordVeto('s1', now, 'recent-user-message')).toBe(true); // reason changed
      expect(b.episodeCount('s1')).toBe(1); // fresh episode
    });

    it('episodeCount is 0 for an unknown session', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      expect(b.episodeCount('nope')).toBe(0);
    });
  });

  describe('lifecycle drops (recordKilled / clear / reset)', () => {
    it('all three drop the entry and reset episode state', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 9_000_000;
      b.recordVeto('a', now, 'open-commitment'); b.recordKilled('a');
      expect(b.shouldRequest('a', now, 'open-commitment')).toBe(true);
      expect(b.episodeCount('a')).toBe(0);

      b.recordVeto('b', now, 'open-commitment'); b.clear('b');
      expect(b.shouldRequest('b', now, 'open-commitment')).toBe(true);

      b.recordVeto('c', now, 'open-commitment'); b.reset('c');
      expect(b.shouldRequest('c', now, 'open-commitment')).toBe(true);
      expect(b.trackedCount).toBe(0);
    });
  });

  describe('memory bound (trackedCount + maxTracked oldest-eviction)', () => {
    it('evicts the oldest entries beyond maxTracked', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN, maxTracked: 3 });
      for (let i = 0; i < 5; i++) b.recordVeto('s' + i, 1000 + i, 'open-commitment');
      expect(b.trackedCount).toBe(3);
      expect(b.shouldRequest('s0', 1000, 'open-commitment')).toBe(true);  // evicted → allowed
      expect(b.shouldRequest('s4', 1000, 'open-commitment')).toBe(false); // retained → suppressed
    });
  });

  describe('cooldownMs:0 is enabled-but-no-cooldown (R4-5)', () => {
    it('shouldRequest is always true YET recordVeto still counts episodes + gates firstOfEpisode', () => {
      const b = new VetoedKillBackoff({ backoffMs: 0 });
      const now = 10_000_000;
      expect(b.recordVeto('s1', now, 'open-commitment')).toBe(true);  // first
      expect(b.shouldRequest('s1', now, 'open-commitment')).toBe(true);  // no cooldown gate
      expect(b.recordVeto('s1', now, 'open-commitment')).toBe(false); // same episode
      expect(b.shouldRequest('s1', now + 5_000, 'open-commitment')).toBe(true);
      expect(b.episodeCount('s1')).toBe(2); // episodes STILL counted
      expect(b.trackedCount).toBe(1);       // and the entry IS tracked
    });
  });

  describe('defaults / coercion', () => {
    it('a negative/NaN backoff falls back to the default', () => {
      const b = new VetoedKillBackoff({ backoffMs: -5 });
      b.recordVeto('s1', 0, 'open-commitment');
      expect(b.remainingMs('s1', 0)).toBe(DEFAULT_VETOED_KILL_BACKOFF.backoffMs);
    });
  });

  describe('normalizeReasonKey (R4-4)', () => {
    it('maps every known ReapGuard keep-reason to its own distinct key', () => {
      const keys = KNOWN_REAP_KEEP_REASONS.map((r) => normalizeReasonKey({ reason: r }));
      // Each maps to itself (stable enum key, used verbatim).
      for (const r of KNOWN_REAP_KEEP_REASONS) {
        expect(normalizeReasonKey({ reason: r })).toBe(r);
      }
      // No two known reasons collapse onto one another.
      expect(new Set(keys).size).toBe(KNOWN_REAP_KEEP_REASONS.length);
    });

    it('an unknown variant WITH a reason string keys on that string verbatim (distinct, fail-open)', () => {
      expect(normalizeReasonKey({ reason: 'brand-new-reason-2027' })).toBe('brand-new-reason-2027');
      // and it does NOT collapse onto a known reason
      expect(normalizeReasonKey({ reason: 'brand-new-reason-2027' })).not.toBe('open-commitment');
    });

    it('a bare reason string is accepted', () => {
      expect(normalizeReasonKey('open-commitment')).toBe('open-commitment');
    });

    it('a truthy blocked WITHOUT a usable reason string → null (unkeyable, fail-open)', () => {
      expect(normalizeReasonKey({})).toBeNull();
      expect(normalizeReasonKey({ reason: '' })).toBeNull();
      expect(normalizeReasonKey({ reason: undefined })).toBeNull();
    });

    it('null / undefined → null', () => {
      expect(normalizeReasonKey(null)).toBeNull();
      expect(normalizeReasonKey(undefined)).toBeNull();
    });
  });

  describe('back-compat: two-arg age-gate callsites', () => {
    it('shouldRequest(id, now) and remainingMs(id, now) compile and behave', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      const now = 11_000_000;
      expect(b.shouldRequest('s1', now)).toBe(true);
      b.recordVeto('s1', now); // 2-arg
      expect(b.shouldRequest('s1', now)).toBe(false);
      expect(b.remainingMs('s1', now)).toBe(10 * MIN);
    });

    it('the every-5s flood is cut to ~1 request per window (17,503-line regression)', () => {
      const b = new VetoedKillBackoff({ backoffMs: 10 * MIN });
      let requests = 0;
      for (let t = 0; t < 60 * MIN; t += 5_000) {
        if (b.shouldRequest('s1', t)) { requests++; b.recordVeto('s1', t); }
      }
      expect(requests).toBe(6); // one per 10-min window over an hour — was 720
    });
  });
});
