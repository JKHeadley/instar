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

type RefetchResult = Awaited<ReturnType<GreenPrAutoMergerDeps['refetchPr']>>;

interface Harness {
  deps: GreenPrAutoMergerDeps;
  state: GreenPrState;
  audits: Record<string, unknown>[];
  runCalls: MergeAttempt[];
  attentionLines: string[][];
  disarmCalls: number[];
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
  /** Full control of refetchPr per PR (overrides refetchState when set). */
  refetch: (n: number) => RefetchResult;
  /** Per-PR confirmed-disabled result for disarmArmedEpisodes (default true). */
  disarmResult: (n: number) => boolean;
  now: () => number;
}> = {}): Harness {
  const state = freshState();
  const audits: Record<string, unknown>[] = [];
  const runCalls: MergeAttempt[] = [];
  const attentionLines: string[][] = [];
  const disarmCalls: number[] = [];
  let t = 1_000_000;
  const nowFn = over.now ?? (() => (t += 1000));
  const deps: GreenPrAutoMergerDeps = {
    holdsLease: () => over.lease ?? true,
    leaseEpoch: () => over.epoch ?? 1,
    listOpenPrs: async () => over.prs ?? [pr()],
    protectedPaths: async (p) => (over.protectedFor ? over.protectedFor(p.number) : { touches: false, unverifiable: false }),
    refetchPr: async (n) => (over.refetch ? over.refetch(n) : { title: 'feat: x', labels: [], isDraft: false, headRefOid: 'sha100', state: over.refetchState ?? 'OPEN' }),
    disarmArmedEpisodes: async (n) => { disarmCalls.push(n); return over.disarmResult ? over.disarmResult(n) : true; },
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
    now: nowFn,
  };
  return { deps, state, audits, runCalls, attentionLines, disarmCalls };
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

// ── mergerunner-auto-arm-handoff ──────────────────────────────────────────

describe('GreenPrAutoMerger — armed accounting + B10 (Blocker B)', () => {
  const prime = (h: Harness) => { h.state.lastActingEpoch = 1; };

  it('an armed result passes through act() UNCHANGED into the armed branch (acted:true, reason:acted), NOT rewritten to error:merge-unconfirmed', async () => {
    const h = harness({ runResult: { outcome: 'armed', confirmedMerged: false, armedHead: 'sha100' } });
    prime(h);
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.acted).toBe(true);
    expect(r.reason).toBe('acted');
    // Episode is alive + armed, NOT errored. The B10 merged-mirror misimpl would
    // have produced error:merge-unconfirmed — forbid that here.
    expect(h.audits.some(a => a.event === 'error:merge-unconfirmed')).toBe(false);
    expect(h.audits.some(a => a.event === 'armed')).toBe(true);
    const ep = h.state.episodes[100];
    expect(ep?.state).toBe('active');
    expect(ep?.armedAt).toBeTruthy();
    expect(ep?.armedHead).toBe('sha100');
    expect(ep?.lastOutcome).toBe('armed');
  });

  it('an armed episode is reaped only by reconciliation, never the act path', async () => {
    const h = harness({ runResult: { outcome: 'armed', confirmedMerged: false, armedHead: 'sha100' } });
    prime(h);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]).toBeDefined(); // NOT reaped on arm
  });
});

describe('GreenPrAutoMerger — gather skip-already-armed (Blocker 2/4)', () => {
  const prime = (h: Harness) => { h.state.lastActingEpoch = 1; };

  it('skips a PR with a LOCAL armedAt episode (never re-arms)', async () => {
    // refetch returns still-OPEN + armed so reconciliation (which runs FIRST)
    // leaves the episode armed; then gather skips it on the local-episode belt.
    const h = harness({
      prs: [pr({ number: 100 })],
      refetch: () => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'sha100', state: 'OPEN', autoMergeRequest: { expectedHeadOid: 'sha100' } }),
    });
    prime(h);
    h.state.episodes[100] = { pr: 100, headRefOid: 'sha100', attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: 5, armedHead: 'sha100' };
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.reason).toBe('no-candidate');
    expect(h.runCalls.length).toBe(0);
    expect(h.audits.some(a => a.event === 'skipped:already-armed' && a.source === 'local-episode')).toBe(true);
  });

  it('skips a PR that GitHub reports autoMergeArmed even with NO local episode (lease-move belt)', async () => {
    const h = harness({ prs: [pr({ number: 100, autoMergeArmed: true })] });
    prime(h);
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.reason).toBe('no-candidate');
    expect(h.runCalls.length).toBe(0);
    expect(h.audits.some(a => a.event === 'skipped:already-armed' && a.source === 'github')).toBe(true);
  });
});

