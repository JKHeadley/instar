/**
 * Tier-1 tests for the red-PR watchdog (red-pr-watchdog).
 *
 * Two layers:
 *  1. The pure rollup helpers — latestRunPerCheck / failingChecksFromRollup /
 *     stuckRedChecks / the deriveRollup latest-run-dedup fix (the 2026-07-08
 *     bug: a stale FAILED run superseded by a passing rerun must NOT read
 *     FAILURE).
 *  2. The orchestrator pass — redPrWatchdogPass raises ONE deduped,
 *     age-escalating attention line for a self-authored PR stuck RED past the
 *     threshold; clears on recovery; skips a green / not-authored-by-me PR.
 */

import { describe, it, expect } from 'vitest';
import {
  latestRunPerCheck,
  failingChecksFromRollup,
  stuckRedChecks,
  type PrSummary,
} from '../../src/monitoring/greenPrLogic.js';
import { deriveRollup } from '../../src/monitoring/greenPrAutomergeWiring.js';
import {
  GreenPrAutoMerger,
  freshState,
  type GreenPrAutoMergerDeps,
  type GreenPrState,
} from '../../src/monitoring/GreenPrAutoMerger.js';

const NOW = 1_700_000_000_000; // fixed clock for determinism
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 100, title: 'feat: x', labels: [], isDraft: false,
  headRefName: 'echo/feature', headRefOid: 'sha100', mergeable: 'MERGEABLE', statusRollup: 'SUCCESS', ...over,
});

// ── pure rollup helpers ────────────────────────────────────────────────────

describe('latestRunPerCheck — dedup to the newest run per check name', () => {
  it('keeps the later run when a check name repeats (by startedAt)', () => {
    const rollup = [
      { __typename: 'CheckRun', name: 'shard 4', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: iso(NOW - 3 * H), completedAt: iso(NOW - 3 * H + 60_000) },
      { __typename: 'CheckRun', name: 'shard 4', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: iso(NOW - 1 * H), completedAt: iso(NOW - 1 * H + 60_000) },
    ];
    const latest = latestRunPerCheck(rollup);
    expect(latest).toHaveLength(1);
    expect(latest[0].conclusion).toBe('SUCCESS'); // the newer run wins
  });

  it('keeps distinct check names separate and preserves unnamed checks', () => {
    const rollup = [
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: iso(NOW) },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: iso(NOW), completedAt: iso(NOW) },
      { context: 'legacy-status', state: 'FAILURE', createdAt: iso(NOW) }, // StatusContext shape
      { status: 'COMPLETED', conclusion: 'SUCCESS' }, // unnamed → kept as-is
    ];
    const latest = latestRunPerCheck(rollup);
    expect(latest.map((c) => c.name).sort()).toEqual(['', 'legacy-status', 'lint', 'test']);
    // StatusContext state maps into `conclusion`.
    expect(latest.find((c) => c.name === 'legacy-status')?.conclusion).toBe('FAILURE');
  });
});

describe('failingChecksFromRollup', () => {
  it('returns only latest-run failing checks with their completedAt', () => {
    const rollup = [
      { name: 'shard 1', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: iso(NOW), completedAt: iso(NOW) },
      { name: 'shard 4', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: iso(NOW - 2 * H), completedAt: iso(NOW - 2 * H) },
    ];
    const failing = failingChecksFromRollup(rollup);
    expect(failing).toHaveLength(1);
    expect(failing[0].name).toBe('shard 4');
    expect(failing[0].completedAt).toBe(NOW - 2 * H);
  });

  it('does NOT report a failing check that a later run turned green (the 2026-07-08 regression)', () => {
    const rollup = [
      { name: 'shard 4', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: iso(NOW - 3 * H), completedAt: iso(NOW - 3 * H) },
      { name: 'shard 4', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: iso(NOW - 1 * H), completedAt: iso(NOW - 1 * H) },
    ];
    expect(failingChecksFromRollup(rollup)).toEqual([]);
  });

  it('treats ERROR / CANCELLED / TIMED_OUT as failing but SKIPPED / NEUTRAL as not', () => {
    const rollup = [
      { name: 'a', status: 'COMPLETED', conclusion: 'ERROR', completedAt: iso(NOW) },
      { name: 'b', status: 'COMPLETED', conclusion: 'TIMED_OUT', completedAt: iso(NOW) },
      { name: 'c', status: 'COMPLETED', conclusion: 'SKIPPED', completedAt: iso(NOW) },
      { name: 'd', status: 'COMPLETED', conclusion: 'NEUTRAL', completedAt: iso(NOW) },
    ];
    expect(failingChecksFromRollup(rollup).map((c) => c.name).sort()).toEqual(['a', 'b']);
  });
});

