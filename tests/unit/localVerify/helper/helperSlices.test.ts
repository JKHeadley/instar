// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: how a helper runs slices (docs/specs/local-verify-borrowed-slices-count.md, E, D and the
 * related Build decisions), on a FakeSandboxDriver, fake GitHub, in-memory trees and a fixed clock.
 * Nothing real runs.
 *
 *  - lanes: unit, integration and e2e, each with its own worker rule and budget;
 *  - the queue: accepted and answered at once; check slice first, then counted, then compare-only;
 *  - per-slice cancel; a whole-run cancel; the prepared tree kept until `verifyOver` or 10 minutes;
 *  - signed progress, its sequence number, a hand-back that keeps finished files, a last answer
 *    that would contradict progress;
 *  - the learned request keyed by tree hash, the runner version, and the "compared on" record;
 *  - the start-up checks' named reasons, the package volume and the host-disk margin;
 *  - the signed status answer and the "I am here" request.
 */
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import {
  HELPER_LIMITS, finalContradictsProgress, parseHelperAnswer, parseHelperHere, parseHelperProgress, progressSupersedes, verifyHelperAnswer, verifyHelperHere, verifyHelperProgress, verifyHelperStatus,
  type HelperHereRequest, type HelperProgressAnswer, type HelperSliceAnswer,
} from '../../../../src/localVerify/helper/helperProtocol.js';
import { HelperDryRunStore, dryRunLaneProven } from '../../../../src/localVerify/helper/dryRunRecord.js';
import { HelperComparedStore, comparedDigest } from '../../../../src/localVerify/helper/comparedFiles.js';
import { PKG_VOLUME_MISSING_EXIT, SANDBOX_PROPERTY_CHECKS } from '../../../../src/localVerify/helper/sandboxDriver.js';
import { parseStatusQuery } from '../../../../src/localVerify/helper/helperRoutes.js';
import { HEAD, UNIT_A, UNIT_B, UNIT_SCAN, helperRig, id32, memoryTreeHash, pins, sha, type HelperRig } from '../../../helpers/borrowedHelperFixture.js';
import { vitestReport } from '../../../helpers/fakeSandboxDriver.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperSlices.test.ts' }); });

const body = (a: { body: unknown }) => a.body as HelperSliceAnswer & { reason?: string; state: string };
const tick = (ms = 15) => new Promise((res) => setTimeout(res, ms));
const CANARY = 'tests/fixtures/borrowed-canary/canary-pass.test.ts';
const INTEG = 'tests/integration/routes-alive.test.ts';
const INTEG_B = 'tests/integration/second-routes.test.ts';
const E2E = 'tests/e2e/lifecycle-alive.test.ts';
const GB = 1024 ** 3;

/** A rig whose merged commit also has integration, e2e and check-slice files. */
function rig(over: Parameters<typeof helperRig>[0] = {}, opts: Parameters<typeof helperRig>[2] = {}): HelperRig {
  const r = helperRig(over, dirs, opts);
  for (const f of [CANARY, INTEG, INTEG_B, E2E]) r.trees.files[HEAD][f] = "import { it } from 'vitest';\nit('x', () => {});\n";
  return r;
}
const passing = (r: HelperRig, files: string[]) => vitestReport(r.driver.root, Object.fromEntries(files.map((f) => [f, ['passed'] as Array<'passed'>])));

/** A driver slice that waits to be released, one call at a time; `order` records what ran. */
function gated(r: HelperRig) {
  const order: string[][] = [];
  const releases: Array<() => void> = [];
  r.driver.slice = (files, signal) => new Promise((res) => {
    order.push([...files]);
    const rel = (): void => res({ exitCode: 0, resultText: passing(r, files) });
    releases.push(rel);
    // A stopped slice is no longer waiting to be released.
    signal.addEventListener('abort', () => { const i = releases.indexOf(rel); if (i >= 0) releases.splice(i, 1); res({ exitCode: null }); }, { once: true });
  });
  // Release the slice that is running now (waiting, at most 2 s, for the next one to have started).
  return { order, release: async () => { for (let i = 0; i < 400 && releases.length === 0; i++) await tick(5); releases.shift()?.(); await tick(); } };
}

describe('lanes', () => {
  it('runs each lane as its own: a unit slice with the workers the governor allows, integration and e2e slices with one', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = { exitCode: 0, resultText: passing(r, [UNIT_A]) };
    expect(body(await r.send(r.slice({ runAttemptId: run, lane: 'unit', files: [UNIT_A] }))).state).toBe('done');
    r.driver.slice = { exitCode: 0, resultText: passing(r, [INTEG]) };
    expect(body(await r.send(r.slice({ runAttemptId: run, lane: 'integration', files: [INTEG], budgetMs: 60_000 }))).state).toBe('done');
    r.driver.slice = { exitCode: 0, resultText: passing(r, [E2E]) };
    const e2e = body(await r.send(r.slice({ runAttemptId: run, lane: 'e2e', files: [E2E], budgetMs: 60_000 })));
    expect([e2e.state, e2e.lane]).toEqual(['done', 'e2e']);
    // Workers: min(cpus 8, 16 − reserve 4 − owner (2 − 0.5)) = 8 for unit; one for the other two.
    expect(r.driver.runs).toEqual([
      { lane: 'unit', workers: 8, files: [UNIT_A] },
      { lane: 'integration', workers: 1, files: [INTEG] },
      { lane: 'e2e', workers: 1, files: [E2E] },
    ]);
  });

  it('a file of another lane is refused in each direction, and the check-slice fixtures ride any lane', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const ask = async (lane: 'unit' | 'integration' | 'e2e', files: string[], use: 'check' | 'compare' = 'compare') => body(await r.send(r.slice({ runAttemptId: run, lane, files, use })));
    expect((await ask('integration', [UNIT_A])).reason).toBe('file-wrong-lane');
    expect((await ask('unit', [INTEG])).reason).toBe('file-wrong-lane');
    expect((await ask('e2e', [INTEG])).reason).toBe('file-wrong-lane');
    expect((await ask('integration', [E2E])).reason).toBe('file-wrong-lane');
    r.driver.slice = { exitCode: 0, resultText: passing(r, [CANARY]) };
    for (const lane of ['unit', 'integration', 'e2e'] as const) expect((await ask(lane, [CANARY], 'check')).state, lane).toBe('done');
    // The check slice of an integration request still runs as that lane (one worker).
    expect(r.driver.runs.map((x) => [x.lane, x.workers])).toEqual([['unit', 8], ['integration', 1], ['e2e', 1]]);
  });

  it('a slice states its budget, and it is at most its lane\'s: 10 s for unit, 60 s for integration and e2e', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = { exitCode: 0, resultText: null };
    const ask = async (lane: 'unit' | 'integration' | 'e2e', file: string, budgetMs: number) => body(await r.send(r.slice({ runAttemptId: run, lane, files: [file], budgetMs })));
    expect((await ask('unit', UNIT_A, 10_000)).state).toBe('done');
    expect((await ask('unit', UNIT_A, 10_001)).reason).toBe('budget-over-limit');
    expect((await ask('integration', INTEG, 60_000)).state).toBe('done');
    expect((await ask('integration', INTEG, 60_001)).reason).toBe('budget-over-limit');
    expect((await ask('e2e', E2E, 60_000)).state).toBe('done');
    expect((await ask('e2e', E2E, 60_001)).reason).toBe('budget-over-limit');
  });
});

