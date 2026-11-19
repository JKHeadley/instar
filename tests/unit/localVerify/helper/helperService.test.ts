// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the borrowed-machine helper service (docs/specs/local-verify-borrowed-unit-slices.md, B to E)
 * on a FakeSandboxDriver, fake GitHub, scriptable owner load and a fixed clock. Nothing real runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { verifyHelperAnswer, type HelperSliceAnswer } from '../../../../src/localVerify/helper/helperProtocol.js';
import { readHelperPaused } from '../../../../src/localVerify/helper/HelperService.js';
import { HEAD, UNIT_A, UNIT_B, UNIT_SCAN, UNIT_TMUX, helperRig, id32, machineKeys, pins, sha } from '../../../helpers/borrowedHelperFixture.js';
import { vitestReport } from '../../../helpers/fakeSandboxDriver.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperService.test.ts' }); });

const body = (a: { body: unknown }) => a.body as HelperSliceAnswer & { reason?: string; state: string };

describe('HelperService — admission', () => {
  it('answers 404 while disabled, and refuses through the tunnel', async () => {
    const r = helperRig({}, dirs);
    r.cfg.value = null;
    expect((await r.svc.handleSlice(r.slice(), r.route)).status).toBe(404);
    const r2 = helperRig({}, dirs);
    const t = await r2.svc.handleSlice(r2.slice(), { cfConnectingIp: '1.2.3.4', localAddress: '100.64.1.2' });
    expect(t.status).toBe(403);
    expect(body(t).reason).toBe('tunnel');
  });

  it('refuses unsigned, unpinned, expired and replayed requests, each with its reason', async () => {
    const r = helperRig({}, dirs);
    const unsigned = { ...r.slice() } as Record<string, unknown>;
    delete unsigned.sig;
    expect(body(await r.svc.handleSlice(unsigned, r.route)).reason).toBe('unsigned');
    const stranger = machineKeys('m_stranger');
    expect(body(await r.svc.handleSlice(r.slice({ requesterMachineId: 'm_stranger' }, stranger.signer), r.route)).reason).toBe('requester-not-pinned');
    expect(body(await r.svc.handleSlice(r.slice({ expiresAt: r.clock.t - 31_000 }), r.route)).reason).toBe('expired');
    expect(r.audits.some((a) => a.event === 'helper-refused-expired')).toBe(true);
    const once = r.slice({ files: [], prepare: true });
    expect((await r.svc.handleSlice(once, r.route)).status).toBe(202);
    expect(body(await r.svc.handleSlice(once, r.route)).reason).toBe('replayed');
  });

  it('refuses a commit that is not on main, and one GitHub cannot confirm', async () => {
    const r = helperRig({}, dirs);
    r.github.onMain.set(sha('e'), false);
    expect(body(await r.svc.handleSlice(r.slice({ headSha: sha('e'), files: [], prepare: true }), r.route)).reason).toBe('not-merged');
    expect(body(await r.svc.handleSlice(r.slice({ headSha: sha('f'), files: [], prepare: true }), r.route)).reason).toBe('merged-unknown');
  });

  it('refuses files that are missing, not unit tests, excluded, scan hits, or on the learned list (retrial bypasses at most 5)', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    const ask = async (files: string[], extra = {}) => body(await r.svc.handleSlice(r.slice({ runAttemptId: run, files, ...extra }), r.route));
    expect((await ask(['tests/unit/nope.test.ts'])).reason).toBe('file-missing');
    r.trees.files[HEAD]['tests/integration/x.test.ts'] = "it('x', () => {});";
    expect((await ask(['tests/integration/x.test.ts'])).reason).toBe('file-not-unit');
    const excluded = await ask([UNIT_TMUX]);
    expect(excluded.reason).toBe('file-ineligible');
    const scan = await ask([UNIT_SCAN]);
    expect(scan.reason).toBe('file-ineligible');
    expect(r.audits.some((a) => a.event === 'scan-hit' && a.matchedFile === UNIT_SCAN && a.pattern === 'homedir-call' && a.line === 2)).toBe(true);
    // Learned list: two paired differences from two runs add the file; then only a retrial may name it.
    await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'differ', source: 'paired' }]), r.route);
    await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'differ', source: 'paired' }]), r.route);
    expect((await ask([UNIT_A])).reason).toBe('file-ineligible');
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) };
    expect((await ask([UNIT_A], { retrial: true })).state).toBe('done');
  });

  it('a slice arriving while another runs is busy (one queue), not an error', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    let release!: () => void;
    r.driver.slice = () => new Promise((res) => { release = () => res({ exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) }); });
    const first = r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route);
    await new Promise((res) => setTimeout(res, 20));
    const second = body(await r.svc.handleSlice(r.slice({ runAttemptId: run, files: [UNIT_B] }), r.route));
    expect(second.state).toBe('busy');
    release();
    expect(body(await first).state).toBe('done');
  });

  it('paused refuses new work; no signer or no sandbox refuses too', async () => {
    const r = helperRig({}, dirs);
    await r.svc.setPaused(true, 'test');
    expect(readHelperPaused(r.dir)).toBe(true);
    expect(body(await r.svc.handleSlice(r.slice({ files: [], prepare: true }), r.route)).reason).toBe('paused');
    const n = helperRig({ signer: null }, dirs);
    expect(body(await n.svc.handleSlice(n.slice({ files: [], prepare: true }), n.route)).reason).toBe('no-signer');
    const d = helperRig({ driver: null }, dirs);
    expect(body(await d.svc.handleSlice(d.slice({ files: [], prepare: true }), d.route)).reason).toBe('no-sandbox');
  });
});

