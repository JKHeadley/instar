/**
 * Tier-1 tests for the green-PR watcher's local floor
 * (docs/specs/local-verify-merge-authority.md §2 "Who starts a verify", §3,
 * Rollback): record-based candidacy instead of the Actions rollup, `sync`
 * merges regardless of mergeStrategy, the one-time actions→local disarm, and
 * verify requests (5-minute head stability, oldest-ready first, none while
 * `main` is not healthy). Both sides of every rule.
 */

import { describe, it, expect } from 'vitest';
import {
  GreenPrAutoMerger,
  freshState,
  VERIFY_HEAD_STABLE_MS,
  type GreenPrAutoMergerDeps,
  type GreenPrState,
  type LocalVerifyHook,
  type MergeAttempt,
} from '../../src/monitoring/GreenPrAutoMerger.js';
import type { PrSummary } from '../../src/monitoring/greenPrLogic.js';
import { mapPr } from '../../src/monitoring/greenPrAutomergeWiring.js';

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 100, title: 'feat: x', labels: [], isDraft: false,
  headRefName: 'echo/feature', headRefOid: 'sha100', baseRefName: 'main', mergeable: 'MERGEABLE', statusRollup: 'SUCCESS', ...over,
});

interface H {
  deps: GreenPrAutoMergerDeps;
  state: GreenPrState;
  audits: Record<string, unknown>[];
  runCalls: MergeAttempt[];
  disarmCalls: number[];
  clock: { t: number };
}

function harness(prs: PrSummary[], policy: { reviewsRequired: boolean; lastPushApprovalRequired: boolean } | 'throw' | 'absent' = { reviewsRequired: false, lastPushApprovalRequired: false }): H {
  const state = freshState();
  state.lastActingEpoch = 1; // past warm-up
  const audits: Record<string, unknown>[] = [];
  const runCalls: MergeAttempt[] = [];
  const disarmCalls: number[] = [];
  const clock = { t: 10_000_000 };
  const deps: GreenPrAutoMergerDeps = {
    holdsLease: () => true,
    leaseEpoch: () => 1,
    listOpenPrs: async () => prs,
    ...(policy === 'absent' ? {} : { rulesetReviewPolicy: async () => { if (policy === 'throw') throw new Error('ruleset unreadable'); return policy; } }),
    codeOwnedPaths: async () => ({ touches: false, files: [], unverifiable: false }),
    refetchPr: async (n) => {
      const p = prs.find((x) => x.number === n)!;
      return { title: p.title, labels: p.labels, isDraft: p.isDraft, headRefOid: p.headRefOid, state: 'OPEN' };
    },
    disarmArmedEpisodes: async (n) => { disarmCalls.push(n); return true; },
    resolveGhLogin: async () => 'echo-bot',
    holdEligible: async () => ({ ok: true }),
    applyHoldMarker: async () => true,
    runner: {
      probeContract: async () => ({ ok: true, version: 2 }),
      run: async (a) => { runCalls.push(a); return { outcome: 'merged', confirmedMerged: true }; },
      reapOrphan: async () => ({ reaped: false }),
    },
    latches: { isMergeAllowed: () => ({ allowed: true, reason: 'allowed', activeLatchIds: {} }) },
    postAttentionAggregate: async () => {},
    audit: (e) => audits.push(e),
    loadState: () => state,
    saveState: () => {},
    now: () => clock.t,
  };
  return { deps, state, audits, runCalls, disarmCalls, clock };
}

function hook(over: Partial<{ floor: 'local' | 'actions' | null; health: 'healthy' | 'main-suspect' | 'main-red' | null; records: Set<string>; throwFloor: boolean }> = {}) {
  const requested: number[] = [];
  const lv: LocalVerifyHook = {
    effectiveFloor: () => { if (over.throwFloor) throw new Error('boom'); return over.floor === undefined ? 'local' : over.floor; },
    mainHealth: () => (over.health === undefined ? 'healthy' : over.health),
    hasRecord: (p, h, b) => (over.records ?? new Set()).has(`${p}:${h}:${b}`),
    requestVerify: async (p) => { requested.push(p); return { ok: true, status: 'queued' }; },
  };
  return { lv, requested };
}