describe('the queue', () => {
  it('serves the check slice first, then slices whose results will be used, then compare-only slices, each class in order of arrival', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const g = gated(r);
    // One slice is running, so everything after it waits.
    const first = r.slice({ runAttemptId: run, files: [UNIT_SCAN], use: 'compare' });
    expect(body(await r.svc.handleSlice(first, r.route)).state).toBe('queued');
    await tick();
    const send = async (files: string[], use: 'check' | 'count' | 'compare', lane: 'unit' | 'integration' = 'unit') => {
      const req = r.slice({ runAttemptId: run, lane, files, use, budgetMs: 10_000 });
      const a = await r.svc.handleSlice(req, r.route);
      expect([a.status, body(a).state]).toEqual([202, 'queued']);
      return req.attemptId;
    };
    const c1 = await send([UNIT_A], 'compare');
    const n1 = await send([UNIT_B], 'count');
    const c2 = await send([INTEG], 'compare', 'integration');
    const k = await send([CANARY], 'check');
    const n2 = await send([INTEG_B], 'count', 'integration');
    // The status answer lists what waits, in the order it will be served.
    expect((r.svc.status().queue as Array<{ attemptId: string; use: string }>).map((q) => [q.attemptId, q.use])).toEqual([[k, 'check'], [n1, 'count'], [n2, 'count'], [c1, 'compare'], [c2, 'compare']]);
    for (let i = 0; i < 6; i++) await g.release();
    expect(g.order).toEqual([[UNIT_SCAN], [CANARY], [UNIT_B], [INTEG_B], [UNIT_A], [INTEG]]);
    for (const id of [first.attemptId, c1, n1, c2, k, n2]) expect((await r.svc.whenSliceAnswered(id))?.state, id).toBe('done');
    expect(r.svc.status().queue).toEqual([]);
  });

  it('holds at most 200 waiting slices: the 201st is refused queue-full, and room comes back as they are served', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const g = gated(r);
    await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route); // running
    await tick();
    for (let i = 0; i < HELPER_LIMITS.maxQueuedSlices; i++) {
      const a = await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route);
      expect(body(a).state, String(i)).toBe('queued');
    }
    const over = await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route);
    expect([over.status, body(over).reason]).toEqual([409, 'queue-full']);
    await g.release(); // the running one ends; the first waiting one starts
    expect(body(await r.svc.handleSlice(r.slice({ runAttemptId: run }), r.route)).state).toBe('queued');
    await r.svc.handleCancel(r.cancel(run), r.route);
  });

  it('a per-slice cancel dequeues only the named slices: the others still run, nothing is deleted', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const g = gated(r);
    const running = r.slice({ runAttemptId: run, files: [UNIT_SCAN] });
    await r.svc.handleSlice(running, r.route);
    await tick();
    const a = r.slice({ runAttemptId: run, files: [UNIT_A] });
    const b = r.slice({ runAttemptId: run, files: [UNIT_B] });
    await r.svc.handleSlice(a, r.route);
    await r.svc.handleSlice(b, r.route);
    // The right id under another run touches nothing.
    expect((await r.svc.handleCancel(r.cancel(id32(), { attemptIds: [a.attemptId] }), r.route)).body).toEqual({ cancelled: true, stopped: false, dequeued: 0, removedTrees: [] });
    const c = await r.svc.handleCancel(r.cancel(run, { attemptIds: [a.attemptId] }), r.route);
    expect(c.body).toEqual({ cancelled: true, stopped: false, dequeued: 1, removedTrees: [] });
    const cancelled = await r.svc.whenSliceAnswered(a.attemptId);
    expect([cancelled?.state, cancelled?.reason, cancelled?.perFile]).toEqual(['cancelled', 'cancelled', []]);
    expect(verifyHelperAnswer(cancelled!, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(r.svc.status().busy).toMatchObject({ kind: 'slice', attemptId: running.attemptId });
    await g.release();
    await g.release();
    expect(g.order).toEqual([[UNIT_SCAN], [UNIT_B]]);
    expect((await r.svc.whenSliceAnswered(b.attemptId))?.state).toBe('done');
    expect(r.tree()?.state).toBe('ready');
  });

  it('a whole-run cancel stops and dequeues that run\'s slices only; another run\'s slices on the same tree still run', async () => {
    const r = rig();
    const runA = id32();
    const runB = id32();
    await r.prepareReady(runA);
    await r.prepareReady(runB); // the same merged commit: one tree, two verifies
    const g = gated(r);
    const a1 = r.slice({ runAttemptId: runA, files: [UNIT_SCAN] });
    const a2 = r.slice({ runAttemptId: runA, files: [UNIT_A] });
    const b1 = r.slice({ runAttemptId: runB, files: [UNIT_B] });
    await r.svc.handleSlice(a1, r.route);
    await tick();
    await r.svc.handleSlice(a2, r.route);
    await r.svc.handleSlice(b1, r.route);
    const c = await r.svc.handleCancel(r.cancel(runA), r.route);
    expect(c.body).toEqual({ cancelled: true, stopped: true, dequeued: 1, removedTrees: [] });
    expect((await r.svc.whenSliceAnswered(a1.attemptId))?.state).toBe('cancelled');
    expect((await r.svc.whenSliceAnswered(a2.attemptId))?.state).toBe('cancelled');
    await tick();
    await g.release();
    expect((await r.svc.whenSliceAnswered(b1.attemptId))?.state).toBe('done');
    expect(g.order).toEqual([[UNIT_SCAN], [UNIT_B]]);
  });

  it('when the owner needs the machine, everything still waiting goes back too; a slice that only ran out of its own time does not empty the queue', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = (_f, signal) => new Promise((res) => signal.addEventListener('abort', () => res({ exitCode: null }), { once: true }));
    const first = r.slice({ runAttemptId: run, files: [UNIT_SCAN] });
    const second = r.slice({ runAttemptId: run, files: [UNIT_A] });
    await r.svc.handleSlice(first, r.route);
    await r.svc.handleSlice(second, r.route);
    // Both are accepted; now the owner's memory comes under pressure while the first one runs.
    r.owner.after = { n: r.owner.count + 1, sample: { ncpu: 16, hostBusyCores: 3, sandboxBusyCores: 1, memoryPressure: 'warn', onBattery: false } };
    expect((await r.svc.whenSliceAnswered(first.attemptId))?.state).toBe('handed-back');
    const back = await r.svc.whenSliceAnswered(second.attemptId);
    expect([back?.state, back?.reason]).toEqual(['owner-busy', 'memory-pressure']);
    expect(r.driver.runs).toHaveLength(1);
    // The other side: a slice past its own deadline is answered alone, and the next one runs.
    const g = rig();
    const run2 = id32();
    await g.prepareReady(run2);
    g.driver.slice = { exitCode: 0, resultText: passing(g, [UNIT_B]) };
    const late = g.slice({ runAttemptId: run2, files: [UNIT_A], deadlineAt: g.clock.t - 1 });
    const next = g.slice({ runAttemptId: run2, files: [UNIT_B] });
    await g.svc.handleSlice(late, g.route);
    await g.svc.handleSlice(next, g.route);
    expect([(await g.svc.whenSliceAnswered(late.attemptId))?.state, (await g.svc.whenSliceAnswered(late.attemptId))?.reason]).toEqual(['owner-busy', 'deadline']);
    expect((await g.svc.whenSliceAnswered(next.attemptId))?.state).toBe('done');
  });

  it('a pause hands back every waiting slice at once', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    r.driver.slice = (_f, signal) => new Promise((res) => signal.addEventListener('abort', () => res({ exitCode: null }), { once: true }));
    const first = r.slice({ runAttemptId: run, files: [UNIT_SCAN] });
    const second = r.slice({ runAttemptId: run, files: [UNIT_A] });
    await r.svc.handleSlice(first, r.route);
    await tick();
    await r.svc.handleSlice(second, r.route);
    await r.svc.setPaused(true, 'test');
    expect([(await r.svc.whenSliceAnswered(second.attemptId))?.state, (await r.svc.whenSliceAnswered(second.attemptId))?.reason]).toEqual(['owner-busy', 'paused']);
    expect([(await r.svc.whenSliceAnswered(first.attemptId))?.state, (await r.svc.whenSliceAnswered(first.attemptId))?.reason]).toEqual(['handed-back', 'paused']);
    expect(r.driver.runs).toHaveLength(1);
  });
});