describe('HelperService — prepare and run', () => {
  it('prepares (fetch, copy, npm ci, build, seal, all under reaps), then runs a slice and answers signed per-file counts', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    expect(r.trees.fetched).toEqual([HEAD]);
    const c = r.driver.calls;
    expect(c.indexOf('reap')).toBeLessThan(c.findIndex((x) => x.startsWith('npm-ci')));
    expect(c.findIndex((x) => x.startsWith('npm-ci'))).toBeLessThan(c.findIndex((x) => x.startsWith('build')));
    expect(c.findIndex((x) => x.startsWith('build'))).toBeLessThan(c.findIndex((x) => x.startsWith('seal')));
    expect(c).toContain('checks');
    r.driver.slice = { exitCode: 1, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed', 'failed'], [UNIT_B]: ['passed', 'skipped'] }), vitestStartMs: 900 };
    const req = r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B] });
    const a = body(await r.svc.handleSlice(req, r.route));
    expect(a.state).toBe('done');
    expect(a.perFile).toEqual([
      { file: UNIT_A, tests: 2, passed: 1, failed: 1, skipped: 0, todo: 0, ms: 250 },
      { file: UNIT_B, tests: 2, passed: 1, failed: 0, skipped: 1, todo: 0, ms: 250 },
    ]);
    expect(a.slice).toEqual({ exitCode: 1, unhandledErrors: 0, collected: true, vitestStartMs: 900 });
    expect(a.requestedFiles).toEqual([UNIT_A, UNIT_B]);
    expect(verifyHelperAnswer(a, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    // Workers: min(cpus 8, 16 − reserve 4 − owner (2 − 0.5)) = 8, memory ceiling 8 GB → 8.
    expect(r.driver.lastWorkers).toBe(8);
    expect(r.driver.calls.filter((x) => x === 'reap').length).toBeGreaterThan(3);
  });

  it('a slice before the tree is ready is refused not-prepared; a file missing from the report is listed with zero tests (uncollected)', async () => {
    const r = helperRig({}, dirs);
    expect(body(await r.svc.handleSlice(r.slice(), r.route)).reason).toBe('not-prepared');
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'] }) };
    const a = body(await r.svc.handleSlice(r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B] }), r.route));
    expect(a.perFile.find((p) => p.file === UNIT_B)).toMatchObject({ tests: 0 });
    expect(a.slice?.collected).toBe(false);
  });

  it('keeps at most 2 prepared trees, evicting the least recently used, and cancel deletes a run\'s trees', async () => {
    const r = helperRig({}, dirs);
    const runs = [id32(), id32(), id32()];
    await r.prepareReady(runs[0], HEAD);
    r.clock.t += 1000;
    await r.prepareReady(runs[1], sha('b'));
    r.clock.t += 1000;
    await r.prepareReady(runs[2], sha('c'));
    const heads = (r.svc.status().trees as Array<{ headSha: string }>).map((t) => t.headSha).sort();
    expect(heads).toEqual([sha('b'), sha('c')].sort());
    expect(r.driver.removed.length).toBe(1);
    expect(r.audits.some((a) => a.event === 'helper-tree-evicted' && a.headSha === HEAD)).toBe(true);
    const c = await r.svc.handleCancel(r.cancel(runs[2]), r.route);
    expect((c.body as { removedTrees: string[] }).removedTrees).toEqual([sha('c')]);
  });

  it('refuses to prepare below the measured peak preparation size (disk-low) and without the host-disk margin (host-disk-low)', async () => {
    const r = helperRig({}, dirs);
    r.driver.freeBytes = 50 * 1024 ** 3;
    r.driver.freeBytesAfterPrep = 20 * 1024 ** 3; // the first preparation measures a 30 GB peak
    await r.prepareReady(id32(), HEAD);
    r.driver.freeBytes = 25 * 1024 ** 3;
    r.driver.freeBytesAfterPrep = null;
    await r.svc.handleSlice(r.slice({ headSha: sha('b'), files: [], prepare: true }), r.route);
    await new Promise((res) => setTimeout(res, 30));
    expect((r.svc.status().trees as Array<{ headSha: string; reason?: string }>).find((t) => t.headSha === sha('b'))?.reason).toBe('disk-low');
    // Host disk: 30 GB cap − 1 GB used = 29 GB growth + 5 GB margin = 34 GB needed.
    const h = helperRig({}, dirs);
    h.hostFree.value = 33 * 1024 ** 3;
    await h.svc.handleSlice(h.slice({ files: [], prepare: true }), h.route);
    await new Promise((res) => setTimeout(res, 30));
    expect((h.svc.status().trees as Array<{ reason?: string }>)[0]?.reason).toBe('host-disk-low');
  });

  it('a failed containment check recreates the sandbox and re-checks; still failing refuses helper-containment-unproven', async () => {
    const r = helperRig({}, dirs);
    const bad = { ok: false, checks: [{ name: 'config-no-mounts', result: 'fail' as const }], reason: 'config-no-mounts:fail' };
    r.driver.checksQueue = [bad, bad];
    await r.svc.handleSlice(r.slice({ files: [], prepare: true }), r.route);
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
    await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route);
    expect(r.driver.calls.filter((x) => x === 'reap').length).toBe(3);
    expect(r.driver.calls.slice(-2)).toEqual(['stop', 'start']);
    expect(r.audits.some((a) => a.event === 'helper-reap-restart')).toBe(true);
  });

  it('a result over 4 MB is refused whole and counted result-oversize', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = { exitCode: 0, oversize: { bytesSeen: 4 * 1024 * 1024 + 1 } };
    const a = body(await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route));
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
    const a = body(await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route));
    expect(a.state).toBe('handed-back');
    expect(a.reason).toBe('memory-pressure');
    expect(a.handBackMs).toBe(10);
    expect(r.driver.running).toBe(false);
    expect(r.audits.some((x) => x.event === 'helper-sandbox-stop' && x.why === 'memory-pressure')).toBe(true);
    // Hold-off: owner-busy until memory has stayed normal for 5 min.
    r.owner.after = null;
    const b = body(await r.svc.handleSlice(r.slice({ runAttemptId: run, files: [], prepare: true }), r.route));
    expect(b.state).toBe('owner-busy');
  });

  it('no spare cores (owner busy) answers owner-busy before running; battery stops unless stopOnBattery is off', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.owner.sampleValue = { ncpu: 16, hostBusyCores: 13, sandboxBusyCores: 0, memoryPressure: 'normal', onBattery: false };
    const a = body(await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route));
    expect(a.state).toBe('owner-busy');
    expect(a.reason).toBe('zero-workers');
    r.owner.sampleValue = { ncpu: 16, hostBusyCores: 1, sandboxBusyCores: 0, memoryPressure: 'normal', onBattery: true };
    expect(body(await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route)).reason).toBe('battery');
  });

  it('pause stops current work at once; cancel stops it too', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = (_f, signal) => new Promise((res) => signal.addEventListener('abort', () => res({ exitCode: null }), { once: true }));
    const p = r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route);
    await new Promise((res) => setTimeout(res, 10));
    await r.svc.setPaused(true, 'test');
    const a = body(await p);
    expect(a.state).toBe('handed-back');
    expect(a.reason).toBe('paused');
    await r.svc.setPaused(false, 'test');
    const q = r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route);
    await new Promise((res) => setTimeout(res, 10));
    await r.svc.handleCancel(r.cancel(run), r.route);
    expect(body(await q).state).toBe('cancelled');
  });

  it('the memory hold-off ends: idle samples while it holds, and normal memory for 5 min releases it', async () => {
    const r = helperRig({}, dirs);
    const run = id32();
    await r.prepareReady(run);
    r.owner.count = 0;
    r.owner.after = { n: 2, sample: { ncpu: 16, hostBusyCores: 3, sandboxBusyCores: 1, memoryPressure: 'warn', onBattery: false } };
    r.driver.slice = (_f, signal) => new Promise((res) => signal.addEventListener('abort', () => res({ exitCode: null }), { once: true }));
    expect(body(await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route)).reason).toBe('memory-pressure');
    r.owner.after = null; // memory is back to normal
    expect(body(await r.svc.handleSlice(r.slice({ files: [], prepare: true, headSha: sha('b') }), r.route)).state).toBe('owner-busy');
    r.clock.t += 5 * 60_000;
    await r.svc.sampleDuringHoldOff(); // the idle sampler's tick
    const after = await r.svc.handleSlice(r.slice({ files: [], prepare: true, headSha: sha('b') }), r.route);
    expect(after.status).toBe(202);
    expect(body(after).state).toBe('preparing');
  });

  it('owner first: a preparation or a slice samples the owner BEFORE the sandbox boots', async () => {
    const r = helperRig({}, dirs);
    r.owner.sampleValue = { ncpu: 16, hostBusyCores: 1, sandboxBusyCores: 0, memoryPressure: 'normal', onBattery: true };
    await r.svc.handleSlice(r.slice({ files: [], prepare: true }), r.route);
    await new Promise((res) => setTimeout(res, 30));
    expect((r.svc.status().trees as Array<{ reason?: string }>)[0]?.reason).toBe('owner-busy:battery');
    expect(r.driver.calls.filter((c) => c === 'start' || c === 'create')).toEqual([]);
    // A slice on a stopped sandbox: the battery answer comes without booting it.
    const g = helperRig({}, dirs);
    const run = id32();
    await g.prepareReady(run);
    g.clock.t += 16 * 60_000;
    await g.svc.tickIdle();
    g.driver.calls = [];
    g.owner.sampleValue = { ncpu: 16, hostBusyCores: 1, sandboxBusyCores: 0, memoryPressure: 'normal', onBattery: true };
    expect(body(await g.svc.handleSlice(g.slice({ runAttemptId: run }), g.route)).reason).toBe('battery');
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
      const sl = r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route);
      await new Promise((res) => setTimeout(res, 10));
      expect((await r.svc.handleSlice(r.slice({ files: [], prepare: true, headSha: sha('b') }), r.route)).status).toBe(202); // queued
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

describe('HelperService — learned list route and status', () => {
  it('helper-learned is signed-only (pinned requesters); status serves the list with its cap and incompatibility', async () => {
    const r = helperRig({}, dirs);
    const stranger = machineKeys('m_stranger');
    const bad = await r.svc.handleLearned({ ...r.learned(id32(), [{ file: UNIT_A, kind: 'differ', source: 'dry-run' }]), requesterMachineId: 'm_stranger', sig: stranger.signer.sign('x') }, r.route);
    expect(bad.status).toBe(401);
    await r.prepareReady(id32());
    const ok = await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'differ', source: 'dry-run' }]), r.route);
    expect((ok.body as { results: Array<{ result: string }> }).results[0].result).toBe('added');
    const st = r.svc.status() as { learned: { entries: Array<{ file: string; source: string }>; eligibleCount: number; incompatible: boolean } };
    expect(st.learned.entries.map((e) => [e.file, e.source])).toEqual([[UNIT_A, 'dry-run']]);
    expect(st.learned.eligibleCount).toBe(4);
    expect(st.learned.incompatible).toBe(false);
  });
});
