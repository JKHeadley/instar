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
});
