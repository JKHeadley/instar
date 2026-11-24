// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration tests for the Local Verify queue controls over the real HTTP pipeline
 * (supertest + createRoutes + a real LocalVerifyService on a temp state dir; only the child
 * process, gh and the merge watcher are fakes). Spec docs/specs/local-verify-queue-controls.md:
 * the four routes through the real router (bodies, refusals, the 409 on a machine without the
 * lease, the 404 with the switch off) and GET /local-verify showing held and fronted changes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type PrView } from '../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS } from '../../src/localVerify/policy.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const headOf = (pr: number) => pr.toString(16).padStart(4, '0').repeat(10);
const BY = 'echo-increasing-throughput';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-queue-controls.test.ts' }); });

function baseCtx(stateDir: string, over: Partial<RouteContext>): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
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

function view(pr: number, over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: `echo/pr-${pr}`, headRefOid: headOf(pr), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

function setup(prs: number[], opts: { controls?: boolean } = {}) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvqc-')));
  dirs.push(stateDir);
  const lvDir = path.join(stateDir, 'state', 'local-verify');
  fs.mkdirSync(lvDir, { recursive: true });
  fs.writeFileSync(path.join(lvDir, 'main-health.json'), JSON.stringify({
    v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-11-18T00:00:00.000Z',
  }));
  const views: Record<number, PrView> = Object.fromEntries(prs.map((pr) => [pr, view(pr)]));
  const open: Record<number, boolean> = {};
  const children: Array<{ pr: number; resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  let holders: number[] = [];
  let controls = opts.controls ?? true;
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async (pr) => open[pr] ?? true, baseHead: async () => sha('b'),
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      const input = JSON.parse(fs.readFileSync(a.args[a.args.indexOf('--input') + 1], 'utf-8')) as { pr: number };
      children.push({ pr: input.pr, resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
      return { pid: 90_000 + children.length, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => holders.map((pid) => ({ pid })),
    suiteCapacity: () => 1,
    setTimer: () => {},
  });
  // The production wiring reads `monitoring.localVerify.queueControls` live; here a variable stands in for the config.
  svc.setQueueControlsEnabled(() => controls);
  const audits = () => {
    try { return fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown> & { event: string }); }
    catch { return []; }
  };
  const operatorFile = () => JSON.parse(fs.readFileSync(path.join(lvDir, 'operator-queue.json'), 'utf-8')) as { records: Array<{ pr: number; hold?: Record<string, unknown>; front?: Record<string, unknown> }> };
  return { stateDir, lvDir, svc, views, open, children, audits, operatorFile, setHolders: (h: number[]) => { holders = h; }, setControls: (v: boolean) => { controls = v; } };
}

function app(ctx: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(ctx));
  return a;
}

const post = (a: express.Express, route: string, body: unknown) => request(a).post(`/local-verify/queue/${route}`).send(body as object);

