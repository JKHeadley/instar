// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: what a helper accepts (docs/specs/local-verify-borrowed-unit-slices.md, C, as amended by
 * docs/specs/local-verify-borrowed-slices-count.md) — both sides of every transport check (route,
 * signature, pinned requester, expiry, single use across restarts), protocol version 2 (lane,
 * baseSha and headSha in the request; tree hash, per-file digest and failed test names in the
 * answer; signed progress; per-slice cancel; version 1 refused), and the settings parsers (dark
 * unless enabled; malformed = disabled; modes off / practice / count with `shadow` read as practice).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { routeRefusal, signedRequestRefusal } from '../../../../src/localVerify/helper/admission.js';
import { HelperSeenAttempts } from '../../../../src/localVerify/helper/seenAttempts.js';
import {
  HELPER_LIMITS, HELPER_PROGRESS_DOMAIN, HELPER_REQUEST_DOMAIN, HELPER_SLICE_DOMAIN,
  answerPayload, finalContradictsProgress, isHelperPerFile, parseHelperAnswer, parseHelperProgress, parseHelperRequest, progressPayload, progressSupersedes,
  requestPayload, signHelperAnswer, signHelperProgress, signHelperRequest, verifyHelperAnswer, verifyHelperProgress,
  type HelperCancelRequest, type HelperLearnedRequest, type HelperPerFile, type HelperProgressAnswer, type HelperSliceAnswer, type HelperSliceRequest,
} from '../../../../src/localVerify/helper/helperProtocol.js';
import { parseBorrowedConfig, parseHelperConfig, parseHelperTarget, readBorrowedMode, sandboxWorkerCeiling } from '../../../../src/localVerify/helper/helperConfig.js';
import { outcomeDigest } from '../../../../src/localVerify/laneReport.js';
import { id32, machineKeys, pins, sha } from '../../../helpers/borrowedHelperFixture.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperAdmission.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvadm-'))); dirs.push(d); return d; };

const NOW = Date.parse('2026-11-18T20:00:00.000Z');
const studio = machineKeys('m_studio');
const req = (over: Partial<HelperSliceRequest> = {}): HelperSliceRequest => ({
  kind: 'slice', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_studio', helperMachineId: 'm_laptop',
  lane: 'integration', baseSha: sha('a'), headSha: sha('b'), use: 'count',
  files: ['tests/integration/a.test.ts'], deadlineAt: NOW + 60_000, budgetMs: 60_000, expiresAt: NOW + 55_000, ...over,
});
const DIGEST = outcomeDigest([{ name: 'suite works', outcome: 'passed' }]);
const perFile = (over: Partial<HelperPerFile> = {}): HelperPerFile => ({ file: 'tests/integration/a.test.ts', tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, ms: 5, digest: DIGEST, failedTests: [], ...over });
const answer = (over: Partial<HelperSliceAnswer> = {}): HelperSliceAnswer => ({
  state: 'done', attemptId: id32(), runAttemptId: id32(), lane: 'integration', baseSha: sha('a'), headSha: sha('b'), treeHash: sha('c'),
  requestedFiles: ['tests/integration/a.test.ts'], perFile: [perFile()],
  slice: { exitCode: 0, unhandledErrors: 0, collected: true, vitestStartMs: 100 }, ownerCoresMax: 1.5, handBackMs: null, prepMs: 100, progress: 1, helperVersion: '1', ...over,
});
const progress = (over: Partial<HelperProgressAnswer> = {}): HelperProgressAnswer => ({
  kind: 'progress', attemptId: '1'.repeat(32), runAttemptId: '2'.repeat(32), lane: 'integration', treeHash: sha('c'), seq: 3,
  files: [perFile()], unhandledErrors: 0, helperVersion: '1', ...over,
});
const ctx = (seen: { has(id: string): boolean } = { has: () => false }) => ({ selfMachineId: 'm_laptop', pinnedRequester: 'm_studio', keyLookup: pins(studio), now: NOW, seen });

