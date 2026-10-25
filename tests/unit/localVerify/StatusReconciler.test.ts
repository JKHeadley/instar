/**
 * Tier-1 tests for the `instar/local-verify` status reconcile loop (spec
 * local-verify-merge-authority.md §3 "Posting discipline", "One writer per head",
 * "Status reconcile loop", "Stuck-status canary", "Event-driven withdrawal",
 * foreign-status). GitHub, the lease, the clock and the service are fakes; the
 * projection, floor gate and safe-merge's evaluator are real.
 */

import { describe, expect, it } from 'vitest';
import { evaluateRequiredContexts, ACTIONS_FLOOR_CONTEXTS } from '../../../scripts/safe-merge.mjs';
import { FloorGate } from '../../../src/localVerify/floorGate.js';
import type { LocalVerifyService } from '../../../src/localVerify/LocalVerifyService.js';
import type { MainHealthState } from '../../../src/localVerify/mainHealth.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import {
  RECONCILER_LIMITS, StatusReconciler,
  type CombinedStatusRead, type OpenPr, type StatusReconcilerSeams,
} from '../../../src/localVerify/StatusReconciler.js';
import type { CheckRunView, ContextPin, EvaluateRequiredContexts, ProjectedState } from '../../../src/localVerify/statusProjection.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const MIN = 60_000;
const FLOOR = ACTIONS_FLOOR_CONTEXTS as ContextPin[];

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 7, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
  };
}

function pr(over: Partial<OpenPr> = {}): OpenPr {
  return {
    number: 7, headSha: sha('a'), baseRefName: 'main', headRefName: 'echo/x', author: 'EchoOfDawn', isCrossRepository: false,
    rollup: [], rollupTruncated: false, ...over,
  };
}

const lvStatus = (state: string) => ({ kind: 'status' as const, context: 'instar/local-verify', state });
const greenRuns = (): CheckRunView[] => FLOOR.map((f) => ({ name: f.context, status: 'completed', conclusion: 'success', appSlug: f.appSlug ?? null, workflowPath: f.workflowPath ?? null }));

interface Deferred { state: ProjectedState; resolve: (v: { ok: true } | { ok: false; status: number | null; detail: string }) => void }

function setup(opts: { postStatuses?: boolean; enabled?: boolean; rulesRequire?: boolean; floor?: 'local' | 'actions' } = {}) {
  const st = {
    prs: [pr()] as OpenPr[] | null,
    records: new Map<string, LocalVerifyRecord>([[`7:${sha('a')}`, record()]]),
    health: 'healthy' as MainHealthState,
    mainHead: sha('b') as string | null,
    holds: true,
    epoch: 3 as number | null,
    holder: 'm1' as string | null,
    t: Date.parse('2026-10-21T12:00:00.000Z'),
    combined: new Map<string, CombinedStatusRead | null>(),
    checkRuns: new Map<string, CheckRunView[] | null>(),
    postStatuses: opts.postStatuses ?? true,
    enabled: opts.enabled ?? true,
    holdsAtPost: null as null | (() => boolean),
    blockPosts: false,
    failPosts: false,
  };
  const posts: Array<{ head: string; state: ProjectedState; description: string }> = [];
  /** What GitHub ends up holding: the order in which posts COMPLETE. */
  const landed: ProjectedState[] = [];
  const pending: Deferred[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const signals: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const notedMain: Array<string | null> = [];
  const acquired: Array<{ foreignHolder: boolean }> = [];

  const service = {
    getRecord: (p: number, h: string) => st.records.get(`${p}:${h}`) ?? null,
    isVerifying: () => false,
    mainHealth: () => ({ state: st.health, redHead: null, reason: '', lastGreenHead: null, since: 0, currentMainHead: st.mainHead, pendingMainHead: null, mainInFlight: null }),
    noteMainHead: (h: string | null) => { notedMain.push(h); },
    onLeaseAcquired: (o: { foreignHolder: boolean }) => { acquired.push(o); },
  } as unknown as LocalVerifyService;

  const floorGate = new FloorGate(
    { repo: REPO, configFloor: () => opts.floor ?? 'local', watcherRepo: () => REPO },
    {
      readRulesBranches: async () => [{ type: 'required_status_checks', parameters: { required_status_checks: (opts.rulesRequire ?? true) ? [{ context: 'instar/local-verify' }] : [], strict_required_status_checks_policy: false } }],
      readBranch: async () => ({ name: 'main', protection: { required_status_checks: { contexts: [] } } }),
      readRulesetBypass: async () => 'never',
      now: () => st.t,
      audit: () => {},
    },
  );

  const seams: StatusReconcilerSeams = {
    listOpenPrs: async () => st.prs,
    readMainHead: async () => st.mainHead,
    readCombinedStatus: async (h) => (st.combined.has(h) ? st.combined.get(h)! : { state: 'absent', creator: null, description: null }),
    readCheckRuns: async (h) => (st.checkRuns.has(h) ? st.checkRuns.get(h)! : greenRuns()),
    postStatus: async (head, state, description) => {
      posts.push({ head, state, description });
      if (st.blockPosts) {
        return new Promise((resolve) => { pending.push({ state, resolve: (v) => { if (v.ok) landed.push(state); resolve(v); } }); });
      }
      if (st.failPosts) return { ok: false, status: 403, detail: 'HTTP 403 secondary rate limit' };
      landed.push(state);
      return { ok: true };
    },
    holdsLease: () => (st.holdsAtPost && posts.length >= 0 ? st.holdsAtPost() : st.holds),
    leaseEpoch: () => st.epoch,
    leaseHolder: () => st.holder,
    now: () => st.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); },
    signal: (k) => { signals.push(k); },
    audit: (e) => { audits.push(e); },
  };
  const rec = new StatusReconciler({
    repo: REPO, agentLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley', machineId: 'm1',
    postStatuses: () => st.postStatuses, localVerifyEnabled: () => st.enabled,
    actionsFloor: FLOOR, evaluate: evaluateRequiredContexts as EvaluateRequiredContexts,
  }, seams, floorGate, service);
  const flush = () => new Promise((r) => setImmediate(r));
  return { rec, st, posts, landed, pending, audits, signals, timers, notedMain, acquired, flush };
}