describe('local-verify queue controls (integration, the real router)', () => {
  it('hold takes a queued change out, GET /local-verify lists it, a POST for it answers 409 held, and release puts it back', async () => {
    const s = setup([1, 2, 3]);
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    s.setHolders([90_001]); // another suite holds the slot: nothing starts
    for (const pr of [1, 2, 3]) expect((await request(a).post('/local-verify').send({ pr })).status).toBe(202);
    const held = await post(a, 'hold', { pr: 2, by: BY, reason: 'waiting on PR 120', until: '2026-12-01T18:00:00Z' });
    expect(held.status).toBe(200);
    expect(held.body).toEqual({ ok: true, pr: 2, held: true, alreadyHeld: false, running: false, removed: 'queue', queueHold: true, mergeHold: 'not-requested' });
    const v = await request(a).get('/local-verify');
    expect(v.status).toBe(200);
    expect(v.body.queue.map((e: { pr: number }) => e.pr)).toEqual([1, 3]);
    expect(v.body.operator.held).toEqual([expect.objectContaining({ pr: 2, reason: 'waiting on PR 120', by: BY, until: '2026-12-01T18:00:00.000Z', savedEntry: true, running: false })]);
    expect(v.body.operator.fronted).toEqual([]);
    // The operator file is where the service reads it, written before the entry left the queue file.
    expect(s.operatorFile().records).toEqual([expect.objectContaining({ pr: 2, hold: expect.objectContaining({ by: BY, reason: 'waiting on PR 120' }) })]);
    const queueFile = JSON.parse(fs.readFileSync(path.join(s.lvDir, 'queue.json'), 'utf-8')) as { entries: Array<{ pr: number }> };
    expect(queueFile.entries.map((e) => e.pr)).toEqual([1, 3]);
    // The watcher's and anyone's request for it answers `held`.
    const again = await request(a).post('/local-verify').send({ pr: 2 });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ ok: false, code: 'held' });
    // It does not start when the slot frees.
    s.setHolders([]);
    await s.svc.tick();
    expect(s.children.map((c) => c.pr)).toEqual([1]);
    const rel = await post(a, 'release', { pr: 2, by: BY });
    expect(rel.status).toBe(200);
    expect(rel.body).toMatchObject({ ok: true, pr: 2, released: true, placed: 'queue', mergeHold: 'not-removed' });
    expect((await request(a).get('/local-verify')).body.queue.map((e: { pr: number }) => e.pr)).toEqual([3, 2]);
    expect((await post(a, 'release', { pr: 2, by: BY })).status).toBe(409); // not-held: an entry is restored once
    s.svc.shutdown();
  });

  it('front admits a change into a full queue and makes it the next to start; the fourth front is refused; unfront ends a mark', async () => {
    const prs = [...Array.from({ length: LOCAL_VERIFY_LIMITS.queueCap }, (_, i) => i + 1), 21, 22, 23, 24];
    const s = setup(prs);
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    s.setHolders([90_001]);
    for (let pr = 1; pr <= LOCAL_VERIFY_LIMITS.queueCap; pr++) expect((await request(a).post('/local-verify').send({ pr })).status).toBe(202);
    expect((await request(a).post('/local-verify').send({ pr: 21 })).status).toBe(429); // the queue is full
    const fr = await post(a, 'front', { pr: 21, by: BY, reason: 'unblocks fourteen others' });
    expect(fr.status).toBe(200);
    expect(fr.body).toMatchObject({ ok: true, pr: 21, status: 'admitted', overCap: true, order: 1 });
    for (const pr of [22, 23]) expect((await post(a, 'front', { pr, by: BY, reason: `promised ${pr}` })).status).toBe(200);
    const fourth = await post(a, 'front', { pr: 24, by: BY, reason: 'one too many' });
    expect(fourth.status).toBe(409);
    expect(fourth.body.code).toBe('front-limit');
    expect(fourth.body.fronted.map((f: { pr: number }) => f.pr)).toEqual([23, 22, 21]);
    const v = (await request(a).get('/local-verify')).body;
    expect(v.queue).toHaveLength(LOCAL_VERIFY_LIMITS.queueCap + 3);
    expect(v.operator.fronted.map((f: { pr: number; queued: boolean }) => [f.pr, f.queued])).toEqual([[23, true], [22, true], [21, true]]);
    expect(v.operator.overflow).toEqual({ used: 3, max: 5 });
    const un = await post(a, 'unfront', { pr: 23, by: BY });
    expect(un.status).toBe(200);
    expect(un.body).toEqual({ ok: true, pr: 23, unfronted: true });
    expect((await post(a, 'unfront', { pr: 23, by: BY })).status).toBe(409);
    s.setHolders([]);
    await s.svc.tick();
    expect(s.children.map((c) => c.pr)).toEqual([22]); // the most recently fronted of those still marked
    expect(s.audits().filter((x) => x.event === 'front-admitted-over-cap').map((x) => x.pr)).toEqual([21, 22, 23]);
    expect(s.audits().filter((x) => x.event === 'operator-front').map((x) => [x.pr, x.by, x.reason]))
      .toEqual([[21, BY, 'unblocks fourteen others'], [22, BY, 'promised 22'], [23, BY, 'promised 23']]);
    s.svc.shutdown();
  });

  it('strict bodies: by is required on all four, reason on hold and front, and unknown fields are refused', async () => {
    const s = setup([1]);
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    const bad: Array<[string, unknown]> = [
      ['hold', {}], ['hold', { pr: 1, reason: 'r' }], ['hold', { pr: 1, by: BY }], ['hold', { pr: 1, by: BY, reason: 'x'.repeat(501) }],
      ['hold', { pr: 1, by: BY, reason: 'r', until: 'soon' }], ['hold', { pr: 1, by: BY, reason: 'r', blockMerge: 'yes' }],
      ['hold', { pr: 1, by: BY, reason: 'r', repo: 'evil/repo' }], ['hold', { pr: 0, by: BY, reason: 'r' }],
      ['front', { pr: 1, by: BY }], ['front', { pr: 1, reason: 'r' }], ['front', { pr: 1, by: BY, reason: 'r', until: '2026-12-01' }],
      ['release', { pr: 1 }], ['release', { pr: 1, by: BY, reason: 'r' }], ['unfront', { pr: 1 }], ['unfront', { pr: '1', by: BY }],
    ];
    for (const [route, body] of bad) {
      const r = await post(a, route, body);
      expect(r.status, `${route} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
      expect(typeof r.body.error).toBe('string');
    }
    expect((await request(a).get('/local-verify')).body.operator).toMatchObject({ held: [], fronted: [] });
    expect(s.audits().filter((x) => x.event.startsWith('operator-'))).toEqual([]);
    // A reason of exactly 500 characters is accepted and shown in full.
    const long = 'r'.repeat(500);
    expect((await post(a, 'hold', { pr: 1, by: BY, reason: long })).status).toBe(200);
    expect((await request(a).get('/local-verify')).body.operator.held[0].reason).toBe(long);
    s.svc.shutdown();
  });

  it('refusals: not-held, not-fronted and a closed change', async () => {
    const s = setup([1, 2]);
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    const r1 = await post(a, 'release', { pr: 1, by: BY });
    expect([r1.status, r1.body]).toEqual([409, { ok: false, code: 'not-held' }]);
    const r2 = await post(a, 'unfront', { pr: 1, by: BY });
    expect([r2.status, r2.body]).toEqual([409, { ok: false, code: 'not-fronted' }]);
    s.open[2] = false;
    const r3 = await post(a, 'front', { pr: 2, by: BY, reason: 'r' });
    expect([r3.status, r3.body]).toEqual([409, { ok: false, code: 'pr-closed' }]);
    expect((await request(a).get('/local-verify')).body.operator.fronted).toEqual([]);
    s.svc.shutdown();
  });

  it('a machine without the lease answers 409 naming the holder on all four routes', async () => {
    const s = setup([1]);
    const coordinator = { holdsLease: () => false, getSyncStatus: () => ({ leaseHolder: 'm_other' }) };
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc, coordinator: coordinator as never }));
    for (const [route, body] of [
      ['hold', { pr: 1, by: BY, reason: 'r' }], ['release', { pr: 1, by: BY }], ['front', { pr: 1, by: BY, reason: 'r' }], ['unfront', { pr: 1, by: BY }],
    ] as const) {
      const r = await post(a, route, body);
      expect(r.status, route).toBe(409);
      expect(r.body).toEqual({ error: 'not-lease-holder', holderMachineId: 'm_other' });
    }
    expect(fs.existsSync(path.join(s.lvDir, 'operator-queue.json'))).toBe(false);
    s.svc.shutdown();
  });

  it('the switch off: all four routes answer 404, GET /local-verify has no operator block, and a held record is not applied', async () => {
    const s = setup([1, 2]);
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    s.setHolders([90_001]);
    // A hold set while the switch was on…
    expect((await post(a, 'hold', { pr: 1, by: BY, reason: 'r' })).status).toBe(200);
    s.setControls(false);
    for (const [route, body] of [
      ['hold', { pr: 2, by: BY, reason: 'r' }], ['release', { pr: 1, by: BY }], ['front', { pr: 2, by: BY, reason: 'r' }], ['unfront', { pr: 2, by: BY }],
    ] as const) {
      const r = await post(a, route, body);
      expect(r.status, route).toBe(404);
      expect(r.body.error).toBe('queue-controls-off');
    }
    const v = await request(a).get('/local-verify');
    expect(v.status).toBe(200);
    expect(v.body).not.toHaveProperty('operator');
    // …is kept but not applied: the change is admitted as before the controls existed.
    expect((await request(a).post('/local-verify').send({ pr: 1 })).status).toBe(202);
    expect(s.operatorFile().records.map((r) => r.pr)).toEqual([1]);
    // On again, with no restart: the route answers, and the queued entry of the held change goes back to held.
    s.setControls(true);
    await s.svc.tick();
    expect((await request(a).get('/local-verify')).body.queue.map((e: { pr: number }) => e.pr)).toEqual([]);
    expect((await request(a).get('/local-verify')).body.operator.held.map((h: { pr: number }) => h.pr)).toEqual([1]);
    s.svc.shutdown();
  });

  it('answers 503 when the service is not constructed', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvqc-')));
    dirs.push(dir);
    const a = app(baseCtx(dir, { localVerify: null }));
    expect((await post(a, 'hold', { pr: 1, by: BY, reason: 'r' })).status).toBe(503);
    expect((await post(a, 'front', { pr: 1, by: BY, reason: 'r' })).status).toBe(503);
  });

  it('blockMerge applies the merge-side hold through the merge watcher (the function POST /green-pr-automerge/hold calls), and says which of the two applied', async () => {
    const s = setup([1, 2]);
    const calls: Array<{ pr: number; reason: string }> = [];
    let githubOk = true;
    const greenPrAutoMerger = {
      applyHold: async (pr: number, reason: string) => { calls.push({ pr, reason }); return githubOk ? { ok: true, pr } : { ok: false, status: 502, detail: 'gh failed to apply the hold marker', pr }; },
    };
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc, greenPrAutoMerger: greenPrAutoMerger as never }));
    const both = await post(a, 'hold', { pr: 1, by: BY, reason: 'known wrong] do not merge', blockMerge: true });
    expect(both.status).toBe(200);
    expect(both.body).toMatchObject({ ok: true, held: true, queueHold: true, mergeHold: 'applied' });
    expect(calls).toEqual([{ pr: 1, reason: 'known wrong  do not merge' }]); // cleaned the way that route cleans it
    // The merge-side route itself uses the same cleaning.
    const direct = await request(a).post('/green-pr-automerge/hold').send({ pr: 1, reason: 'known wrong] do not merge' });
    expect(direct.status).toBe(200);
    expect(calls[1]).toEqual({ pr: 1, reason: 'known wrong  do not merge' });
    // GitHub refuses: the queue hold still applies and the answer says the merge-side hold failed.
    githubOk = false;
    const half = await post(a, 'hold', { pr: 2, by: BY, reason: 'r', blockMerge: true });
    expect(half.status).toBe(200);
    expect(half.body).toMatchObject({ ok: true, held: true, queueHold: true, mergeHold: 'failed', mergeHoldDetail: 'gh failed to apply the hold marker' });
    expect((await request(a).get('/local-verify')).body.operator.held.map((h: { pr: number }) => h.pr)).toEqual([1, 2]);
    // Without a merge watcher the answer says so.
    const b = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await post(b, 'hold', { pr: 2, by: BY, reason: 'r', blockMerge: true })).body).toMatchObject({ queueHold: true, mergeHold: 'unavailable' });
    s.svc.shutdown();
  });
});