describe('results through the signed status answer', () => {
  it('each finished slice\'s signed answer is listed with a rising sequence number; a reader asks for one verify, after the last it has, 20 at a time', async () => {
    const r = rig();
    const runA = id32();
    const runB = id32();
    await r.prepareReady(runA);
    await r.prepareReady(runB);
    r.driver.slice = { exitCode: 0, resultText: passing(r, [UNIT_A]) };
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) { const q = r.slice({ runAttemptId: runA }); ids.push(q.attemptId); await r.send(q); }
    const other = r.slice({ runAttemptId: runB });
    await r.send(other);
    type St = { results: Array<{ seq: number; answer: HelperSliceAnswer }>; resultsMore: boolean; resultSeq: number };
    const first = r.svc.status({ runAttemptId: runA }) as unknown as St;
    expect(first.results.map((x) => x.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(first.results.map((x) => x.answer.attemptId)).toEqual(ids.slice(0, 20));
    expect(first.resultsMore).toBe(true);
    expect(first.resultSeq).toBe(23);
    const rest = r.svc.status({ runAttemptId: runA, sinceSeq: 20 }) as unknown as St;
    expect(rest.results.map((x) => x.answer.attemptId)).toEqual(ids.slice(20));
    expect(rest.resultsMore).toBe(false);
    // Another verify's answers are its own.
    expect((r.svc.status({ runAttemptId: runB }) as unknown as St).results.map((x) => x.answer.attemptId)).toEqual([other.attemptId]);
    // Each listed answer is the slice's own signed answer, and parses strictly.
    for (const x of first.results) {
      expect(verifyHelperAnswer(x.answer, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
      expect(parseHelperAnswer(JSON.parse(JSON.stringify(x.answer)))?.state).toBe('done');
    }
  });

  it('the status answer is signed as a whole: it verifies for this helper, a changed field breaks it, and an old one is stale', async () => {
    const r = rig();
    const st = JSON.parse(JSON.stringify(r.svc.status())) as Record<string, unknown>;
    expect(st.at).toBe(r.clock.t);
    expect(st.runnerVersion).toBe('hr1:runner-one');
    expect(verifyHelperStatus(st, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(verifyHelperStatus({ ...st, paused: true }, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBe('signature-bad');
    expect(verifyHelperStatus(st, 'm_other', pins(r.helperKeys), r.clock.t)).toBe('signature-wrong-machine');
    const { sig: _sig, ...unsigned } = st;
    expect(verifyHelperStatus(unsigned, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBe('unsigned');
    // 90 s (a request's lifetime plus the clock tolerance) is still fresh; one millisecond more is a replay.
    expect(verifyHelperStatus(st, 'm_laptop', pins(r.helperKeys), r.clock.t + 90_000)).toBeNull();
    expect(verifyHelperStatus(st, 'm_laptop', pins(r.helperKeys), r.clock.t + 90_001)).toBe('stale');
  });
});

describe('the status request\'s query', () => {
  it('reads a run id, a sequence number and a lane strictly; a malformed value is ignored, never guessed at', () => {
    const run = 'a'.repeat(32);
    expect(parseStatusQuery({ run, since: '20', compared: 'integration' })).toEqual({ runAttemptId: run, sinceSeq: 20, comparedLane: 'integration' });
    expect(parseStatusQuery({})).toEqual({});
    expect(parseStatusQuery({ run: 'short', since: '-1', compared: 'contract' })).toEqual({});
    expect(parseStatusQuery({ run: [run], since: '1e3', compared: ['unit'] })).toEqual({});
    expect(parseStatusQuery({ since: '0' })).toEqual({ sinceSeq: 0 });
    expect(parseStatusQuery({ since: '9'.repeat(16) })).toEqual({});
  });
});

describe('progress', () => {
  /** A slice that reports each file as it "finishes" and then waits for `finish`. */
  function stepped(r: HelperRig) {
    let report!: (reportText: string, unhandled?: number) => void;
    let finish!: (res: { exitCode: number | null; resultText?: string | null; unhandledErrors?: number }) => void;
    r.driver.slice = (_files, signal, progress) => new Promise((res) => {
      report = progress;
      finish = res;
      signal.addEventListener('abort', () => res({ exitCode: null }), { once: true });
    });
    return { report: (t: string, u?: number) => report(t, u), finish: (x: Parameters<typeof finish>[0]) => finish(x) };
  }
  const progressOf = (r: HelperRig) => JSON.parse(JSON.stringify(r.svc.status().progress)) as HelperProgressAnswer | null;

  it('lists the files finished so far with the unhandled errors so far, a rising sequence number and the request\'s ids, signed', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const s = stepped(r);
    const req = r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B] });
    expect(r.svc.status().progress).toBeNull();
    await r.svc.handleSlice(req, r.route);
    await tick();
    const p0 = progressOf(r)!;
    expect(p0).toMatchObject({ kind: 'progress', attemptId: req.attemptId, runAttemptId: run, lane: 'unit', treeHash: memoryTreeHash(r.trees.files[HEAD]), seq: 0, files: [], unhandledErrors: 0 });
    s.report(passing(r, [UNIT_A]));
    const p1 = progressOf(r)!;
    expect(p1.seq).toBe(1);
    expect(p1.files.map((f) => [f.file, f.passed, f.failed])).toEqual([[UNIT_A, 1, 0]]);
    s.report(vitestReport(r.driver.root, { [UNIT_B]: ['passed', 'failed'] }), 1);
    const p2 = progressOf(r)!;
    expect([p2.seq, p2.unhandledErrors]).toEqual([2, 1]);
    expect(p2.files.map((f) => f.file)).toEqual([UNIT_A, UNIT_B]);
    // Signed under its own domain, and exactly what the run machine's strict parser accepts.
    for (const p of [p0, p1, p2]) {
      expect(verifyHelperProgress(p, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
      expect(parseHelperProgress(p)).not.toBeNull();
    }
    expect(verifyHelperProgress({ ...p1, seq: 9 }, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBe('signature-bad');
    // A reader keeps only a newer one of the same slice.
    expect(progressSupersedes(p1, p2)).toBe(true);
    expect(progressSupersedes(p2, p1)).toBe(false);
    expect(progressSupersedes(p2, p2)).toBe(false);
    // A file reported twice keeps its first result, and a repeat changes nothing (no new sequence number).
    s.report(vitestReport(r.driver.root, { [UNIT_A]: ['failed'] }));
    expect(progressOf(r)!.seq).toBe(2);
    expect(progressOf(r)!.files[0]).toMatchObject({ file: UNIT_A, passed: 1, failed: 0 });
    // A file the slice was not asked for never enters progress.
    s.report(passing(r, [UNIT_SCAN]));
    expect(progressOf(r)!.files.map((f) => f.file)).toEqual([UNIT_A, UNIT_B]);
    // The last answer repeats every result: nothing contradicts, and progress ends with the slice.
    s.finish({ exitCode: 1, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed'], [UNIT_B]: ['passed', 'failed'] }) });
    const last = (await r.svc.whenSliceAnswered(req.attemptId))!;
    expect(last.state).toBe('done');
    expect(finalContradictsProgress(p2.files, last)).toBeNull();
    // The unhandled error progress saw is in the last answer too, though the final report did not count it.
    expect(last.slice?.unhandledErrors).toBe(1);
    expect(r.svc.status().progress).toBeNull();
  });

  it('a hand-back keeps the files that finished: its answer repeats their results and lists nothing for the rest', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const s = stepped(r);
    const req = r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B, UNIT_SCAN] });
    await r.svc.handleSlice(req, r.route);
    await tick();
    s.report(passing(r, [UNIT_B]));
    const seen = progressOf(r)!;
    r.owner.after = { n: r.owner.count + 1, sample: { ncpu: 16, hostBusyCores: 3, sandboxBusyCores: 1, memoryPressure: 'warn', onBattery: false } };
    const back = (await r.svc.whenSliceAnswered(req.attemptId))!;
    expect([back.state, back.reason]).toEqual(['handed-back', 'memory-pressure']);
    expect(back.requestedFiles).toEqual([UNIT_A, UNIT_B, UNIT_SCAN]);
    expect(back.perFile.map((p) => [p.file, p.passed])).toEqual([[UNIT_B, 1]]);
    expect(back.slice).toEqual({ exitCode: null, unhandledErrors: 0, collected: false, vitestStartMs: null });
    expect(back.progress).toBe(0.333);
    // The hand-back repeats what progress said, so those results may be used as provisional.
    expect(finalContradictsProgress(seen.files, back)).toBeNull();
    expect(verifyHelperAnswer(back, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(parseHelperAnswer(JSON.parse(JSON.stringify(back)))).not.toBeNull();
    expect(r.audits.some((a) => a.event === 'helper-handed-back' && a.finished === 1 && a.of === 3)).toBe(true);
  });

  it('a hand-back with nothing finished lists no file, and one that saw an unhandled error says so', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const s = stepped(r);
    const req = r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B] });
    await r.svc.handleSlice(req, r.route);
    await tick();
    s.report(passing(r, [UNIT_A]), 2);
    await r.svc.handleCancel(r.cancel(run, { attemptIds: [req.attemptId] }), r.route);
    const cancelled = (await r.svc.whenSliceAnswered(req.attemptId))!;
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.slice?.unhandledErrors).toBe(2);
    expect(cancelled.perFile.map((p) => p.file)).toEqual([UNIT_A]);
    const g = rig();
    const run2 = id32();
    await g.prepareReady(run2);
    stepped(g);
    const q = g.slice({ runAttemptId: run2, files: [UNIT_A] });
    await g.svc.handleSlice(q, g.route);
    await tick();
    await g.svc.handleCancel(g.cancel(run2, { attemptIds: [q.attemptId] }), g.route);
    const none = (await g.svc.whenSliceAnswered(q.attemptId))!;
    expect([none.perFile, none.progress]).toEqual([[], 0]);
  });

  it('a last answer that would contradict earlier progress is never sent: the slice is answered progress-contradicted with no file result', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const s = stepped(r);
    const req = r.slice({ runAttemptId: run, files: [UNIT_A, UNIT_B] });
    await r.svc.handleSlice(req, r.route);
    await tick();
    s.report(passing(r, [UNIT_A]));
    // The final report now says the file failed: progress and the last answer cannot both be true.
    s.finish({ exitCode: 1, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['failed'], [UNIT_B]: ['passed'] }) });
    const last = (await r.svc.whenSliceAnswered(req.attemptId))!;
    expect([last.state, last.reason, last.perFile, last.slice?.collected]).toEqual(['done', 'progress-contradicted', [], false]);
    expect(r.audits.some((a) => a.event === 'helper-progress-contradicted' && a.file === UNIT_A)).toBe(true);
    // The same for a file progress reported that the final report no longer lists.
    const g = rig();
    const run2 = id32();
    await g.prepareReady(run2);
    const s2 = stepped(g);
    const q = g.slice({ runAttemptId: run2, files: [UNIT_A, UNIT_B] });
    await g.svc.handleSlice(q, g.route);
    await tick();
    s2.report(passing(g, [UNIT_A]));
    s2.finish({ exitCode: 0, resultText: passing(g, [UNIT_B]) });
    expect((await g.svc.whenSliceAnswered(q.attemptId))?.reason).toBe('progress-contradicted');
    // The other side: a different run time for the same result is not a contradiction.
    const h = rig();
    const run3 = id32();
    await h.prepareReady(run3);
    const s3 = stepped(h);
    const q3 = h.slice({ runAttemptId: run3, files: [UNIT_A] });
    await h.svc.handleSlice(q3, h.route);
    await tick();
    s3.report(passing(h, [UNIT_A]));
    s3.finish({ exitCode: 0, resultText: JSON.stringify({ testResults: [{ name: `${h.driver.root}/${UNIT_A}`, status: 'passed', startTime: 1000, endTime: 9000, assertionResults: [{ title: 't0', status: 'passed', failureMessages: [] }] }] }) });
    const ok = (await h.svc.whenSliceAnswered(q3.attemptId))!;
    expect([ok.state, ok.reason, ok.perFile[0].ms]).toEqual(['done', undefined, 8000]);
  });
});

describe('the prepared tree outlives the verify briefly', () => {
  const treeStates = (r: HelperRig) => (r.svc.status().trees as Array<{ headSha: string; state: string }>).map((t) => [t.headSha, t.state]);

  it('is kept through a whole-run cancel, released when the run machine says the verify is over', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    await r.svc.handleCancel(r.cancel(run), r.route);
    expect(treeStates(r)).toEqual([[HEAD, 'ready']]);
    // The failing-direction request can still use it: a slice of the same verify is accepted and runs.
    r.driver.slice = { exitCode: 1, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['failed'] }) };
    expect(body(await r.send(r.slice({ runAttemptId: run }))).state).toBe('done');
    const over = await r.svc.handleCancel(r.cancel(run, { verifyOver: true }), r.route);
    expect((over.body as { removedTrees: string[] }).removedTrees).toEqual([HEAD]);
    expect(treeStates(r)).toEqual([]);
    expect(r.driver.removed).toContain(memoryTreeHash(r.trees.files[HEAD]));
    expect(r.audits.some((a) => a.event === 'helper-tree-released' && a.why === 'verify-over')).toBe(true);
    // Its finished answers go with it.
    expect((r.svc.status({ runAttemptId: run }).results as unknown[])).toEqual([]);
  });

  it('a tree two verifies use is released only when both are over', async () => {
    const r = rig();
    const runA = id32();
    const runB = id32();
    await r.prepareReady(runA);
    await r.prepareReady(runB);
    await r.svc.handleCancel(r.cancel(runA, { verifyOver: true }), r.route);
    expect(treeStates(r)).toEqual([[HEAD, 'ready']]);
    await r.svc.handleCancel(r.cancel(runB, { verifyOver: true }), r.route);
    expect(treeStates(r)).toEqual([]);
  });

  it('goes after 10 minutes with no request for it, not after 9; a request starts the 10 minutes again', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    r.clock.t += 9 * 60_000 + 59_000;
    await r.svc.tickIdle();
    expect(treeStates(r)).toEqual([[HEAD, 'ready']]);
    // A request for the tree (here: the same preparation asked again) resets its clock.
    await r.svc.handleSlice(r.slice({ runAttemptId: run, files: [], prepare: true }), r.route);
    r.clock.t += 9 * 60_000 + 59_000;
    await r.svc.tickIdle();
    expect(treeStates(r)).toEqual([[HEAD, 'ready']]);
    r.clock.t += 1_000;
    await r.svc.tickIdle();
    expect(treeStates(r)).toEqual([]);
    expect(r.audits.some((a) => a.event === 'helper-tree-released' && a.why === 'no-request-10-min')).toBe(true);
    expect(r.driver.removed).toContain(memoryTreeHash(r.trees.files[HEAD]));
  });

  it('a tree with a slice running or waiting is never released, whatever the clock or the run machine says', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const g = gated(r);
    const a = r.slice({ runAttemptId: run, files: [UNIT_A], deadlineAt: r.clock.t + 60 * 60_000 });
    await r.svc.handleSlice(a, r.route);
    await tick();
    r.clock.t += 11 * 60_000;
    await r.svc.tickIdle();
    expect(treeStates(r)).toEqual([[HEAD, 'ready']]);
    await g.release();
    expect((await r.svc.whenSliceAnswered(a.attemptId))?.state).toBe('done');
    // The slice's end counts as use: the 10 minutes start from there.
    await r.svc.tickIdle();
    expect(treeStates(r)).toEqual([[HEAD, 'ready']]);
  });

  it('a verify that ends before its lanes start cancels the preparation: nothing is left of it', async () => {
    const r = rig();
    let open!: () => void;
    r.driver.builderGate = new Promise<void>((res) => { open = res; });
    const run = id32();
    // The preparation request carries no files: it is sent when the verify starts.
    const prep = await r.svc.handleSlice(r.slice({ runAttemptId: run, files: [], prepare: true }), r.route);
    expect([prep.status, body(prep).state]).toEqual([202, 'preparing']);
    await tick(30);
    expect(r.svc.status().busy).toMatchObject({ kind: 'prep', runAttemptId: run });
    const c = await r.svc.handleCancel(r.cancel(run, { verifyOver: true }), r.route);
    expect((c.body as { stopped: boolean }).stopped).toBe(true);
    await tick(40);
    open();
    expect(treeStates(r)).toEqual([]);
    expect(r.svc.status().busy).toBeNull();
    expect(r.audits.some((a) => a.event === 'helper-prep-stopped' && a.stop === 'cancelled')).toBe(true);
    // Another verify's preparation is not touched by it.
    const g = rig();
    let open2!: () => void;
    g.driver.builderGate = new Promise<void>((res) => { open2 = res; });
    await g.svc.handleSlice(g.slice({ runAttemptId: id32(), files: [], prepare: true }), g.route);
    await tick(30);
    expect((await g.svc.handleCancel(g.cancel(id32(), { verifyOver: true }), g.route)).body).toMatchObject({ stopped: false });
    open2();
    await tick(40);
    expect(treeStates(g)).toEqual([[HEAD, 'ready']]);
  });
});