describe('StatusReconciler — posting discipline', () => {
  it('posts only when the projection differs from what GitHub reports on the head', async () => {
    const s = setup();
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([expect.objectContaining({ head: sha('a'), state: 'success' })]);
    // GitHub now reports success: nothing more is posted.
    s.st.prs = [pr({ rollup: [lvStatus('SUCCESS')] })];
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(1);
    // A status posted by hand (pending) is overwritten within one pass.
    s.st.prs = [pr({ rollup: [lvStatus('PENDING')] })];
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.map((p) => p.state)).toEqual(['success', 'success']);
  });

  it('lists every open PR to main with no author filter; other bases and invalid heads are ignored', async () => {
    const s = setup();
    s.st.prs = [pr(), pr({ number: 8, headSha: sha('c'), baseRefName: 'release' }), pr({ number: 9, headSha: 'nope' })];
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.map((p) => p.head)).toEqual([sha('a')]);
  });

  it('a failed PR listing posts nothing', async () => {
    const s = setup();
    s.st.prs = null;
    const r = await s.rec.pass(); await s.rec.drain();
    expect(r.outcome).toBe('list-failed');
    expect(s.posts).toEqual([]);
    expect(s.audits.some((a) => a.event === 'list-failed')).toBe(true);
  });

  it('notes the remote main head on every pass (the service enqueues the main verify)', async () => {
    const s = setup();
    await s.rec.pass();
    s.st.mainHead = sha('e');
    await s.rec.pass();
    expect(s.notedMain).toEqual([sha('b'), sha('e')]);
  });

  it('a truncated rollup with the context missing reads the combined status; unreadable ⇒ the head is skipped, never "absent"', async () => {
    const s = setup();
    s.st.prs = [pr({ rollupTruncated: true })];
    s.st.combined.set(sha('a'), null);
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([]);
    expect(s.audits.some((a) => a.event === 'status-unreadable')).toBe(true);
    // Readable and already success ⇒ still nothing to post.
    s.st.combined.set(sha('a'), { state: 'success', creator: 'EchoOfDawn', description: 'verified' });
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([]);
    // Readable and absent ⇒ posted.
    s.st.combined.set(sha('a'), { state: 'absent', creator: null, description: null });
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(1);
  });

  it('logs an instar/local-verify status created by another login as foreign-status, and overwrites it', async () => {
    const s = setup();
    s.st.records.clear(); // projection: pending
    s.st.prs = [pr({ rollup: [lvStatus('SUCCESS')] })];
    s.st.combined.set(sha('a'), { state: 'success', creator: 'github-actions[bot]', description: 'forged' });
    await s.rec.pass(); await s.rec.drain();
    expect(s.audits.find((a) => a.event === 'foreign-status')).toMatchObject({ head: sha('a'), creator: 'github-actions[bot]' });
    expect(s.posts.map((p) => p.state)).toEqual(['pending']);
  });

  it('dry-run (postStatuses false) posts nothing and audits each would-post once per change', async () => {
    const s = setup({ postStatuses: false });
    await s.rec.pass(); await s.rec.drain();
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([]);
    expect(s.audits.filter((a) => a.event === 'would-post')).toHaveLength(1);
    expect(s.audits.find((a) => a.event === 'would-post')).toMatchObject({ head: sha('a'), state: 'success', machineId: 'm1', epoch: 3 });
  });

  it('a failed post is retried by the pass only once its backoff has elapsed; no extra timer per failure', async () => {
    const s = setup();
    s.st.failPosts = true;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(1);
    expect(s.timers).toEqual([]); // one retry path: the pass
    expect((s.rec.status().failedPosts as unknown[]).length).toBe(1);
    s.st.t += RECONCILER_LIMITS.retryBaseMs - 1;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(1); // nextAt still in the future: skipped
    s.st.t += 1;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(2);
    s.st.t += RECONCILER_LIMITS.retryBaseMs; // the second backoff is doubled
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(2);
    s.st.failPosts = false;
    s.st.t += RECONCILER_LIMITS.retryBaseMs;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(3);
    expect((s.rec.status().failedPosts as unknown[]).length).toBe(0);
    expect(s.timers).toEqual([]);
  });

  it('a global posts-per-minute cap defers the excess to the next pass', async () => {
    const s = setup();
    const many = Array.from({ length: RECONCILER_LIMITS.postsPerMinute + 5 }, (_, i) => {
      const h = (i + 16).toString(16).padStart(2, '0').repeat(20);
      s.st.records.set(`${100 + i}:${h}`, record({ pr: 100 + i, headSha: h }));
      return pr({ number: 100 + i, headSha: h });
    });
    s.st.prs = many;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(RECONCILER_LIMITS.postsPerMinute);
    expect(s.audits.filter((a) => a.event === 'post-deferred-rate')).toHaveLength(5);
    s.st.t += MIN;
    s.st.prs = many.map((p) => (s.posts.some((x) => x.head === p.headSha) ? { ...p, rollup: [lvStatus('SUCCESS')] } : p));
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(RECONCILER_LIMITS.postsPerMinute + 5);
  });

  it('an unreadable settings read never stops the pass: check treated as required, floor actions, withdrawals still posted', async () => {
    const s = setup();
    await s.rec.pass(); await s.rec.drain(); // success posted under the local floor
    expect(s.posts.map((p) => p.state)).toEqual(['success']);
    const gate = (s.rec as unknown as { floorGate: { seams: { readRulesBranches: () => Promise<unknown>; readBranch: () => Promise<unknown> } } }).floorGate;
    gate.seams.readRulesBranches = async () => null;
    gate.seams.readBranch = async () => ({ name: 'main', protected: true }); // no protection block: unreadable too
    s.st.prs = [pr({ rollup: [lvStatus('SUCCESS')] })];
    s.st.checkRuns.set(sha('a'), null); // the mirror cannot read check runs either
    const r = await s.rec.pass(); await s.rec.drain();
    expect(r.outcome).toBe('ok');
    expect(s.rec.status().floor).toMatchObject({ effective: 'actions', checkRequired: true });
    expect(s.posts.map((p) => p.state)).toEqual(['success', 'pending']); // withdrawn
    expect((await s.rec.pass()).outcome).toBe('ok'); // no whole-pass backoff
  });

  it('only the mirror\'s per-head check-run reads back off after read failures', async () => {
    const s = setup();
    s.st.prs = [pr({ author: 'outsider', number: 11, headSha: sha('f') })];
    let reads = 0;
    (s.rec as unknown as { seams: { readCheckRuns: () => Promise<null> } }).seams.readCheckRuns = async () => { reads++; return null; };
    await s.rec.pass(); await s.rec.pass();
    expect(reads).toBe(1); // backed off
    s.st.t += RECONCILER_LIMITS.passBackoffBaseMs;
    await s.rec.pass(); await s.rec.pass();
    expect(reads).toBe(2); // second failure doubles the wait
    s.st.t += RECONCILER_LIMITS.passBackoffBaseMs;
    await s.rec.pass();
    expect(reads).toBe(2);
    s.st.t += RECONCILER_LIMITS.passBackoffBaseMs;
    await s.rec.pass();
    expect(reads).toBe(3);
  });

  it('a PR-list failure backs off the whole pass (doubling, capped at 15 min)', async () => {
    const s = setup();
    s.st.prs = null;
    expect((await s.rec.pass()).outcome).toBe('list-failed');
    expect((await s.rec.pass()).outcome).toBe('backoff');
    s.st.t += RECONCILER_LIMITS.passBackoffBaseMs;
    expect((await s.rec.pass()).outcome).toBe('list-failed');
    s.st.t += RECONCILER_LIMITS.passBackoffBaseMs;
    expect((await s.rec.pass()).outcome).toBe('backoff');
    for (let i = 0; i < 6; i++) { s.st.t += RECONCILER_LIMITS.passBackoffMaxMs; await s.rec.pass(); }
    expect((s.rec.status().passBackoff as { nextPassAt: string }).nextPassAt).toBe(new Date(s.st.t + RECONCILER_LIMITS.passBackoffMaxMs).toISOString());
    s.st.prs = [pr()];
    s.st.t += RECONCILER_LIMITS.passBackoffMaxMs;
    expect((await s.rec.pass()).outcome).toBe('ok');
    expect(s.rec.status().passBackoff).toBeNull();
  });

  it('the per-minute cap never delays a withdrawal: >30 success heads all withdrawn in one pass on main-red', async () => {
    const s = setup();
    const n = RECONCILER_LIMITS.postsPerMinute + 10;
    const many = Array.from({ length: n }, (_, i) => {
      const h = (i + 16).toString(16).padStart(2, '0').repeat(20);
      s.st.records.set(`${100 + i}:${h}`, record({ pr: 100 + i, headSha: h }));
      return pr({ number: 100 + i, headSha: h, rollup: [lvStatus('SUCCESS')] });
    });
    s.st.prs = many;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([]); // GitHub already agrees
    // Exhaust the cap with unrelated posts in this minute.
    const fresh = Array.from({ length: RECONCILER_LIMITS.postsPerMinute }, (_, i) => {
      const h = (i + 100).toString(16).padStart(2, '0').repeat(20);
      s.st.records.set(`${300 + i}:${h}`, record({ pr: 300 + i, headSha: h }));
      return pr({ number: 300 + i, headSha: h });
    });
    s.st.prs = [...many, ...fresh];
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toHaveLength(RECONCILER_LIMITS.postsPerMinute);
    s.st.health = 'main-red'; s.st.mainHead = sha('e');
    s.st.prs = [...many, ...fresh.map((p) => ({ ...p, rollup: [lvStatus('SUCCESS')] }))];
    s.posts.length = 0;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.filter((p) => p.state === 'pending')).toHaveLength(n + RECONCILER_LIMITS.postsPerMinute);
    expect(s.audits.filter((a) => a.event === 'post-deferred-rate' && a.state === 'pending')).toHaveLength(0);
  });

  it('the audit records machine and epoch of every post', async () => {
    const s = setup();
    await s.rec.pass(); await s.rec.drain();
    expect(s.audits.find((a) => a.event === 'status-posted')).toMatchObject({ machineId: 'm1', epoch: 3, ok: true });
  });
});

