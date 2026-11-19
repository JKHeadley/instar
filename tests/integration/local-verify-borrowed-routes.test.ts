// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration tests for the run machine's borrowed-helper routes over the real HTTP pipeline
 * (supertest + the production auth middleware + createRoutes + a real LocalVerifyService wired by
 * wireBorrowedRunMachine, the function server.ts calls). Spec
 * docs/specs/local-verify-borrowed-slices-count.md, F and "Build decisions".
 *
 *   GET  /local-verify, GET /local-verify/borrowed   the mode and per helper and lane the state and evidence
 *   POST /local-verify/borrowed/decision             refused without the evidence
 *   POST /local-verify/borrowed/dry-run              a recorded request
 *   POST /local-verify/helper-here                   the helper's signed "I am here"
 *   POST /local-verify/borrowed-proxy                loopback only, a running verify's attempt token
 *   POST /local-verify/peer-baseline                 the coordinator's baseline results
 *
 * The helper is a real HelperService reached through a `fetch` double (no socket); the run child and
 * gh are fakes. NOT run locally on the verify machines: Local Verify's own integration lane runs it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type PrView } from '../../src/localVerify/LocalVerifyService.js';
import { wireBorrowedRunMachine } from '../../src/localVerify/localVerifyWiring.js';
import { signHelperHere } from '../../src/localVerify/helper/helperProtocol.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { HEAD, helperRig, pins, sha, type HelperRig } from '../helpers/borrowedHelperFixture.js';

const REPO = 'JKHeadley/instar';
const AUTH = 'integration-bearer';
const HELPER_URL = 'http://100.64.0.9:4042';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-borrowed-routes.test.ts' }); });

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

/** A `fetch` that answers the helper's routes from a real HelperService in this process. */
function helperFetch(r: HelperRig, calls: string[]): typeof fetch {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    if (url.pathname === '/local-verify/helper-status') {
      const run = url.searchParams.get('run');
      const since = url.searchParams.get('since');
      return json(200, r.svc.status({ ...(run ? { runAttemptId: run } : {}), ...(since ? { sinceSeq: Number(since) } : {}) }));
    }
    if (url.pathname === '/local-verify/helper-slice') { const a = await r.svc.handleSlice(body, r.route); return json(a.status, a.body); }
    if (url.pathname === '/local-verify/helper-slice/cancel') { const a = await r.svc.handleCancel(body, r.route); return json(a.status, a.body); }
    return json(404, { error: 'not found' });
  }) as typeof fetch;
}

async function setup(o: { mode?: 'practice' | 'count' | null; holdsLease?: boolean } = {}) {
  const r = helperRig({}, dirs);
  // The run machine's side runs on the real clock here (production wiring), so the helper does too:
  // a status answer is read only when it is fresh, and a request only before it expires.
  r.clock.t = Date.now();
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvborrowed-')));
  dirs.push(stateDir);
  fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({ v: 1, machineId: 'm_studio', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-11-18T00:00:00.000Z' }));
  const children: Array<{ token: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const view: PrView = { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: HEAD, baseRefName: 'main', baseRefOid: HEAD };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm_studio', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, {
    prView: async (pr) => (pr === 7 ? view : null),
    isPrOpen: async () => true, baseHead: async () => HEAD,
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((res) => { resolve = res; });
      children.push({ token: a.args[a.args.indexOf('--attempt-token') + 1], resolve });
      return { pid: 90_000 + children.length, exited };
    },
    isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [], suiteCapacity: () => 1, setTimer: () => {},
  });
  const mode = o.mode === undefined ? 'practice' : o.mode;
  const calls: string[] = [];
  const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const wired = await wireBorrowedRunMachine(svc, {
    liveConfig: { get: <T>(k: string, fb: T): T => (k === 'monitoring.localVerify.borrowed' && mode ? { mode, helpers: [{ machineId: 'm_laptop', url: HELPER_URL }] } as T : fb) },
    stateDir, agentHome: stateDir, machineId: 'm_studio', authToken: AUTH, agentId: 'echo', version: 'it',
    fetchImpl: helperFetch(r, calls), signer: r.requester.signer, keyLookup: () => pins(r.helperKeys),
    lease: { holdsLease: () => o.holdsLease ?? true },
    hooks: { signal: (key, detail) => { signals.push({ key, detail }); } },
    evidence: (row) => { evidence.push(row); },
  });
  const lease = { holdsLease: () => o.holdsLease ?? true, getSyncStatus: () => ({ leaseHolder: 'm_studio', leaseEpoch: 3 }) };
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(AUTH));
  a.use(createRoutes(baseCtx(stateDir, { localVerify: svc, coordinator: lease as never })));
  const bearer = { Authorization: `Bearer ${AUTH}` };
  const audit = () => fs.existsSync(path.join(stateDir, 'logs', 'local-verify.jsonl'))
    ? fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  return { r, svc, app: a, bearer, children, calls, signals, evidence, wired, stateDir, audit };
}

