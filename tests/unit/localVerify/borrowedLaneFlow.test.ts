/**
 * The verify child's lane flow with a borrowed helper (docs/specs/local-verify-borrowed-slices-count.md, F):
 * the pure rules (what a pass is, the check slice, comparison, admission into a report, the share
 * allocation, the split among shards, baseline selection against git) and the session's take-back.
 */
import { describe, expect, it } from 'vitest';
import {
  BorrowedLaneFlow, LANE_FLOW, admitHelperPasses, allocateShare, checkSliceRight, compareFile, editsCheckFixtures, filesDigest,
  isCountablePass, laneShare, parsePlan, parseStatusFacts, selectVerifyBaseline, sliceTrouble, splitPortion,
  type HelperFileResult, type PlanFacts, type ProxyCall,
} from '../../../src/localVerify/borrowedLaneFlow.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from '../../../src/localVerify/borrowedCanary.js';
import type { FileCountsRow, MainBaseline } from '../../../src/localVerify/mainFileCounts.js';

const D = (c: string) => c.repeat(64);
const TREE = 'd'.repeat(40);
const pass = (file: string, digest = D('1'), over: Partial<HelperFileResult> = {}): HelperFileResult => ({ file, tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, ms: 100, digest, failedTests: [], ...over });
const row = (digest = D('1')): FileCountsRow => [2, 0, 0, 0, digest];

describe('what a pass is', () => {
  it('collected, at least one test, none failed, digest equal to the baseline row', () => {
    expect(isCountablePass(pass('a'), row(), false)).toBe(true);
    expect(isCountablePass(pass('a', D('2')), row(), false)).toBe(false);
    expect(isCountablePass(pass('a'), undefined, false)).toBe(false);
    expect(isCountablePass(pass('a', D('1'), { tests: 0, passed: 0 }), row(), false)).toBe(false);
    expect(isCountablePass(pass('a', D('1'), { failed: 1 }), row(), false)).toBe(false);
    expect(isCountablePass({ ...pass('a'), digest: null }, row(), false)).toBe(false);
  });
  it('a test file this change edits that reports any skip is never a pass', () => {
    expect(isCountablePass(pass('a', D('1'), { skipped: 1 }), row(), true)).toBe(false);
    expect(isCountablePass(pass('a', D('1'), { skipped: 1 }), row(), false)).toBe(true);
  });
});

describe('slice-level trouble discards the whole slice', () => {
  const facts = (o: Partial<{ exitCode: number | null; unhandledErrors: number; collected: boolean }> = {}) => ({ exitCode: 0, unhandledErrors: 0, collected: true, ...o });
  it('clean slices are fine; a failed file explains a non-zero exit', () => {
    expect(sliceTrouble({ slice: facts(), perFile: [pass('a')] })).toBe(false);
    expect(sliceTrouble({ slice: facts({ exitCode: 1 }), perFile: [pass('a', D('1'), { failed: 1 })] })).toBe(false);
  });
  it('no facts, an unhandled error, an unexplained exit, nothing collected', () => {
    expect(sliceTrouble({ slice: null, perFile: [pass('a')] })).toBe(true);
    expect(sliceTrouble({ slice: facts({ unhandledErrors: 1 }), perFile: [pass('a')] })).toBe(true);
    expect(sliceTrouble({ slice: facts({ exitCode: 1 }), perFile: [pass('a')] })).toBe(true);
    expect(sliceTrouble({ slice: facts({ collected: false }), perFile: [pass('a', D('1'), { tests: 0 })] })).toBe(true);
  });
});

describe('the check slice', () => {
  const right = () => ({
    valid: true, slice: { exitCode: 1, unhandledErrors: 1, collected: true },
    perFile: BORROWED_CANARY_FILES.map((f) => ({ ...pass(f), ...BORROWED_CANARY[f], tests: 1 })),
  });
  it('exactly right: every fixture with its known counts, and the unhandled rejection reported', () => {
    expect(checkSliceRight(right())).toBe(true);
  });
  it('a false green, a missing fixture, no unhandled error, or an invalid answer is wrong', () => {
    const r1 = right(); r1.perFile = r1.perFile.map((p) => (p.failed > 0 ? { ...p, failed: 0 } : p));
    expect(checkSliceRight(r1)).toBe(false);
    const r2 = right(); r2.perFile = r2.perFile.slice(1);
    expect(checkSliceRight(r2)).toBe(false);
    const r3 = right(); r3.slice = { ...r3.slice, unhandledErrors: 0 };
    expect(checkSliceRight(r3)).toBe(false);
    expect(checkSliceRight({ ...right(), valid: false })).toBe(false);
  });
});