const cfg = { agentNamespace: 'echo', repo: 'JKHeadley/instar', enabled: true, expectedGhLogin: 'echo-bot', mergeStrategy: 'auto' as const };

describe('local floor — a flagged record without an independent review (directive 2026-10-22)', () => {
  it('refused:needs-independent-review is terminal for the head: no ladder, no attention item, no re-spawn until the head moves', async () => {
    const prs = [pr()];
    const h = harness(prs);
    const lines: string[][] = [];
    h.deps.postAttentionAggregate = async (l) => { lines.push(l); };
    h.deps.runner.run = async (a) => { h.runCalls.push(a); return { outcome: 'refused:needs-independent-review' } as never; };
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: new Set(['100:sha100:main', '100:sha101:main']) }).lv);
    await w.tick();
    expect(h.runCalls).toHaveLength(1);
    expect(h.state.episodes[100]).toMatchObject({ lastOutcome: 'refused:needs-independent-review', headRefOid: 'sha100', attempts: 0 });
    expect(h.audits.some((a) => a.event === 'needs-independent-review')).toBe(true);
    expect(lines.flat().some((l) => /approv|operator|review/i.test(l))).toBe(false);
    h.clock.t += 60 * 60_000;
    await w.tick();
    expect(h.runCalls).toHaveLength(1); // same head: not attempted again
    // The trace is committed: a new head (with its own record) is attempted.
    prs[0] = pr({ headRefOid: 'sha101' });
    h.deps.runner.run = async (a) => { h.runCalls.push(a); return { outcome: 'merged', confirmedMerged: true }; };
    h.clock.t += 60 * 60_000;
    await w.tick();
    expect(h.runCalls).toHaveLength(2);
    expect(h.runCalls[1]).toMatchObject({ pr: 100 });
  });
});

describe('local floor — candidacy and merge strategy', () => {
  it('merges a PR with a record even while its Actions rollup is PENDING, with strategy sync', async () => {
    const h = harness([pr({ statusRollup: 'PENDING' })]);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: new Set(['100:sha100:main']) }).lv);
    const r = await w.tick();
    expect(r.acted).toBe(true);
    expect(h.runCalls[0]).toMatchObject({ pr: 100, strategy: 'sync' });
  });

  it('does not merge a SUCCESS-rollup PR without a record under local', async () => {
    const h = harness([pr()]);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: new Set() }).lv);
    expect((await w.tick()).acted).toBe(false);
    expect(h.runCalls).toHaveLength(0);
  });

  it('a record for a different head or base does not count', async () => {
    const h = harness([pr()]);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: new Set(['100:oldsha:main', '100:sha100:dev']) }).lv);
    expect((await w.tick()).acted).toBe(false);
  });

  it('actions floor keeps today: rollup-gated, no strategy override', async () => {
    const h = harness([pr()]);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ floor: 'actions' }).lv);
    expect((await w.tick()).acted).toBe(true);
    expect(h.runCalls[0].strategy).toBeUndefined();
  });

  it('an unreadable or null floor reads as actions (no local candidacy)', async () => {
    for (const lv of [hook({ floor: null, records: new Set(['100:sha100:main']) }).lv, hook({ throwFloor: true, records: new Set(['100:sha100:main']) }).lv]) {
      const h = harness([pr({ statusRollup: 'PENDING' })]);
      const w = new GreenPrAutoMerger(h.deps, cfg);
      w.attachLocalVerify(lv);
      expect(w.currentFloor()).toBe('actions');
      expect((await w.tick()).acted).toBe(false);
    }
  });

  it('no hook attached → actions floor', () => {
    const h = harness([pr()]);
    expect(new GreenPrAutoMerger(h.deps, cfg).currentFloor()).toBe('actions');
  });

  it('the namespace filter stays under local', async () => {
    const h = harness([pr({ headRefName: 'dawn/x' })]);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: new Set(['100:sha100:main']) }).lv);
    expect((await w.tick()).acted).toBe(false);
  });
});

