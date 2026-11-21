// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The dry run of a borrowed helper (docs/specs/local-verify-borrowed-slices-count.md, "The dry run"),
 * against a real HelperService in-process: it consumes the recorded request, pins the newest
 * green baseline, sends every eligible file of the lane once as `dryRun` slices on that merged
 * commit, compares with the baseline, records the lane's coverage and proof through the practice
 * record's one entry point, measures the helper, lets the helper write its own "dry run done"
 * record, releases the pin, and can be stopped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { BorrowedDryRun, judgeDryRunFile, laneProvenByTime } from '../../../src/localVerify/borrowedDryRun.js';
import { parseHelperStatus, type HelperClient } from '../../../src/localVerify/borrowedClient.js';
import { BorrowedPracticeStore } from '../../../src/localVerify/borrowedState.js';
import { recordDryRun } from '../../../src/localVerify/borrowedPractice.js';
import { MainFileCountsStore, type FileCountsRow } from '../../../src/localVerify/mainFileCounts.js';
import { parseVitestJson } from '../../../src/localVerify/laneReport.js';
import { laneOfTestFile, excludedBy } from '../../../src/localVerify/borrowedEligibility.js';
import { vitestReport } from '../../helpers/fakeSandboxDriver.js';
import { HEAD, helperRig, pins, type HelperRig } from '../../helpers/borrowedHelperFixture.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedDryRun.test.ts' }); });
const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const ROOT = '/srv/slice/fake';
const LAPTOP = { machineId: 'm_laptop', url: 'http://100.64.0.9:4042' };