describe('borrowed-helper routes on a run machine (integration)', () => {
  it('are dark with the setting absent: every route answers 404 and GET /local-verify reports mode off', async () => {
    const s = await setup({ mode: null });
    expect((await request(s.app).post('/local-verify/borrowed/decision').set(s.bearer).send({ helper: 'm_laptop', lane: 'integration', reason: 'r' })).status).toBe(404);
    expect((await request(s.app).post('/local-verify/borrowed/dry-run').set(s.bearer).send({ helper: 'm_laptop' })).status).toBe(404);
    expect((await request(s.app).post('/local-verify/helper-here').set(s.bearer).send({ kind: 'here' })).status).toBe(404);
    expect((await request(s.app).post('/local-verify/borrowed-proxy').set('X-Instar-Attempt-Token', '1'.repeat(32)).send({ op: 'plan' })).status).toBe(404);
    expect((await request(s.app).post('/local-verify/peer-baseline').set(s.bearer).send({})).status).toBe(404);
    const g = await request(s.app).get('/local-verify').set(s.bearer);
    expect(g.status).toBe(200);
    expect(g.body.borrowed).toMatchObject({ mode: 'off', helpers: [] });
    expect(s.calls).toEqual([]); // nothing was sent to any helper
  });

  it('GET /local-verify and GET /local-verify/borrowed show the mode and, per helper and lane, the state and each evidence item', async () => {
    const s = await setup({ mode: 'count' });
    for (const p of ['/local-verify', '/local-verify/borrowed']) {
      const g = await request(s.app).get(p).set(s.bearer);
      expect(g.status).toBe(200);
      expect(g.body.borrowed).toMatchObject({ mode: 'count', countBehavesAsPractice: true, helpers: [{ machineId: 'm_laptop', url: HELPER_URL, spotOneIn: 20, lanes: { unit: { state: 'practice', mayCount: false }, integration: { state: 'practice', mayCount: false }, e2e: { state: 'practice', mayCount: false } } }] });
    }
    expect((await request(s.app).get('/local-verify/borrowed')).status).toBe(401); // the ordinary credential
  });

  it('the decision route needs the ordinary credential and refuses without the evidence, naming what is missing', async () => {
    const s = await setup({ mode: 'count' });
    const body = { helper: 'm_laptop', lane: 'integration', reason: 'practice report reviewed', by: 'echo-increasing-throughput' };
    expect((await request(s.app).post('/local-verify/borrowed/decision').send(body)).status).toBe(401);
    const r = await request(s.app).post('/local-verify/borrowed/decision').set(s.bearer).send(body);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'evidence-incomplete', missing: ['coverage', 'spread', 'failing-direction', 'check-slice'] });
    expect(s.audit().some((e) => e.event === 'borrowed-decision-refused' && e.helper === 'm_laptop')).toBe(true);
    expect(s.evidence).toEqual([expect.objectContaining({ kind: 'held', subject: 'm_laptop' })]);
    expect((await request(s.app).post('/local-verify/borrowed/decision').set(s.bearer).send({ ...body, helper: 'm_winpc' })).status).toBe(404);
    expect((await request(s.app).post('/local-verify/borrowed/decision').set(s.bearer).send({ ...body, lane: 'smoke' })).status).toBe(400);
    const g = await request(s.app).get('/local-verify/borrowed').set(s.bearer);
    expect(g.body.borrowed.helpers[0].lanes.integration).toMatchObject({ state: 'practice', mayCount: false, decision: null });
  });

  it('a dry-run request is recorded (202) and shown; the task that runs it is a later stage', async () => {
    const s = await setup();
    const r = await request(s.app).post('/local-verify/borrowed/dry-run').set(s.bearer).send({ helper: 'm_laptop', lanes: ['integration'], by: 'echo' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, intent: { lanes: ['integration'], state: 'requested', by: 'echo' } });
    const g = await request(s.app).get('/local-verify/borrowed').set(s.bearer);
    expect(g.body.borrowed.helpers[0].dryRunIntent).toMatchObject({ lanes: ['integration'], state: 'requested' });
    expect((await request(s.app).post('/local-verify/borrowed/dry-run').set(s.bearer).send({ helper: 'm_laptop', headSha: sha('f') })).status).toBe(400);
  });

  it('"I am here": a valid signature restores asking; a bad one is refused and changes nothing', async () => {
    const s = await setup();
    const here = (over: Record<string, unknown> = {}) => JSON.parse(JSON.stringify(signHelperHere(s.r.helperKeys.signer, { kind: 'here', helperMachineId: 'm_laptop', runMachineId: 'm_studio', why: 'wake', at: Date.now(), expiresAt: Date.now() + 60_000, runnerVersion: 'hr1:runner-one', ...over } as never))) as Record<string, unknown>;
    expect((await request(s.app).post('/local-verify/helper-here').send(here())).status).toBe(401); // no Bearer credential
    const bad = await request(s.app).post('/local-verify/helper-here').set(s.bearer).send({ ...here(), why: 'start' });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ ok: false, reason: 'signature-bad' });
    const wrong = await request(s.app).post('/local-verify/helper-here').set(s.bearer).send(here({ runMachineId: 'm_m5' }));
    expect(wrong.status).toBe(409);
    const tunnelled = await request(s.app).post('/local-verify/helper-here').set(s.bearer).set('CF-Connecting-IP', '203.0.113.9').send(here());
    expect(tunnelled.status).toBe(403);
    const ok = await request(s.app).post('/local-verify/helper-here').set(s.bearer).send(here());
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(s.audit().filter((e) => e.event === 'helper-here').length).toBe(1);
    expect(s.audit().filter((e) => e.event === 'helper-here-refused').map((e) => e.reason)).toEqual(['signature-bad', 'wrong-run-machine']);
  });

  it('the loopback proxy: a running verify\'s attempt token in place of the Bearer credential; the commits are the server\'s', async () => {
    const s = await setup();
    expect((await s.svc.request(7)).ok).toBe(true);
    expect(s.children.length).toBe(1);
    const token = s.children[0].token;
    const proxy = (body: unknown, headers: Record<string, string> = { 'X-Instar-Attempt-Token': token }) => request(s.app).post('/local-verify/borrowed-proxy').set(headers).send(body as object);

    // No token, a token of the wrong shape, the Bearer credential alone, and an unknown token.
    expect((await proxy({ op: 'plan' }, {})).status).toBe(401);
    expect((await proxy({ op: 'plan' }, { 'X-Instar-Attempt-Token': 'nope' })).status).toBe(401);
    expect((await proxy({ op: 'plan' }, s.bearer)).status).toBe(401);
    expect((await proxy({ op: 'plan' }, { 'X-Instar-Attempt-Token': '0'.repeat(32) })).status).toBe(401);
    // Through the tunnel or another forwarder: refused even with the right token.
    expect((await proxy({ op: 'plan' }, { 'X-Instar-Attempt-Token': token, 'CF-Connecting-IP': '203.0.113.9' })).status).toBe(403);
    expect((await proxy({ op: 'plan' }, { 'X-Instar-Attempt-Token': token, 'X-Forwarded-For': '10.0.0.4' })).status).toBe(403);

    const plan = await proxy({ op: 'plan' });
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ ok: true, helper: 'm_laptop', mode: 'practice', answered: true, lanes: { integration: { state: 'practice', mayCount: false } } });
    expect(['counting', 'compare-only']).toContain(plan.body.assigned);
    expect(s.audit().find((e) => e.event === 'borrowed-assigned')).toMatchObject({ pr: 7, headSha: HEAD, helper: 'm_laptop', assigned: plan.body.assigned });

    // A commit of the caller's is refused whole; the forwarded request carries the verify's own commits.
    const evil = sha('f');
    expect((await proxy({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000, headSha: evil })).status).toBe(400);
    const prep = await proxy({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 });
    expect(prep.status).toBe(200);
    expect(prep.body).toMatchObject({ ok: true, answer: { state: 'preparing', baseSha: HEAD, headSha: HEAD } });
    expect((await proxy({ op: 'slice', lane: 'unit', files: ['src/core/Config.ts'], use: 'compare', budgetMs: 10_000, deadlineInMs: 60_000 })).status).toBe(400);
    const st = await proxy({ op: 'status' });
    expect(st.body).toMatchObject({ ok: true, status: { enabled: true } });

    // When the verify ends its token opens nothing.
    s.children[0].resolve({ status: 1, signal: null });
    await new Promise((res) => setImmediate(res));
    await s.svc.settle();
    expect((await proxy({ op: 'plan' })).status).toBe(401);
  });

  it('a peer stores the coordinator\'s baseline results only from the lease holder; the lease holder itself refuses', async () => {
    const holder = await setup({ holdsLease: true });
    const body = { coordinatorMachineId: 'm_studio', file: { v: 1, baselines: [{ commit: HEAD, finishedAt: '2026-11-19T08:00:00.000Z', machineId: 'm_studio', files: { 'tests/unit/a.test.ts': [3, 0, 0, 0, 'a'.repeat(64)] } }], pinned: [] } };
    const refused = await request(holder.app).post('/local-verify/peer-baseline').set(holder.bearer).send(body);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ ok: false, reason: 'is-lease-holder' });
    const peer = await setup({ holdsLease: false });
    expect((await request(peer.app).post('/local-verify/peer-baseline').send(body)).status).toBe(401);
    expect((await request(peer.app).post('/local-verify/peer-baseline').set(peer.bearer).send({ ...body, coordinatorMachineId: 'm_other' })).status).toBe(409);
    expect((await request(peer.app).post('/local-verify/peer-baseline').set(peer.bearer).send({ ...body, file: { v: 1, baselines: 'all', pinned: [] } })).status).toBe(400);
    const ok = await request(peer.app).post('/local-verify/peer-baseline').set(peer.bearer).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.hash).toMatch(/^[0-9a-f]{64}$/);
    const g = await request(peer.app).get('/local-verify/borrowed').set(peer.bearer);
    expect(g.body.borrowed.baseline).toMatchObject({ ok: true, hash: ok.body.hash, baselines: [{ commit: HEAD, files: 1 }] });
  });
});