describe('route', () => {
  it('refuses the Cloudflare tunnel (cf-connecting-ip) and loopback; serves the LAN / tailnet address', () => {
    expect(routeRefusal({ cfConnectingIp: '203.0.113.9', localAddress: '100.64.0.5' })).toBe('tunnel');
    expect(routeRefusal({ localAddress: '127.0.0.1' })).toBe('tunnel');
    expect(routeRefusal({ localAddress: '::ffff:127.0.0.1' })).toBe('tunnel');
    expect(routeRefusal({ localAddress: '100.64.0.5' })).toBeNull();
    expect(routeRefusal({ localAddress: '192.168.1.20' })).toBeNull();
    expect(routeRefusal({ localAddress: '127.0.0.1' }, { allowLoopback: true })).toBeNull();
    expect(routeRefusal({ cfConnectingIp: 'x', localAddress: '127.0.0.1' }, { allowLoopback: true })).toBe('tunnel');
  });
});

describe('signed requests', () => {
  it('accepts a fresh request signed by a pinned requester', () => {
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req()), ctx())).toBeNull();
  });

  it('pairing: one pinned run machine at a time; a second run machine is refused even with a key this helper knows and a valid signature', () => {
    const m5 = machineKeys('m_m5');
    const both = { ...ctx(), keyLookup: pins(studio, m5) };
    const fromM5 = signHelperRequest(m5.signer, req({ requesterMachineId: 'm_m5' }));
    expect(signedRequestRefusal(fromM5, both)).toBe('requester-not-pinned');
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req()), both)).toBeNull();
    // Serving the other run machine is a change to the helper's own setting, and then the first is refused.
    const repinned = { ...both, pinnedRequester: 'm_m5' };
    expect(signedRequestRefusal(fromM5, repinned)).toBeNull();
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req()), repinned)).toBe('requester-not-pinned');
  });

  it('refuses unsigned, unpinned, wrong-machine, unknown-key and tampered requests', () => {
    expect(signedRequestRefusal({ ...req() } as never, ctx())).toBe('unsigned');
    const other = machineKeys('m_other');
    expect(signedRequestRefusal(signHelperRequest(other.signer, req({ requesterMachineId: 'm_other' })), ctx())).toBe('requester-not-pinned');
    // Signed by another machine while claiming to be the Studio.
    expect(signedRequestRefusal(signHelperRequest(other.signer, req()), ctx())).toBe('requester-not-pinned');
    const rotated = machineKeys('m_studio');
    expect(signedRequestRefusal(signHelperRequest(rotated.signer, req()), ctx())).toBe('signature-unknown-key');
    const s = signHelperRequest(studio.signer, req());
    expect(signedRequestRefusal({ ...s, files: ['tests/unit/b.test.ts'] }, ctx())).toBe('signature-bad');
    // Protocol v2: the lane and both commits are signed, so none can be swapped on the way.
    expect(signedRequestRefusal({ ...s, lane: 'e2e' }, ctx())).toBe('signature-bad');
    expect(signedRequestRefusal({ ...s, baseSha: sha('e') }, ctx())).toBe('signature-bad');
    expect(signedRequestRefusal({ ...s, headSha: sha('e') }, ctx())).toBe('signature-bad');
    expect(signedRequestRefusal({ ...s, use: 'compare' }, ctx())).toBe('signature-bad');
  });

  it('a version 1 signature is refused: the same body signed under the v1 domain does not verify', () => {
    expect([HELPER_REQUEST_DOMAIN, HELPER_SLICE_DOMAIN, HELPER_PROGRESS_DOMAIN]).toEqual(['instar-lv-helper-request-v2', 'instar-lv-helper-slice-v2', 'instar-lv-helper-progress-v2']);
    const cancel: HelperCancelRequest = { kind: 'cancel', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', expiresAt: NOW + 55_000 };
    // A cancel has the same fields in both versions; only the signing domain tells them apart.
    const v1Payload = requestPayload(cancel).replace(HELPER_REQUEST_DOMAIN, 'instar-lv-helper-request-v1');
    const v1 = { ...cancel, sig: studio.signer.sign(v1Payload) };
    expect(signedRequestRefusal(v1, ctx())).toBe('signature-bad');
    expect(signedRequestRefusal(signHelperRequest(studio.signer, cancel), ctx())).toBeNull();
  });

  it('audience: a request signed for another helper is refused (wrong-helper)', () => {
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req({ helperMachineId: 'm_pc' })), ctx())).toBe('wrong-helper');
    expect(parseHelperRequest({ ...signHelperRequest(studio.signer, req()), helperMachineId: undefined }, 'slice')).toBeNull();
  });

  it('expiry: refused after expiresAt + 30 s, and when signed to live more than 60 s (+30 s)', () => {
    const ok = signHelperRequest(studio.signer, req({ expiresAt: NOW - 29_000 }));
    expect(signedRequestRefusal(ok, ctx())).toBeNull();
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req({ expiresAt: NOW - 31_000 })), ctx())).toBe('expired');
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req({ expiresAt: NOW + 89_000 })), ctx())).toBeNull();
    expect(signedRequestRefusal(signHelperRequest(studio.signer, req({ expiresAt: NOW + 91_000 })), ctx())).toBe('expired');
  });

  it('replay: a seen attemptId is refused, and the seen set survives a restart for 10 min', () => {
    const dir = tmp();
    let t = NOW;
    const seen = new HelperSeenAttempts(dir, () => t);
    const s = signHelperRequest(studio.signer, req());
    expect(signedRequestRefusal(s, ctx(seen))).toBeNull();
    seen.add(s.attemptId);
    expect(signedRequestRefusal(s, ctx(seen))).toBe('replayed');
    const restarted = new HelperSeenAttempts(dir, () => t);
    expect(restarted.has(s.attemptId)).toBe(true);
    t += HELPER_LIMITS.seenAttemptMs + 1;
    expect(new HelperSeenAttempts(dir, () => t).has(s.attemptId)).toBe(false);
  });
});

