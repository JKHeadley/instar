/**
 * ResponseReviewCanary — Tests for Phase 4 (canary tests and health).
 *
 * Tests canary test runner, reviewer health reporting, and health endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import type { ResponseReviewConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

function createGate(overrides?: Partial<ResponseReviewConfig>): CoherenceGate {
  return new CoherenceGate({
    config: {
      enabled: true,
      reviewers: {
        'conversational-tone': { enabled: true, mode: 'block' },
        'settling-detection': { enabled: true, mode: 'warn' },
        'capability-accuracy': { enabled: true, mode: 'block' },
      },
      maxRetries: 2,
      timeoutMs: 8000,
      channelDefaults: {
        external: { failOpen: false, skipGate: true, queueOnFailure: false },
        internal: { failOpen: true, skipGate: false, queueOnFailure: false },
      },
      ...overrides,
    },
    stateDir: tmpDir,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CoherenceGate — Canary & Health', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrg-canary-'));
    fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), '# Test\n## Intent\n- Be helpful');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/CoherenceGateCanary.test.ts:51' });
  });

  // ── Canary Tests ──────────────────────────────────────────────────

  describe('canary test runner', () => {
    it('runs canary tests and returns results', async () => {
      const gate = createGate();
      // Mock fetch to pass everything (canary should detect misses)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.canaryId).toMatch(/^canary-/);
        expect(result.description).toBeDefined();
        expect(result.expectedDimension).toBeDefined();
        expect(typeof result.caught).toBe('boolean');
        expect(typeof result.pass).toBe('boolean');
      }
    });

    it('canary-clean-1 should pass (not be caught)', async () => {
      const gate = createGate();
      // Gate returns no review needed for simple messages
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ needsReview: false, reason: 'Simple ack' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();
      const cleanResult = results.find(r => r.canaryId === 'canary-clean-1');

      expect(cleanResult).toBeDefined();
      // canary-clean-1 shouldBlock=false, so if not caught (pass=true), canary passes
      expect(cleanResult!.caught).toBe(false);
      expect(cleanResult!.pass).toBe(true);
    });

    it('canary-tone-1 should be caught (PEL catches internal URLs)', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();
      const toneResult = results.find(r => r.canaryId === 'canary-tone-1');

      expect(toneResult).toBeDefined();
      // canary-tone-1 contains localhost URL in external message — PEL catches it
      expect(toneResult!.caught).toBe(true);
      expect(toneResult!.pass).toBe(true);
    });

    it('stores canary results for health reporting', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();
      gate.setCanaryResults(results);

      const health = gate.getReviewerHealth();
      expect(health.lastCanaryRun).not.toBeNull();
      expect(health.lastCanaryRun!.length).toBe(results.length);
    });
  });

  // ── Reviewer Health ────────────────────────────────────────────────

  describe('reviewer health', () => {
    // REPLACES a test that asserted `overallStatus === 'healthy'` when no reviews had
    // run. That assertion pinned the defect in place as correct behaviour: a reviewer
    // that had never executed once reported `passRate: 1` (a PERFECT score) and
    // `status: 'healthy'`, so the absence of observations was indistinguishable from
    // the presence of good ones. The name of the old test — "reports healthy status
    // when no reviews have run" — described the bug accurately; only the expectation
    // that this was DESIRABLE was wrong.
    it('refuses to call a reviewer that has NEVER RUN healthy, and reports no rate for it', () => {
      const gate = createGate();
      const health = gate.getReviewerHealth();

      expect(health.overallStatus).toBe('unobserved');
      expect(Object.keys(health.reviewers).length).toBeGreaterThan(0);

      for (const [name, r] of Object.entries(health.reviewers)) {
        expect(r.status, `${name} never ran`).toBe('unobserved');
        // A rate over zero observations is not a rate.
        expect(r.passRate, `${name} passRate`).toBeNull();
        expect(r.errorRate, `${name} errorRate`).toBeNull();
        // The denominator is always present so the reader can see WHY there is no rate.
        expect(r.total).toBe(0);
        expect(r.insufficientEvidence).toBe(true);
        expect(r.observationsRequired).toBeGreaterThan(0);
      }

      expect(health.lastCanaryRun).toBeNull();
    });

    it('does not let thin evidence read as a proven pass rate', () => {
      const gate = createGate();
      // ONE passing observation. The rate is a truthful 1.0 — but 1-of-1 is not a
      // basis for the verdict "healthy", which is the only thing the floor gates.
      const reviewers = (gate as unknown as { reviewers: Map<string, { metrics: Record<string, number> }> }).reviewers;
      const first = [...reviewers.values()][0];
      first.metrics.passCount = 1;

      const r = gate.getReviewerHealth();
      const entry = Object.values(r.reviewers).find(x => x.total === 1)!;
      expect(entry.passRate).toBe(1);          // the rate is reported honestly
      expect(entry.status).toBe('unobserved'); // the VERDICT is withheld
      expect(entry.insufficientEvidence).toBe(true);
    });

    it('still reports FAILING on thin evidence — the floor gates optimism only, never bad news', () => {
      const gate = createGate();
      const reviewers = (gate as unknown as { reviewers: Map<string, { metrics: Record<string, number> }> }).reviewers;
      const first = [...reviewers.values()][0];
      // Errored on both of its only two calls. Below the observation floor, but a
      // failure is a failure — suppressing it "for want of samples" would recreate
      // the original defect pointing the other way.
      first.metrics.errorCount = 2;

      const r = gate.getReviewerHealth();
      const entry = Object.values(r.reviewers).find(x => x.total === 2)!;
      expect(entry.errorRate).toBe(1);
      expect(entry.status).toBe('failing');
      expect(r.overallStatus).toBe('failing');
    });

    it('reports HEALTHY once there is enough evidence to support the claim', () => {
      const gate = createGate();
      const reviewers = (gate as unknown as { reviewers: Map<string, { metrics: Record<string, number> }> }).reviewers;
      for (const rv of reviewers.values()) rv.metrics.passCount = 20;

      const r = gate.getReviewerHealth();
      expect(r.overallStatus).toBe('healthy');
      for (const entry of Object.values(r.reviewers)) {
        expect(entry.status).toBe('healthy');
        expect(entry.passRate).toBe(1);
        expect(entry.insufficientEvidence).toBe(false);
      }
    });

    it('overallStatus never aggregates an unobserved reviewer as healthy', () => {
      const gate = createGate();
      const reviewers = (gate as unknown as { reviewers: Map<string, { metrics: Record<string, number> }> }).reviewers;
      const all = [...reviewers.values()];
      // All but one well-observed and clean; one never ran.
      for (const rv of all.slice(1)) rv.metrics.passCount = 20;

      const r = gate.getReviewerHealth();
      // The healthy majority must not drown out the one we know nothing about.
      expect(r.overallStatus).toBe('unobserved');
    });

    it('reports per-reviewer health metrics', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      await gate.evaluate({
        message: 'A message for health check testing purposes here',
        sessionId: 'health-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      const health = gate.getReviewerHealth();
      for (const [name, reviewer] of Object.entries(health.reviewers)) {
        expect(reviewer).toHaveProperty('passRate');
        expect(reviewer).toHaveProperty('total');
        expect(reviewer).toHaveProperty('status');
        // 'unobserved' included: a reviewer with no observations must be reportable as
        // such rather than being forced into one of the three verdict states.
        expect(['healthy', 'degraded', 'failing', 'unobserved']).toContain(reviewer.status);
      }
    });

    // This test previously carried the comment "Simulate high error rate by directly
    // manipulating metrics" — and then manipulated nothing. It created a fresh gate and
    // asserted `overallStatus === 'healthy'`, so despite its name it exercised the
    // never-ran path and left `degraded` and `failing` with ZERO coverage while sitting
    // green in the suite. A passing test named for a check is indistinguishable from
    // that check being verified. It now performs the simulation its own comment described.
    it('detects degraded status when error rate is high', () => {
      const gate = createGate();
      const reviewers = (gate as unknown as { reviewers: Map<string, { metrics: Record<string, number> }> }).reviewers;
      const first = [...reviewers.values()][0];
      // 3 errors in 10 calls = 0.3 — above the 0.2 degraded threshold, below the 0.5
      // failing one, and well past the observation floor so the verdict is supported.
      first.metrics.passCount = 7;
      first.metrics.errorCount = 3;

      const health = gate.getReviewerHealth();
      const entry = Object.values(health.reviewers).find(x => x.total === 10)!;
      expect(entry.errorRate).toBeCloseTo(0.3, 5);
      expect(entry.status).toBe('degraded');
      expect(health.overallStatus).toBe('degraded');
    });

    it('detects failing status when the error rate is past the failing threshold', () => {
      const gate = createGate();
      const reviewers = (gate as unknown as { reviewers: Map<string, { metrics: Record<string, number> }> }).reviewers;
      const first = [...reviewers.values()][0];
      first.metrics.passCount = 2;
      first.metrics.errorCount = 8; // 0.8 > 0.5

      const health = gate.getReviewerHealth();
      const entry = Object.values(health.reviewers).find(x => x.total === 10)!;
      expect(entry.status).toBe('failing');
      expect(health.overallStatus).toBe('failing');
    });

    it('getReviewerStats reports null rates — not zeros or a perfect score — when nothing ran', () => {
      const gate = createGate();
      const stats = gate.getReviewerStats() as Record<string, Record<string, {
        passRate: number | null; flagRate: number | null; errorRate: number | null;
        avgLatencyMs: number | null; jsonValidityRate: number | null;
        total: number; insufficientEvidence: boolean;
      }>>;
      const perReviewer = stats.reviewers;
      expect(Object.keys(perReviewer).length).toBeGreaterThan(0);
      for (const [name, r] of Object.entries(perReviewer)) {
        // Before: passRate 0 here but 1 in getReviewerHealth — the same quantity with
        // opposite defaults in one file — and jsonValidityRate 1, claiming perfect JSON
        // validity from a reviewer that had never parsed a single response.
        expect(r.passRate, `${name} passRate`).toBeNull();
        expect(r.flagRate, `${name} flagRate`).toBeNull();
        expect(r.errorRate, `${name} errorRate`).toBeNull();
        expect(r.avgLatencyMs, `${name} avgLatencyMs`).toBeNull();
        expect(r.jsonValidityRate, `${name} jsonValidityRate`).toBeNull();
        expect(r.total).toBe(0);
        expect(r.insufficientEvidence).toBe(true);
      }
    });

    it('includes canary results in health report after running canaries', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      // Before canary
      expect(gate.getReviewerHealth().lastCanaryRun).toBeNull();

      // Run canary
      const results = await gate.runCanaryTests();
      gate.setCanaryResults(results);

      // After canary
      const health = gate.getReviewerHealth();
      expect(health.lastCanaryRun).toHaveLength(results.length);
    });
  });

  // ── Integration: Canary + Proposal ────────────────────────────────

  describe('canary failure triggers investigation', () => {
    it('canary miss can be logged as a proposal for investigation', async () => {
      const gate = createGate();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' }) }],
        }),
      }));

      const results = await gate.runCanaryTests();
      const misses = results.filter(r => !r.pass);

      // If any canary was missed, create a proposal
      for (const miss of misses) {
        const proposal = gate.addProposal({
          type: 'modify-reviewer',
          title: `Canary miss: ${miss.canaryId}`,
          description: `Canary ${miss.canaryId} (${miss.description}) was not caught by ${miss.expectedDimension}`,
          source: 'canary',
          data: { canaryId: miss.canaryId, verdict: miss.verdict },
        });
        expect(proposal.source).toBe('canary');
      }

      // The gate should have proposals equal to the number of misses
      const proposals = gate.getProposals('pending');
      expect(proposals.length).toBe(misses.length);
    });
  });
});