describe('StatusReconciler — one serialized writer per head', () => {
  it('a success computed before a withdrawal can never land after it', async () => {
    const s = setup();
    s.st.blockPosts = true;
    await s.rec.pass(); // success post in flight, blocked
    await s.flush();
    expect(s.posts.map((p) => p.state)).toEqual(['success']);
    // main turns red while the success post is in flight; the completion path and
    // the event-driven withdrawal both queue on the same per-head writer.
    s.st.health = 'main-red';
    s.st.mainHead = sha('e');
    s.rec.onRecord(sha('a'));
    s.rec.withdrawAll('main-red');
    await s.flush();
    // Adversarial network: always complete the NEWEST outstanding post first.
    while (s.pending.length) {
      s.pending.pop()!.resolve({ ok: true });
      await s.flush(); await s.flush();
    }
    await s.rec.drain();
    expect(s.landed.at(-1)).toBe('pending');
    expect(s.posts.map((p) => p.state)).toEqual(['success', 'pending']);
    expect(s.rec.successHeads()).toEqual([]);
  });

  it('re-projects immediately before each send (a queued send uses the state at its turn)', async () => {
    const s = setup();
    s.st.records.clear();
    s.st.blockPosts = true;
    await s.rec.pass(); await s.flush(); // pending post in flight
    expect(s.posts.map((p) => p.state)).toEqual(['pending']);
    s.rec.onRecord(sha('a')); // queued while there is still no record
    s.st.records.set(`7:${sha('a')}`, record()); // the record lands before the queued send runs
    s.pending.shift()!.resolve({ ok: true });
    await s.flush(); await s.flush();
    expect(s.posts.map((p) => p.state)).toEqual(['pending', 'success']);
    s.pending.shift()!.resolve({ ok: true });
    await s.rec.drain();
  });
});

