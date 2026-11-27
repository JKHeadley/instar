/**
 * Tier-1: the shadow comparison (docs/specs/local-verify-borrowed-unit-slices.md, F) — answer validity
 * first (ids, exact files, each listed once, signature), per-file agreement only with `collected`,
 * slice-level errors judged once without turning passing files into disagreements, directions, the
 * canary's false greens / reds, result-oversize, and the learned-list observations.
 */
import { describe, expect, it } from 'vitest';
import { answerInvalid, compareShadow, directionOf, type SentSlice } from '../../../src/localVerify/borrowedCompare.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from '../../../src/localVerify/borrowedCanary.js';
import type { FileCounts } from '../../../src/localVerify/laneReport.js';
import { HELPER_RESPONSE_MAX_BYTES, readBodyCapped } from '../../../src/localVerify/borrowedClient.js';
import type { HelperSliceAnswer, HelperSliceRequest } from '../../../src/localVerify/helper/helperProtocol.js';

const A = 'tests/unit/a.test.ts';
const B = 'tests/unit/b.test.ts';
const C = 'tests/unit/c.test.ts';
const req = (files: string[], o: Partial<HelperSliceRequest> = {}): HelperSliceRequest => ({ kind: 'slice', attemptId: '1'.repeat(32), runAttemptId: '2'.repeat(32), requesterMachineId: 'm_s', helperMachineId: 'm_l', lane: 'unit', baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40), files, use: 'compare', deadlineAt: 1, budgetMs: 1, expiresAt: 1, ...o });
const pf = (file: string, passed: number, failed = 0, skipped = 0, todo = 0) => ({ file, tests: passed + failed + skipped + todo, passed, failed, skipped, todo, ms: 100, digest: 'd'.repeat(64), failedTests: [] as string[] });
const ans = (r: HelperSliceRequest, perFile: HelperSliceAnswer['perFile'], o: Partial<HelperSliceAnswer> = {}): HelperSliceAnswer => ({
  state: 'done', attemptId: r.attemptId, runAttemptId: r.runAttemptId, lane: r.lane, baseSha: r.baseSha, headSha: r.headSha, treeHash: null, requestedFiles: [...r.files], perFile,
  slice: { exitCode: perFile.some((p) => p.failed) ? 1 : 0, unhandledErrors: 0, collected: true, vitestStartMs: 700 }, ownerCoresMax: 2, handBackMs: null, prepMs: 1, progress: 1, helperVersion: 'v', ...o,
});
const local = (m: Record<string, [number, number, number?, number?]>): Map<string, FileCounts> => new Map(Object.entries(m).map(([f, [p, fl, s, t]]) => [f, { passed: p, failed: fl, skipped: s ?? 0, todo: t ?? 0, ms: 200 }]));
const slice = (r: HelperSliceRequest, a: HelperSliceAnswer | null, o: Partial<SentSlice> = {}): SentSlice => ({ request: r, canary: false, answer: a, sigRefusal: null, ...o });