describe('one comparison per file, against the final local result', () => {
  const local = (failed: number, digest: string | null = D('1'), failedTests: string[] = []) => ({ failed, digest, failedTests });
  const solo = (o: Partial<{ soloFailed: boolean; passedAlone: boolean }> = {}) => ({ soloFailed: false, passedAlone: false, ...o });
  it('both pass: agree on equal digests, otherwise a digest difference', () => {
    expect(compareFile(local(0), pass('a'), solo())).toBe('agreed');
    expect(compareFile(local(0), pass('a', D('2')), solo())).toBe('digest-differs-both-pass');
  });
  it('the helper failed where the run machine passed', () => {
    expect(compareFile(local(0), pass('a', D('2'), { failed: 1, failedTests: ['x'] }), solo())).toBe('helper-failed-local-passed');
  });
  it('a helper pass against a local failure: confirmed only when the file failed again alone; flaky when it passed alone', () => {
    expect(compareFile(local(1), pass('a'), solo({ soloFailed: true }))).toBe('confirmed-wrong-pass');
    expect(compareFile(local(1), pass('a'), solo())).toBe('unconfirmed');
    expect(compareFile(local(1), pass('a'), solo({ passedAlone: true }))).toBe('flaky');
  });
  it('the failing direction: at least one of the same tests failed on both sides; otherwise an environment difference', () => {
    expect(compareFile(local(1, null, ['t1', 't2']), pass('a', D('3'), { failed: 1, failedTests: ['t2'] }), solo())).toBe('failing-agreed');
    expect(compareFile(local(1, null, ['t1']), pass('a', D('3'), { failed: 1, failedTests: ['t9'] }), solo())).toBe('environment-difference');
    expect(compareFile(local(1, null, ['t1']), pass('a', null, { tests: 0, passed: 0 }), solo())).toBe('environment-difference');
  });
});

describe('admitHelperPasses: the one way a helper result enters a report', () => {
  it('adds passes for files the run machine did not run; a local result always wins; never a failure', () => {
    const report = { files: new Map([['tests/unit/a.test.ts', { passed: 0, failed: 1, skipped: 0, todo: 0 }]]) };
    const added = admitHelperPasses(report, new Map([
      ['tests/unit/a.test.ts', pass('tests/unit/a.test.ts')],
      ['tests/unit/b.test.ts', pass('tests/unit/b.test.ts', D('1'), { skipped: 1, passed: 1 })],
      ['tests/unit/c.test.ts', pass('tests/unit/c.test.ts', D('1'), { failed: 1 })],
    ]));
    expect(added).toEqual(['tests/unit/b.test.ts']);
    expect(report.files.get('tests/unit/a.test.ts')!.failed).toBe(1);
    expect(report.files.get('tests/unit/b.test.ts')).toEqual({ passed: 1, failed: 0, skipped: 1, todo: 0, ms: 100 });
    expect(report.files.has('tests/unit/c.test.ts')).toBe(false);
  });
});