describe('GreenPrAutoMerger — armed-episode reconciliation', () => {
  function armedHarness(refetch: (n: number) => RefetchResult, opts: { now?: () => number } = {}) {
    // No candidates so the tick is acting (post warm-up) and reconciliation runs.
    const h = harness({ prs: [], refetch, now: opts.now });
    h.state.lastActingEpoch = 1; // post warm-up
    h.state.episodes[100] = { pr: 100, headRefOid: 'sha100', attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: 1000, armedHead: 'sha100' };
    return h;
  }

  it('MERGED with final head === armedHead reaps + records merged (no false-fire)', async () => {
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'sha100', state: 'MERGED', mergeCommitOid: 'squashBase', autoMergeRequest: null }));
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]).toBeUndefined(); // reaped
    expect(h.audits.some(a => a.event === 'merged' && a.viaArmed === true)).toBe(true);
    expect(h.audits.some(a => a.event === 'merged-at-unexpected-head')).toBe(false);
  });

  it('MERGED via clean squash (mergeCommitOid ≠ head) does NOT false-fire merged-at-unexpected-head', async () => {
    // The squash base commit oid is DIFFERENT from the head; the detector compares
    // the PR final head, which matches armedHead → clean merge.
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'sha100', state: 'MERGED', mergeCommitOid: 'totallyDifferentSquashCommit', autoMergeRequest: null }));
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.audits.some(a => a.event === 'merged-at-unexpected-head')).toBe(false);
    expect(h.audits.some(a => a.event === 'merged')).toBe(true);
    expect(h.state.episodes[100]).toBeUndefined();
  });

  it('MERGED at a genuinely unexpected final head reaps + audits merged-at-unexpected-head + attention', async () => {
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'DIFFERENTHEAD', state: 'MERGED', mergeCommitOid: 'sq', autoMergeRequest: null }));
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]).toBeUndefined(); // STILL reaped
    expect(h.audits.some(a => a.event === 'merged-at-unexpected-head')).toBe(true);
    expect(h.attentionLines.flat().some(l => /did not arm/.test(l))).toBe(true);
  });

  it('uses autoMergeRequest.expectedHeadOid as the comparison operand when present', async () => {
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'movedHead', state: 'MERGED', mergeCommitOid: 'sq', autoMergeRequest: { expectedHeadOid: 'sha100' } }));
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    // expectedHeadOid === armedHead → clean, despite headRefOid having moved.
    expect(h.audits.some(a => a.event === 'merged-at-unexpected-head')).toBe(false);
    expect(h.audits.some(a => a.event === 'merged')).toBe(true);
  });

  it('CLOSED reaps + records closed-by-other', async () => {
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'sha100', state: 'CLOSED', autoMergeRequest: null }));
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]).toBeUndefined();
    expect(h.audits.some(a => a.event === 'closed-by-other' && a.viaArmed === true)).toBe(true);
  });

  it('still-OPEN + armed holds the episode (steady state, no ladder/breaker)', async () => {
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'sha100', state: 'OPEN', autoMergeRequest: { expectedHeadOid: 'sha100' } }));
    const before = { ...h.state.breaker };
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.armedAt).toBe(1000); // unchanged
    expect(h.state.breaker.consecutiveTickFailures).toBe(before.consecutiveTickFailures);
  });

  it('OPEN with autoMergeRequest ABSENT (disarmed) clears armedAt for re-evaluation', async () => {
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'sha100', state: 'OPEN', autoMergeRequest: null }));
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    const ep = h.state.episodes[100];
    expect(ep).toBeDefined();
    expect(ep?.armedAt).toBeUndefined();
    expect(ep?.armedHead).toBeUndefined();
    expect(h.audits.some(a => a.event === 'armed-cleared' && a.reason === 'disarmed')).toBe(true);
  });

  it('OPEN but head moved past armedHead clears armedAt', async () => {
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'newHead', state: 'OPEN', autoMergeRequest: { expectedHeadOid: 'newHead' } }));
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.armedAt).toBeUndefined();
    expect(h.audits.some(a => a.event === 'armed-cleared' && a.reason === 'head-moved')).toBe(true);
  });

  it('read-failure / UNKNOWN is fail-open: leaves armed, no ladder, no breaker', async () => {
    const h = armedHarness(() => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'sha100', state: 'UNKNOWN', autoMergeRequest: null }));
    const before = h.state.breaker.consecutiveTickFailures;
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.armedAt).toBe(1000); // STILL armed
    expect(h.state.breaker.consecutiveTickFailures).toBe(before); // no breaker feed
    expect(h.audits.some(a => a.event === 'armed-reconcile-read-failed')).toBe(true);
  });

  it('a thrown refetch is also fail-open (leaves armed)', async () => {
    const h = armedHarness(() => { throw new Error('gh down'); });
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.armedAt).toBe(1000);
  });

  it('past the 24h ceiling transitions to armed-overdue, KEEPS reconciling, re-raises deduped', async () => {
    let now = 1000;
    const h = armedHarness(
      () => ({ title: 'x', labels: [], isDraft: false, headRefOid: 'sha100', state: 'OPEN', autoMergeRequest: { expectedHeadOid: 'sha100' } }),
      { now: () => now },
    );
    // First tick: still inside the ceiling → not overdue.
    now = 1000 + 1000;
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.overdue).toBeUndefined();
    // Advance past 24h → overdue + attention.
    now = 1000 + 86_400_000 + 1;
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.overdue).toBe(true);
    expect(h.state.episodes[100]?.armedAt).toBe(1000); // NEVER cleared by the ceiling
    expect(h.attentionLines.flat().some(l => /armed >24h/.test(l))).toBe(true);
    const raises = h.attentionLines.flat().filter(l => /armed >24h/.test(l)).length;
    // A second immediate tick within the re-raise cadence does NOT re-raise.
    now = now + 1000;
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.overdue).toBe(true);
    expect(h.attentionLines.flat().filter(l => /armed >24h/.test(l)).length).toBe(raises);
  });
});

