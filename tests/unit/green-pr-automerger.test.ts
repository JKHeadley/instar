/**
 * Tier-1 tests for the GreenPrAutoMerger orchestrator (green-pr-automerge R1–R11).
 * Fake deps exercise every gate on both sides: lease, single-flight busy-skip,
 * dual-latch disabled, warm-up observe-only, identity contract (4 states),
 * protected-paths routing, dry-run inertness, merge success/failure, the
 * timeout invariant boot refusal, and B10 unconfirmed-merge.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GreenPrAutoMerger,
  freshState,
  type GreenPrAutoMergerDeps,
  type GreenPrState,
  type MergeRunResult,
  type MergeAttempt,
  type ProtectedPathsVerdict,
} from '../../src/monitoring/GreenPrAutoMerger.js';
import type { PrSummary } from '../../src/monitoring/greenPrLogic.js';

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 100, title: 'feat: x', labels: [], isDraft: false,
  headRefName: 'echo/feature', headRefOid: 'sha100', mergeable: 'MERGEABLE', statusRollup: 'SUCCESS', ...over,
});

interface Harness {
  deps: GreenPrAutoMergerDeps;
  state: GreenPrState;
  audits: Record<string, unknown>[];
  runCalls: MergeAttempt[];
  attentionLines: string[][];
}

function harness(over: Partial<{
  lease: boolean;
  epoch: number;
  prs: PrSummary[];
  gateAllowed: boolean;
  ghLogin: string | null;
  protectedFor: (n: number) => ProtectedPathsVerdict;
  runResult: MergeRunResult;
  refetchState: string;
}> = {}): Harness {
  const state = freshState();
  const audits: Record<string, unknown>[] = [];
  const runCalls: MergeAttempt[] = [];
  const attentionLines: string[][] = [];
  let t = 1_000_000;
  const deps: GreenPrAutoMergerDeps = {
    holdsLease: () => over.lease ?? true,
    leaseEpoch: () => over.epoch ?? 1,
    listOpenPrs: async () => over.prs ?? [pr()],
    protectedPaths: async (p) => (over.protectedFor ? over.protectedFor(p.number) : { touches: false, unverifiable: false }),
    refetchPr: async (n) => ({ title: 'feat: x', labels: [], isDraft: false, headRefOid: 'sha100', state: over.refetchState ?? 'OPEN' }),
    resolveGhLogin: async () => (over.ghLogin === undefined ? 'echo-bot' : over.ghLogin),
    holdEligible: async () => ({ ok: true }),
    applyHoldMarker: async () => true,
    runner: {
      probeContract: async () => ({ ok: true, version: 2 }),
      run: async (a) => { runCalls.push(a); return over.runResult ?? { outcome: 'merged', confirmedMerged: true }; },
      reapOrphan: async () => ({ reaped: false }),
    },
    latches: { isMergeAllowed: () => ({ allowed: over.gateAllowed ?? true, reason: (over.gateAllowed ?? true) ? 'allowed' : 'rollback', activeLatchIds: {} }) },
    postAttentionAggregate: async (lines) => { attentionLines.push(lines); },
    audit: (e) => audits.push(e),
    loadState: () => state,
    saveState: () => { /* in-place */ },
    now: () => (t += 1000),
  };
  return { deps, state, audits, runCalls, attentionLines };
}

const cfg = { agentNamespace: 'echo', repo: 'JKHeadley/instar', enabled: true, expectedGhLogin: 'echo-bot' };

describe('GreenPrAutoMerger — gates', () => {
  it('does not act when not the lease holder', async () => {
    const h = harness({ lease: false });
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.reason).toBe('not-lease-holder');
    expect(h.runCalls.length).toBe(0);
  });

  it('does not act when the dual-latch gate is closed', async () => {
    const h = harness({ gateAllowed: false });
    // Need a non-warmup tick: prime lastActingEpoch.
    h.state.lastActingEpoch = 1;
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.reason).toMatch(/disabled:rollback/);
    expect(h.runCalls.length).toBe(0);
  });

  it('the first tick of a tenure is warm-up (observe-only)', async () => {
    const h = harness();
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.reason).toBe('warm-up');
    expect(h.runCalls.length).toBe(0);
    expect(h.audits.some(a => a.event === 'tick-warm-up')).toBe(true);
  });
});