describe('stuckRedChecks', () => {
  const thresholdMs = 2 * H;
  it('flags a failing check older than the threshold', () => {
    const p = pr({ failingChecks: [{ name: 'shard 4', completedAt: NOW - 3 * H }] });
    expect(stuckRedChecks(p, NOW, thresholdMs)).toHaveLength(1);
  });
  it('does NOT flag a fresh failure below the threshold (mid-churn)', () => {
    const p = pr({ failingChecks: [{ name: 'shard 4', completedAt: NOW - 1 * H }] });
    expect(stuckRedChecks(p, NOW, thresholdMs)).toEqual([]);
  });
  it('does NOT flag a failing check with an unknown completed time (fail toward not-alerting)', () => {
    const p = pr({ failingChecks: [{ name: 'shard 4', completedAt: 0 }] });
    expect(stuckRedChecks(p, NOW, thresholdMs)).toEqual([]);
  });
  it('a PR with no failing checks is never stuck', () => {
    expect(stuckRedChecks(pr(), NOW, thresholdMs)).toEqual([]);
  });
});

describe('deriveRollup — latest-run dedup fix', () => {
  it('a stale FAILED run superseded by a passing rerun reads SUCCESS, not FAILURE', () => {
    const rollup = [
      { name: 'shard 4', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: iso(NOW - 3 * H) },
      { name: 'shard 4', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: iso(NOW - 1 * H) },
    ];
    expect(deriveRollup(rollup)).toBe('SUCCESS');
  });
  it('a genuinely-failed latest run still reads FAILURE', () => {
    const rollup = [
      { name: 'shard 4', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: iso(NOW - 3 * H) },
      { name: 'shard 4', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: iso(NOW - 1 * H) },
    ];
    expect(deriveRollup(rollup)).toBe('FAILURE');
  });
  it('an in-progress rerun reads PENDING even after a prior failure', () => {
    const rollup = [
      { name: 'shard 4', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: iso(NOW - 3 * H) },
      { name: 'shard 4', status: 'IN_PROGRESS', conclusion: null, startedAt: iso(NOW - 1 * H) },
    ];
    expect(deriveRollup(rollup)).toBe('PENDING');
  });
  it('all-green reads SUCCESS; a string passthrough is preserved', () => {
    expect(deriveRollup([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('SUCCESS');
    expect(deriveRollup('SUCCESS')).toBe('SUCCESS');
    expect(deriveRollup(null)).toBeNull();
  });
});

// ── orchestrator pass ───────────────────────────────────────────────────────

interface Harness {
  deps: GreenPrAutoMergerDeps;
  state: GreenPrState;
  audits: Record<string, unknown>[];
  attentionCalls: string[][];
}

function harness(prs: PrSummary[], opts: { epoch?: number } = {}): Harness {
  const state = freshState();
  const audits: Record<string, unknown>[] = [];
  const attentionCalls: string[][] = [];
  const deps: GreenPrAutoMergerDeps = {
    holdsLease: () => true,
    leaseEpoch: () => opts.epoch ?? 1,
    listOpenPrs: async () => prs,
    protectedPaths: async () => ({ touches: false, unverifiable: false }),
    refetchPr: async () => ({ title: 'feat', labels: [], isDraft: false, headRefOid: 'sha100', state: 'OPEN', autoMergeRequest: null }),
    disarmArmedEpisodes: async () => true,
    resolveGhLogin: async () => 'echo-bot',
    holdEligible: async () => ({ ok: true }),
    applyHoldMarker: async () => true,
    runner: {
      probeContract: async () => ({ ok: true, version: 2 }),
      run: async () => ({ outcome: 'merged', confirmedMerged: true }),
      reapOrphan: async () => ({ reaped: false }),
    },
    latches: { isMergeAllowed: () => ({ allowed: true, reason: 'allowed', activeLatchIds: {} }) },
    postAttentionAggregate: async (lines) => { attentionCalls.push(lines); },
    audit: (e) => audits.push(e),
    loadState: () => state,
    saveState: () => { /* in-place */ },
    now: () => NOW,
  };
  return { deps, state, audits, attentionCalls };
}

const cfg = { agentNamespace: 'echo', repo: 'JKHeadley/instar', enabled: true, expectedGhLogin: 'echo-bot' };
const redPr = (over: Partial<PrSummary> = {}) =>
  pr({ number: 1399, statusRollup: 'FAILURE', failingChecks: [{ name: 'shard 4', completedAt: NOW - 3 * H }], ...over });

describe('redPrWatchdogPass — orchestrator', () => {
  it('(a) a self-authored PR stuck RED past the threshold raises ONE attention line', async () => {
    const h = harness([redPr()]);
    await new GreenPrAutoMerger(h.deps, cfg).tick(); // warm-up tick still runs the watchdog
    expect(h.attentionCalls).toHaveLength(1);
    expect(h.attentionCalls[0].some((l) => /PR #1399 red for 3h — shard 4/.test(l))).toBe(true);
    expect(h.state.redPrRaised?.[1399]).toBeTruthy();
    expect(h.audits.some((a) => a.event === 'red-pr-stuck' && a.pr === 1399)).toBe(true);
  });

  it('(b) a fresh failure BELOW the threshold raises nothing (mid-churn)', async () => {
    const h = harness([redPr({ failingChecks: [{ name: 'shard 4', completedAt: NOW - 1 * H }] })]);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.attentionCalls).toHaveLength(0);
    expect(h.state.redPrRaised?.[1399]).toBeUndefined();
  });

  it('(c) a stale FAILED run superseded by a passing rerun is NOT stuck-red (the tonight-bug regression)', async () => {
    // The wiring would have set failingChecks:[] via latestRunPerCheck; model that here.
    const h = harness([redPr({ statusRollup: 'SUCCESS', failingChecks: [] })]);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.attentionCalls).toHaveLength(0);
    expect(h.state.redPrRaised?.[1399]).toBeUndefined();
  });

  it('(d) the same stuck PR over two ticks raises ONE item (redPrRaised dedup memory)', async () => {
    const h = harness([redPr()]);
    const merger = new GreenPrAutoMerger(h.deps, cfg);
    await merger.tick(); // warm-up: raises
    await merger.tick(); // acting: same age + checks → no re-raise
    expect(h.attentionCalls).toHaveLength(1);
  });

  it('(e) a green PR raises nothing', async () => {
    const h = harness([pr({ number: 1399 })]); // statusRollup SUCCESS, no failingChecks
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.attentionCalls).toHaveLength(0);
    expect(h.state.redPrRaised?.[1399]).toBeUndefined();
  });

  it('(f) a PR NOT authored by me (out of namespace) is skipped even if stuck red', async () => {
    const h = harness([redPr({ headRefName: 'dawn/other' })]);
    await new GreenPrAutoMerger(h.deps, cfg).tick();
    expect(h.attentionCalls).toHaveLength(0);
    expect(h.state.redPrRaised?.[1399]).toBeUndefined();
  });

  it('clears the raise memory when the PR recovers (goes green)', async () => {
    const h = harness([redPr()]);
    const merger = new GreenPrAutoMerger(h.deps, cfg);
    await merger.tick(); // raised
    expect(h.state.redPrRaised?.[1399]).toBeTruthy();
    // Same PR now green.
    (h.deps as { listOpenPrs: () => Promise<PrSummary[]> }).listOpenPrs = async () => [pr({ number: 1399 })];
    await merger.tick();
    expect(h.state.redPrRaised?.[1399]).toBeUndefined();
    expect(h.audits.some((a) => a.event === 'red-pr-recovered' && a.pr === 1399)).toBe(true);
  });

  it('clears the raise memory when the PR leaves the open list (merged/closed)', async () => {
    const h = harness([redPr()]);
    const merger = new GreenPrAutoMerger(h.deps, cfg);
    await merger.tick(); // raised
    (h.deps as { listOpenPrs: () => Promise<PrSummary[]> }).listOpenPrs = async () => [];
    await merger.tick();
    expect(h.state.redPrRaised?.[1399]).toBeUndefined();
    expect(h.audits.some((a) => a.event === 'red-pr-cleared' && a.pr === 1399)).toBe(true);
  });

  it('re-raises on age escalation (elapsed-hours bucket grows)', async () => {
    const h = harness([redPr()]);
    const merger = new GreenPrAutoMerger(h.deps, cfg);
    await merger.tick(); // raised at 3h
    // Advance the failing check's age to 5h by re-listing with an older completedAt.
    (h.deps as { listOpenPrs: () => Promise<PrSummary[]> }).listOpenPrs =
      async () => [redPr({ failingChecks: [{ name: 'shard 4', completedAt: NOW - 5 * H }] })];
    await merger.tick();
    expect(h.attentionCalls).toHaveLength(2);
    expect(h.attentionCalls[1].some((l) => /red for 5h/.test(l))).toBe(true);
  });

  it('is a no-op when disabled via config', async () => {
    const h = harness([redPr()]);
    await new GreenPrAutoMerger(h.deps, { ...cfg, redPrWatchdog: { enabled: false } }).tick();
    expect(h.attentionCalls).toHaveLength(0);
    expect(h.state.redPrRaised?.[1399]).toBeUndefined();
  });

  it('redPrWatchdogView surfaces config + live stuck-red memory', async () => {
    const h = harness([redPr()]);
    const merger = new GreenPrAutoMerger(h.deps, cfg);
    await merger.tick();
    const view = merger.redPrWatchdogView();
    expect(view.config).toEqual({ enabled: true, redThresholdMs: 7_200_000 });
    expect(view.stuckRed).toHaveLength(1);
    expect(view.stuckRed[0]).toMatchObject({ pr: 1399, failingChecks: ['shard 4'] });
    expect(view.stuckRed[0].redForMs).toBe(3 * H);
  });
});