describe('the learned list and the compared-on record, through the signed learned request', () => {
  const learnedOf = (r: HelperRig) => (r.svc.status().learned as { entries: Array<{ file: string; reason: string; blob: string | null; treeHash: string; runnerVersion: string; retrialDue: boolean }>; candidates: number; runsSeen: number });
  const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

  it('is keyed by tree hash: the entry records that tree and the file\'s content in it', async () => {
    const r = rig();
    await r.prepareReady(id32());
    const tree = memoryTreeHash(r.trees.files[HEAD]);
    const ok = await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'digest-differs-both-pass' }], { treeHash: tree }), r.route);
    expect(ok.body).toMatchObject({ ok: true, results: [{ file: UNIT_A, result: 'added' }] });
    expect(learnedOf(r).entries).toMatchObject([{ file: UNIT_A, reason: 'digest-differs-both-pass', treeHash: tree, blob: sha1(r.trees.files[HEAD][UNIT_A]), runnerVersion: 'hr1:runner-one', retrialDue: false }]);
    // A request that still names a commit in the first design's field is malformed.
    const old = { ...r.learned(id32(), [{ file: UNIT_B, kind: 'agree' }]), headSha: HEAD } as Record<string, unknown>;
    expect(body(await r.svc.handleLearned(old, r.route)).reason).toBe('invalid-request');
    // A tree this helper does not hold: the observation still counts, with no content hash.
    await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_B, kind: 'confirmed-wrong-pass' }], { treeHash: sha('7') }), r.route);
    expect(learnedOf(r).entries.find((e) => e.file === UNIT_B)).toMatchObject({ reason: 'confirmed-wrong-pass', treeHash: sha('7'), blob: null });
  });

  it('each joining rule through the route: a helper failure needs two verifies in a row; a digest difference and a wrong pass need one', async () => {
    const r = rig();
    await r.prepareReady(id32());
    const post = async (run: string, file: string, kind: 'helper-failed-local-passed' | 'digest-differs-both-pass' | 'confirmed-wrong-pass' | 'agree') =>
      ((await r.svc.handleLearned(r.learned(run, [{ file, kind }]), r.route)).body as { results: Array<{ result: string }> }).results[0].result;
    expect(await post(id32(), UNIT_A, 'helper-failed-local-passed')).toBe('candidate');
    expect(learnedOf(r).candidates).toBe(1);
    expect(await post(id32(), UNIT_A, 'agree')).toBe('noop');
    expect(await post(id32(), UNIT_A, 'helper-failed-local-passed')).toBe('candidate');
    expect(await post(id32(), UNIT_A, 'helper-failed-local-passed')).toBe('added');
    expect(await post(id32(), UNIT_B, 'digest-differs-both-pass')).toBe('added');
    expect(await post(id32(), UNIT_SCAN, 'confirmed-wrong-pass')).toBe('added');
    expect(learnedOf(r).entries.map((e) => [e.file, e.reason]).sort()).toEqual([[UNIT_A, 'helper-failed-local-passed'], [UNIT_B, 'digest-differs-both-pass'], [UNIT_SCAN, 'confirmed-wrong-pass']].sort());
    // A listed file is refused in a slice; a trial (always compare-only) may name it; an agreeing trial takes it off.
    expect(body(await r.send(r.slice({ files: [UNIT_B] }))).reason).toBe('file-ineligible');
    expect(body(await r.send(r.slice({ files: [UNIT_B], retrial: true, use: 'count' as never }))).reason).toBe('invalid-request');
    r.driver.slice = { exitCode: 0, resultText: passing(r, [UNIT_B]) };
    expect(body(await r.send(r.slice({ files: [UNIT_B], retrial: true }))).state).toBe('done');
    expect(await post(id32(), UNIT_B, 'agree')).toBe('removed');
    expect(body(await r.send(r.slice({ files: [UNIT_B] }))).state).toBe('done');
  });

  it('a trial is due when the file\'s content changed in the newest prepared tree, and on every 10th verify', async () => {
    const r = rig();
    await r.prepareReady(id32());
    await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }]), r.route);
    expect(learnedOf(r).entries[0].retrialDue).toBe(false);
    // A newer merged commit in which the file was edited.
    r.trees.files[sha('b')][UNIT_A] = "import { it } from 'vitest';\nit('a, edited', () => {});\n";
    await r.prepareReady(id32(), sha('b'));
    expect(learnedOf(r).entries[0].retrialDue).toBe(true);
    // The other side: another file's edit does not make this one due.
    const g = rig();
    await g.prepareReady(id32());
    await g.svc.handleLearned(g.learned(id32(), [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }]), g.route);
    g.trees.files[sha('b')][UNIT_B] = '// edited\n';
    await g.prepareReady(id32(), sha('b'));
    expect(learnedOf(g).entries[0].retrialDue).toBe(false);
    // Every 10th verify: the entry was added at verify 1; 8 more are not enough, the 10th after it is.
    const h = rig();
    await h.prepareReady(id32());
    await h.svc.handleLearned(h.learned(id32(), [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }]), h.route);
    for (let i = 0; i < 9; i++) await h.svc.handleSlice(h.slice({ runAttemptId: id32(), files: [], prepare: true }), h.route);
    expect([learnedOf(h).runsSeen, learnedOf(h).entries[0].retrialDue]).toEqual([10, false]);
    await h.svc.handleSlice(h.slice({ runAttemptId: id32(), files: [], prepare: true }), h.route);
    expect([learnedOf(h).runsSeen, learnedOf(h).entries[0].retrialDue]).toEqual([11, true]);
  });

  it('a new runner version makes every listed file due a trial and starts the compared-on record over; Instar\'s release number does neither', async () => {
    const r = rig();
    await r.prepareReady(id32());
    await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'confirmed-wrong-pass' }, { file: UNIT_B, kind: 'agree' }]), r.route);
    expect(learnedOf(r).entries[0].retrialDue).toBe(false);
    expect((r.svc.status().compared as Record<string, { count: number }>).unit.count).toBe(1);
    r.svc.shutdown();
    // The same helper after a release that left its runner untouched: nothing moves.
    const sameRunner = rig({ helperVersion: '1.3.1950' }, { dir: r.dir });
    await sameRunner.prepareReady(id32());
    expect(learnedOf(sameRunner).entries[0].retrialDue).toBe(false);
    expect((sameRunner.svc.status().compared as Record<string, { count: number }>).unit.count).toBe(1);
    sameRunner.svc.shutdown();
    // The same helper with a changed runner: the trial is due, and nothing counts as compared.
    const newRunner = rig({ runnerVersion: 'hr1:runner-two' }, { dir: r.dir });
    await newRunner.prepareReady(id32());
    expect(newRunner.svc.status().runnerVersion).toBe('hr1:runner-two');
    expect(learnedOf(newRunner).entries[0].retrialDue).toBe(true);
    expect((newRunner.svc.status().compared as Record<string, { count: number }>).unit.count).toBe(0);
  });

  it('status reports, per lane, which files this helper has been compared on: only agreeing comparisons count, and the list comes on request', async () => {
    const r = rig();
    await r.prepareReady(id32());
    type Cmp = Record<'unit' | 'integration' | 'e2e', { count: number; digest: string }>;
    expect((r.svc.status().compared as Cmp).integration).toEqual({ count: 0, digest: comparedDigest([]) });
    const res = await r.svc.handleLearned(r.learned(id32(), [
      { file: INTEG, kind: 'agree' }, { file: E2E, kind: 'agree' }, { file: UNIT_A, kind: 'agree' },
      { file: INTEG_B, kind: 'helper-failed-local-passed' }, { file: UNIT_B, kind: 'digest-differs-both-pass' },
      { file: CANARY, kind: 'agree' }, // a check-slice fixture belongs to no lane
    ]), r.route);
    expect((res.body as { compared: number }).compared).toBe(3);
    const cmp = r.svc.status().compared as Cmp;
    expect(cmp).toEqual({
      unit: { count: 1, digest: comparedDigest([UNIT_A]) },
      integration: { count: 1, digest: comparedDigest([INTEG]) },
      e2e: { count: 1, digest: comparedDigest([E2E]) },
    });
    // A file that disagreed is still new to this helper.
    expect(r.svc.status()).not.toHaveProperty('comparedFiles');
    expect(r.svc.status({ comparedLane: 'integration' }).comparedFiles).toEqual({ lane: 'integration', files: [INTEG] });
    expect(r.svc.status({ comparedLane: 'unit' }).comparedFiles).toEqual({ lane: 'unit', files: [UNIT_A] });
    // It is the helper's own file, beside its learned list.
    expect(new HelperComparedStore(r.dir).files({ imageDigest: 'sha256:image-one', settingsHash: 'settings-one', runnerVersion: 'hr1:runner-one' }, 'e2e')).toEqual([E2E]);
    // A new pinned image: what was compared before says nothing about the helper as it is now.
    r.driver.image = { imageDigest: 'sha256:image-two', settingsHash: 'settings-one' };
    await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_B, kind: 'agree' }]), r.route);
    expect((r.svc.status().compared as Cmp).integration.count).toBe(0);
    expect(r.svc.status({ comparedLane: 'unit' }).comparedFiles).toEqual({ lane: 'unit', files: [UNIT_B] });
    // With an image the helper cannot name, nothing is recorded as compared.
    r.driver.image = null;
    const none = await r.svc.handleLearned(r.learned(id32(), [{ file: UNIT_A, kind: 'agree' }]), r.route);
    expect((none.body as { compared: number }).compared).toBe(0);
  });
});

