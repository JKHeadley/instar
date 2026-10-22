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
    protectedPaths: async () => ({ touches: false, unverifiable: false }),
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
