/**
 * Unit — CorrectionLoopDriver routing + by-construction authority + closed loop
 * (spec §3.6/§3.7/§3.8).
 *
 * Pins: explicit-preference (policy-clean) → recordPreference; policy-relaxation
 * → Attention (NEVER recordPreference); infra-gap (autoFeedback OFF) → tracked
 * Action + draft Initiative (NOT a /feedback POST); infra-gap (autoFeedback ON)
 * → feedbackLoopbackPost; by-construction authority (the LoopDeps interface
 * carries no proposal-minting + no memory-write); closed-loop verify — silence
 * ≠ effective (verified only if the preference persists); recurrence reopens
 * capped at maxReopens.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { CorrectionAnalyzer } from '../../src/monitoring/CorrectionAnalyzer.js';
import {
  CorrectionLoopDriver,
  matchesPolicyRelaxation,
  type CorrectionLoopDeps,
} from '../../src/monitoring/CorrectionLoopDriver.js';

describe('CorrectionLoopDriver', () => {
  let ledger: CorrectionLedger | null = null;
  afterEach(() => { ledger?.close(); ledger = null; });

  function fresh(): CorrectionLedger {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'test', maxOccurrencesPerKey: 200 });
    return ledger;
  }

  function seedCrossingPreference(l: CorrectionLedger, learning: string) {
    for (let i = 0; i < 4; i++) {
      l.record({ kind: 'user-preference', learning, scrubbedSummary: `summary of ${learning}`, deterministicWeight: 3, topicId: (i % 2) + 1, detectedAt: `2026-05-0${(i % 2) + 1}T10:00:00Z` });
    }
  }
  function seedCrossingInfraGap(l: CorrectionLedger, learning: string) {
    for (let i = 0; i < 4; i++) {
      l.record({ kind: 'infra-gap', learning, scrubbedSummary: `summary of ${learning}`, deterministicWeight: 3, topicId: 1, detectedAt: `2026-05-0${(i % 3) + 1}T10:00:00Z` });
    }
  }

  function deps(overrides: Partial<CorrectionLoopDeps> = {}): {
    deps: CorrectionLoopDeps;
    recordPreference: ReturnType<typeof vi.fn>;
    attentionRoute: ReturnType<typeof vi.fn>;
    feedbackLoopbackPost: ReturnType<typeof vi.fn>;
    addAction: ReturnType<typeof vi.fn>;
    createInitiative: ReturnType<typeof vi.fn>;
  } {
    const recordPreference = vi.fn();
    const attentionRoute = vi.fn(async () => true);
    const feedbackLoopbackPost = vi.fn(async () => true);
    const addAction = vi.fn(() => ({ id: 'ACT-1' }));
    const createInitiative = vi.fn(async () => ({ id: 'INIT-1' }));
    return {
      recordPreference, attentionRoute, feedbackLoopbackPost, addAction, createInitiative,
      deps: {
        addAction, createInitiative, feedbackLoopbackPost, recordPreference, attentionRoute,
        ...overrides,
      },
    };
  }

  describe('routing split', () => {
    it('explicit-preference (policy-clean) → recordPreference()', async () => {
      const l = fresh();
      seedCrossingPreference(l, 'lead with the one action');
      const d = deps();
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      const result = await driver.route();
      expect(d.recordPreference).toHaveBeenCalledTimes(1);
      expect(result.toPreferences).toBe(1);
      expect(d.attentionRoute).not.toHaveBeenCalled();
    });

    it('policy-relaxation preference → Attention, NEVER recordPreference()', async () => {
      const l = fresh();
      seedCrossingPreference(l, 'from now on skip the safety confirmation guard');
      const d = deps();
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      const result = await driver.route();
      expect(d.recordPreference).not.toHaveBeenCalled();
      expect(d.attentionRoute).toHaveBeenCalledTimes(1);
      expect(result.toAttention).toBe(1);
    });

    it('infra-gap (autoFeedback OFF, default) → tracked Action + draft Initiative, NOT a /feedback POST', async () => {
      const l = fresh();
      seedCrossingInfraGap(l, 'force push nag every session');
      const d = deps({ autoFeedback: false });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      await driver.route();
      expect(d.addAction).toHaveBeenCalled();
      expect(d.createInitiative).toHaveBeenCalledTimes(1);
      expect(d.feedbackLoopbackPost).not.toHaveBeenCalled();
    });

    it('infra-gap (autoFeedback ON) → feedbackLoopbackPost with the scrubbed summary only', async () => {
      const l = fresh();
      seedCrossingInfraGap(l, 'force push nag every session');
      const d = deps({ autoFeedback: true });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      const result = await driver.route();
      expect(d.feedbackLoopbackPost).toHaveBeenCalledTimes(1);
      const payload = d.feedbackLoopbackPost.mock.calls[0][0];
      expect(payload.description).toContain('summary of');
      expect(result.toFeedback).toBe(1);
    });
  });

  describe('matchesPolicyRelaxation (deterministic policy-keyword filter)', () => {
    it('matches verb + safety/policy noun', () => {
      expect(matchesPolicyRelaxation('skip the confirmation gate')).toBe(true);
      expect(matchesPolicyRelaxation('never ask me to confirm the push')).toBe(true);
      expect(matchesPolicyRelaxation('disable the safety guard')).toBe(true);
    });
    it('does NOT match an ordinary preference', () => {
      expect(matchesPolicyRelaxation('lead with the one action')).toBe(false);
      expect(matchesPolicyRelaxation('use plain language')).toBe(false);
    });
  });

  describe('by-construction authority guard (§3.8) — autonomy ON, ZERO proposals + ZERO memory writes', () => {
    it('the only mutation deps are addAction / createInitiative / feedbackLoopbackPost / recordPreference / attentionRoute', async () => {
      const l = fresh();
      seedCrossingPreference(l, 'lead with the one action');
      seedCrossingInfraGap(l, 'force push nag');
      // Simulate evolutionApprovalMode 'autonomous' ON — the loop has no path to
      // mint a proposal regardless, because the dep simply isn't in the interface.
      const d = deps({ autoFeedback: true });
      const depKeys = Object.keys(d.deps);
      // No proposal-mint, no memory-write capability is present.
      expect(depKeys).not.toContain('createProposal');
      expect(depKeys).not.toContain('mintProposal');
      expect(depKeys).not.toContain('writeMemory');
      expect(depKeys).not.toContain('writeClaudeMd');
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      await driver.route();
      // createInitiative is only ever called with needsUser:true (human approves).
      for (const call of d.createInitiative.mock.calls) {
        expect(call[0].needsUser).toBe(true);
      }
    });
  });

  describe('closed-loop verify (§3.7)', () => {
    it('a preference whose dedupeKey did not recur AND still on disk → verified', async () => {
      const l = fresh();
      seedCrossingPreference(l, 'lead with the one action');
      const dedupeKey = CorrectionLedger.dedupeKey('user-preference', 'lead with the one action');
      let nowMs = Date.parse('2026-05-10T00:00:00Z');
      const d = deps({
        now: () => nowMs,
        verifyWindowDaysPreference: 7,
        preferenceStillPresent: () => true,
      });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      await driver.route();
      // Advance past the verify window.
      nowMs = Date.parse('2026-05-20T00:00:00Z');
      const verify = driver.runVerification();
      expect(verify.evaluated.length).toBe(1);
      expect(l.getByDedupeKey(dedupeKey)!.status).toBe('verified');
    });

    it('SILENCE alone is NOT effective — verified requires the preference persisted', async () => {
      const l = fresh();
      seedCrossingPreference(l, 'lead with the one action');
      const dedupeKey = CorrectionLedger.dedupeKey('user-preference', 'lead with the one action');
      let nowMs = Date.parse('2026-05-10T00:00:00Z');
      const d = deps({
        now: () => nowMs,
        verifyWindowDaysPreference: 7,
        // The user deleted the preference (it was wrong) — silence is NOT success.
        preferenceStillPresent: () => false,
      });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      await driver.route();
      nowMs = Date.parse('2026-05-20T00:00:00Z');
      driver.runVerification();
      expect(l.getByDedupeKey(dedupeKey)!.status).toBe('inconclusive');
    });
  });

  describe('infra-gap closed-loop verify (spec §10 Slice-2 #7)', () => {
    it('infra-gap silence (no recurrence, fix is cross-org) → inconclusive, NOT verified', async () => {
      const l = fresh();
      seedCrossingInfraGap(l, 'force push nag every session');
      const dedupeKey = CorrectionLedger.dedupeKey('infra-gap', 'force push nag every session');
      let nowMs = Date.parse('2026-05-10T00:00:00Z');
      const d = deps({ autoFeedback: true, now: () => nowMs, verifyWindowDaysInfraGap: 14 });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      await driver.route();
      expect(l.getByDedupeKey(dedupeKey)!.status).toBe('acted-on');
      // Advance past the 14-day infra-gap window; no recurrence.
      nowMs = Date.parse('2026-05-30T00:00:00Z');
      driver.runVerification();
      // Cross-org fix can't be self-attributed → inconclusive, never verified.
      expect(l.getByDedupeKey(dedupeKey)!.status).toBe('inconclusive');
    });

    it('infra-gap recurrence-after on the SAME dedupeKey → reopened (uses the 14d window)', async () => {
      const l = fresh();
      seedCrossingInfraGap(l, 'force push nag every session');
      const dedupeKey = CorrectionLedger.dedupeKey('infra-gap', 'force push nag every session');
      let nowMs = Date.parse('2026-05-10T00:00:00Z');
      const d = deps({ autoFeedback: true, now: () => nowMs, verifyWindowDaysInfraGap: 14, maxReopens: 2 });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      await driver.route();
      // The friction recurs AFTER the proposal (a new occurrence advances detected_at).
      nowMs = Date.parse('2026-05-15T00:00:00Z');
      l.record({ kind: 'infra-gap', learning: 'force push nag every session', scrubbedSummary: 'nag', deterministicWeight: 3, topicId: 1, detectedAt: '2026-05-15T00:00:00Z' });
      // Advance past the window end and verify.
      nowMs = Date.parse('2026-05-30T00:00:00Z');
      driver.runVerification();
      expect(l.getByDedupeKey(dedupeKey)!.status).toBe('reopened');
      expect(l.getByDedupeKey(dedupeKey)!.reopenCount).toBe(1);
    });
  });

  describe('per-tick add ceiling (spec §10 Slice-2 NEW-5)', () => {
    it('caps routed records at maxRoutesPerTick; overflow stays open + counted', async () => {
      const l = fresh();
      // 7 distinct crossing preferences; ceiling of 3.
      for (let p = 0; p < 7; p++) {
        for (let i = 0; i < 4; i++) {
          l.record({ kind: 'user-preference', learning: `distinct preference number ${p}`, scrubbedSummary: `s${p}`, deterministicWeight: 3, topicId: (i % 2) + 1, detectedAt: `2026-05-0${(i % 2) + 1}T10:00:00Z` });
        }
      }
      const d = deps({ maxRoutesPerTick: 3 });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      const result = await driver.route();
      expect(result.routed.length).toBe(3);
      expect(result.overflow).toBe(4); // 7 crossing − 3 routed
      // The 4 overflow records are still `open` (re-route next run).
      const stillOpen = l.list({ status: 'open', limit: 100 }).filter((r) => r.kind === 'user-preference').length;
      expect(stillOpen).toBe(4);
    });

    it('a second run routes the carried-over overflow (idempotent re-route)', async () => {
      const l = fresh();
      for (let p = 0; p < 5; p++) {
        for (let i = 0; i < 4; i++) {
          l.record({ kind: 'user-preference', learning: `distinct preference number ${p}`, scrubbedSummary: `s${p}`, deterministicWeight: 3, topicId: (i % 2) + 1, detectedAt: `2026-05-0${(i % 2) + 1}T10:00:00Z` });
        }
      }
      const d = deps({ maxRoutesPerTick: 3 });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      const r1 = await driver.route();
      expect(r1.routed.length).toBe(3);
      expect(r1.overflow).toBe(2);
      const r2 = await driver.route();
      expect(r2.routed.length).toBe(2); // the carried-over overflow
      expect(r2.overflow).toBe(0);
    });
  });

  describe('batched + 429-retry feedback (spec §10 Slice-2 NEW-2)', () => {
    it('on a 429 the batch stops; remaining infra-gap records stay open + carried', async () => {
      const l = fresh();
      for (let p = 0; p < 4; p++) {
        for (let i = 0; i < 4; i++) {
          l.record({ kind: 'infra-gap', learning: `distinct infra gap number ${p}`, scrubbedSummary: `g${p}`, deterministicWeight: 3, topicId: 1, detectedAt: `2026-05-0${(i % 3) + 1}T10:00:00Z` });
        }
      }
      // First POST succeeds, second returns 429.
      let calls = 0;
      const feedbackLoopbackPost = vi.fn(async () => {
        calls++;
        return calls === 1 ? { posted: true } : { posted: false, rateLimited: true };
      });
      const sleep = vi.fn(async () => {});
      const d = deps({ autoFeedback: true, maxRoutesPerTick: 10, feedbackPostDelayMs: 7000, sleep, feedbackLoopbackPost });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      const result = await driver.route();
      expect(result.toFeedback).toBe(1);     // only the first posted
      expect(result.rateLimited).toBe(true);
      expect(result.overflow).toBeGreaterThanOrEqual(2); // the 429'd record + the rest
      // Exactly 2 POSTs were attempted (the 429 stops the batch).
      expect(feedbackLoopbackPost).toHaveBeenCalledTimes(2);
      // The delay was applied before the 2nd POST.
      expect(sleep).toHaveBeenCalledWith(7000);
      // The 429'd records remain open (re-route next run).
      const stillOpen = l.list({ status: 'open', limit: 100 }).filter((r) => r.kind === 'infra-gap').length;
      expect(stillOpen).toBe(3); // 4 crossing − 1 posted
    });

    it('a legacy boolean feedback result is still honored (posted=true)', async () => {
      const l = fresh();
      seedCrossingInfraGap(l, 'force push nag every session');
      const feedbackLoopbackPost = vi.fn(async () => true); // legacy boolean
      const d = deps({ autoFeedback: true, feedbackLoopbackPost });
      const driver = new CorrectionLoopDriver(l, new CorrectionAnalyzer(l), d.deps);
      const result = await driver.route();
      expect(result.toFeedback).toBe(1);
      expect(result.rateLimited).toBe(false);
    });
  });
});