describe('StatusReconciler — the lease', () => {
  it('a standby posts nothing and remembers the foreign holder; acquisition after it tells the service', async () => {
    const s = setup();
    s.st.holds = false; s.st.holder = 'm_other';
    expect((await s.rec.pass()).outcome).toBe('not-holder');
    expect(s.posts).toEqual([]);
    s.st.holds = true; s.st.epoch = 4;
    await s.rec.pass(); await s.rec.drain();
    expect(s.acquired.at(-1)).toEqual({ foreignHolder: true, epoch: 4 });
    expect(s.posts).toHaveLength(1);
  });

  it('lease lost mid-pass: re-checked immediately before the post, nothing is posted', async () => {
    const s = setup();
    let calls = 0;
    s.st.holdsAtPost = () => { calls++; return calls <= 1; }; // holds at pass start, lost at post time
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([]);
    expect(s.audits.find((a) => a.event === 'post-skipped-lease')).toMatchObject({ machineId: 'm1' });
  });

  it('an epoch change since acquisition blocks an event-driven post; the next pass re-acquires and posts', async () => {
    const s = setup();
    s.st.records.clear();
    s.st.prs = [pr({ rollup: [lvStatus('PENDING')] })];
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([]);
    s.st.records.set(`7:${sha('a')}`, record());
    s.st.epoch = 9; // the lease moved (and came back) since this machine acquired it
    s.rec.onRecord(sha('a')); await s.rec.drain();
    expect(s.posts).toEqual([]);
    expect(s.audits.find((a) => a.event === 'post-skipped-lease')).toMatchObject({ epoch: 9, acquiredEpoch: 3 });
    await s.rec.pass(); await s.rec.drain();
    expect(s.acquired).toHaveLength(2);
    expect(s.posts).toEqual([expect.objectContaining({ head: sha('a'), state: 'success' })]);
  });

  it('after acquisition the cache is rebuilt from GitHub, never by blind re-posting', async () => {
    const s = setup();
    s.st.prs = [pr({ rollup: [lvStatus('SUCCESS')] })];
    await s.rec.pass(); await s.rec.drain();
    s.st.epoch = 5;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([]);
  });
});