describe('answer validity', () => {
  it('needs the request\'s ids and exact files, each requested file exactly once, and a good signature', () => {
    const r = req([A, B]);
    expect(answerInvalid(slice(r, ans(r, [pf(A, 1), pf(B, 1)])))).toBeNull();
    expect(answerInvalid(slice(r, { ...ans(r, [pf(A, 1), pf(B, 1)]), attemptId: '9'.repeat(32) }))).toBe('ids');
    expect(answerInvalid(slice(r, { ...ans(r, [pf(A, 1), pf(B, 1)]), headSha: 'b'.repeat(40) }))).toBe('ids');
    // Protocol v2: the lane and the base commit are part of what an answer must repeat.
    expect(answerInvalid(slice(r, { ...ans(r, [pf(A, 1), pf(B, 1)]), baseSha: 'b'.repeat(40) }))).toBe('ids');
    expect(answerInvalid(slice(r, { ...ans(r, [pf(A, 1), pf(B, 1)]), lane: 'integration' }))).toBe('ids');
    expect(answerInvalid(slice(r, { ...ans(r, [pf(A, 1), pf(B, 1)]), requestedFiles: [A] }))).toBe('requested-files');
    expect(answerInvalid(slice(r, ans(r, [pf(A, 1)])))).toBe('per-file');
    expect(answerInvalid(slice(r, ans(r, [pf(A, 1), pf(A, 1)])))).toBe('per-file');
    expect(answerInvalid(slice(r, ans(r, [pf(A, 1), pf(C, 1)])))).toBe('per-file');
    expect(answerInvalid(slice(r, ans(r, [pf(A, 1), pf(B, 1)]), { sigRefusal: 'signature-bad' }))).toBe('sig:signature-bad');
    expect(answerInvalid(slice(r, null))).toBe('no-answer');
  });

  it('an invalid answer is compared not at all and never feeds the learned list', () => {
    const r = req([A]);
    const c = compareShadow([slice(r, ans(r, [pf(A, 0, 1)]), { sigRefusal: 'signature-bad' })], local({ [A]: [1, 0] }), BORROWED_CANARY);
    expect(c).toMatchObject({ invalidAnswers: 1, badSignatures: 1, agree: 0, disagree: [], observations: [] });
  });
});

describe('per-file comparison', () => {
  it('agrees on equal counts with collected; records each disagreement\'s direction', () => {
    const r = req([A, B, C]);
    const c = compareShadow([slice(r, ans(r, [pf(A, 2), pf(B, 1, 1), pf(C, 1, 0, 1)]))], local({ [A]: [2, 0], [B]: [2, 0], [C]: [2, 0] }), BORROWED_CANARY);
    expect(c.agree).toBe(1);
    expect(c.disagree).toEqual([{ file: B, direction: 'helper-red/local-green' }, { file: C, direction: 'skip-difference' }]);
    // The amended kinds: the helper failed where the run machine passed; both passed with different skips.
    expect(c.observations).toEqual([{ file: B, kind: 'helper-failed-local-passed' }, { file: C, kind: 'digest-differs-both-pass' }]);
    expect(directionOf({ failed: 0 }, { failed: 2 })).toBe('helper-green/local-red');
  });

  it('a helper-green / local-red file is a disagreement but never a learned-list entry; locally red files are counted', () => {
    const r = req([A]);
    const c = compareShadow([slice(r, ans(r, [pf(A, 2)]))], local({ [A]: [1, 1] }), BORROWED_CANARY);
    expect(c.disagree).toEqual([{ file: A, direction: 'helper-green/local-red' }]);
    expect(c.observations).toEqual([]);
    expect(c.localRedCompared).toBe(1);
  });

  it('equal counts without collected are not agreement', () => {
    const r = req([A, B]);
    const a = ans(r, [pf(A, 1), pf(B, 0)]);
    const c = compareShadow([slice(r, { ...a, slice: { ...a.slice!, collected: false } })], local({ [A]: [1, 0] }), BORROWED_CANARY);
    expect([c.agree, c.uncollected, c.disagree.length]).toEqual([0, 1, 0]);
  });

  it('a slice-level error is counted once per slice and does not turn its passing files into disagreements', () => {
    const r = req([A, B]);
    const a = ans(r, [pf(A, 1), pf(B, 1)], { slice: { exitCode: 1, unhandledErrors: 2, collected: true, vitestStartMs: 1 } });
    const c = compareShadow([slice(r, a)], local({ [A]: [1, 0], [B]: [1, 0] }), BORROWED_CANARY);
    expect([c.sliceErrors, c.agree, c.disagree.length]).toEqual([1, 2, 0]);
    // A nonzero exit explained by a failed file is not a slice error.
    const r2 = req([A]);
    expect(compareShadow([slice(r2, ans(r2, [pf(A, 0, 1)]))], local({ [A]: [0, 1] }), BORROWED_CANARY).sliceErrors).toBe(0);
  });

  it('retrial agreement removes a learned entry; refusals, busy, hand-backs and oversize are counted, not compared', () => {
    const rt = req([A], { retrial: true });
    const busy = req([B]);
    const back = req([C]);
    const big = req([A]);
    const c = compareShadow([
      slice(rt, ans(rt, [pf(A, 1)])),
      slice(busy, ans(busy, [], { state: 'busy' })),
      slice(back, ans(back, [], { state: 'handed-back', handBackMs: 40 })),
      slice(big, ans(big, [], { resultOversize: { bytesSeen: 5_000_000 } })),
      slice(req([B]), null, { refusedReason: 'base-not-merged' }),
    ], local({ [A]: [1, 0] }), BORROWED_CANARY);
    expect(c.observations).toEqual([{ file: A, kind: 'agree' }]);
    expect([c.busy, c.handedBack, c.handBackMs, c.resultOversize, c.refused]).toEqual([1, 1, [40], [{ attemptId: big.attemptId, bytesSeen: 5_000_000 }], { 'base-not-merged': 1 }]);
  });
});