describe('protocol', () => {
  it('a slice request names a lane, a merged base and a head (40 hex each); a version 1 body is malformed', () => {
    const s = signHelperRequest(studio.signer, req());
    expect(parseHelperRequest(s, 'slice')).toMatchObject({ lane: 'integration', baseSha: sha('a'), headSha: sha('b'), use: 'count' });
    for (const lane of ['unit', 'integration', 'e2e']) expect(parseHelperRequest({ ...s, lane }, 'slice'), lane).not.toBeNull();
    for (const lane of ['flaky', 'Unit', '', 7, undefined]) expect(parseHelperRequest({ ...s, lane }, 'slice'), String(lane)).toBeNull();
    // A main verify or a dry run: the head is the base itself.
    expect(parseHelperRequest({ ...s, headSha: sha('a') }, 'slice')).not.toBeNull();
    expect(parseHelperRequest({ ...s, baseSha: undefined }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, headSha: undefined }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, baseSha: 'a'.repeat(39) }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, headSha: 'A'.repeat(40) }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, baseSha: 'main' }, 'slice')).toBeNull();
    // The version 1 slice: one commit, no lane, no base, no use.
    const { lane: _l, baseSha: _b, use: _u, ...v1 } = s;
    expect(parseHelperRequest(v1, 'slice')).toBeNull();
    // The version 1 field name for nothing: an unknown key is refused, never ignored.
    expect(parseHelperRequest({ ...s, commit: sha('a') }, 'slice')).toBeNull();
  });

  it('use is check, count or compare: required with files, absent on a preparation; a retrial and a dry run never count', () => {
    const s = signHelperRequest(studio.signer, req());
    for (const use of ['check', 'count', 'compare']) expect(parseHelperRequest({ ...s, use }, 'slice'), use).not.toBeNull();
    expect(parseHelperRequest({ ...s, use: 'practice' }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, use: undefined }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, use: undefined, files: [], prepare: true }, 'slice')).not.toBeNull();
    expect(parseHelperRequest({ ...s, files: [], prepare: true }, 'slice')).toBeNull(); // a preparation with a use
    expect(parseHelperRequest({ ...s, retrial: true, use: 'compare' }, 'slice')).not.toBeNull();
    expect(parseHelperRequest({ ...s, retrial: true, use: 'count' }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, retrial: true, use: 'check' }, 'slice')).toBeNull();
    // A dry run is on merged code only, and compare-only.
    expect(parseHelperRequest({ ...s, dryRun: true, headSha: sha('a'), use: 'compare' }, 'slice')).not.toBeNull();
    expect(parseHelperRequest({ ...s, dryRun: true, headSha: sha('a'), use: 'check' }, 'slice')).not.toBeNull();
    expect(parseHelperRequest({ ...s, dryRun: true, headSha: sha('b'), use: 'compare' }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, dryRun: true, headSha: sha('a'), use: 'count' }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, dryRun: false, headSha: sha('a'), use: 'compare' }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, use: undefined, files: [], prepare: true, dryRun: true, headSha: sha('a') }, 'slice')).not.toBeNull();
  });

  it('a cancel is for the whole run, or for named slices (kept tree); "the verify is over" only for the whole run', () => {
    const base: HelperCancelRequest = { kind: 'cancel', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', expiresAt: NOW + 55_000 };
    const ok = (o: Record<string, unknown>) => parseHelperRequest(signHelperRequest(studio.signer, { ...base, ...o } as HelperCancelRequest), 'cancel');
    expect(ok({})).not.toBeNull();
    expect(ok({ attemptIds: [id32(), id32()] })).not.toBeNull();
    expect(ok({ verifyOver: true })).not.toBeNull();
    expect(ok({ attemptIds: [] })).toBeNull();
    expect(ok({ attemptIds: ['not-an-id'] })).toBeNull();
    const twice = id32();
    expect(ok({ attemptIds: [twice, twice] })).toBeNull();
    expect(ok({ attemptIds: Array.from({ length: HELPER_LIMITS.maxCancelAttemptIds }, () => id32()) })).not.toBeNull();
    expect(ok({ attemptIds: Array.from({ length: HELPER_LIMITS.maxCancelAttemptIds + 1 }, () => id32()) })).toBeNull();
    expect(ok({ attemptIds: [id32()], verifyOver: true })).toBeNull();
    expect(ok({ verifyOver: false })).toBeNull();
    expect(ok({ lane: 'unit' })).toBeNull();
  });

  it('a learned report is keyed by the merge tree\'s hash and names what each comparison showed; the first design\'s shape is malformed', () => {
    const l: HelperLearnedRequest = { kind: 'learned', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', treeHash: sha('a'), expiresAt: NOW + 55_000, observations: [{ file: 'tests/unit/a.test.ts', kind: 'helper-failed-local-passed' }] };
    const s = signHelperRequest(studio.signer, l);
    expect(parseHelperRequest(s, 'learned')).not.toBeNull();
    expect(signedRequestRefusal(s, ctx())).toBeNull();
    // Every kind the amendment names, and no other.
    for (const kind of ['helper-failed-local-passed', 'digest-differs-both-pass', 'confirmed-wrong-pass', 'agree']) {
      expect(parseHelperRequest({ ...s, observations: [{ file: 'tests/unit/a.test.ts', kind }] }, 'learned'), kind).not.toBeNull();
    }
    for (const kind of ['differ', 'maybe', '', 7, null]) {
      expect(parseHelperRequest({ ...s, observations: [{ file: 'tests/unit/a.test.ts', kind }] }, 'learned'), String(kind)).toBeNull();
    }
    // The first design's fields: a commit in place of the tree, and a source per observation.
    const { treeHash: _t, ...noTree } = s;
    expect(parseHelperRequest({ ...noTree, headSha: sha('a') }, 'learned')).toBeNull();
    expect(parseHelperRequest({ ...s, headSha: sha('a') }, 'learned')).toBeNull();
    expect(parseHelperRequest({ ...s, observations: [{ file: 'tests/unit/a.test.ts', kind: 'agree', source: 'paired' }] }, 'learned')).toBeNull();
    expect(parseHelperRequest({ ...s, treeHash: 'short' }, 'learned')).toBeNull();
    // One comparison per file per request: two kinds for one file would contradict each other.
    expect(parseHelperRequest({ ...s, observations: [{ file: 'tests/unit/a.test.ts', kind: 'agree' }, { file: 'tests/unit/a.test.ts', kind: 'confirmed-wrong-pass' }] }, 'learned')).toBeNull();
    expect(parseHelperRequest({ ...s, observations: [{ file: 'tests/unit/a.test.ts', kind: 'agree' }, { file: 'tests/unit/b.test.ts', kind: 'confirmed-wrong-pass' }] }, 'learned')).not.toBeNull();
    expect(parseHelperRequest({ ...s, observations: [{ file: '../x.test.ts', kind: 'agree' }] }, 'learned')).toBeNull();
    expect(parseHelperRequest({ ...s, lane: 'unit' }, 'learned')).toBeNull();
  });

  it('parses exactly one request kind; prepare carries no files; files are bounded test paths', () => {
    const s = signHelperRequest(studio.signer, req());
    expect(parseHelperRequest(s, 'slice')).not.toBeNull();
    expect(parseHelperRequest(s, 'cancel')).toBeNull();
    expect(parseHelperRequest({ ...s, extra: 1 }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: ['../etc/passwd.test.ts'] }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: ['/abs/x.test.ts'] }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: ['tests/unit/a.ts'] }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: [] }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: [], prepare: true, use: undefined }, 'slice')).not.toBeNull();
    expect(parseHelperRequest({ ...s, prepare: true, use: undefined }, 'slice')).toBeNull();
    expect(parseHelperRequest({ ...s, files: Array.from({ length: 401 }, (_, i) => `tests/unit/f${i}.test.ts`) }, 'slice')).toBeNull();
  });

  it('a signed answer verifies for the helper that signed it, and not when altered or from another machine', () => {
    const laptop = machineKeys('m_laptop');
    const ans = answer();
    const s = signHelperAnswer(laptop.signer, ans);
    const parsed = parseHelperAnswer(JSON.parse(JSON.stringify(s)))!;
    expect(parsed).not.toBeNull();
    expect(verifyHelperAnswer(parsed, 'm_laptop', pins(laptop), NOW)).toBeNull();
    expect(verifyHelperAnswer(parsed, 'm_pc', pins(laptop), NOW)).toBe('signature-wrong-machine');
    expect(verifyHelperAnswer({ ...parsed, perFile: [{ ...parsed.perFile[0], failed: 1 }] }, 'm_laptop', pins(laptop), NOW)).toBe('signature-bad');
    // The tree hash, the digest and the failed names are signed: a pass cannot be moved to another tree or another test set.
    expect(verifyHelperAnswer({ ...parsed, treeHash: sha('d') }, 'm_laptop', pins(laptop), NOW)).toBe('signature-bad');
    expect(verifyHelperAnswer({ ...parsed, perFile: [{ ...parsed.perFile[0], digest: 'e'.repeat(64) }] }, 'm_laptop', pins(laptop), NOW)).toBe('signature-bad');
    expect(verifyHelperAnswer({ ...ans }, 'm_laptop', pins(laptop), NOW)).toBe('unsigned');
    expect(parseHelperAnswer({ ...s, perFile: [{ file: 'x' }] })).toBeNull();
  });

  it('an answer is parsed strictly: its ids, lane, commits and tree hash, and no unknown key at any level', () => {
    const ok = answer();
    expect(parseHelperAnswer(ok)).not.toBeNull();
    // Before a tree exists (a refusal, a preparation) the tree hash is null; otherwise 40 hex.
    expect(parseHelperAnswer(answer({ state: 'preparing', treeHash: null, perFile: [], slice: null, requestedFiles: [] }))).not.toBeNull();
    expect(parseHelperAnswer(answer({ state: 'queued', perFile: [], slice: null }))).not.toBeNull();
    expect(parseHelperAnswer({ ...ok, treeHash: 'c'.repeat(64) })).toBeNull();
    expect(parseHelperAnswer({ ...ok, treeHash: undefined })).toBeNull();
    expect(parseHelperAnswer({ ...ok, lane: 'flaky' })).toBeNull();
    expect(parseHelperAnswer({ ...ok, baseSha: undefined })).toBeNull();
    expect(parseHelperAnswer({ ...ok, headSha: 'head' })).toBeNull();
    expect(parseHelperAnswer({ ...ok, attemptId: 'x' })).toBeNull();
    expect(parseHelperAnswer({ ...ok, state: 'finished' })).toBeNull();
    expect(parseHelperAnswer({ ...ok, extra: 1 })).toBeNull();
    expect(parseHelperAnswer({ ...ok, slice: { ...ok.slice, extra: 1 } })).toBeNull();
    expect(parseHelperAnswer({ ...ok, slice: undefined })).toBeNull();
    expect(parseHelperAnswer({ ...ok, perFile: [{ ...perFile(), extra: 1 }] })).toBeNull();
    expect(parseHelperAnswer({ ...ok, perFile: [perFile(), perFile()] })).toBeNull(); // one file listed twice
    expect(parseHelperAnswer({ ...ok, requestedFiles: ['../x.test.ts'] })).toBeNull();
    expect(parseHelperAnswer({ ...ok, resultOversize: { bytesSeen: 5_000_000 } })).not.toBeNull();
    expect(parseHelperAnswer({ ...ok, resultOversize: { bytesSeen: 5_000_000, kept: 1 } })).toBeNull();
    expect(parseHelperAnswer({ ...ok, reason: 'x'.repeat(201) })).toBeNull();
    // A helper's bare refusal body is not an answer; its reader takes the reason from the body.
    expect(parseHelperAnswer({ state: 'refused', reason: 'base-not-merged' })).toBeNull();
    // A version 1 answer: one commit, no lane, no tree hash, per-file counts only.
    expect(parseHelperAnswer({ state: 'done', attemptId: ok.attemptId, runAttemptId: ok.runAttemptId, headSha: sha('a'), requestedFiles: ok.requestedFiles,
      perFile: [{ file: 'tests/integration/a.test.ts', tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, ms: 5 }], slice: ok.slice, ownerCoresMax: 1, handBackMs: null, prepMs: 1, progress: 1, helperVersion: '1' })).toBeNull();
  });

  it('a per-file entry carries four counts that add up, a 64-hex digest or null, and at most 50 failed test names', () => {
    expect(isHelperPerFile(perFile())).toBe(true);
    expect(isHelperPerFile(perFile({ tests: 4, passed: 1, failed: 1, skipped: 1, todo: 1, failedTests: ['suite fails'] }))).toBe(true);
    // Not collected: no tests, no digest.
    expect(isHelperPerFile(perFile({ tests: 0, passed: 0, digest: null }))).toBe(true);
    expect(isHelperPerFile(perFile({ tests: 2 }))).toBe(false); // counts do not add up
    expect(isHelperPerFile(perFile({ digest: 'abc' }))).toBe(false);
    expect(isHelperPerFile(perFile({ digest: 'G'.repeat(64) }))).toBe(false);
    expect(isHelperPerFile({ ...perFile(), digest: undefined })).toBe(false);
    expect(isHelperPerFile({ ...perFile(), failedTests: undefined })).toBe(false);
    expect(isHelperPerFile(perFile({ passed: -1 }))).toBe(false);
    expect(isHelperPerFile(perFile({ ms: 1.5 }))).toBe(false);
    expect(isHelperPerFile(perFile({ file: 'tests/unit/a.ts' }))).toBe(false);
    // Failed names: bounded in number (50) and length (300), never more than the failed count, never empty.
    const names = (n: number) => Array.from({ length: n }, (_, i) => `suite fails case ${i}`);
    expect(isHelperPerFile(perFile({ tests: 60, passed: 0, failed: 60, failedTests: names(50) }))).toBe(true);
    expect(isHelperPerFile(perFile({ tests: 60, passed: 0, failed: 60, failedTests: names(51) }))).toBe(false);
    expect(isHelperPerFile(perFile({ tests: 2, passed: 1, failed: 1, failedTests: names(2) }))).toBe(false);
    expect(isHelperPerFile(perFile({ failedTests: ['a passing file names no failure'] }))).toBe(false);
    expect(isHelperPerFile(perFile({ tests: 1, passed: 0, failed: 1, failedTests: ['n'.repeat(HELPER_LIMITS.maxTestNameChars)] }))).toBe(true);
    expect(isHelperPerFile(perFile({ tests: 1, passed: 0, failed: 1, failedTests: ['n'.repeat(HELPER_LIMITS.maxTestNameChars + 1)] }))).toBe(false);
    expect(isHelperPerFile(perFile({ tests: 1, passed: 0, failed: 1, failedTests: [''] }))).toBe(false);
    // A failed test whose name could not be listed is disclosed by the shorter list.
    expect(isHelperPerFile(perFile({ tests: 1, passed: 0, failed: 1, failedTests: [] }))).toBe(true);
  });

  it('progress: signed under its own domain, parsed strictly, with a rising sequence number and the unhandled errors so far', () => {
    const laptop = machineKeys('m_laptop');
    const p = signHelperProgress(laptop.signer, progress());
    const parsed = parseHelperProgress(JSON.parse(JSON.stringify(p)))!;
    expect(parsed).toMatchObject({ seq: 3, unhandledErrors: 0, lane: 'integration', treeHash: sha('c') });
    expect(verifyHelperProgress(parsed, 'm_laptop', pins(laptop), NOW)).toBeNull();
    expect(verifyHelperProgress({ ...parsed, seq: 4 }, 'm_laptop', pins(laptop), NOW)).toBe('signature-bad');
    expect(verifyHelperProgress({ ...parsed, unhandledErrors: 1 }, 'm_laptop', pins(laptop), NOW)).toBe('signature-bad');
    expect(verifyHelperProgress(parsed, 'm_pc', pins(laptop), NOW)).toBe('signature-wrong-machine');
    expect(verifyHelperProgress(progress(), 'm_laptop', pins(laptop), NOW)).toBe('unsigned');
    // The two answer kinds sign different payloads: a progress signature never passes as a final answer's.
    expect(progressPayload(progress()).startsWith(`${HELPER_PROGRESS_DOMAIN}\n`)).toBe(true);
    expect(answerPayload(answer()).startsWith(`${HELPER_SLICE_DOMAIN}\n`)).toBe(true);
    expect(parseHelperAnswer(p)).toBeNull();
    expect(parseHelperProgress(signHelperAnswer(laptop.signer, answer()))).toBeNull();
    expect(parseHelperProgress({ ...p, seq: -1 })).toBeNull();
    expect(parseHelperProgress({ ...p, seq: 1.5 })).toBeNull();
    expect(parseHelperProgress({ ...p, seq: undefined })).toBeNull();
    expect(parseHelperProgress({ ...p, unhandledErrors: undefined })).toBeNull();
    expect(parseHelperProgress({ ...p, treeHash: null })).toBeNull();
    expect(parseHelperProgress({ ...p, files: [{ ...perFile(), extra: 1 }] })).toBeNull();
    expect(parseHelperProgress({ ...p, files: [perFile(), perFile()] })).toBeNull();
    expect(parseHelperProgress({ ...p, extra: 1 })).toBeNull();
    expect(parseHelperProgress({ ...p, files: [] })).not.toBeNull();
  });

  it('a newer progress answer replaces an older one only for the same slice and tree with a higher sequence number', () => {
    const a = progress({ seq: 3 });
    expect(progressSupersedes(a, progress({ seq: 4 }))).toBe(true);
    expect(progressSupersedes(a, progress({ seq: 3 }))).toBe(false);
    expect(progressSupersedes(a, progress({ seq: 2 }))).toBe(false);
    expect(progressSupersedes(a, progress({ seq: 4, attemptId: '9'.repeat(32) }))).toBe(false);
    expect(progressSupersedes(a, progress({ seq: 4, runAttemptId: '9'.repeat(32) }))).toBe(false);
    expect(progressSupersedes(a, progress({ seq: 4, treeHash: sha('d') }))).toBe(false);
    expect(progressSupersedes(a, progress({ seq: 4, lane: 'e2e' }))).toBe(false);
  });

  it('a last answer must repeat what progress reported for each file: a changed count, a changed digest or a missing file contradicts', () => {
    const A = 'tests/integration/a.test.ts';
    const B = 'tests/integration/b.test.ts';
    const seen = [perFile({ file: A }), perFile({ file: B, tests: 2, passed: 1, skipped: 1 })];
    const last = (files: HelperPerFile[]) => answer({ requestedFiles: [A, B], perFile: files });
    // Repeated exactly (time may differ: it is not a result), with more files finished since.
    expect(finalContradictsProgress(seen, last([perFile({ file: A, ms: 999 }), perFile({ file: B, tests: 2, passed: 1, skipped: 1 })]))).toBeNull();
    expect(finalContradictsProgress([seen[0]], last(seen))).toBeNull();
    expect(finalContradictsProgress([], last([]))).toBeNull();
    // A pass in progress that the last answer reports failed.
    expect(finalContradictsProgress(seen, last([perFile({ file: A, passed: 0, failed: 1, failedTests: ['suite works'] }), seen[1]]))).toBe(A);
    // Equal counts, different tests: only the digest shows it.
    expect(finalContradictsProgress(seen, last([seen[0], { ...seen[1], digest: 'e'.repeat(64) }]))).toBe(B);
    // A hand-back that drops a file progress had reported.
    expect(finalContradictsProgress(seen, answer({ state: 'handed-back', requestedFiles: [A, B], perFile: [seen[0]] }))).toBe(B);
  });
});