describe('lane proven: the dry-run record stores the share of the lane\'s time that passed', () => {
  it('writes files, passed files, both times and the share; status says whether that proves the lane', async () => {
    const r = rig();
    const run = id32();
    await r.prepareReady(run);
    const dry = async (statuses: Record<string, Array<'passed' | 'failed'>>) => {
      r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, statuses) };
      return body(await r.send(r.slice({ runAttemptId: run, lane: 'integration', files: Object.keys(statuses), dryRun: true, budgetMs: 60_000 })));
    };
    // The integration lane here has two files; one passes and one fails, each 250 ms.
    expect((await dry({ [INTEG]: ['passed'] })).state).toBe('done');
    expect(new HelperDryRunStore(r.dir).get('integration')).toBeNull();
    await dry({ [INTEG_B]: ['passed', 'failed'] });
    const rec = new HelperDryRunStore(r.dir).get('integration')!;
    expect(rec).toMatchObject({ lane: 'integration', files: 2, passedFiles: 1, totalMs: 500, passedMs: 250, passedShare: 0.5 });
    expect(dryRunLaneProven(rec)).toBe(true);
    const st = (r.svc.status().dryRun as { records: Array<{ lane: string; passedShare: number; proven: boolean }> }).records;
    expect(st.map((x) => [x.lane, x.passedShare, x.proven])).toEqual([['integration', 0.5, true]]);
    expect(r.audits.some((a) => a.event === 'helper-dry-run-done' && a.lane === 'integration' && a.passedShare === 0.5 && a.proven === true)).toBe(true);
  });

  it('at least half proves a lane; just under half, or no time measured at all, does not', () => {
    expect(dryRunLaneProven({ passedShare: 0.5 })).toBe(true);
    expect(dryRunLaneProven({ passedShare: 0.4999 })).toBe(false);
    expect(dryRunLaneProven({ passedShare: 1 })).toBe(true);
    expect(dryRunLaneProven({ passedShare: 0 })).toBe(false);
    expect(dryRunLaneProven({ passedShare: null })).toBe(false);
    expect(dryRunLaneProven(null)).toBe(false);
  });

  it('a file that was not collected counts as not passed, and a file answered twice keeps its latest answer', () => {
    const r = rig();
    const store = new HelperDryRunStore(r.dir, () => r.clock.t);
    const image = { imageDigest: 'i', settingsHash: 's' };
    const lane = [INTEG, INTEG_B];
    expect(store.noteAnswered('integration', image, HEAD, [{ file: INTEG, ms: 900, passed: false }], lane)).toBeNull();
    expect(store.noteAnswered('integration', image, HEAD, [{ file: INTEG, ms: 300, passed: true }], lane)).toBeNull();
    const rec = store.noteAnswered('integration', image, HEAD, [{ file: INTEG_B, ms: 0, passed: false }], lane)!;
    expect(rec).toMatchObject({ files: 2, passedFiles: 1, totalMs: 300, passedMs: 300, passedShare: 1 });
    // No time measured at all: the share is unknown, which never proves a lane.
    const none = new HelperDryRunStore(rig().dir).noteAnswered('e2e', image, HEAD, [{ file: E2E, ms: 0, passed: false }], [E2E])!;
    expect([none.passedShare, dryRunLaneProven(none)]).toEqual([null, false]);
  });
});