describe('GreenPrAutoMerger — disarm reach (Blocker 3)', () => {
  it('disarmAllArmed disables every armed episode and, on all-confirmed, clears armedAt + raises the disarmed line', async () => {
    const h = harness();
    h.state.episodes[10] = { pr: 10, headRefOid: 'a', attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: 5, armedHead: 'a' };
    h.state.episodes[20] = { pr: 20, headRefOid: 'b', attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: 5, armedHead: 'b' };
    h.state.episodes[30] = { pr: 30, headRefOid: 'c', attempts: 0, rearmEpisodes: 0, state: 'active' }; // NOT armed
    const res = await new GreenPrAutoMerger(h.deps, cfg).disarmAllArmed('rollback');
    expect(res.disarmed.sort()).toEqual([10, 20]);
    expect(res.failed).toEqual([]);
    expect(h.disarmCalls.sort()).toEqual([10, 20]); // never touches the unarmed #30
    expect(h.state.episodes[10]?.armedAt).toBeUndefined();
    expect(h.state.episodes[20]?.armedAt).toBeUndefined();
    expect(h.attentionLines.flat().some(l => /Disarmed auto-merge on PR #10, #20/.test(l))).toBe(true);
  });

  it('honest failure (Blocker 3b): a per-PR --disable-auto FAILURE leaves armedAt set + a DISTINCT failed line, never collapsed', async () => {
    const h = harness({ disarmResult: (n) => n !== 20 }); // #20 fails to disable
    h.state.episodes[10] = { pr: 10, headRefOid: 'a', attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: 5, armedHead: 'a' };
    h.state.episodes[20] = { pr: 20, headRefOid: 'b', attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: 5, armedHead: 'b' };
    const res = await new GreenPrAutoMerger(h.deps, cfg).disarmAllArmed('rollback');
    expect(res.disarmed).toEqual([10]);
    expect(res.failed).toEqual([20]);
    expect(h.state.episodes[10]?.armedAt).toBeUndefined(); // confirmed → cleared
    expect(h.state.episodes[20]?.armedAt).toBe(5);          // failed → LEFT set
    const lines = h.attentionLines.flat();
    expect(lines.some(l => /Disarmed auto-merge on PR #10/.test(l) && !/#20/.test(l))).toBe(true);
    expect(lines.some(l => /Could NOT disable auto-merge on PR #20/.test(l))).toBe(true);
  });

  it('a per-PR HOLD on an armed episode --disable-autos it; an honest non-2xx on disable failure', async () => {
    const okH = harness();
    okH.state.episodes[42] = { pr: 42, headRefOid: 'h', attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: 5, armedHead: 'h' };
    const okRes = await new GreenPrAutoMerger(okH.deps, cfg).applyHold(42, 'wait');
    expect(okRes.ok).toBe(true);
    expect(okH.disarmCalls).toContain(42);
    expect(okH.state.episodes[42]?.armedAt).toBeUndefined();

    const failH = harness({ disarmResult: () => false });
    failH.state.episodes[42] = { pr: 42, headRefOid: 'h', attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: 5, armedHead: 'h' };
    const failRes = await new GreenPrAutoMerger(failH.deps, cfg).applyHold(42, 'wait');
    expect(failRes.ok).toBe(false);
    expect(failRes.status).toBe(502);
    expect(failRes.detail).toMatch(/could not disable the in-flight auto-merge/);
    expect(failH.state.episodes[42]?.armedAt).toBe(5); // NOT cleared on failure
  });
});

describe('GreenPrAutoMerger — unconfirmed-arm ceiling (Blocker D)', () => {
  const prime = (h: Harness) => { h.state.lastActingEpoch = 1; };

  it('repeated error:auto-arm-unconfirmed on the SAME head advances the counter, surfaces ONE line at the ceiling, no ladder', async () => {
    const merger = (h: Harness) => new GreenPrAutoMerger(h.deps, cfg);
    // 3 consecutive unconfirmed arms on sha100 → counter 1,2,3; the line fires at 3.
    let h = harness({ runResult: { outcome: 'error:auto-arm-unconfirmed', confirmedMerged: false } });
    prime(h);
    await merger(h).tick();
    expect(h.state.episodes[100]?.unconfirmedArmAttempts).toEqual({ head: 'sha100', count: 1 });
    expect(h.state.episodes[100]?.attempts).toBe(0); // NOT a ladder attempt
    expect(h.attentionLines.flat().some(l => /cannot confirm it stuck/.test(l))).toBe(false);

    await merger(h).tick();
    expect(h.state.episodes[100]?.unconfirmedArmAttempts?.count).toBe(2);
    await merger(h).tick();
    expect(h.state.episodes[100]?.unconfirmedArmAttempts?.count).toBe(3);
    expect(h.attentionLines.flat().some(l => /cannot confirm it stuck \(3 attempts\)/.test(l))).toBe(true);
    expect(h.state.episodes[100]?.attempts).toBe(0); // STILL not a ladder attempt
    void h;
  });

  it('a head change resets the counter to 1', async () => {
    const h = harness({ runResult: { outcome: 'error:auto-arm-unconfirmed', confirmedMerged: false } });
    prime(h);
    h.state.episodes[100] = { pr: 100, headRefOid: 'sha100', attempts: 0, rearmEpisodes: 0, state: 'active', unconfirmedArmAttempts: { head: 'oldHead', count: 2 } };
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.unconfirmedArmAttempts).toEqual({ head: 'sha100', count: 1 });
  });
});

describe('GreenPrAutoMerger — auto-merge-unavailable terminal-non-ladder', () => {
  const prime = (h: Harness) => { h.state.lastActingEpoch = 1; };

  it('records the refusal + raises ONE attention line, never advancing the ladder', async () => {
    const h = harness({ runResult: { outcome: 'refused:auto-arm-unavailable', confirmedMerged: false } });
    prime(h);
    const r = await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(r.acted).toBe(false);
    expect(h.state.episodes[100]?.attempts).toBe(0); // NOT a ladder attempt
    expect(h.state.episodes[100]?.lastOutcome).toBe('refused:auto-arm-unavailable');
    expect(h.audits.some(a => a.event === 'auto-merge-unavailable')).toBe(true);
    expect(h.attentionLines.flat().some(l => /Allow auto-merge.*disabled/.test(l))).toBe(true);
  });

  it('a generic refused:auto-arm-error:* takes the normal backoff ladder', async () => {
    const h = harness({ runResult: { outcome: 'refused:auto-arm-error:merge-command-failed', confirmedMerged: false } });
    prime(h);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.state.episodes[100]?.attempts).toBe(1); // normal ladder advance
    expect(h.state.episodes[100]?.nextEligibleAt).toBeTruthy(); // backoff set
  });
});

describe('GreenPrAutoMerger — boot invariant', () => {
  it('refuses to start when the timeout invariant is inverted (admin path)', () => {
    const h = harness();
    // The 25-min mergeTimeoutMs invariant is scoped to mergeStrategy:'admin'
    // (mergerunner-auto-arm-handoff §armTimeoutMs). On the admin path:
    // busySkip 2 × tick 600000 = 1.2M < mergeTimeout 1.5M + grace 60k → inverted.
    const m = new GreenPrAutoMerger(h.deps, { ...cfg, mergeStrategy: 'admin', busySkipBreakerThreshold: 2 });
    expect(m.invariantOk).toBe(false);
    m.start();
    expect(h.audits.some(a => a.event === 'boot-refused-invariant')).toBe(true);
  });

  it('the auto path checks the invariant against the SHORT armTimeoutMs, so the same combo is fine', () => {
    const h = harness();
    // Same busySkip 2 × tick 600000 = 1.2M, but the auto path needs only
    // armTimeoutMs(60k) + grace(60k) = 120k — well under budget → not inverted.
    const m = new GreenPrAutoMerger(h.deps, { ...cfg, busySkipBreakerThreshold: 2 });
    expect(m.invariantOk).toBe(true);
  });
});