function client(r: HelperRig): HelperClient {
  return {
    async slice(_h, body) { const a = await r.svc.handleSlice(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async cancel(_h, body) { const a = await r.svc.handleCancel(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async learned(_h, body) { const a = await r.svc.handleLearned(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async status(_h, _s, query) { return parseHelperStatus(wire(r.svc.status({ ...(query?.run ? { runAttemptId: query.run } : {}), ...(query?.since !== undefined ? { sinceSeq: query.since } : {}) }))); },
  };
}

function setup(fails: string[] = []) {
  const r = helperRig({}, dirs);
  const unit = Object.keys(r.trees.files[HEAD]).filter((f) => laneOfTestFile(f) === 'unit' && excludedBy(f) === null).sort();
  // Each file passes on the helper (or fails, for `fails`); the baseline holds the digest of a pass.
  r.driver.slice = async (files) => ({ exitCode: files.some((f) => fails.includes(f)) ? 1 : 0, resultText: vitestReport(ROOT, Object.fromEntries(files.map((f) => [f, [fails.includes(f) ? 'failed' as const : 'passed' as const]]))) });
  const passDigest = (f: string) => parseVitestJson(vitestReport(ROOT, { [f]: ['passed'] }), ROOT, { outcomeDigest: true }).files.get(f)!.outcomeDigest!;
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvdry-')));
  dirs.push(stateDir);
  const store = new BorrowedPracticeStore(stateDir);
  const audits: Array<Record<string, unknown>> = [];
  const baseline = new MainFileCountsStore({ stateDir, audit: () => {} });
  baseline.add({ commit: HEAD, finishedAt: '2026-11-18T19:00:00.000Z', machineId: 'm_studio', files: Object.fromEntries(unit.map((f) => [f, [1, 0, 0, 0, passDigest(f)] as FileCountsRow])) });
  const recorded: Array<{ lane: string; eligible: readonly string[]; compared: readonly string[]; proven: boolean }> = [];
  const evidence: Array<{ kind: string; reason: string }> = [];
  const dry = new BorrowedDryRun({
    client: client(r), signer: r.requester.signer, keyLookup: () => pins(r.helperKeys), machineId: 'm_studio', store, baseline,
    treeFiles: async () => unit.map((f) => ({ file: f, ms: 100 })),
    recordDryRunResult: (h, lane, x) => { recorded.push({ lane, eligible: x.eligible, compared: x.compared, proven: x.proven }); store.setLane(h, lane, recordDryRun(store.lane(h, lane, r.clock.t), x, r.clock.t)); },
    audit: (e) => audits.push(e), evidence: (row) => evidence.push(row), now: () => r.clock.t,
    sleep: () => new Promise((res) => setTimeout(res, 2)),
  });
  const request = (state: 'requested' | 'stopped' = 'requested') => { store.get('m_laptop').dryRunIntent = { requestedAt: r.clock.t, lanes: ['unit'], by: 'echo', state }; };
  const until = async (cond: () => boolean) => { for (let i = 0; i < 1500 && !cond(); i++) await new Promise((res) => setTimeout(res, 5)); };
  return { r, unit, store, baseline, audits, recorded, evidence, dry, request, until };
}

describe('the dry run\'s rules', () => {
  const p = (o: Partial<{ tests: number; failed: number; digest: string | null }> = {}) => ({ file: 'f', tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, ms: 1, digest: 'a'.repeat(64), failedTests: [], ...o });
  const row: FileCountsRow = [1, 0, 0, 0, 'a'.repeat(64)];
  it('a file is compared only on an equal digest; a helper failure or a digest difference starts the learned list', () => {
    expect(judgeDryRunFile(p(), row)).toBe('compared');
    expect(judgeDryRunFile(p({ failed: 1 }), row)).toBe('helper-failed-local-passed');
    expect(judgeDryRunFile(p({ digest: 'b'.repeat(64) }), row)).toBe('digest-differs-both-pass');
    expect(judgeDryRunFile(p(), undefined)).toBe('no-baseline');
    expect(judgeDryRunFile(p({ tests: 0 }), row)).toBe('not-collected');
  });
  it('a lane is proven when the passing files are worth at least half of its time', () => {
    const ms = (f: string) => ({ a: 60, b: 40, c: 100 } as Record<string, number>)[f];
    expect(laneProvenByTime(['a', 'b'], new Set(['a']), ms)).toBe(true);
    expect(laneProvenByTime(['a', 'b'], new Set(['b']), ms)).toBe(false);
    // A file the helper never finished counts against the lane: 60 of 200 is not half.
    expect(laneProvenByTime(['a', 'b', 'c'], new Set(['a']), ms)).toBe(false);
    expect(laneProvenByTime([], new Set(), ms)).toBe(false);
  });
});

describe('a dry run that cannot finish', () => {
  it('is started again at most three times, then stopped and said once', async () => {
    const s = setup();
    s.baseline.clear(); // nothing can start: every try ends unfinished
    s.request();
    let t = 0;
    (s.dry as unknown as { d: { now: () => number } }).d.now = () => (t += 11 * 60_000);
    for (let i = 0; i < 8; i++) { s.dry.tick([LAPTOP]); await s.until(() => !s.dry.isRunning('m_laptop')); }
    expect(s.audits.filter((a) => a.event === 'borrowed-dry-run-waiting')).toHaveLength(3);
    expect(s.audits.filter((a) => a.event === 'borrowed-dry-run-gave-up')).toHaveLength(1);
    expect(s.store.get('m_laptop').dryRunIntent?.state).toBe('stopped');
  });
});

describe('a dry run end to end against a real helper service', () => {
  it('sends every eligible file once, compares with the baseline, records coverage and proof, and the helper writes its own record', async () => {
    const s = setup();
    s.request();
    s.dry.tick([LAPTOP]);
    expect(s.dry.isRunning('m_laptop')).toBe(true);
    await s.until(() => !s.dry.isRunning('m_laptop'));
    expect(s.recorded).toEqual([{ lane: 'unit', eligible: s.unit, compared: s.unit, proven: true }]);
    expect(s.store.peekLane('m_laptop', 'unit')).toMatchObject({ coverage: { eligible: s.unit.length, uncovered: [], proven: true } });
    expect(s.store.get('m_laptop').dryRunIntent?.state).toBe('done');
    expect(s.store.get('m_laptop').runs.at(-1)).toMatchObject({ counted: true, slicesSent: s.unit.length, done: s.unit.length });
    expect(s.r.audits.some((a) => a.event === 'helper-dry-run-done' && a.lane === 'unit')).toBe(true);
    expect(s.audits.find((a) => a.event === 'borrowed-dry-run-end')).toMatchObject({ finished: true, stopped: false });
    expect(s.evidence.map((e) => e.reason)).toEqual(['dry-run-done']);
    // The baseline's pin was released.
    const b = s.baseline.read();
    expect(b.ok && b.file.pinned).toEqual([]);
  });

  it('a file the helper fails is answered but not compared, and goes to its learned list', async () => {
    const s = setup();
    const bad = s.unit[0];
    const t = setup([bad]);
    t.request();
    t.dry.tick([LAPTOP]);
    await t.until(() => !t.dry.isRunning('m_laptop'));
    expect(t.recorded[0].compared).not.toContain(bad);
    expect(t.audits.find((a) => a.event === 'borrowed-dry-run-lane')).toMatchObject({ learned: 1, learnedFiles: [bad] });
    void s;
  });

  it('no baseline: nothing starts and the request waits', async () => {
    const s = setup();
    s.baseline.clear();
    s.request();
    s.dry.tick([LAPTOP]);
    await s.until(() => !s.dry.isRunning('m_laptop'));
    expect(s.audits.find((a) => a.event === 'borrowed-dry-run-waiting')).toMatchObject({ reason: 'no-baseline' });
    expect(s.store.get('m_laptop').dryRunIntent?.state).toBe('requested');
    expect(s.recorded).toEqual([]);
  });

  it('a stopped request ends the running dry run, keeps it stopped, and releases the pin', async () => {
    const s = setup();
    s.r.driver.slice = () => new Promise(() => {}); // the helper never finishes a slice
    s.request();
    s.dry.tick([LAPTOP]);
    await s.until(() => s.audits.some((a) => a.event === 'borrowed-dry-run-start'));
    s.request('stopped');
    s.dry.tick([LAPTOP]);
    await s.until(() => !s.dry.isRunning('m_laptop'));
    expect(s.audits.find((a) => a.event === 'borrowed-dry-run-end')).toMatchObject({ finished: false, stopped: true });
    expect(s.store.get('m_laptop').dryRunIntent?.state).toBe('stopped');
    const b = s.baseline.read();
    expect(b.ok && b.file.pinned).toEqual([]);
  });
});