describe('local floor — actions→local disarm (Rollback)', () => {
  const armed = (h: H) => { h.state.episodes[7] = { pr: 7, headRefOid: 's7', attempts: 1, rearmEpisodes: 0, state: 'active', armedAt: 1, armedHead: 's7' } as never; };

  it('disarms armed episodes exactly once on actions→local', async () => {
    const h = harness([]);
    armed(h);
    h.state.lastFloor = 'actions';
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook().lv);
    await w.tick();
    expect(h.disarmCalls).toEqual([7]);
    expect(h.state.lastFloor).toBe('local');
    armed(h); // even if something re-armed, local→local does not disarm again
    await w.tick();
    expect(h.disarmCalls).toEqual([7]);
  });

  it('postStatuses false (local-verify dry-run): logs would-disarm once, disarms nothing, and disarms for real once posting is live', async () => {
    const h = harness([]);
    armed(h);
    h.state.lastFloor = 'actions';
    const w = new GreenPrAutoMerger(h.deps, cfg);
    let posting = false;
    w.attachLocalVerify({ ...hook().lv, postStatuses: () => posting });
    await w.tick();
    await w.tick();
    expect(h.disarmCalls).toEqual([]);
    expect(h.audits.filter((a) => a.event === 'would-disarm')).toHaveLength(1);
    expect(h.state.lastFloor).toBe('actions');
    posting = true;
    await w.tick();
    expect(h.disarmCalls).toEqual([7]);
  });

  it('a never-observed floor counts as actions (first local tick disarms)', async () => {
    const h = harness([]);
    armed(h);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook().lv);
    await w.tick();
    expect(h.disarmCalls).toEqual([7]);
  });

  it('local→actions does not disarm', async () => {
    const h = harness([]);
    armed(h);
    h.state.lastFloor = 'local';
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ floor: 'actions' }).lv);
    await w.tick();
    expect(h.disarmCalls).toEqual([]);
    expect(h.state.lastFloor).toBe('actions');
  });
});