describe('second-pass: a slice with no readable report', () => {
  it('counts once as a slice error: no file becomes a disagreement and nothing feeds the learned list', () => {
    const r = req([A, B]);
    const zero = ans(r, [pf(A, 0), pf(B, 0)], { slice: { exitCode: null, unhandledErrors: 0, collected: false, vitestStartMs: null } });
    const c = compareShadow([slice(r, zero)], local({ [A]: [2, 0], [B]: [1, 0] }), BORROWED_CANARY);
    expect([c.sliceErrors, c.disagree.length, c.observations.length, c.agree]).toEqual([1, 0, 0, 0]);
    // A partly uncollected slice still compares, but never feeds the learned list.
    const part = ans(r, [pf(A, 1, 1), pf(B, 0)], { slice: { exitCode: 1, unhandledErrors: 0, collected: false, vitestStartMs: 1 } });
    const c2 = compareShadow([slice(r, part)], local({ [A]: [2, 0], [B]: [1, 0] }), BORROWED_CANARY);
    expect(c2.disagree.length).toBe(2);
    expect(c2.observations).toEqual([]);
  });
});

describe('second-pass: the client reads the answer with the cap streaming', () => {
  it('refuses past the cap without buffering the rest', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({ pull(ctl) { pulled++; if (pulled > 100) ctl.close(); else ctl.enqueue(chunk); } });
    expect(await readBodyCapped(new Response(stream), HELPER_RESPONSE_MAX_BYTES)).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(await readBodyCapped(new Response('{"ok":1}'), HELPER_RESPONSE_MAX_BYTES)).toBe('{"ok":1}');
  });
});

describe('the known-red canary', () => {
  it('scores false greens and false reds against the seeded outcomes, separately from the agreement', () => {
    const r = req([...BORROWED_CANARY_FILES]);
    const honest = BORROWED_CANARY_FILES.map((f) => { const e = BORROWED_CANARY[f]; return pf(f, e.passed, e.failed, e.skipped, e.todo); });
    expect(compareShadow([slice(r, ans(r, honest), { canary: true })], local({}), BORROWED_CANARY).canary).toEqual({ compared: 5, falseGreen: 0, falseRed: 0 });
    const lying = honest.map((p) => ({ ...p, failed: p.file.includes('assertion-fail') || p.file.includes('thrown') ? 0 : p.failed, passed: p.passed + (p.file.includes('pass.test') ? 0 : 0) }));
    lying[BORROWED_CANARY_FILES.indexOf('tests/fixtures/borrowed-canary/canary-pass.test.ts')].failed = 1;
    const c = compareShadow([slice(r, ans(r, lying), { canary: true })], local({}), BORROWED_CANARY);
    expect(c.canary).toEqual({ compared: 5, falseGreen: 2, falseRed: 1 });
    expect([c.agree, c.disagree.length, c.observations.length]).toEqual([0, 0, 0]);
  });
});