describe('start-up checks, the package volume and the host disk', () => {
  it('a failed or unrunnable start-up check means the helper does not run, and the reason names the check', async () => {
    for (const [name, result] of [['testns-no-route-tailnet-listener', 'unrunnable'], ['testns-dummy-iface-present', 'fail'], ['tester-no-host-path-readable', 'fail'], ['builder-no-github-token', 'fail'], ['control-channel-env-clean', 'fail']] as const) {
      const r = rig();
      const bad = { ok: false, checks: [{ name, result }], reason: `${name}:${result}` };
      r.driver.checksQueue = [bad, bad];
      await r.svc.handleSlice(r.slice({ files: [], prepare: true }), r.route);
      await tick(40);
      expect(r.tree()?.reason, name).toBe('helper-containment-unproven');
      expect((r.svc.status().sandbox as { containment: { ok: boolean; reason: string } }).containment).toMatchObject({ ok: false, reason: `${name}:${result}` });
      expect(r.driver.calls.some((c) => c.startsWith('copyIn') || c.startsWith('install'))).toBe(false);
      expect(r.driver.running).toBe(false);
    }
    // The property checks are part of what every start must prove.
    expect(SANDBOX_PROPERTY_CHECKS).toEqual([
      'tester-no-host-path-readable', 'tester-no-github-token', 'tester-no-secret-store', 'tester-no-agent-socket',
      'builder-no-host-path-readable', 'builder-no-github-token', 'builder-no-secret-store', 'builder-no-agent-socket',
      'control-channel-env-clean',
    ]);
  });

  it('the start-up check is given only the digest of the helper\'s GitHub token, never the token', async () => {
    const token = 'ghp_' + 'a1B2'.repeat(10);
    const digest = crypto.createHash('sha256').update(token).digest('hex');
    const r = rig({ credentialDigests: () => [digest, 'not-a-digest'] });
    await r.prepareReady(id32());
    expect(r.driver.lastFacts).toEqual({ credentialDigests: [digest] });
    expect(JSON.stringify(r.driver.lastFacts)).not.toContain(token);
    // No token configured: the check still runs, with no digest.
    const g = rig();
    await g.prepareReady(id32());
    expect(g.driver.lastFacts).toEqual({ credentialDigests: [] });
  });

  it('a missing package volume has its own reason, package-volume-missing: nothing is installed or placed; with the volume there it prepares', async () => {
    const r = rig();
    r.driver.packageVolume = false;
    await r.svc.handleSlice(r.slice({ files: [], prepare: true }), r.route);
    await tick(40);
    expect(r.tree()?.reason).toBe('package-volume-missing');
    expect(r.driver.calls.some((c) => c.startsWith('install:') || c.startsWith('place:') || c.startsWith('pkg-verify'))).toBe(false);
    expect((r.svc.status().lastRefusal as { reason: string }).reason).toBe('package-volume-missing');
    expect(r.audits.some((a) => a.event === 'helper-prep-refused' && a.reason === 'package-volume-missing')).toBe(true);
    // Not remembered against the two commits: once the disk is attached the same request prepares.
    r.driver.packageVolume = true;
    await r.prepareReady(id32());
    expect(r.tree()?.state).toBe('ready');
    // The runner's own "volume missing" exit during an install reads the same, not as install-failed.
    const g = rig();
    g.driver.builderExit.install = PKG_VOLUME_MISSING_EXIT;
    await g.svc.handleSlice(g.slice({ files: [], prepare: true }), g.route);
    await tick(40);
    expect(g.tree()?.reason).toBe('package-volume-missing');
    const h = rig();
    h.driver.builderExit.install = 2;
    await h.svc.handleSlice(h.slice({ files: [], prepare: true }), h.route);
    await tick(40);
    expect(h.tree()?.reason).toBe('install-failed:2');
  });

  it('the host-disk margin counts the package disk\'s remaining growth too', async () => {
    // Sandbox disk: 30 GB cap − 1 GB used = 29 GB. Package disk: 12 GB cap − 2 GB used = 10 GB. Margin 5 GB: 44 GB needed.
    const prep = async (hostFreeGb: number, pkgFile: number | null) => {
      const r = rig();
      r.driver.pkgDiskCapBytes = 12 * GB;
      r.driver.pkgDiskFileBytes = pkgFile;
      r.hostFree.value = hostFreeGb * GB;
      await r.svc.handleSlice(r.slice({ files: [], prepare: true }), r.route);
      await tick(40);
      return r.tree();
    };
    expect((await prep(44, 2 * GB))?.state).toBe('ready');
    expect((await prep(43.99, 2 * GB))?.reason).toBe('host-disk-low');
    // A package disk whose size is not known counts as nothing written: its whole 12 GB may still grow (46 GB needed).
    expect((await prep(46, null))?.state).toBe('ready');
    expect((await prep(45.99, null))?.reason).toBe('host-disk-low');
    // A driver that keeps no package disk on the host counts the sandbox disk only (34 GB needed), as before.
    const r = rig();
    r.hostFree.value = 34 * GB;
    await r.prepareReady(id32());
  });
});