describe('verify requests (§2 "Who starts a verify")', () => {
  it('requests only after the head is unchanged for 5 minutes', async () => {
    const h = harness([pr()]);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    const k = hook();
    w.attachLocalVerify(k.lv);
    await w.tick();
    expect(k.requested).toEqual([]);
    h.clock.t += VERIFY_HEAD_STABLE_MS - 1;
    await w.tick();
    expect(k.requested).toEqual([]);
    h.clock.t += 1;
    await w.tick();
    expect(k.requested).toEqual([100]);
  });

  it('a moved head restarts the 5-minute clock', async () => {
    const prs = [pr()];
    const h = harness(prs);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    const k = hook();
    w.attachLocalVerify(k.lv);
    await w.tick();
    h.clock.t += VERIFY_HEAD_STABLE_MS;
    prs[0] = pr({ headRefOid: 'sha101' });
    await w.tick();
    expect(k.requested).toEqual([]);
  });

  it('orders oldest-ready first, tiebreak by PR number', async () => {
    const prs = [pr({ number: 300, headRefOid: 'a' }), pr({ number: 200, headRefOid: 'b' })];
    const h = harness(prs);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    const k = hook();
    w.attachLocalVerify(k.lv);
    await w.tick(); // both first seen now
    h.clock.t += 60_000;
    prs.push(pr({ number: 50, headRefOid: 'c' })); // seen later
    await w.tick();
    h.clock.t += VERIFY_HEAD_STABLE_MS;
    await w.tick();
    expect(k.requested.slice(0, 3)).toEqual([200, 300, 50]);
  });

  it('none while main is not healthy (suspect, red, unreadable)', async () => {
    for (const health of ['main-suspect', 'main-red', null] as const) {
      const h = harness([pr()]);
      const w = new GreenPrAutoMerger(h.deps, cfg);
      const k = hook({ health });
      w.attachLocalVerify(k.lv);
      await w.tick();
      h.clock.t += VERIFY_HEAD_STABLE_MS;
      await w.tick();
      expect(k.requested).toEqual([]);
    }
  });

  it('skips PRs that already have a record, are held, draft, conflicting or out of namespace', async () => {
    const prs = [
      pr({ number: 1, headRefOid: 'r' }),
      pr({ number: 2, labels: ['hold'] }),
      pr({ number: 3, isDraft: true }),
      pr({ number: 4, mergeable: 'CONFLICTING' }),
      pr({ number: 5, headRefName: 'dawn/x' }),
      pr({ number: 6, headRefOid: 'want' }),
    ];
    const h = harness(prs);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    const k = hook({ floor: 'actions', records: new Set(['1:r:main']) });
    w.attachLocalVerify(k.lv);
    await w.tick();
    h.clock.t += VERIFY_HEAD_STABLE_MS;
    await w.tick();
    expect(k.requested).toEqual([6]);
  });

  it('requests under the actions floor and in dryRun, but not on warm-up or without a hook', async () => {
    const h = harness([pr({ statusRollup: 'PENDING' })]);
    const w = new GreenPrAutoMerger(h.deps, { ...cfg, dryRun: true });
    const k = hook({ floor: 'actions' });
    w.attachLocalVerify(k.lv);
    await w.tick();
    h.clock.t += VERIFY_HEAD_STABLE_MS;
    h.state.lastActingEpoch = 0; // next tick is a warm-up
    await w.tick();
    expect(k.requested).toEqual([]);
    await w.tick();
    expect(k.requested).toEqual([100]);
  });

  it('a failing request is caught and audited', async () => {
    const h = harness([pr()]);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    const k = hook();
    k.lv.requestVerify = async () => { throw new Error('queue down'); };
    w.attachLocalVerify(k.lv);
    await w.tick();
    h.clock.t += VERIFY_HEAD_STABLE_MS;
    await expect(w.tick()).resolves.toBeDefined();
    expect(h.audits.some((a) => a.event === 'verify-request-failed')).toBe(true);
  });
});

describe('mapPr carries baseRefName', () => {
  it('maps the base branch when present and omits it when absent', () => {
    expect(mapPr({ number: 1, headRefName: 'echo/x', headRefOid: 's', baseRefName: 'main' }).baseRefName).toBe('main');
    expect(mapPr({ number: 1, headRefName: 'echo/x', headRefOid: 's' }).baseRefName).toBeUndefined();
  });
});