describe('StatusReconciler — canaries and modes', () => {
  it('stuck-status canary: an eligible green admissible head whose posted status differs > 15 min ⇒ ONE signal', async () => {
    const s = setup();
    s.st.failPosts = true;
    await s.rec.pass(); await s.rec.drain();
    s.st.t += 10 * MIN; await s.rec.pass(); await s.rec.drain();
    expect(s.signals).toEqual([]);
    s.st.t += 6 * MIN; await s.rec.pass(); await s.rec.drain();
    s.st.t += 6 * MIN; await s.rec.pass(); await s.rec.drain();
    expect(s.signals).toEqual(['local-verify:status-stuck']);
    expect((s.rec.status().stuckHeads as unknown[]).length).toBe(1);
  });

  it('the stuck canary is not armed in dry-run (nothing is posted by design)', async () => {
    const s = setup({ postStatuses: false });
    for (let i = 0; i < 4; i++) { await s.rec.pass(); s.st.t += 10 * MIN; }
    expect(s.signals).not.toContain('local-verify:status-stuck');
  });

  it('mirror pending > 6 h ⇒ one signal per head', async () => {
    const s = setup();
    s.st.prs = [pr({ author: 'outsider', number: 11, headSha: sha('f') })];
    s.st.checkRuns.set(sha('f'), []); // nothing started
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.at(-1)).toMatchObject({ head: sha('f'), state: 'pending' });
    s.st.prs = [pr({ author: 'outsider', number: 11, headSha: sha('f'), rollup: [lvStatus('PENDING')] })];
    s.st.t += 7 * 60 * MIN; await s.rec.pass();
    s.st.t += MIN; await s.rec.pass();
    expect(s.signals).toEqual(['local-verify:mirror-pending']);
  });

  it('an ineligible PR gets the Actions-floor mirror (success when the floor is green)', async () => {
    const s = setup();
    s.st.prs = [pr({ author: 'outsider', number: 11, headSha: sha('f') })];
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([expect.objectContaining({ head: sha('f'), state: 'success', description: 'actions-floor green' })]);
  });

  it('verifier disabled: only the mirror runs, and only while GitHub requires the check', async () => {
    const off = setup({ enabled: false, rulesRequire: false });
    expect((await off.rec.pass()).outcome).toBe('inactive');
    expect(off.posts).toEqual([]);
    const on = setup({ enabled: false, rulesRequire: true });
    await on.rec.pass(); await on.rec.drain();
    // The eligible PR with a green record is mirrored (actions floor), not locally authorized.
    expect(on.posts).toEqual([expect.objectContaining({ state: 'success', description: 'actions-floor green' })]);
  });

  it('the local floor is used only once the settings make it effective', async () => {
    const s = setup({ floor: 'actions' });
    s.st.records.clear(); // no local record — the mirror decides
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.at(-1)).toMatchObject({ state: 'success', description: 'actions-floor green' });
  });

  it('a shared head is success only when every PR on it is authorized', async () => {
    const s = setup();
    s.st.prs = [pr(), pr({ number: 8 })]; // PR 8 shares the head but has no record
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([expect.objectContaining({ head: sha('a'), state: 'pending' })]);
  });

});