describe('"I am here"', () => {
  function withAnnounce(ok = true) {
    const sent: Array<{ url: string; body: HelperHereRequest }> = [];
    const r = rig({ announce: async (target, b) => { sent.push({ url: target.url, body: JSON.parse(JSON.stringify(b)) as HelperHereRequest }); return ok; } });
    return { r, sent };
  }

  it('is sent once, signed, to the pinned run machine when the service starts, and verifies only for that helper and that run machine', async () => {
    const { r, sent } = withAnnounce();
    r.svc.start();
    await tick();
    r.svc.shutdown();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('http://100.64.0.9:4042');
    const h = sent[0].body;
    expect(h).toMatchObject({ kind: 'here', helperMachineId: 'm_laptop', runMachineId: 'm_studio', why: 'start', at: r.clock.t, expiresAt: r.clock.t + 60_000, runnerVersion: 'hr1:runner-one' });
    expect(parseHelperHere(h)).not.toBeNull();
    expect(parseHelperHere({ ...h, extra: 1 })).toBeNull();
    expect(verifyHelperHere(h, 'm_laptop', 'm_studio', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(verifyHelperHere(h, 'm_laptop', 'm_m5', pins(r.helperKeys), r.clock.t)).toBe('wrong-run-machine');
    expect(verifyHelperHere({ ...h, why: 'wake' }, 'm_laptop', 'm_studio', pins(r.helperKeys), r.clock.t)).toBe('signature-bad');
    expect(verifyHelperHere(h, 'm_other', 'm_studio', pins(r.helperKeys), r.clock.t)).toBe('signature-wrong-machine');
    // Fresh for its 60 s plus the clock tolerance, then expired.
    expect(verifyHelperHere(h, 'm_laptop', 'm_studio', pins(r.helperKeys), r.clock.t + 90_000)).toBeNull();
    expect(verifyHelperHere(h, 'm_laptop', 'm_studio', pins(r.helperKeys), r.clock.t + 90_001)).toBe('expired');
    expect(r.audits.some((a) => a.event === 'helper-here' && a.why === 'start' && a.ok === true)).toBe(true);
  });

  it('is sent when the owner resumes the helper and when the machine wakes (the 60 s sweep was held 3 minutes); not on an ordinary sweep, and not while paused', async () => {
    const { r, sent } = withAnnounce();
    await r.svc.setPaused(true, 'test');
    expect(await r.svc.sayHere('start')).toBe(false);
    expect(sent).toHaveLength(0);
    await r.svc.setPaused(false, 'test');
    await tick();
    expect(sent.map((s) => s.body.why)).toEqual(['resume']);
    await r.svc.tickIdle();
    r.clock.t += 60_000;
    await r.svc.tickIdle();
    r.clock.t += 2 * 60_000 + 59_000;
    await r.svc.tickIdle();
    await tick();
    expect(sent.map((s) => s.body.why)).toEqual(['resume']);
    r.clock.t += 3 * 60_000;
    await r.svc.tickIdle();
    await tick();
    expect(sent.map((s) => s.body.why)).toEqual(['resume', 'wake']);
  });

  it('a run machine that cannot be reached is audited and nothing else happens; with no sender nothing is sent', async () => {
    const { r, sent } = withAnnounce(false);
    expect(await r.svc.sayHere('start')).toBe(false);
    expect(sent).toHaveLength(1);
    expect(r.audits.some((a) => a.event === 'helper-here' && a.ok === false)).toBe(true);
    const thrower = rig({ announce: async () => { throw new Error('unreachable'); } });
    expect(await thrower.svc.sayHere('wake')).toBe(false);
    const none = rig();
    expect(await none.svc.sayHere('start')).toBe(false);
    expect(none.audits.some((a) => a.event === 'helper-here')).toBe(false);
  });
});