describe('the share and its allocation', () => {
  it('no free workers means no share; never more than half', () => {
    expect(laneShare(0.25, 0)).toBe(0);
    expect(laneShare(0.25, 3)).toBe(0.25);
    expect(laneShare(0.9, null)).toBe(LANE_FLOW.maxShare);
  });
  it('gives work to the counting lane projected to finish last, within its share and before it ends', () => {
    const g = (n: number, ms: number) => Array.from({ length: n }, (_, i) => ({ files: [`f${ms}-${i}`], ms }));
    const alloc = allocateShare([
      { lane: 'integration', mode: 'count', groups: g(10, 10_000), localMs: 100_000, wallPerMs: 1 / 2, share: 0.25 },
      { lane: 'e2e', mode: 'count', groups: g(10, 10_000), localMs: 200_000, wallPerMs: 1 / 2, share: 0.25 },
    ], 1, 0);
    // e2e is projected to end last (100 s vs 50 s), so it gets groups first, up to its share (50 s of files).
    expect(alloc.get('e2e')!.length).toBeGreaterThan(alloc.get('integration')?.length ?? 0);
    expect(alloc.get('e2e')!.length * 10_000).toBeLessThanOrEqual(0.25 * 200_000);
  });
  it('the helper cannot be given more than it can finish before the lane is projected to end', () => {
    const alloc = allocateShare([{ lane: 'unit', mode: 'count', groups: [{ files: ['a'], ms: 1000 }, { files: ['b'], ms: 1000 }], localMs: 2000, wallPerMs: 1, share: 0.5 }], 0.1, 0);
    // 1000 ms of files is 10 s of helper time: more than the lane's remaining ~1 s.
    expect(alloc.get('unit')).toBeUndefined();
  });
  it('splits a counting lane\'s groups among its shards, largest to the lightest', () => {
    const portions = splitPortion([['a'], ['b'], ['c']], [100, 0], (f) => ({ a: 50, b: 40, c: 30 } as Record<string, number>)[f]);
    expect(portions[1]).toContain('a');
    expect(portions.flat().sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('parsing what the server passes on', () => {
  it('a plan with no answer or no assignment is no helper; malformed lanes are refused', () => {
    expect(parsePlan({ ok: false })).toBeNull();
    expect(parsePlan({ ok: true, helper: 'h', mode: 'count', assigned: 'counting', lanes: {} })).toBeNull();
  });
  it('status results keep only well-formed slices, and an invalid one carries no files', () => {
    const st = parseStatusFacts({ ok: true, tree: { state: 'ready', treeHash: TREE }, results: [
      { seq: 1, attemptId: 'a'.repeat(32), valid: true, state: 'done', treeHash: TREE, perFile: [pass('tests/unit/x.test.ts')], slice: { exitCode: 0, unhandledErrors: 0, collected: true } },
      { seq: 2, attemptId: 'b'.repeat(32), valid: false, state: 'done', treeHash: TREE, perFile: [pass('tests/unit/y.test.ts')], slice: null },
      { seq: 'x', attemptId: 'c' },
    ] });
    expect(st!.results.map((r) => [r.seq, r.valid, r.perFile.length])).toEqual([[1, true, 1], [2, false, 0]]);
    expect(st!.tree).toEqual({ state: 'ready', treeHash: TREE });
  });
});

describe('the baseline a verify may use, against the clone', () => {
  const MERGE = 'e'.repeat(40);
  const base = (commit: string, files: Record<string, FileCountsRow>): MainBaseline => ({ commit, finishedAt: '2026-11-20T00:00:00.000Z', machineId: 'm', files });
  it('the newest baseline that is the base or its ancestor; only files whose content is the same in the merge tree', async () => {
    const B1 = '1'.repeat(40); const B2 = '2'.repeat(40); const BASE = '3'.repeat(40);
    const git = async (args: string[]) => {
      if (args[0] === 'merge-base') return { status: args[2] === B1 ? 1 : 0, stdout: '' };
      if (args[0] === 'ls-tree' && args[2] === B2) return { status: 0, stdout: `100644 blob ${'a'.repeat(40)}\ttests/unit/same.test.ts\n100644 blob ${'b'.repeat(40)}\ttests/unit/edited.test.ts\n` };
      if (args[0] === 'ls-tree' && args[2] === MERGE) return { status: 0, stdout: `100644 blob ${'a'.repeat(40)}\ttests/unit/same.test.ts\n100644 blob ${'c'.repeat(40)}\ttests/unit/edited.test.ts\n` };
      return { status: 128, stdout: '' };
    };
    const sel = await selectVerifyBaseline([base(B1, { 'tests/unit/same.test.ts': row() }), base(B2, { 'tests/unit/same.test.ts': row(), 'tests/unit/edited.test.ts': row() })], BASE, MERGE, git);
    expect(sel.commit).toBe(B2);
    expect([...sel.rows.keys()]).toEqual(['tests/unit/same.test.ts']);
  });
  it('git failing means no rows', async () => {
    const sel = await selectVerifyBaseline([base('1'.repeat(40), { x: row() })], '3'.repeat(40), MERGE, async () => ({ status: null, stdout: '' }));
    expect(sel.rows.size).toBe(0);
  });
});

describe('the check fixtures', () => {
  it('a change that edits them (or an unreadable change list) sends no slices', () => {
    expect(editsCheckFixtures(new Set(['tests/fixtures/borrowed-canary/canary-pass.test.ts']))).toBe(true);
    expect(editsCheckFixtures(null)).toBe(true);
    expect(editsCheckFixtures(new Set(['src/x.ts']))).toBe(false);
  });
  it('the record\'s files digest is order-independent', () => {
    expect(filesDigest(['b', 'a'])).toBe(filesDigest(['a', 'b']));
    expect(filesDigest(['a'])).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── the session: take-back ──────────────────────────────────────────────

function plan(over: Partial<PlanFacts> = {}): PlanFacts {
  const lane = { state: 'counting', mayCount: true, proven: true, share: 0.5, uncovered: [] as string[] };
  return {
    helper: 'm_laptop', mode: 'count', assigned: 'counting', answered: true,
    lanes: { unit: { ...lane }, integration: { ...lane }, e2e: { ...lane } }, spotOneIn: 1_000_000, learned: [],
    throughput: 100, prepMs: 0, workersFree: 4, ...over,
  };
}

/** A fake proxy: slices are queued, and `answer` decides each slice's result (null: never answered). */
function fakeProxy(answer: (files: string[], use: string) => Record<string, unknown> | null) {
  let n = 0;
  const slices: Array<{ id: string; files: string[]; use: string }> = [];
  const cancelled: string[] = [];
  const call: ProxyCall = async (b) => {
    if (b.op === 'slice') {
      const id = (++n).toString(16).padStart(32, '0');
      slices.push({ id, files: b.files as string[], use: b.use as string });
      return { ok: true, attemptId: id, state: 'queued' };
    }
    if (b.op === 'cancel') { cancelled.push(...((b.attemptIds as string[]) ?? [])); return { ok: true }; }
    if (b.op === 'status') {
      const results = slices.flatMap((s, i) => { const a = answer(s.files, s.use); return a ? [{ seq: i + 1, attemptId: s.id, ...a }] : []; });
      return { ok: true, tree: { state: 'ready', treeHash: TREE }, results };
    }
    return null;
  };
  return { call, slices, cancelled };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const deps = (call: ProxyCall) => ({ call, now: () => 0, sleep: tick, log: () => {}, randomInt: () => 1 });
const FILES = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'];
/** A lane file with no baseline row: never sent to count, it keeps the helper's share at half the lane. */
const LOCAL_ONLY = 'tests/unit/c.test.ts';
const rightCheck = () => ({
  valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 1, unhandledErrors: 1, collected: true },
  perFile: BORROWED_CANARY_FILES.map((f) => ({ ...pass(f), ...BORROWED_CANARY[f], tests: 1 })),
});

async function session(answer: (files: string[], use: string) => Record<string, unknown> | null, rows = new Map(FILES.map((f) => [f, row()]))) {
  const px = fakeProxy(answer);
  const flow = new BorrowedLaneFlow(plan(), deps(px.call), TREE, rows, new Set());
  flow.planLanes([{ lane: 'unit', files: [...FILES, LOCAL_ONLY], procs: 1, balanced: true, firstPart: false, wallPerMs: 1 }], { [FILES[0]]: 1000, [FILES[1]]: 1000, [LOCAL_ONLY]: 2000 });
  flow.setPortions('unit', [0], {});
  flow.start(60_000);
  for (let i = 0; i < 20; i++) await tick();
  return { flow, px };
}

describe('take-back', () => {
  it('accepted passes are frozen and not taken back; the check slice is sent first', async () => {
    const { flow, px } = await session((files, use) => (use === 'check' ? rightCheck() : { valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 0, unhandledErrors: 0, collected: true }, perFile: files.map((f) => pass(f)) }));
    expect(px.slices[0].use).toBe('check');
    const back = await flow.takeBack('unit', 0);
    expect(back.files).toEqual([]);
    expect([...flow.acceptedPasses('unit').keys()].sort()).toEqual(FILES);
    await flow.stop();
  });
  it('a silent helper: the whole portion is taken back and its slices cancelled', async () => {
    const { flow, px } = await session(() => null);
    const back = await flow.takeBack('unit', 0);
    expect(back.files).toEqual(FILES);
    expect(px.cancelled.length).toBeGreaterThan(0);
    expect(flow.acceptedPasses('unit').size).toBe(0);
    await flow.stop();
  });
  it('a wrong check slice takes back everything, even passes', async () => {
    const { flow } = await session((files, use) => (use === 'check' ? { ...rightCheck(), slice: { exitCode: 0, unhandledErrors: 0, collected: true } } : { valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 0, unhandledErrors: 0, collected: true }, perFile: files.map((f) => pass(f)) }));
    expect((await flow.takeBack('unit', 0)).files).toEqual(FILES);
    await flow.stop();
  });
  it('another tree, a different digest, or slice trouble: taken back', async () => {
    for (const bad of [
      (files: string[]) => ({ valid: true, state: 'done', treeHash: 'f'.repeat(40), slice: { exitCode: 0, unhandledErrors: 0, collected: true }, perFile: files.map((f) => pass(f)) }),
      (files: string[]) => ({ valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 0, unhandledErrors: 0, collected: true }, perFile: files.map((f) => pass(f, D('9'))) }),
      (files: string[]) => ({ valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 0, unhandledErrors: 2, collected: true }, perFile: files.map((f) => pass(f)) }),
    ]) {
      const { flow } = await session((files, use) => (use === 'check' ? rightCheck() : bad(files)));
      expect((await flow.takeBack('unit', 0)).files).toEqual(FILES);
      await flow.stop();
    }
  });
  it('more than five disagreements so far: no helper result is used', async () => {
    const { flow } = await session((files, use) => (use === 'check' ? rightCheck() : { valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 0, unhandledErrors: 0, collected: true }, perFile: files.map((f) => pass(f)) }));
    flow.noteDisagreements(6);
    expect((await flow.takeBack('unit', 0)).files).toEqual(FILES);
    await flow.stop();
  });
  it('spot re-runs: a drawn pass is run locally too and not counted', async () => {
    const px = fakeProxy((files, use) => (use === 'check' ? rightCheck() : { valid: true, state: 'done', treeHash: TREE, slice: { exitCode: 0, unhandledErrors: 0, collected: true }, perFile: files.map((f) => pass(f)) }));
    const flow = new BorrowedLaneFlow(plan({ spotOneIn: 1 }), { ...deps(px.call), randomInt: () => 0 }, TREE, new Map(FILES.map((f) => [f, row()])), new Set());
    flow.planLanes([{ lane: 'unit', files: [...FILES, LOCAL_ONLY], procs: 1, balanced: true, firstPart: false, wallPerMs: 1 }], { [FILES[0]]: 1000, [FILES[1]]: 1000, [LOCAL_ONLY]: 2000 });
    flow.setPortions('unit', [0], {});
    flow.start(60_000);
    for (let i = 0; i < 20; i++) await tick();
    const back = await flow.takeBack('unit', 0);
    expect(back.spot).toEqual(FILES);
    expect(flow.acceptedPasses('unit').size).toBe(0);
    await flow.stop();
  });
  it('practice (compare-only) lanes send compare slices and never take back', async () => {
    const px = fakeProxy(() => null);
    const flow = new BorrowedLaneFlow(plan({ assigned: 'compare-only' }), deps(px.call), TREE, new Map(), new Set());
    const plans = flow.planLanes([{ lane: 'unit', files: FILES, procs: 1, balanced: true, firstPart: false, wallPerMs: 1 }], {});
    expect(plans.get('unit')!.mode).toBe('compare');
    flow.start(60_000);
    for (let i = 0; i < 20; i++) await tick();
    expect(px.slices.filter((s) => s.use === 'compare').length).toBeGreaterThan(0);
    expect((await flow.takeBack('unit', 0)).files).toEqual([]);
    await flow.stop();
  });
});
