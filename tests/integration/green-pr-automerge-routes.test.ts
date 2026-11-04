/**
 * Tier-2 integration tests for the green-pr-automerge routes over the real HTTP
 * pipeline (supertest + createRoutes + file-based state). Proves the feature is
 * ALIVE and wired: 503 when unconfigured → 200 when wired; the route→watcher and
 * route→latch flows; PIN gating on /enable + /pool-disarm; the rollback gate
 * closing merges; and the /hold route's validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { GuardLatchStore } from '../../src/monitoring/GuardLatchStore.js';
import { AgentStopSurfacer, type AgentStopFacts } from '../../src/monitoring/agentStopRelease.js';
import { GreenPrAutoMerger, freshState, type GreenPrAutoMergerDeps } from '../../src/monitoring/GreenPrAutoMerger.js';
import type { PrSummary } from '../../src/monitoring/greenPrLogic.js';

const PIN = '123456';

function baseCtx(stateDir: string, over: Partial<RouteContext>): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0, dashboardPin: PIN } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null,
    startTime: new Date(),
    ...over,
  } as never;
}

const disarmTracker: { calls: number[] } = { calls: [] };

function fakeWatcher(stateDir: string, latches: GuardLatchStore, prs: PrSummary[] = [], seedArmed: Array<{ pr: number; armedHead: string }> = []): GreenPrAutoMerger {
  let state = freshState();
  for (const a of seedArmed) {
    state.episodes[a.pr] = { pr: a.pr, headRefOid: a.armedHead, attempts: 0, rearmEpisodes: 0, state: 'active', armedAt: Date.now(), armedHead: a.armedHead };
  }
  const deps: GreenPrAutoMergerDeps = {
    holdsLease: () => true,
    leaseEpoch: () => 1,
    listOpenPrs: async () => prs,
    codeOwnedPaths: async () => ({ touches: false, files: [], unverifiable: false }),
    refetchPr: async () => ({ title: 'feat', labels: [], isDraft: false, headRefOid: 'sha', state: 'OPEN', autoMergeRequest: null }),
    disarmArmedEpisodes: async (n) => { disarmTracker.calls.push(n); return true; },
    resolveGhLogin: async () => 'echo-bot',
    holdEligible: async () => ({ ok: true }),
    applyHoldMarker: async () => true,
    runner: { probeContract: async () => ({ ok: true }), run: async () => ({ outcome: 'merged', confirmedMerged: true }), reapOrphan: async () => ({ reaped: false }) },
    latches,
    postAttentionAggregate: async () => {},
    audit: () => {},
    loadState: () => state,
    saveState: (s) => { state = s; },
    now: () => Date.now(),
  };
  return new GreenPrAutoMerger(deps, { agentNamespace: 'echo', repo: 'JKHeadley/instar', enabled: true, expectedGhLogin: 'echo-bot' });
}

describe('green-pr-automerge routes (integration)', () => {
  let tmp: string, stateDir: string;
  let latches: GuardLatchStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr-routes-'));
    stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    latches = new GuardLatchStore({ stateDir, machineId: 'm1', leaseEpoch: () => 1 });
    disarmTracker.calls = [];
  });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ignore */ } });

  function appWith(ctx: RouteContext): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return app;
  }

  it('503s every route when the watcher is not configured', async () => {
    const app = appWith(baseCtx(stateDir, {}));
    expect((await request(app).get('/green-pr-automerge')).status).toBe(503);
    expect((await request(app).post('/green-pr-automerge/tick')).status).toBe(503);
    expect((await request(app).post('/green-pr-automerge/rollback')).status).toBe(503);
  });

  it('GET /green-pr-automerge returns 200 with the gate snapshot when wired (feature-alive)', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    const res = await request(app).get('/green-pr-automerge');
    expect(res.status).toBe(200);
    expect(res.body.gate).toBeTruthy();
    expect(res.body.gate.mergeAllowed).toBe(true);
    expect(res.body.invariantOk).toBe(true);
    expect(res.body.configuration).toEqual({
      ok: true,
      issues: [],
      agentNamespace: 'echo',
      identityConfigured: true,
    });
    expect(res.body.namespaceMismatch).toBeNull();
  });

  it('rollback (Bearer) closes the gate; GET reflects it; PIN-gated enable re-arms', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));

    const rb = await request(app).post('/green-pr-automerge/rollback').send({ reason: 'stop' });
    expect(rb.status).toBe(200);
    expect(rb.body.latchId).toBeTruthy();

    const after = await request(app).get('/green-pr-automerge');
    expect(after.body.gate.mergeAllowed).toBe(false);
    expect(after.body.gate.reason).toBe('rollback');

    // enable WITHOUT the PIN is refused.
    expect((await request(app).post('/green-pr-automerge/enable').send({})).status).toBe(403);
    // enable WITH the PIN re-arms.
    const en = await request(app).post('/green-pr-automerge/enable').send({ pin: PIN });
    expect(en.status).toBe(200);
    expect((await request(app).get('/green-pr-automerge')).body.gate.mergeAllowed).toBe(true);
  });

  it('pool-disarm is PIN-gated', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    expect((await request(app).post('/green-pr-automerge/pool-disarm').send({})).status).toBe(403);
    expect((await request(app).post('/green-pr-automerge/pool-disarm').send({ pin: PIN })).status).toBe(200);
  });

  it('/hold validates the pr argument', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    expect((await request(app).post('/green-pr-automerge/hold').send({})).status).toBe(400);
    const ok = await request(app).post('/green-pr-automerge/hold').send({ pr: 42, reason: 'wait' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  it('POST /tick runs the watcher through the HTTP pipeline (warm-up first)', async () => {
    const pr: PrSummary = { number: 7, title: 'feat', labels: [], isDraft: false, headRefName: 'echo/x', headRefOid: 'sha', mergeable: 'MERGEABLE', statusRollup: 'SUCCESS' };
    const watcher = fakeWatcher(stateDir, latches, [pr]);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    const first = await request(app).post('/green-pr-automerge/tick');
    expect(first.status).toBe(200);
    expect(first.body.reason).toBe('warm-up'); // first tick of a tenure is observe-only
    const second = await request(app).post('/green-pr-automerge/tick');
    expect(second.body.acted).toBe(true); // merges on the second tick
  });

  // ── mergerunner-auto-arm-handoff ────────────────────────────────────────

  it('GET serializes armedCount + armed[] (non-optional) and shows an armed episode', async () => {
    // Nothing armed → armedCount:0, armed:[] (never undefined).
    const empty = fakeWatcher(stateDir, latches);
    const emptyApp = appWith(baseCtx(stateDir, { greenPrAutoMerger: empty, guardLatchStore: latches }));
    const emptyRes = await request(emptyApp).get('/green-pr-automerge');
    expect(emptyRes.body.armedCount).toBe(0);
    expect(emptyRes.body.armed).toEqual([]);

    // An armed episode is first-class observable.
    const armed = fakeWatcher(stateDir, latches, [], [{ pr: 55, armedHead: 'sha55' }]);
    const armedApp = appWith(baseCtx(stateDir, { greenPrAutoMerger: armed, guardLatchStore: latches }));
    const res = await request(armedApp).get('/green-pr-automerge');
    expect(res.body.armedCount).toBe(1);
    expect(res.body.armed).toHaveLength(1);
    expect(res.body.armed[0]).toMatchObject({ pr: 55, armedHead: 'sha55', overdue: false });
    expect(res.body.armed[0].armedAt).toBeTruthy();
  });

  it('rollback invokes disarmAllArmed IN-LINE (an armed episode is disarmed by the route call, not a subsequent tick)', async () => {
    const watcher = fakeWatcher(stateDir, latches, [], [{ pr: 77, armedHead: 'sha77' }]);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    const rb = await request(app).post('/green-pr-automerge/rollback').send({ reason: 'stop' });
    expect(rb.status).toBe(200);
    expect(disarmTracker.calls).toContain(77); // disabled in-line by the route
    expect(rb.body.disarmed).toContain(77);
    // The armed episode is now cleared (confirmed disable).
    const after = await request(app).get('/green-pr-automerge');
    expect(after.body.armedCount).toBe(0);
  });

  it('pool-disarm (PIN) invokes disarmAllArmed in-line', async () => {
    const watcher = fakeWatcher(stateDir, latches, [], [{ pr: 88, armedHead: 'sha88' }]);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    const res = await request(app).post('/green-pr-automerge/pool-disarm').send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(disarmTracker.calls).toContain(88);
    expect(res.body.disarmed).toContain(88);
  });

  // ── red-pr-watchdog ─────────────────────────────────────────────────────

  it('GET surfaces redPrWatchdog config + an empty stuckRed[] when nothing is stuck (feature-alive)', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    const res = await request(app).get('/green-pr-automerge');
    expect(res.status).toBe(200);
    expect(res.body.stuckRed).toEqual([]); // non-optional, empty when nothing is red
    expect(res.body.redPrWatchdog).toMatchObject({ enabled: true, redThresholdMs: 7_200_000 });
  });

  it('a tick over a stuck-red self-authored PR surfaces it in GET stuckRed[]', async () => {
    const redPr: PrSummary = {
      number: 1399, title: 'feat: money', labels: [], isDraft: false,
      headRefName: 'echo/money', headRefOid: 'sha1399', mergeable: 'MERGEABLE', statusRollup: 'FAILURE',
      failingChecks: [{ name: 'shard 4', completedAt: Date.now() - 3 * 3_600_000 }], // red for ~3h > 2h threshold
    };
    const watcher = fakeWatcher(stateDir, latches, [redPr]);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    // One tick (warm-up) runs the watchdog and records the stuck-red memory.
    const tick = await request(app).post('/green-pr-automerge/tick');
    expect(tick.status).toBe(200);
    const res = await request(app).get('/green-pr-automerge');
    expect(res.status).toBe(200);
    expect(res.body.stuckRed).toHaveLength(1);
    expect(res.body.stuckRed[0]).toMatchObject({ pr: 1399, failingChecks: ['shard 4'] });
    expect(res.body.stuckRed[0].redForMs).toBeGreaterThanOrEqual(2 * 3_600_000);
  });

  it('GET exposes notAgentOwnedCount/notAgentOwned (non-optional) and a tick fills them for a refused PR', async () => {
    const empty = appWith(baseCtx(stateDir, { greenPrAutoMerger: fakeWatcher(stateDir, latches), guardLatchStore: latches }));
    const before = await request(empty).get('/green-pr-automerge');
    expect(before.body.notAgentOwnedCount).toBe(0);
    expect(before.body.notAgentOwned).toEqual([]);
    const other: PrSummary = {
      number: 77, title: 'fix: x', labels: [], isDraft: false, headRefName: 'fix/x', headRefOid: 'sha77',
      mergeable: 'MERGEABLE', statusRollup: 'SUCCESS', authorLogin: 'someone-else', isCrossRepository: false,
    };
    const own: PrSummary = { ...other, number: 78, headRefOid: 'sha78', authorLogin: 'echo-bot' };
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: fakeWatcher(stateDir, latches, [other, own]), guardLatchStore: latches }));
    expect((await request(app).post('/green-pr-automerge/tick')).status).toBe(200);
    const res = await request(app).get('/green-pr-automerge');
    expect(res.body.notAgentOwnedCount).toBe(1);
    expect(res.body.notAgentOwned[0]).toMatchObject({ pr: 77, reason: 'author-mismatch' });
  });

  it('rollback is a null-safe no-op for disarm when the merger is absent (latch still set)', async () => {
    // guardLatchStore present, greenPrAutoMerger null → the route still rolls
    // back the latch and does not throw on the in-line disarm.
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: null as never, guardLatchStore: latches }));
    const rb = await request(app).post('/green-pr-automerge/rollback').send({ reason: 'stop' });
    expect(rb.status).toBe(200);
    expect(rb.body.rolledBack).toBe(true);
    expect(rb.body.disarmed).toEqual([]);
  });

  describe('agent stop release (green-pr-agent-stop-release)', () => {
    const claim = { topicId: 18330, sessionId: 's1', cause: 'The old watcher merged PR 2648 before hosted CI finished.', release: { kind: 'fix-pr-released' } };
    const by = { latchId: '', releasedBy: { topicId: 136706, sessionId: 's2' }, note: 'the fix is in the running release' };
    let commits: Array<{ id: string; externalKey?: string }>;
    let delivered: string[];
    let withdrawn: string[];
    let readerFacts: AgentStopFacts;

    function app(over: { surfacer?: AgentStopSurfacer | null; commitments?: unknown } = {}) {
      const surfacer = over.surfacer !== undefined ? over.surfacer : new AgentStopSurfacer({
        stateDir,
        listRollbackStops: () => latches.rollbackStops(),
        facts: { mergedPrsCiting: (m) => readerFacts.mergedPrsCiting(m), commitInReleaseTag: (c, v) => readerFacts.commitInReleaseTag(c, v) },
        runningVersion: () => '1.3.1640',
        commitments: (over.commitments ?? {
          record: (input: { externalKey: string }) => {
            const hit = commits.find((c) => c.externalKey === input.externalKey);
            if (hit) return hit;
            const c = { id: `CMT-${commits.length + 1}`, externalKey: input.externalKey };
            commits.push(c);
            return c;
          },
          getActive: () => commits,
          deliver: (id: string) => { delivered.push(id); commits = commits.filter((c) => c.id !== id); },
          withdraw: (id: string) => { withdrawn.push(id); commits = commits.filter((c) => c.id !== id); },
        }) as never,
      });
      return appWith(baseCtx(stateDir, { greenPrAutoMerger: fakeWatcher(stateDir, latches), guardLatchStore: latches, agentStopSurfacer: surfacer }));
    }
    const merged = (marker: string, tag: 'contained' | 'not-contained' | 'unreadable' = 'contained'): AgentStopFacts => ({
      mergedPrsCiting: async () => [{ number: 2700, body: `Resolves ${marker}`, state: 'MERGED', mergedAt: new Date(Date.now() + 60_000).toISOString(), baseRefName: 'main', mergeCommitOid: 'abc1234' }],
      commitInReleaseTag: async () => tag,
    });
    const stop = async (a: express.Express, body: object) => (await request(a).post('/green-pr-automerge/rollback').send(body)).body;

    beforeEach(() => {
      commits = []; delivered = []; withdrawn = [];
      readerFacts = { mergedPrsCiting: async () => [], commitInReleaseTag: async () => 'not-contained' };
    });

    it('a stop with no claim is operator-class and a release is refused 403', async () => {
      const a = app();
      const r = await stop(a, { reason: 'stopped from the console' });
      expect(r).toMatchObject({ ok: true, rolledBack: true, originClass: 'operator' });
      expect(r.marker).toBeUndefined();
      const rel = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId });
      expect(rel.status).toBe(403);
      expect(rel.body.error).toBe('operator-stop');
      expect(latches.activeLatchIds('rollback')).toEqual([r.latchId]);
    });

    it('an invalid claim still stops, 200, operator-class, and says why', async () => {
      const a = app();
      const res = await request(a).post('/green-pr-automerge/rollback').send({ reason: 'x', agentStop: { topicId: 'nope' } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ rolledBack: true, originClass: 'operator' });
      expect(res.body.agentClaimRejected.join(' ')).toMatch(/topicId/);
      expect(latches.isMergeAllowed().allowed).toBe(false);
      expect(commits).toHaveLength(0);
    });

    it('a latch in an older file, with no origin, is refused 403', async () => {
      const file = path.join(stateDir, 'state', 'green-pr-automerge-latches.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ machineId: 'm1', ownSeq: 212, transitions: { rollback: { 'm1:212': { action: 'set', epoch: 1, seq: 212, reason: 'older stop', ts: new Date().toISOString() } } } }));
      latches = new GuardLatchStore({ stateDir, machineId: 'm1', leaseEpoch: () => 1 });
      const rel = await request(app()).post('/green-pr-automerge/release').send({ ...by, latchId: 'm1:212' });
      expect(rel.status).toBe(403);
      expect(latches.activeLatchIds('rollback')).toEqual(['m1:212']);
    });

    it('a pin in a release body does nothing', async () => {
      const a = app();
      const r = await stop(a, { reason: 'x' });
      const rel = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId, pin: PIN });
      expect(rel.status).toBe(403);
    });

    it('a claim sent at release time cannot change a stop\'s class', async () => {
      const a = app();
      const r = await stop(a, { reason: 'x' });
      const rel = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId, class: 'agent', origin: { class: 'agent' }, agentStop: claim });
      expect(rel.status).toBe(403);
    });

    it.each([
      ['no id', { releasedBy: { topicId: 1 }, note: 'n' }],
      ['a list of ids', { latchId: ['m1:1'], releasedBy: { topicId: 1 }, note: 'n' }],
      ['no releaser', { latchId: 'm1:1', note: 'n' }],
      ['no note', { latchId: 'm1:1', releasedBy: { topicId: 1 } }],
      ['an empty note', { latchId: 'm1:1', releasedBy: { topicId: 1 }, note: '  ' }],
    ])('400 for %s', async (_n, body) => {
      expect((await request(app()).post('/green-pr-automerge/release').send(body)).status).toBe(400);
    });

    it('404 for an unknown id', async () => {
      const rel = await request(app()).post('/green-pr-automerge/release').send({ ...by, latchId: 'm1:999' });
      expect(rel.status).toBe(404);
    });

    it('refuses while the condition is unmet, 503 when unreadable, and the stop stands', async () => {
      const a = app();
      const r = await stop(a, { reason: 'x', agentStop: claim });
      expect(r).toMatchObject({ originClass: 'agent', marker: `agent-stop-${r.latchId.replace(':', '-')}`, commitmentId: 'CMT-1' });
      const none = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId });
      expect(none.status).toBe(409);
      expect(none.body.error).toBe('condition-not-met');
      readerFacts = merged(r.marker, 'not-contained');
      const notRunning = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId });
      expect(notRunning.status).toBe(409);
      readerFacts = merged(r.marker, 'unreadable');
      const unread = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId });
      expect(unread.status).toBe(503);
      expect(unread.body.error).toBe('condition-unverifiable');
      readerFacts = { mergedPrsCiting: async () => { throw new Error('gh hung up'); }, commitInReleaseTag: async () => 'contained' };
      expect((await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId })).status).toBe(503);
      expect(latches.activeLatchIds('rollback')).toEqual([r.latchId]);
    });

    it('with no condition reader the release is refused', async () => {
      const a = app({ surfacer: null });
      const r = await stop(a, { reason: 'x', agentStop: claim });
      expect((await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId })).status).toBe(503);
      expect(latches.activeLatchIds('rollback')).toEqual([r.latchId]);
    });

    it('releases once the fix is running, delivers the commitment; a second release is 409', async () => {
      const a = app();
      const r = await stop(a, { reason: 'x', agentStop: claim });
      readerFacts = merged(r.marker);
      const rel = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId });
      expect(rel.status).toBe(200);
      expect(rel.body).toMatchObject({ ok: true, released: r.latchId, stillStopped: [], mergeAllowed: true, evidence: { pr: 2700 } });
      expect(latches.isMergeAllowed().allowed).toBe(true);
      expect(delivered).toEqual(['CMT-1']);
      expect((await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId })).status).toBe(409);
    });

    it('a stop that clears during the condition read is not cleared twice', async () => {
      const a = app();
      const r = await stop(a, { reason: 'x', agentStop: claim });
      const real = merged(r.marker);
      readerFacts = { ...real, mergedPrsCiting: async (m) => { latches.clear('rollback', [r.latchId], 're-arm'); return real.mergedPrsCiting(m); } };
      expect((await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: r.latchId })).status).toBe(409);
    });

    it('an operator stop keeps the gate shut after an agent release, and the caller is told', async () => {
      const a = app();
      const op = await stop(a, { reason: 'operator-rollback' });
      const mine = await stop(a, { reason: 'x', agentStop: claim });
      readerFacts = merged(mine.marker);
      const rel = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: mine.latchId });
      expect(rel.body).toMatchObject({ released: mine.latchId, stillStopped: [op.latchId], mergeAllowed: false });
    });

    it('two agent stops keep each other\'s gate shut', async () => {
      const a = app();
      const one = await stop(a, { reason: 'one', agentStop: claim });
      const two = await stop(a, { reason: 'two', agentStop: claim });
      readerFacts = merged(one.marker);
      const rel = await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: one.latchId });
      expect(rel.body).toMatchObject({ stillStopped: [two.latchId], mergeAllowed: false });
      expect((await request(a).post('/green-pr-automerge/release').send({ ...by, latchId: two.latchId })).status).toBe(409);
    });

    it('the release route cannot reach the emergency stop', async () => {
      const id = latches.set('emergency-pause', 'stop everything');
      const rel = await request(app()).post('/green-pr-automerge/release').send({ ...by, latchId: id });
      expect(rel.status).toBe(404);
      expect(latches.activeLatchIds('emergency-pause')).toEqual([id]);
    });

    it('the PIN still clears an agent stop and withdraws its commitment; without it, 403', async () => {
      const a = app();
      const r = await stop(a, { reason: 'x', agentStop: claim });
      expect((await request(a).post('/green-pr-automerge/enable').send({})).status).toBe(403);
      expect(latches.activeLatchIds('rollback')).toEqual([r.latchId]);
      expect((await request(a).post('/green-pr-automerge/enable').send({ pin: PIN })).status).toBe(200);
      expect(withdrawn).toEqual(['CMT-1']);
      expect(latches.isMergeAllowed().allowed).toBe(true);
    });

    it('a failing commitment store does not block the stop', async () => {
      const a = app({ commitments: { record: () => { throw new Error('disk'); }, getActive: () => [], deliver: () => {}, withdraw: () => {} } });
      const res = await request(a).post('/green-pr-automerge/rollback').send({ reason: 'x', agentStop: claim });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ rolledBack: true, originClass: 'agent', commitmentId: null });
      expect(latches.isMergeAllowed().allowed).toBe(false);
    });

    it('GET shows each stop\'s class; operator rows carry nothing extra', async () => {
      const a = app();
      const op = await stop(a, { reason: 'operator-rollback' });
      const mine = await stop(a, { reason: 'short', agentStop: { ...claim, cause: 'c'.repeat(300) } });
      const res = await request(a).get('/green-pr-automerge');
      expect(res.body.gate.rollback).toEqual([op.latchId, mine.latchId]);
      const [opRow, mineRow] = res.body.gate.rollbackStops;
      expect(opRow).toMatchObject({ latchId: op.latchId, class: 'operator' });
      expect(opRow.cause).toBeUndefined();
      expect(opRow.origin).toBeUndefined();
      expect(mineRow).toMatchObject({ latchId: mine.latchId, class: 'agent', topicId: 18330, sessionId: 's1', marker: mine.marker, conditionMet: null, release: { kind: 'fix-pr-released' } });
      expect(mineRow.cause).toHaveLength(300);
    });
  });
});
