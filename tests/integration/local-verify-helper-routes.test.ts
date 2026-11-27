// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration: the borrowed-machine helper routes (docs/specs/local-verify-borrowed-unit-slices.md,
 * B, C, E, G) over the real HTTP pipeline (createRoutes + authMiddleware on a listening express
 * server), driven by the run machine's real client (`makeHelperClient`, real fetch). The sandbox is a
 * FakeSandboxDriver; GitHub, the owner load and the clock are fakes. Covers: routes absent (404)
 * while disabled; refusals with reasons; signed answers verified; helper-learned signed-only; the
 * prepare-then-poll protocol; helper-status serving the learned list; the pause toggle and the pause
 * CLI; and the `borrowed` field of GET /local-verify.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { makeHelperClient } from '../../src/localVerify/borrowedClient.js';
import { BorrowedShadow } from '../../src/localVerify/BorrowedShadow.js';
import { LocalVerifyService } from '../../src/localVerify/LocalVerifyService.js';
import { finalContradictsProgress, parseHelperAnswer, parseHelperProgress, progressSupersedes, signHelperRequest, verifyHelperAnswer, verifyHelperProgress, verifyHelperStatus, type HelperSliceRequest } from '../../src/localVerify/helper/helperProtocol.js';
import type { HelperRuntime } from '../../src/localVerify/helper/helperWiring.js';
import { helperPauseAt, helperUninstallAt } from '../../src/commands/helper.js';
import { HEAD, UNIT_A, UNIT_B, helperRig, id32, machineKeys, pins, type HelperRig, sha, memoryTreeHash } from '../helpers/borrowedHelperFixture.js';
import { vitestReport } from '../helpers/fakeSandboxDriver.js';

const AUTH = 'test-token';
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-helper-routes.test.ts' });
});

function ctx(stateDir: string, helper: HelperRuntime | null, localVerify: LocalVerifyService | null = null): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify, localVerifyHelper: helper,
    startTime: new Date(),
  } as never;
}

async function serve(r: HelperRig | null, enabled = { value: true }, lv: LocalVerifyService | null = null): Promise<{ url: string; stateDir: string }> {
  const stateDir = r?.dir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvhr-')));
  if (!r) dirs.push(stateDir);
  const runtime: HelperRuntime = { get: () => (r && enabled.value ? r.svc : null), shutdown: () => r?.svc.shutdown() };
  const a = express();
  a.use(express.json({ limit: '8mb' }));
  a.use(authMiddleware(() => AUTH, 'echo'));
  a.use(createRoutes(ctx(stateDir, runtime, lv)));
  const s = http.createServer(a);
  servers.push(s);
  await new Promise((res) => s.listen(0, '127.0.0.1', () => res(null)));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, stateDir };
}

const H = { Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'echo' };
const target = (url: string) => ({ machineId: 'm_laptop', url });