describe('GreenPrAutoMerger — acting (post warm-up)', () => {
  const prime = (h: Harness) => { h.state.lastActingEpoch = 1; };

  it('merges the oldest eligible candidate and reaps the episode', async () => {
    const h = harness({ prs: [pr({ number: 200 }), pr({ number: 100 })] });
    prime(h);
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.acted).toBe(true);
    expect(h.runCalls.length).toBe(1);
    expect(h.runCalls[0].pr).toBe(100); // oldest first
    expect(h.state.episodes[100]).toBeUndefined(); // reaped on success
  });

  it('dry-run observes but never spawns', async () => {
    const h = harness();
    prime(h);
    const r = await new GreenPrAutoMerger(h.deps, { ...cfg, dryRun: true }).tick();
    expect(r.reason).toBe('dry-run');
    expect(h.runCalls.length).toBe(0);
    expect(h.audits.some(a => a.event === 'would-merge')).toBe(true);
  });

  it('routes a protected-paths PR to the operator and never merges it', async () => {
    const h = harness({ protectedFor: () => ({ touches: true, unverifiable: false }) });
    prime(h);
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.acted).toBe(false);
    expect(h.runCalls.length).toBe(0);
    expect(h.attentionLines.flat().some(l => /protected paths/.test(l))).toBe(true);
    // Snapshot carries it as the operator-routed variant for Layer 2.
    expect(h.state.snapshot.entries.some(e => e.kind === 'protected-paths')).toBe(true);
  });

  it('a held PR is excluded', async () => {
    const h = harness({ prs: [pr({ labels: ['hold'] })] });
    prime(h);
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.reason).toBe('no-candidate');
    expect(h.runCalls.length).toBe(0);
  });
});

describe('GreenPrAutoMerger — identity contract (R4)', () => {
  const prime = (h: Harness) => { h.state.lastActingEpoch = 1; };

  it('skips when expectedGhLogin is unset', async () => {
    const h = harness();
    prime(h);
    await new GreenPrAutoMerger(h.deps, { ...cfg, expectedGhLogin: '' }).tick();
    expect(h.audits.some(a => a.event === 'skipped:identity-unconfigured')).toBe(true);
    expect(h.runCalls.length).toBe(0);
  });
  it('skips when the resolved login mismatches', async () => {
    const h = harness({ ghLogin: 'someone-else' });
    prime(h);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.audits.some(a => a.event === 'skipped:identity-mismatch')).toBe(true);
  });
  it('skips when the login cannot be resolved', async () => {
    const h = harness({ ghLogin: null });
    prime(h);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.audits.some(a => a.event === 'skipped:identity-unresolved')).toBe(true);
  });
});

describe('GreenPrAutoMerger — outcomes', () => {
  const prime = (h: Harness) => { h.state.lastActingEpoch = 1; };

  it('a merged-by-other refetch is a success-noop, not a ladder failure', async () => {
    const h = harness({ refetchState: 'MERGED' });
    prime(h);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.runCalls.length).toBe(0);
    expect(h.state.episodes[100]?.state).toBe('gave-up'); // terminal noop
    expect(h.state.episodes[100]?.lastOutcome).toBe('merged-by-other');
  });

  it('B10: an unconfirmed "merged" is reclassified as error, not success', async () => {
    const h = harness({ runResult: { outcome: 'merged', confirmedMerged: false } });
    prime(h);
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.acted).toBe(false);
    expect(h.audits.some(a => a.event === 'error:merge-unconfirmed')).toBe(true);
  });

  it('a deadline-killed attempt feeds the deadline-kill breaker counter', async () => {
    const h = harness({ runResult: { outcome: 'refused:checks-timeout', confirmedMerged: false, deadlineKilled: true } });
    prime(h);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.breaker.consecutiveDeadlineKills).toBe(1);
  });
});

describe('GreenPrAutoMerger — boot invariant', () => {
  it('refuses to start when the timeout invariant is inverted', () => {
    const h = harness();
    // busySkip 2 × tick 600000 = 1.2M < mergeTimeout 1.5M + grace 60k → inverted
    const m = new GreenPrAutoMerger(h.deps, { ...cfg, busySkipBreakerThreshold: 2 });
    expect(m.invariantOk).toBe(false);
    m.start();
    expect(h.audits.some(a => a.event === 'boot-refused-invariant')).toBe(true);
  });
});