describe('StatusReconciler — flagged records (independent review) and the status contract', () => {
  it('a harness-changing PR stays pending without the recorded independent review and reaches success with it — no review or executor read', async () => {
    const s = setup();
    s.st.records.set(`7:${sha('a')}`, record({ harnessChanging: true }));
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.at(-1)).toMatchObject({ state: 'pending' });
    expect(s.posts.at(-1)?.description).toMatch(/^awaiting-independent-review/);
    s.st.prs = [pr({ rollup: [lvStatus('PENDING')] })];
    s.st.records.set(`7:${sha('a')}`, record({ harnessChanging: true, independentReview: { trace: '.instar/instar-dev-traces/t.json', concurred: true } }));
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.at(-1)).toMatchObject({ state: 'success' });
    expect((s.rec.status() as Record<string, unknown>).approverAcceptance).toBeUndefined();
  });

  it('status() carries the contract safe-merge reads, plus takeoverFloorCheck', async () => {
    const s = setup();
    await s.rec.pass();
    const b = s.rec.status() as { floor: Record<string, unknown>; mainHealth: Record<string, unknown>; takeoverFloorCheck: string };
    expect(b.floor).toMatchObject({ configured: 'local', effective: 'local', reason: 'ok' });
    expect(b.mainHealth).toMatchObject({ state: 'healthy', mainHead: sha('b') });
    expect(b.takeoverFloorCheck).toBe('not-built');
    expect(s.rec.effectiveFloor()).toBe('local');
  });

  it('effective floor is actions with the verifier off, or GitHub not requiring the check', async () => {
    const off = setup({ enabled: false });
    await off.rec.pass();
    expect((off.rec.status() as { floor: unknown }).floor).toMatchObject({ configured: 'local', effective: 'actions', reason: 'verifier-disabled' });
    const notReq = setup({ rulesRequire: false });
    await notReq.rec.pass();
    expect((notReq.rec.status() as { floor: unknown }).floor).toMatchObject({ effective: 'actions', reason: 'awaiting-edit-a' });
  });

  it('a standby still reads the floor (its safe-merge reads its own status route)', async () => {
    const s = setup();
    s.st.holds = false;
    await s.rec.pass();
    expect((s.rec.status() as { floor: unknown }).floor).toMatchObject({ effective: 'local' });
    expect(s.posts).toEqual([]);
  });

});