describe('helper routes (integration, real HTTP)', () => {
  it('are absent (404) while the helper role is disabled, and still need the Bearer token', async () => {
    const none = await serve(null);
    for (const [m, p] of [['post', '/local-verify/helper-slice'], ['post', '/local-verify/helper-slice/cancel'], ['post', '/local-verify/helper-learned'], ['get', '/local-verify/helper-status'], ['post', '/local-verify/helper-pause']] as const) {
      expect((await request(none.url)[m](p).set(H).send({})).status, p).toBe(404);
    }
    const r = helperRig({}, dirs);
    const enabled = { value: false };
    const off = await serve(r, enabled);
    expect((await request(off.url).get('/local-verify/helper-status').set(H)).status).toBe(404);
    enabled.value = true;
    expect((await request(off.url).get('/local-verify/helper-status')).status).toBe(401);
    expect((await request(off.url).get('/local-verify/helper-status').set(H)).status).toBe(200);
  });

  it('refuses with reasons: unsigned, tunnel, expired, replayed, not on main', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    const unsigned: Partial<HelperSliceRequest> & { sig?: unknown } = { ...r.slice({ files: [], prepare: true }) };
    delete unsigned.sig;
    let res = await request(url).post('/local-verify/helper-slice').set(H).send(unsigned);
    expect([res.status, res.body.reason]).toEqual([401, 'unsigned']);
    res = await request(url).post('/local-verify/helper-slice').set({ ...H, 'cf-connecting-ip': '198.51.100.7' }).send(r.slice({ files: [], prepare: true }));
    expect([res.status, res.body.reason]).toEqual([403, 'tunnel']);
    res = await request(url).post('/local-verify/helper-slice').set(H).send(r.slice({ files: [], prepare: true, expiresAt: r.clock.t - 60_000 }));
    expect(res.body.reason).toBe('expired');
    const once = r.slice({ files: [], prepare: true });
    expect((await request(url).post('/local-verify/helper-slice').set(H).send(once)).status).toBe(202);
    expect((await request(url).post('/local-verify/helper-slice').set(H).send(once)).body.reason).toBe('replayed');
    r.github.onMain.set(HEAD, false);
    const r2 = helperRig({}, dirs);
    r2.github.onMain.set(HEAD, false);
    const s2 = await serve(r2);
    expect((await request(s2.url).post('/local-verify/helper-slice').set(H).send(r2.slice({ files: [], prepare: true }))).body.reason).toBe('base-not-merged');
  });

  it('refuses a waiting change with reasons over HTTP: a fork head, a moved head, GitHub unreachable, no dry run, a merge conflict, changed install inputs', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    const CHANGE = sha('1');
    r.trees.files[CHANGE] = { ...r.trees.files[HEAD], 'src/x.ts': 'export const x = 2;\n' };
    const ask = async () => request(url).post('/local-verify/helper-slice').set(H).send(r.slice({ baseSha: HEAD, headSha: CHANGE, files: [], prepare: true }));
    for (const [verdict, status, reason] of [['fork', 409, 'head-fork'], ['moved', 409, 'head-moved'], ['closed', 409, 'head-pr-closed'], ['unreachable', 503, 'head-unknown'], ['rate-limited', 503, 'head-rate-limited']] as const) {
      r.github.heads.set(CHANGE, verdict);
      const res = await ask();
      expect([res.status, res.body.state, res.body.reason], verdict).toEqual([status, 'refused', reason]);
    }
    r.github.heads.set(CHANGE, 'ours');
    let res = await ask();
    expect([res.status, res.body.reason]).toEqual([409, 'dry-run-not-done']);
    r.dryRunDone();
    r.trees.merges[`${HEAD}:${CHANGE}`] = 'conflict';
    expect((await ask()).status).toBe(202);
    for (let i = 0; i < 200 && r.tree(CHANGE, HEAD)?.state !== 'failed'; i++) await new Promise((x) => setTimeout(x, 5));
    res = await ask();
    expect([res.status, res.body.reason]).toEqual([409, 'merge-conflict']);
    // Another change, whose merge edits the package list.
    const r2 = helperRig({}, dirs);
    const s2 = await serve(r2);
    r2.dryRunDone();
    r2.github.heads.set(CHANGE, 'ours');
    r2.trees.files[CHANGE] = { ...r2.trees.files[HEAD], 'package.json': '{"name":"instar","version":"1.3.1903","dependencies":{"left-pad":"1.3.0","other":"1.0.0"}}' };
    const ask2 = async () => request(s2.url).post('/local-verify/helper-slice').set(H).send(r2.slice({ baseSha: HEAD, headSha: CHANGE, files: [], prepare: true }));
    expect((await ask2()).status).toBe(202);
    for (let i = 0; i < 200 && r2.tree(CHANGE, HEAD)?.state !== 'failed'; i++) await new Promise((x) => setTimeout(x, 5));
    res = await ask2();
    expect([res.status, res.body.reason]).toEqual([409, 'install-inputs-changed']);
    const st = await request(s2.url).get('/local-verify/helper-status').set(H);
    expect(st.body.lastRefusal).toMatchObject({ reason: 'install-inputs-changed' });
    expect(st.body.dryRun.records).toHaveLength(1);
  });

  it('prepare-then-poll, then a slice that is queued at once and whose signed answer comes through the signed status (through the real client)', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    const client = makeHelperClient(AUTH, 'echo');
    const run = id32();
    const prep = await client.slice(target(url), r.slice({ runAttemptId: run, files: [], prepare: true }), 10_000);
    expect(prep?.status).toBe(202);
    expect(parseHelperAnswer(prep?.body)?.state).toBe('preparing');
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      const st = await client.status(target(url));
      ready = st?.trees.find((t) => t.headSha === HEAD)?.state === 'ready';
      if (!ready) await new Promise((res) => setTimeout(res, 5));
    }
    expect(ready).toBe(true);
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed', 'passed'] }) };
    const sliceReq = r.slice({ runAttemptId: run, files: [UNIT_A] });
    const sl = await client.slice(target(url), sliceReq, 10_000);
    // The slice is accepted, queued and answered at once with its id.
    expect(sl?.status).toBe(202);
    const queued = parseHelperAnswer(sl?.body)!;
    expect([queued.state, queued.attemptId]).toEqual(['queued', sliceReq.attemptId]);
    expect(verifyHelperAnswer(queued, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    // Its last signed answer is read from the status answer, asked for this verify.
    let ans: ReturnType<typeof parseHelperAnswer> = null;
    for (let i = 0; i < 200 && !ans; i++) {
      const st = await client.status(target(url), undefined, { run, since: 0 });
      ans = st?.results.map((x) => parseHelperAnswer(x.answer)).find((a) => a?.attemptId === sliceReq.attemptId) ?? null;
      if (!ans) await new Promise((res) => setTimeout(res, 5));
    }
    if (!ans) throw new Error('the slice never answered');
    expect(ans.state).toBe('done');
    // The status answer itself is signed by the helper as a whole, over real HTTP.
    const raw = await request(url).get(`/local-verify/helper-status?run=${run}&since=0`).set(H);
    expect(verifyHelperStatus(raw.body, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(verifyHelperStatus({ ...raw.body, paused: true }, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBe('signature-bad');
    expect(raw.body.results.map((x: { seq: number }) => x.seq)).toEqual([1]);
    expect((await request(url).get(`/local-verify/helper-status?run=${run}&since=1`).set(H)).body.results).toEqual([]);
    expect(raw.body.progress).toBeNull();
    // The answer carries the hash of the merge tree the helper built itself.
    expect(ans.treeHash).toBe(memoryTreeHash(r.trees.files[HEAD]));
    expect(ans.perFile).toEqual([{ file: UNIT_A, tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, ms: 250, digest: expect.stringMatching(/^[0-9a-f]{64}$/), failedTests: [] }]);
    expect(verifyHelperAnswer(ans, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(verifyHelperAnswer({ ...ans, perFile: [{ ...ans.perFile[0], failed: 1 }] }, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBe('signature-bad');
    // A whole-run cancel keeps the prepared tree; saying the verify is over releases it.
    const c = await client.cancel(target(url), r.cancel(run));
    expect(c?.body).toMatchObject({ cancelled: true, removedTrees: [] });
    const over = await client.cancel(target(url), r.cancel(run, { verifyOver: true }));
    expect(over?.body).toMatchObject({ cancelled: true, removedTrees: [HEAD] });
  });

  it('signed progress over HTTP: the files finished so far, a rising sequence number and the request\'s ids, while the slice still runs', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    const run = id32();
    await r.prepareReady(run);
    let report!: (text: string, unhandled?: number) => void;
    let finish!: (x: { exitCode: number; resultText: string }) => void;
    r.driver.slice = (_files, _signal, progress) => new Promise((res) => { report = progress; finish = res; });
    const req = r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B] });
    expect((await request(url).post('/local-verify/helper-slice').set(H).send(req)).body.state).toBe('queued');
    for (let i = 0; i < 200 && !report; i++) await new Promise((res) => setTimeout(res, 5));
    report(vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }));
    const p1 = parseHelperProgress((await request(url).get('/local-verify/helper-status').set(H)).body.progress)!;
    expect(p1).toMatchObject({ kind: 'progress', attemptId: req.attemptId, runAttemptId: run, lane: 'unit', treeHash: memoryTreeHash(r.trees.files[HEAD]), seq: 1, unhandledErrors: 0 });
    expect(p1.files.map((f) => f.file)).toEqual([UNIT_A]);
    expect(verifyHelperProgress(p1, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    report(vitestReport(r.driver.root, { [UNIT_B]: ['passed'] }));
    const p2 = parseHelperProgress((await request(url).get('/local-verify/helper-status').set(H)).body.progress)!;
    expect(p2.seq).toBe(2);
    expect(progressSupersedes(p1, p2)).toBe(true);
    finish({ exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'], [UNIT_B]: ['passed'] }) });
    const last = (await r.svc.whenSliceAnswered(req.attemptId))!;
    expect(last.state).toBe('done');
    expect(finalContradictsProgress(p2.files, last)).toBeNull();
  });

  it('lanes over HTTP: an integration and an e2e slice are accepted and run; a per-slice cancel dequeues only the named slice', async () => {
    const r = helperRig({}, dirs);
    const INTEG = 'tests/integration/routes-alive.test.ts';
    const E2E = 'tests/e2e/lifecycle-alive.test.ts';
    for (const f of [INTEG, E2E]) r.trees.files[HEAD][f] = "import { it } from 'vitest';\nit('x', () => {});\n";
    const { url } = await serve(r);
    const run = id32();
    await r.prepareReady(run);
    let release!: () => void;
    r.driver.slice = (files) => new Promise((res) => { release = () => res({ exitCode: 0, resultText: vitestReport(r.driver.root, { [files[0]]: ['passed'] }) }); });
    const a = r.slice({ runAttemptId: run, lane: 'integration', files: [INTEG], budgetMs: 60_000 });
    const b = r.slice({ runAttemptId: run, lane: 'e2e', files: [E2E], budgetMs: 60_000 });
    const c = r.slice({ runAttemptId: run, lane: 'unit', files: [UNIT_A] });
    for (const q of [a, b, c]) expect((await request(url).post('/local-verify/helper-slice').set(H).send(q)).body.state).toBe('queued');
    // A budget above the lane's is refused with its reason.
    expect((await request(url).post('/local-verify/helper-slice').set(H).send(r.slice({ runAttemptId: run, lane: 'unit', files: [UNIT_B], budgetMs: 60_000 }))).body.reason).toBe('budget-over-limit');
    const cancel = await request(url).post('/local-verify/helper-slice/cancel').set(H).send(r.cancel(run, { attemptIds: [b.attemptId] }));
    expect(cancel.body).toEqual({ cancelled: true, stopped: false, dequeued: 1, removedTrees: [] });
    for (let i = 0; i < 200 && !release; i++) await new Promise((res) => setTimeout(res, 5));
    release();
    expect((await r.svc.whenSliceAnswered(a.attemptId))?.state).toBe('done');
    for (let i = 0; i < 200 && r.driver.runs.length < 2; i++) await new Promise((res) => setTimeout(res, 5));
    release();
    expect((await r.svc.whenSliceAnswered(c.attemptId))?.state).toBe('done');
    expect((await r.svc.whenSliceAnswered(b.attemptId))?.state).toBe('cancelled');
    expect(r.driver.runs.map((x) => [x.lane, x.workers])).toEqual([['integration', 1], ['unit', 8]]);
  });

  it('helper-learned is signed-only from the pinned requester and keyed by tree hash; helper-status serves the list and, per lane, the files compared on', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    const stranger = machineKeys('m_stranger');
    const forged = signHelperRequest(stranger.signer, { kind: 'learned', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_stranger', helperMachineId: 'm_laptop', treeHash: memoryTreeHash(r.trees.files[HEAD]), expiresAt: r.clock.t + 30_000, observations: [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }] });
    const bad = await request(url).post('/local-verify/helper-learned').set(H).send(forged);
    expect([bad.status, bad.body.reason]).toEqual([401, 'requester-not-pinned']);
    // The first design's body (a commit, a source per observation) is refused as malformed.
    const v1 = await request(url).post('/local-verify/helper-learned').set(H).send({ ...r.learned(id32(), []), observations: [{ file: UNIT_A, kind: 'differ', source: 'dry-run' }] });
    expect([v1.status, v1.body.reason]).toEqual([400, 'invalid-request']);
    const ok = await request(url).post('/local-verify/helper-learned').set(H).send(r.learned(id32(), [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }, { file: UNIT_B, kind: 'agree' }]));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, compared: 1 });
    const st = await request(url).get('/local-verify/helper-status?compared=unit').set(H);
    expect(st.body.learned.entries.map((e: { file: string; reason: string }) => [e.file, e.reason])).toEqual([[UNIT_A, 'confirmed-wrong-pass']]);
    expect(st.body.compared.unit.count).toBe(1);
    expect(st.body.comparedFiles).toEqual({ lane: 'unit', files: [UNIT_B] });
    expect(st.body.runnerVersion).toBe('hr1:runner-one');
    expect(st.body).toMatchObject({ enabled: true, paused: false, helperVersion: '1.3.1903' });
  });

  it('the pause toggle and the pause CLI pause and resume the helper; uninstall goes through the driver seam', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    expect((await request(url).post('/local-verify/helper-pause').set(H).send({ paused: 'yes' })).status).toBe(400);
    expect((await request(url).post('/local-verify/helper-pause').set(H).send({ paused: true })).body).toEqual({ paused: true });
    expect((await request(url).post('/local-verify/helper-slice').set(H).send(r.slice({ files: [], prepare: true }))).body.reason).toBe('paused');
    await helperPauseAt(r.dir, false);
    expect((await request(url).get('/local-verify/helper-status').set(H)).body.paused).toBe(false);
    await helperPauseAt(r.dir, true);
    expect(r.svc.paused()).toBe(true);
    fs.writeFileSync(path.join(r.dir, 'config.json'), JSON.stringify({ monitoring: { localVerify: { helper: { enabled: true }, enabled: false } } }));
    expect((await helperUninstallAt(r.dir, r.driver, false)).join('\n')).toContain('--yes');
    expect(r.driver.calls).not.toContain('uninstall');
    await helperUninstallAt(r.dir, r.driver, true);
    expect(r.driver.calls).toContain('uninstall');
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'config.json'), 'utf-8')).monitoring.localVerify).toEqual({ enabled: false });
  });

  it('GET /local-verify carries the borrowed shadow summary', async () => {
    const r = helperRig({}, dirs);
    const lv = new LocalVerifyService({
      repo: 'JKHeadley/instar', stateDir: r.dir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/x/runVerifyMain.js', remoteUrl: 'https://github.com/JKHeadley/instar.git',
      machineId: 'm_studio', nodeVersion: 'v24', protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
    }, {
      prView: async () => null, isPrOpen: async () => true, spawnRun: () => ({ pid: 1, exited: new Promise(() => {}) }),
      isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [], setTimer: () => {},
    });
    lv.setMainRunObserver(new BorrowedShadow({
      config: () => ({ mode: 'practice', helpers: [{ machineId: 'm_laptop', url: 'http://100.64.0.9:4042' }] }),
      client: makeHelperClient(AUTH, 'echo'), signer: r.requester.signer, keyLookup: () => pins(r.helperKeys), machineId: 'm_studio', stateDir: r.dir, version: 'v', localWorkers: 4,
      unitFiles: async () => [], treeReader: () => ({ read: async () => null }), localUnitReport: async () => null, audit: () => {},
    }));
    const { url } = await serve(r, { value: true }, lv);
    const res = await request(url).get('/local-verify').set(H);
    expect(res.status).toBe(200);
    expect(res.body.borrowed).toMatchObject({ mode: 'practice', helpers: [{ machineId: 'm_laptop', lastShadow: null }] });
    lv.shutdown();
  });
});