describe('settings', () => {
  const hw = { ncpu: 16, totalMemGb: 32 };
  const PIN = { machineId: 'm_studio', url: 'http://100.64.0.9:4042' };
  it('absent, not enabled or malformed means disabled', () => {
    expect(parseHelperConfig(undefined, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: false, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequester: PIN }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRequester: PIN }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://gitlab.com/a/b', pinnedRequester: PIN }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/a/b' }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequester: PIN, sandbox: 'test-bypass' }, hw)).toBeNull();
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequester: PIN, sandbox: { cpus: 99 } }, hw)).toBeNull();
  });

  it('pairing: exactly one pinned run machine, { machineId, url }; a list, a bare id, a second machine or a URL with a path disables the role', () => {
    const base = { enabled: true, pinnedRepoUrl: 'https://github.com/a/b' };
    expect(parseHelperConfig({ ...base, pinnedRequester: { machineId: 'm_studio', url: 'http://100.64.0.9:4042/' } }, hw)!.pinnedRequester).toEqual(PIN);
    // The first design's list, even with one entry, and even beside the new field.
    expect(parseHelperConfig({ ...base, pinnedRequesters: ['m_studio'] }, hw)).toBeNull();
    expect(parseHelperConfig({ ...base, pinnedRequester: PIN, pinnedRequesters: ['m_m5'] }, hw)).toBeNull();
    for (const bad of ['m_studio', [PIN], [PIN, { machineId: 'm_m5', url: 'http://100.64.0.8:4042' }], { machineId: 'm_studio' }, { url: PIN.url }, { ...PIN, extra: 1 },
      { machineId: 'bad id', url: PIN.url }, { machineId: 'm_studio', url: 'http://100.64.0.9:4042/x/y' }, { machineId: 'm_studio', url: 'ftp://100.64.0.9' }, null]) {
      expect(parseHelperConfig({ ...base, pinnedRequester: bad }, hw), JSON.stringify(bad)).toBeNull();
    }
    expect(parseHelperTarget(PIN)).toEqual(PIN);
    expect(parseHelperTarget({ machineId: 'm_studio', url: 'https://studio.tail.example:4042' })).toEqual({ machineId: 'm_studio', url: 'https://studio.tail.example:4042' });
  });

  it('starting values: half the cores, min(8 GB, RAM/4), 30 GB, a quarter of the cores reserved, battery stops', () => {
    const c = parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/JKHeadley/instar.git', pinnedRequester: PIN }, hw)!;
    expect(c).toMatchObject({ repo: 'JKHeadley/instar', reserveCores: 4, stopOnBattery: true, sandbox: { cpus: 8, memoryGb: 8, diskGb: 30 } });
    expect(parseHelperConfig({ enabled: true, pinnedRepoUrl: 'https://github.com/a/b', pinnedRequester: PIN }, { ncpu: 8, totalMemGb: 16 })!.sandbox).toEqual({ cpus: 4, memoryGb: 4, diskGb: 30 });
    expect(sandboxWorkerCeiling({ cpus: 8, memoryGb: 4, diskGb: 30 }, 1)).toBe(4);
  });

  it('the run-machine block: off, practice or count; the first design\'s shadow reads as practice; absent or malformed is off', () => {
    const helpers = [{ machineId: 'm_l', url: 'http://1.2.3.4:4042/' }];
    const parsed = [{ machineId: 'm_l', url: 'http://1.2.3.4:4042' }];
    expect(parseBorrowedConfig({ mode: 'practice', helpers }, 'm_studio')).toEqual({ mode: 'practice', helpers: parsed });
    expect(parseBorrowedConfig({ mode: 'count', helpers }, 'm_studio')).toEqual({ mode: 'count', helpers: parsed });
    expect(parseBorrowedConfig({ mode: 'shadow', helpers }, 'm_studio')).toEqual({ mode: 'practice', helpers: parsed });
    expect(parseBorrowedConfig({ mode: 'off', helpers }, 'm_studio')).toEqual({ mode: 'off', helpers: [] });
    // Absent or malformed, at any level, is off.
    expect(parseBorrowedConfig(undefined, 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig(null, 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig('count', 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig([{ mode: 'count', helpers }], 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig({ helpers }, 'm_studio').mode).toBe('off');
    for (const mode of ['Count', 'COUNT', 'counting', 'on', '', true, 1, null, ['count'], { mode: 'count' }]) {
      expect(parseBorrowedConfig({ mode, helpers }, 'm_studio').mode, JSON.stringify(mode)).toBe('off');
    }
    // A mode with no valid helper is off too: this machine itself, a missing list, a URL with a path.
    expect(parseBorrowedConfig({ mode: 'count', helpers: [{ machineId: 'm_studio', url: 'http://1.2.3.4:4042' }] }, 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig({ mode: 'practice' }, 'm_studio').mode).toBe('off');
    expect(parseBorrowedConfig({ mode: 'practice', helpers: [{ machineId: 'm_l', url: 'http://1.2.3.4:4042/x/y' }] }, 'm_studio').mode).toBe('off');
    expect([readBorrowedMode('practice'), readBorrowedMode('count'), readBorrowedMode('shadow'), readBorrowedMode('off'), readBorrowedMode(undefined), readBorrowedMode('Shadow')])
      .toEqual(['practice', 'count', 'practice', 'off', 'off', 'off']);
  });
});