describe('StatusReconciler — second-pass review fixes', () => {
  it('a post that completed after the listing started is not overwritten by that listing\'s rollup', async () => {
    const s = setup();
    s.st.records.clear();
    s.st.prs = [pr({ rollup: [lvStatus('PENDING')] })];
    await s.rec.pass(); await s.rec.drain(); // GitHub: pending, projection pending
    expect(s.posts).toEqual([]);
    // The listing is taken (rollup says PENDING); while it is in flight the record lands and its success post completes.
    const listing = [pr({ rollup: [lvStatus('PENDING')] })];
    (s.rec as unknown as { seams: { listOpenPrs: () => Promise<OpenPr[]> } }).seams.listOpenPrs = async () => {
      s.st.records.set(`7:${sha('a')}`, record());
      s.rec.onRecord(sha('a'));
      await s.rec.drain();
      return listing;
    };
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.map((p) => p.state)).toEqual(['success']);
    // The cache must still say success (GitHub does): a withdrawal now has to post pending.
    expect(s.rec.successHeads()).toEqual([sha('a')]);
    s.st.health = 'main-red'; s.st.mainHead = sha('e');
    s.rec.withdrawAll('main-red'); await s.rec.drain();
    expect(s.posts.map((p) => p.state)).toEqual(['success', 'pending']);
  });

  it('a post that completed while the head\'s own reads were awaited is not overwritten either', async () => {
    const s = setup();
    s.st.records.clear(); // projection: pending
    await s.rec.pass(); await s.rec.drain(); // establishes the head context; posts pending
    s.posts.length = 0;
    s.st.prs = [pr({ rollup: [lvStatus('SUCCESS')] })]; // someone else set success
    (s.rec as unknown as { observed: Map<string, unknown> }).observed.delete(sha('a'));
    (s.rec as unknown as { seams: { readCombinedStatus: (h: string) => Promise<CombinedStatusRead> } }).seams.readCombinedStatus = async () => {
      s.rec.onRecord(sha('a')); // the completion path posts pending while this read is in flight
      await s.rec.drain();
      return { state: 'success', creator: 'someone', description: null };
    };
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.map((p) => p.state)).toEqual(['pending']);
  });

  it('withdrawAll submits every known head, even one whose cache does not say success', async () => {
    const s = setup();
    s.st.prs = [pr({ rollup: [lvStatus('SUCCESS')] })];
    await s.rec.pass(); await s.rec.drain();
    (s.rec as unknown as { observed: Map<string, { state: string; by: string }> }).observed.set(sha('a'), { state: 'absent', by: 'github' });
    s.st.health = 'main-red'; s.st.mainHead = sha('e');
    s.rec.withdrawAll('main-red'); await s.rec.drain();
    expect(s.posts.map((p) => p.state)).toEqual(['pending']);
  });

  it('a head that leaves the listing while holding a server-posted success gets pending', async () => {
    const s = setup();
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([expect.objectContaining({ head: sha('a'), state: 'success' })]);
    s.st.prs = [pr({ headSha: sha('c') })]; // head moved
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toContainEqual(expect.objectContaining({ head: sha('a'), state: 'pending', description: expect.stringContaining('withdrawn') }));
    const count = s.posts.filter((p) => p.head === sha('a')).length;
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts.filter((p) => p.head === sha('a')).length).toBe(count); // withdrawn once
  });

  it('a dropped head this server never posted success on is left alone', async () => {
    const s = setup();
    s.st.prs = [pr({ rollup: [lvStatus('SUCCESS')] })]; // success, but not posted by this server
    await s.rec.pass(); await s.rec.drain();
    s.st.prs = [];
    await s.rec.pass(); await s.rec.drain();
    expect(s.posts).toEqual([]);
  });

  it('a failed main-head read is passed on as unknown (the service clears its head)', async () => {
    const s = setup();
    s.st.mainHead = null;
    await s.rec.pass();
    expect(s.notedMain).toEqual([null]);
  });

  it('GitHub requiring the check while postStatuses is false ⇒ ONE HIGH signal, shown on status()', async () => {
    const s = setup({ postStatuses: false });
    await s.rec.pass(); await s.rec.pass();
    expect(s.signals.filter((k) => k === 'local-verify:required-but-not-posting')).toHaveLength(1);
    expect(s.rec.status().requiredButNotPosting).toBe(true);
    const off = setup({ postStatuses: false, rulesRequire: false });
    await off.rec.pass();
    expect(off.signals).not.toContain('local-verify:required-but-not-posting');
    expect(off.rec.status().requiredButNotPosting).toBe(false);
    const live = setup({ postStatuses: true });
    await live.rec.pass();
    expect(live.rec.status().requiredButNotPosting).toBe(false);
  });
});