describe('verify requests — review precheck and ready ordering', () => {
  const required = { reviewsRequired: false, lastPushApprovalRequired: true };

  it('a review-required PR that is not APPROVED gets no verify; once APPROVED it does', async () => {
    const prs = [pr({ reviewDecision: 'REVIEW_REQUIRED' })];
    const h = harness(prs, required);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    const k = hook();
    w.attachLocalVerify(k.lv);
    await w.tick();
    h.clock.t += VERIFY_HEAD_STABLE_MS;
    await w.tick();
    expect(k.requested).toEqual([]);
    prs[0] = pr({ reviewDecision: 'APPROVED' });
    await w.tick();
    expect(k.requested).toEqual([100]);
  });

  it('an unreadable or unwired review policy requests nothing', async () => {
    for (const policy of ['throw', 'absent'] as const) {
      const h = harness([pr()], policy);
      const w = new GreenPrAutoMerger(h.deps, cfg);
      const k = hook();
      w.attachLocalVerify(k.lv);
      await w.tick();
      h.clock.t += VERIFY_HEAD_STABLE_MS;
      await w.tick();
      expect(k.requested).toEqual([]);
    }
  });

  it('no review required: ready = PR open time (oldest opened first, regardless of number)', async () => {
    const prs = [
      pr({ number: 10, headRefOid: 'x', createdAt: '2026-10-20T00:00:00Z' }),
      pr({ number: 20, headRefOid: 'y', createdAt: '2026-10-01T00:00:00Z' }),
    ];
    const h = harness(prs);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    const k = hook();
    w.attachLocalVerify(k.lv);
    await w.tick();
    h.clock.t += VERIFY_HEAD_STABLE_MS;
    await w.tick();
    expect(k.requested).toEqual([20, 10]);
  });

  it('review required: ready = when the precheck started passing, not open time', async () => {
    const prs = [
      pr({ number: 10, headRefOid: 'x', createdAt: '2026-10-01T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
      pr({ number: 20, headRefOid: 'y', createdAt: '2026-10-20T00:00:00Z', reviewDecision: 'APPROVED' }),
    ];
    const h = harness(prs, required);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    const k = hook();
    w.attachLocalVerify(k.lv);
    await w.tick();                       // #20 ready now
    h.clock.t += 60_000;
    prs[0] = { ...prs[0], reviewDecision: 'APPROVED' };
    await w.tick();                       // #10 ready a minute later
    h.clock.t += VERIFY_HEAD_STABLE_MS;
    await w.tick();
    expect(k.requested.slice(0, 2)).toEqual([20, 10]);
  });

  it('losing the approval resets the ready time', async () => {
    const prs = [pr({ reviewDecision: 'APPROVED' })];
    const h = harness(prs, required);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ health: 'main-red' }).lv);
    await w.tick();
    expect(h.state.reviewReadySince).toBeUndefined(); // unhealthy main: nothing evaluated
    w.attachLocalVerify(hook().lv);
    await w.tick();
    const first = h.state.reviewReadySince?.[100];
    expect(first).toBe(h.clock.t);
    prs[0] = pr({ reviewDecision: 'CHANGES_REQUESTED' });
    h.clock.t += 1000;
    await w.tick();
    expect(h.state.reviewReadySince?.[100]).toBeUndefined();
    prs[0] = pr({ reviewDecision: 'APPROVED' });
    await w.tick();
    expect(h.state.reviewReadySince?.[100]).toBe(h.clock.t);
  });

  it('maps reviewDecision and createdAt from the list projection', () => {
    const m = mapPr({ number: 1, headRefName: 'echo/a', headRefOid: 's', reviewDecision: 'APPROVED', createdAt: '2026-10-01T00:00:00Z' });
    expect(m.reviewDecision).toBe('APPROVED');
    expect(m.createdAt).toBe('2026-10-01T00:00:00Z');
  });
});

describe('boot timeout invariant accounts for sync under a configured local floor', () => {
  // budget = busySkip(3) × tick(600s) = 1_800_000; sync needs mergeTimeoutMs + grace.
  const base = { ...cfg, busySkipBreakerThreshold: 3, tickIntervalMs: 600_000, armTimeoutMs: 60_000, mergeKillGraceMs: 60_000 };

  it('auto + actions floor: only the 60s arm must fit (a 30-min mergeTimeoutMs is fine)', () => {
    const w = new GreenPrAutoMerger(harness([]).deps, { ...base, mergeTimeoutMs: 1_800_000, floor: 'actions' });
    expect(w.invariantOk).toBe(true);
  });

  it('auto + local floor: the same config is flagged, because merges run sync at mergeTimeoutMs', () => {
    const w = new GreenPrAutoMerger(harness([]).deps, { ...base, mergeTimeoutMs: 1_800_000, floor: 'local' });
    expect(w.invariantOk).toBe(false);
    expect(w.invariantReason).toMatch(/mergeTimeoutMs\(1800000\)/);
  });

  it('auto + local floor with the default 25-min deadline passes', () => {
    const w = new GreenPrAutoMerger(harness([]).deps, { ...base, mergeTimeoutMs: 1_500_000, floor: 'local' });
    expect(w.invariantOk).toBe(true);
  });
});

describe('local floor — protected paths are judged by the record, not the watcher', () => {
  it('a protected-path PR with a record is attempted without the watcher reading any review (safe-merge decides)', async () => {
    const h = harness([pr()]);
    let reads = 0;
    h.deps.codeOwnedPaths = async () => ({ touches: false, files: [], protectedFiles: ['scripts/safe-merge.mjs'], unverifiable: false });
    h.deps.independentReviewAtHead = async () => { reads++; return { ok: false, unverifiable: false }; };
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: new Set(['100:sha100:main']) }).lv);
    expect((await w.tick()).acted).toBe(true);
    expect(reads).toBe(0);
  });
});

describe('merge line hand-off (CMT-980): tick({ handoff })', () => {
  const two = () => [pr({ number: 100, headRefOid: 'sha100' }), pr({ number: 200, headRefOid: 'sha200', headRefName: 'echo/two' })];
  const both = new Set(['100:sha100:main', '200:sha200:main']);

  it('merges exactly the handed-off PR with strategy sync — not the oldest candidate — and requests no verifies', async () => {
    const h = harness(two());
    const hk = hook({ records: both });
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hk.lv);
    const r = await w.tick({ handoff: { pr: 200, head: 'sha200' } });
    expect(r).toEqual({ acted: true, reason: 'merged' });
    expect(h.runCalls).toEqual([expect.objectContaining({ pr: 200, headRefOid: 'sha200', strategy: 'sync' })]);
    expect(hk.requested).toEqual([]);
    expect(h.audits.some((a) => a.event === 'handoff' && a.pr === 200)).toBe(true);
  });

  it('a hand-off for a PR with no record, a moved head, a held PR or an unlisted PR runs nothing and names why', async () => {
    const prs = [pr({ number: 100, headRefOid: 'sha100' }), pr({ number: 300, headRefOid: 'sha300', headRefName: 'echo/three', labels: ['hold'] })];
    const h = harness(prs);
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: new Set(['300:sha300:main']) }).lv);
    expect(await w.tick({ handoff: { pr: 100, head: 'sha100' } })).toEqual({ acted: false, reason: 'handoff-not-eligible:no-verify-record' });
    expect(await w.tick({ handoff: { pr: 100, head: 'old' } })).toEqual({ acted: false, reason: 'handoff-not-eligible:head-moved' });
    expect(await w.tick({ handoff: { pr: 300, head: 'sha300' } })).toEqual({ acted: false, reason: 'handoff-not-eligible:held' });
    expect(await w.tick({ handoff: { pr: 999, head: 'sha999' } })).toEqual({ acted: false, reason: 'handoff-not-eligible:not-listed' });
    expect(h.runCalls).toHaveLength(0);
    expect(h.audits.filter((a) => a.event === 'handoff-not-eligible').map((a) => a.reason)).toEqual(['no-verify-record', 'head-moved', 'held', 'not-listed']);
  });

  it('on the actions floor a hand-off is skipped before the PR list is even read', async () => {
    const h = harness(two());
    h.deps.listOpenPrs = async () => { throw new Error('must not list'); };
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ floor: 'actions', records: both }).lv);
    expect(await w.tick({ handoff: { pr: 100, head: 'sha100' } })).toEqual({ acted: false, reason: 'floor-actions' });
    expect(h.runCalls).toHaveLength(0);
  });

  it('dryRun, the disarm latch and a non-holder refuse a hand-off exactly like a tick', async () => {
    const h = harness(two());
    const dry = new GreenPrAutoMerger(h.deps, { ...cfg, dryRun: true });
    dry.attachLocalVerify(hook({ records: both }).lv);
    expect(await dry.tick({ handoff: { pr: 100, head: 'sha100' } })).toEqual({ acted: false, reason: 'dry-run' });
    expect(h.audits.some((a) => a.event === 'would-merge' && a.handoff === true)).toBe(true);
    h.deps.latches = { isMergeAllowed: () => ({ allowed: false, reason: 'rollback', activeLatchIds: {} }) };
    const latched = new GreenPrAutoMerger(h.deps, cfg);
    latched.attachLocalVerify(hook({ records: both }).lv);
    expect(await latched.tick({ handoff: { pr: 100, head: 'sha100' } })).toEqual({ acted: false, reason: 'disabled:rollback' });
    h.deps.holdsLease = () => false;
    expect(await latched.tick({ handoff: { pr: 100, head: 'sha100' } })).toEqual({ acted: false, reason: 'not-lease-holder' });
    expect(h.runCalls).toHaveLength(0);
  });

  it('a hand-off during an attempt in flight waits for it instead of feeding the busy-skip breaker, then merges', async () => {
    const h = harness(two());
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => { releaseFirst = r; });
    let calls = 0;
    h.deps.runner.run = async (a) => {
      h.runCalls.push(a);
      calls += 1;
      if (calls === 1) await firstDone;
      return { outcome: 'merged', confirmedMerged: true };
    };
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: both }).lv);
    const regular = w.tick(); // picks the oldest (100) and hangs in the runner
    await new Promise((r) => setTimeout(r, 5));
    expect(h.runCalls.map((c) => c.pr)).toEqual([100]);
    const handoff = w.tick({ handoff: { pr: 200, head: 'sha200' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.runCalls).toHaveLength(1); // still waiting
    expect(h.audits.some((a) => a.event === 'handoff-waited-in-flight' && a.pr === 200)).toBe(true);
    expect(h.audits.some((a) => a.event === 'tick-skipped-busy')).toBe(false);
    releaseFirst();
    expect(await regular).toMatchObject({ acted: true });
    expect(await handoff).toEqual({ acted: true, reason: 'merged' });
    expect(h.runCalls.map((c) => c.pr)).toEqual([100, 200]);
  });

  it('a hand-off that waited on an in-flight attempt does not overwrite that tick\'s saved episode/ladder state (load/save go through a store copy)', async () => {
    const h = harness(two());
    // A store that behaves like the real JSON file: every load is a copy of the last save.
    let stored = JSON.parse(JSON.stringify(h.state)) as GreenPrState;
    h.deps.loadState = () => JSON.parse(JSON.stringify(stored)) as GreenPrState;
    h.deps.saveState = (st) => { stored = JSON.parse(JSON.stringify(st)) as GreenPrState; };
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => { releaseFirst = r; });
    let calls = 0;
    h.deps.runner.run = async (a) => {
      h.runCalls.push(a);
      calls += 1;
      if (calls === 1) { await firstDone; return { outcome: 'refused:needs-independent-review', confirmedMerged: false }; }
      return { outcome: 'merged', confirmedMerged: true };
    };
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: both }).lv);
    const regular = w.tick(); // PR 100: refused for want of a review → the head is pinned in episodes[100]
    await new Promise((r) => setTimeout(r, 5));
    const handoff = w.tick({ handoff: { pr: 200, head: 'sha200' } });
    await new Promise((r) => setTimeout(r, 5));
    releaseFirst();
    await regular;
    await handoff;
    // The regular tick's pin survived the hand-off's own save.
    expect(stored.episodes[100]).toMatchObject({ lastOutcome: 'refused:needs-independent-review', headRefOid: 'sha100' });
    expect(h.runCalls.map((c) => c.pr)).toEqual([100, 200]);
    // And the pin holds: a later tick does not spawn safe-merge for PR 100's head again
    // (the static fake list still shows PR 200 open, so it is attempted again; only 100 matters here).
    h.clock.t += 60 * 60_000;
    await w.tick();
    expect(h.runCalls.map((c) => c.pr)).toEqual([100, 200, 200]);
  });

  it('two ticks past the busy check: the one that finds an attempt running spawns nothing (busy-in-act) and cannot release or drop the other\'s waiter', async () => {
    const h = harness(two());
    let stored = JSON.parse(JSON.stringify(h.state)) as GreenPrState;
    h.deps.loadState = () => JSON.parse(JSON.stringify(stored)) as GreenPrState;
    h.deps.saveState = (st) => { stored = JSON.parse(JSON.stringify(st)) as GreenPrState; };
    const gates: Array<() => void> = [];
    const prs = two();
    h.deps.listOpenPrs = () => new Promise((r) => { gates.push(() => r(prs)); });
    let releaseRun!: () => void;
    const runDone = new Promise<void>((r) => { releaseRun = r; });
    h.deps.runner.run = async (a) => { h.runCalls.push(a); if (h.runCalls.length === 1) await runDone; return { outcome: 'refused:needs-independent-review', confirmedMerged: false }; };
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: both }).lv);
    const ticks = [w.tick(), w.tick()]; // both passed the top-of-tick busy check; both wait on their list
    await new Promise((r) => setTimeout(r, 5));
    expect(gates).toHaveLength(2);
    gates[0]();
    await new Promise((r) => setTimeout(r, 5)); // one tick is now in runner.run (in flight)
    expect(h.runCalls.map((c) => c.pr)).toEqual([100]);
    let waiterDone = false;
    const waiter = w.tick({ handoff: { pr: 200, head: 'sha200' } }).then((r) => { waiterDone = true; return r; });
    await new Promise((r) => setTimeout(r, 5));
    gates[1](); // the other tick reaches act() while the attempt is still running
    expect(await Promise.race(ticks)).toEqual({ acted: false, reason: 'skipped' });
    expect(h.audits.some((a) => a.event === 'skipped:busy-in-act' && a.pr === 100)).toBe(true);
    expect(h.runCalls).toHaveLength(1); // it spawned nothing
    await new Promise((r) => setTimeout(r, 10));
    expect(waiterDone).toBe(false); // its finish neither released the waiter early nor dropped the owner's release
    expect(h.audits.filter((a) => a.event === 'merge-attempted')).toHaveLength(1);
    expect(h.audits.some((a) => a.event === 'handoff-wait-timeout')).toBe(false);
    expect(gates).toHaveLength(2); // the waiter has not listed yet: it is still waiting, not merely slow
    releaseRun();
    expect(await Promise.all(ticks)).toEqual([{ acted: false, reason: 'skipped' }, { acted: false, reason: 'skipped' }]);
    for (let i = 0; i < 50 && gates.length < 3; i++) await new Promise((r) => setTimeout(r, 2));
    expect(gates).toHaveLength(3);
    expect(stored.episodes[100]).toMatchObject({ lastOutcome: 'refused:needs-independent-review' }); // pinned BEFORE the waiter lists
    gates[2](); // the waiter woke after the owner's save and now lists on its own
    expect(await waiter).toEqual({ acted: false, reason: 'refused:needs-independent-review' });
    expect(h.runCalls.map((c) => c.pr)).toEqual([100, 200]);
    expect(stored.episodes[100]).toMatchObject({ lastOutcome: 'refused:needs-independent-review' }); // and survived the waiter's save
  }, 8000);

  it('a refused merge answers its outcome and the hand-off does not retry', async () => {
    const h = harness(two());
    h.deps.runner.run = async (a) => { h.runCalls.push(a); return { outcome: 'refused:approval-required', confirmedMerged: false }; };
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: both }).lv);
    expect(await w.tick({ handoff: { pr: 100, head: 'sha100' } })).toEqual({ acted: false, reason: 'refused:approval-required' });
    expect(h.runCalls).toHaveLength(1);
  });

  it('a hand-off for a PR that touches a code-owned file waits for the code-owner review, like a tick', async () => {
    const h = harness(two());
    h.deps.codeOwnedPaths = async (p) => (p.number === 100 ? { touches: true, files: ['docs/STANDARDS-REGISTRY.md'], unverifiable: false } : { touches: false, files: [], unverifiable: false });
    const w = new GreenPrAutoMerger(h.deps, cfg);
    w.attachLocalVerify(hook({ records: both }).lv);
    expect(await w.tick({ handoff: { pr: 100, head: 'sha100' } })).toEqual({ acted: false, reason: 'handoff-not-eligible:waiting' });
    expect(h.runCalls).toHaveLength(0);
    expect(h.audits.some((a) => a.event === 'waiting' && a.class === 'code-owner-review' && a.pr === 100)).toBe(true);
  });
});
