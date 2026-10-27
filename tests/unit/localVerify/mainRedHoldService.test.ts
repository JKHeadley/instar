// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 tests for the main-red hold inside LocalVerifyService (CMT-1033): while `main`
 * fails a known check, repair candidates run first, every other PR entry waits, the read
 * surface and the POST answer say why, ONE deduped item per red episode names the failing
 * check and the PRs fixing it (refreshed only when that list changes, closed on green), a repair is admitted past a full queue, green releases the hold, the failing
 * files survive a restart, and the kill switch restores the old order.
 * Real fs in a temp state dir; the child process, gh and the clock are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS, computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const MIN = 60_000;
const FILE = 'tests/unit/no-silent-fallbacks.test.ts';
const HOLD_KEY = 'local-verify:main-red-hold';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'mainRedHoldService.test.ts' }); });

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
  };
}
const mainRecord = (head: string, outcome: 'success' | 'failure'): LocalVerifyRecord => record({ kind: 'main', pr: 0, headSha: head, baseSha: head, outcome });
const ok = (r: LocalVerifyRecord): VerifyRunResult => ({ kind: 'record', record: r, reasons: [], overlaps: [], keptWorktree: null });
/** A failed `main` run naming the one failing file (the 2026-10-26 shape). */
const redMain = (head: string): VerifyRunResult => ({
  kind: 'record', record: mainRecord(head, 'failure'), overlaps: [], keptWorktree: null,
  reasons: ['lane-failed:unit:1', `file-failed:${FILE}:1`],
  failures: [{ file: FILE, lane: 'unit', failed: 1, message: 'no new silent fallbacks beyond tracked baseline: AssertionError: expected 495 to be less than or equal to 494' }],
});
const view = (head: string, over: Partial<PrView> = {}): PrView => ({
  author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: head, baseRefName: 'main', baseRefOid: sha('b'),
  title: 'chore: unrelated', body: 'nothing about the check', files: [{ path: 'src/core/Foo.ts' }], ...over,
});

function setup(opts: { views: Record<number, PrView>; stateDir?: string; holdEnabled?: () => boolean }) {
  const stateDir = opts.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvhold-')));
  if (!opts.stateDir) {
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
    }));
  }
  const spawned: Array<{ inputPath: string; resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
  const cleared: Array<{ key: string; resolution: string }> = [];
  let t = Date.parse('2026-10-26T13:00:00.000Z');
  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => opts.views[pr] ?? null,
    isPrOpen: async () => true,
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      spawned.push({ inputPath: a.args[a.args.indexOf('--input') + 1], resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
      return { pid: 7000 + spawned.length, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => [],
    isAncestor: async () => false,
    signal: (key, detail) => { signals.push({ key, detail }); },
    clearSignal: (key, resolution) => { cleared.push({ key, resolution }); },
    now: () => t,
    setTimer: () => {},
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/x/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, seams);
  if (opts.holdEnabled) svc.setMainRedHoldEnabled(opts.holdEnabled);
  const finish = async (i: number, result: VerifyRunResult) => {
    fs.writeFileSync(spawned[i].resultPath, JSON.stringify(result));
    spawned[i].resolve({ status: 0, signal: null });
    await new Promise((r) => setImmediate(r));
    await svc.settle();
    await new Promise((r) => setImmediate(r));
  };
  const inputOf = (i: number) => JSON.parse(fs.readFileSync(spawned[i].inputPath, 'utf-8')) as { pr: number; headSha: string; kind?: string };
  const auditLines = () => fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  /** Drive `main` to a failed head: first failure (main-suspect) and, when asked, the failed re-run (main-red). */
  const goRed = async (head: string, red: boolean) => {
    svc.noteMainHead(head);
    const first = spawned.length - 1;
    expect(inputOf(first)).toMatchObject({ kind: 'main', headSha: head });
    await finish(first, redMain(head));
    if (!red) return;
    const rerun = spawned.length - 1;
    expect(inputOf(rerun)).toMatchObject({ kind: 'main', headSha: head });
    await finish(rerun, redMain(head));
    expect(svc.mainHealth().state).toBe('main-red');
  };
  return { svc, stateDir, spawned, signals, cleared, finish, inputOf, auditLines, goRed, advance: (ms: number) => { t += ms; } };
}

describe('main-red hold — the queue while main fails a known check', () => {
  it('holds every PR that neither touches nor names the failing file; a repair candidate runs first; the read surface and the POST answer say why', async () => {
    const s = setup({ views: {
      2363: view(sha('1')),
      2364: view(sha('2'), { files: null }), // file list unreadable, no mention ⇒ held (files-unknown)
      2372: view(sha('3'), { title: 'fix(tests): main red on no-silent-fallbacks after #2367', files: [{ path: 'src/server/routes.ts' }] }),
      2375: view(sha('4')),
    } });
    // main's head moves: its verify starts at once (boot skips the debounce)…
    s.svc.noteMainHead(sha('e'));
    expect(s.inputOf(0)).toMatchObject({ kind: 'main', headSha: sha('e') });
    // …and three PRs are queued behind it while main is still healthy (the watcher's requests).
    for (const pr of [2363, 2364, 2372]) expect((await s.svc.request(pr, { explicit: false })).ok).toBe(true);
    expect(s.svc.snapshot().mainRedHold).toBeNull();
    // main fails on one file (main-suspect, re-run pending). Suspect alternates main/PR starts, and
    // of the three waiting PRs only the repair candidate (2372) may take the slot — not 2363, queued first.
    await s.finish(0, redMain(sha('e')));
    expect(s.svc.mainHealth().state).toBe('main-suspect');
    expect(s.inputOf(1)).toMatchObject({ pr: 2372 });
    const snap = s.svc.snapshot();
    expect(snap.mainRedHold).toMatchObject({ reason: 'main-red', state: 'main-suspect', redHead: sha('e'), failingFiles: [FILE], repairPrs: [2372], heldPrs: [2363, 2364] });
    expect(snap.mainRedHold?.detail).toContain('main is failing (re-run pending)');
    expect(snap.mainRedHold?.detail).toContain('PR #2372 is already fixing it');
    expect(snap.queue.find((e) => e.pr === 2363)).toMatchObject({ held: { reason: 'main-red', why: 'no-overlap' } });
    expect(snap.queue.find((e) => e.pr === 2364)).toMatchObject({ held: { reason: 'main-red', why: 'files-unknown' } });
    expect(snap.queue.find((e) => e.pr === 2364)).not.toHaveProperty('text'); // the PR body stays off the read surface
    // A new unrelated POST while held: queued, with the hold in the answer.
    const r = await s.svc.request(2375);
    expect(r).toMatchObject({ ok: true, status: 'queued', hold: { reason: 'main-red', failingFiles: [FILE], repairPrs: [2372], heldPrs: [2363, 2364, 2375] } });
    expect(s.spawned).toHaveLength(2); // nothing doomed started
    // The repair's own verify is unaffected; then the re-run of main runs; held PRs still wait.
    await s.finish(1, ok(record({ pr: 2372, headSha: sha('3') })));
    expect(s.svc.getRecord(2372, sha('3'), 'main')?.outcome).toBe('success');
    expect(s.inputOf(2)).toMatchObject({ kind: 'main', headSha: sha('e') });
    await s.finish(2, redMain(sha('e')));
    expect(s.svc.mainHealth().state).toBe('main-red');
    expect(s.spawned).toHaveLength(3);
    expect(s.svc.snapshot().inFlight).toBeNull();
    // 2372 left the queue (verified, waiting to merge) but is still the PR fixing it.
    expect(s.svc.snapshot().mainRedHold).toMatchObject({ state: 'main-red', repairPrs: [2372], heldPrs: [2363, 2364, 2375] });
    expect(s.auditLines().filter((l) => l.event === 'main-red-held').map((l) => l.pr)).toEqual([2363, 2364, 2375]);
    expect(s.auditLines().filter((l) => l.event === 'main-red-hold-idle')).toHaveLength(1);
    // The main-red signal carries the hold split as it was at that moment, and once red the repair item names 2372.
    const red = s.signals.find((x) => x.key === 'local-verify:main-red');
    expect(red?.detail.runDetail).toMatchObject({ hold: { failingFiles: [FILE], repairPrs: [], heldPrs: [2363, 2364, 2375] } });
    expect(s.signals.map((x) => x.key)).toEqual(['local-verify:main-red', HOLD_KEY]);
    expect(s.signals[1].detail).toMatchObject({ failingFiles: [FILE], repairPrs: [{ pr: 2372, by: 'names-file', file: FILE }], heldPrs: [2363, 2364, 2375] });
    expect(String(s.signals[1].detail.note)).toContain('Already fixing it: PR #2372');
  });

  it('once main is RED, ONE item names the failing check and the PRs fixing it, refreshed only when that list changes; a renamed PR becomes a candidate', async () => {
    const s = setup({ views: {
      2363: view(sha('1')),
      2373: view(sha('2'), { title: 'fix(ratchet): main is over its own silent-fallback baseline', body: `\`${FILE}\` counts catch blocks`, files: [{ path: 'src/core/machineLoadReport.ts' }] }),
    } });
    await s.goRed(sha('e'), true);
    expect((await s.svc.request(2363)).hold?.heldPrs).toEqual([2363]);
    const holdSignals = () => s.signals.filter((x) => x.key === HOLD_KEY);
    expect(holdSignals().map((x) => x.key)).toEqual([HOLD_KEY]);
    expect(String(holdSignals()[0].detail.note)).toContain('No queued PR is fixing it yet');
    expect(s.spawned).toHaveLength(2); // the two main runs; 2363 is held
    expect((await s.svc.request(2373)).hold).toBeUndefined(); // a candidate is not held
    expect(s.inputOf(2)).toMatchObject({ pr: 2373 });
    // The same item (same id) is re-raised with 2373 named; nothing else.
    expect(holdSignals().map((x) => x.key)).toEqual([HOLD_KEY, HOLD_KEY]);
    expect(holdSignals()[1].detail).toMatchObject({ repairPrs: [{ pr: 2373, by: 'names-file', file: FILE }], heldPrs: [2363] });
    expect(String(holdSignals()[1].detail.note)).toContain('Already fixing it: PR #2373');
    // Re-requesting the same PR raises nothing new (the fixing list did not change).
    const before = s.signals.length;
    expect((await s.svc.request(2373)).status).toBe('in-flight');
    expect(s.signals).toHaveLength(before);
    // The author renames the held PR to say it fixes the check: it becomes a candidate and starts after 2373.
    await s.finish(2, ok(record({ pr: 2373, headSha: sha('2') })));
    expect(s.spawned).toHaveLength(3); // 2363 still held
    const renamed = view(sha('1'), { title: 'fix: also no-silent-fallbacks' });
    (s.svc as unknown as { seams: { prView: (pr: number) => Promise<PrView | null> } }).seams.prView = async (pr) => (pr === 2363 ? renamed : null);
    expect(await s.svc.request(2363)).toMatchObject({ ok: true, status: 'already-queued' });
    expect(s.inputOf(3)).toMatchObject({ pr: 2363 });
    expect(holdSignals().map((x) => x.key)).toEqual([HOLD_KEY, HOLD_KEY, HOLD_KEY]);
    // 2363 is running; 2373 (verified, waiting to merge) is still fixing it.
    expect(holdSignals().at(-1)?.detail).toMatchObject({ heldPrs: [] });
    expect((holdSignals().at(-1)?.detail.repairPrs as Array<{ pr: number }>).map((r) => r.pr).sort()).toEqual([2363, 2373]);
    expect(s.cleared).toEqual([]);
    // 2363 finishes while main stays red: the same two PRs, in another order (both remembered now). No repost.
    const n = holdSignals().length;
    await s.finish(3, ok(record({ pr: 2363, headSha: sha('1') })));
    s.svc.snapshot();
    await s.svc.tick();
    expect(holdSignals()).toHaveLength(n);
    expect(String(holdSignals().at(-1)?.detail.note)).toContain('Already fixing it: PR #2363, PR #2373');
  });

  it('a labelled repair past a full queue keeps its repair audit (the throughput overflow does not claim it)', async () => {
    const views: Record<number, PrView> = {};
    for (let i = 1; i <= 10; i++) views[i] = view((i.toString(16).padStart(2, '0')).repeat(20));
    views[12] = view(sha('c'), { files: [{ path: FILE }], labels: [{ name: 'merge-throughput' }] });
    views[14] = view(sha('d'), { labels: [{ name: 'merge-throughput' }] }); // labelled, not a repair
    const s = setup({ views });
    await s.goRed(sha('e'), true);
    for (let i = 1; i <= 10; i++) expect((await s.svc.request(i)).ok).toBe(true);
    expect(await s.svc.request(12)).toMatchObject({ ok: true, status: 'queued' });
    expect(s.auditLines().filter((l) => l.event === 'queue-full-repair-admitted').map((l) => l.pr)).toEqual([12]);
    // A labelled non-repair uses the overflow but is still held by the main-red hold like any other PR.
    expect(await s.svc.request(14)).toMatchObject({ ok: true, status: 'queued' });
    expect(s.auditLines().filter((l) => l.event === 'queue-full-throughput-admitted').map((l) => l.pr)).toEqual([14]);
    expect(s.svc.snapshot().queue.find((e) => e.pr === 14)?.held).toBeTruthy();
  });

  it('a repair is admitted past a full queue of held PRs; green releases the hold in queue order and clears the episode', async () => {
    const views: Record<number, PrView> = {};
    for (let i = 1; i <= 10; i++) views[i] = view((i.toString(16).padStart(2, '0')).repeat(20));
    views[11] = view(sha('a'));
    views[12] = view(sha('c'), { files: [{ path: FILE }] }); // touches the failing file
    views[13] = view(sha('d'), { files: [{ path: FILE }] });
    const s = setup({ views });
    await s.goRed(sha('e'), true);
    for (let i = 1; i <= 10; i++) expect((await s.svc.request(i)).ok).toBe(true);
    expect(s.svc.snapshot().queue.filter((e) => e.kind !== 'main')).toHaveLength(LOCAL_VERIFY_LIMITS.queueCap);
    expect(await s.svc.request(11)).toEqual({ ok: false, code: 'queue-full' });
    expect(await s.svc.request(12)).toMatchObject({ ok: true, status: 'queued' }); // the repair gets in
    expect(s.inputOf(2)).toMatchObject({ pr: 12 });
    expect(s.auditLines().filter((l) => l.event === 'queue-full-repair-admitted').map((l) => l.pr)).toEqual([12]);
    expect(s.auditLines().filter((l) => l.event === 'queue-full').at(-1)).toMatchObject({ pr: 11, mainRedHold: true });
    await s.finish(2, ok(record({ pr: 12, headSha: sha('c') })));
    expect(s.svc.snapshot().inFlight).toBeNull(); // the 10 held PRs still wait
    // main moves to a green head: the hold lifts, the held PRs start in queue order, the failure file is gone.
    s.svc.noteMainHead(sha('f')); s.advance(10 * MIN); s.svc.noteMainHead(sha('f'));
    (s.svc as unknown as { seams: { isAncestor: (a: string, d: string) => Promise<boolean | null> } }).seams.isAncestor = async () => true;
    expect(s.inputOf(3)).toMatchObject({ kind: 'main', headSha: sha('f') });
    await s.finish(3, ok(mainRecord(sha('f'), 'success')));
    expect(s.svc.mainHealth().state).toBe('healthy');
    expect(s.svc.snapshot().mainRedHold).toBeNull();
    expect(s.inputOf(4)).toMatchObject({ pr: 1 });
    expect(fs.existsSync(path.join(s.stateDir, 'state', 'local-verify', 'main-failure.json'))).toBe(false);
    // A later candidate (13) after green is an ordinary queue entry — no repair item.
    expect((await s.svc.request(13)).hold).toBeUndefined();
    const holdItems = s.signals.filter((x) => x.key === HOLD_KEY);
    expect(new Set(holdItems.map((x) => x.key))).toEqual(new Set([HOLD_KEY])); // one item for the whole episode
    expect((holdItems.at(-1)?.detail.repairPrs as Array<{ pr: number }>).map((r) => r.pr)).toEqual([12]);
    // Green closed it.
    expect(s.cleared).toEqual([{ key: HOLD_KEY, resolution: 'main is green again' }]);
  });

  it('the failing files survive a restart (boot re-reads them) so the hold does not drop with the server; a stale file for another head holds nothing', async () => {
    const s = setup({ views: { 2363: view(sha('1')) } });
    await s.goRed(sha('e'), true);
    const file = path.join(s.stateDir, 'state', 'local-verify', 'main-failure.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ v: 1, detail: { headSha: sha('e'), files: [FILE] } });
    // A new server over the same state dir (the red watermark + the failure file).
    const s2 = setup({ views: { 2363: view(sha('1')) }, stateDir: s.stateDir });
    await s2.svc.boot();
    expect(s2.svc.mainHealth().state).toBe('main-red');
    expect((await s2.svc.request(2363)).hold).toMatchObject({ failingFiles: [FILE], heldPrs: [2363] });
    expect(s2.spawned.filter((_, i) => s2.inputOf(i).kind !== 'main')).toHaveLength(0);
    // A failure file for a different head than the watermark's red head is ignored (no hold, today's order).
    fs.writeFileSync(file, JSON.stringify({ v: 1, detail: { headSha: sha('9'), files: [FILE], reasons: [], messages: {}, recordedAt: 'x' } }));
    const s3 = setup({ views: { 2363: view(sha('1')) }, stateDir: s.stateDir });
    await s3.svc.boot();
    expect(s3.svc.snapshot().mainRedHold).toBeNull();
    expect((await s3.svc.request(2363)).ok).toBe(true); // restored from queue.json, and now started
    expect(s3.spawned.some((_, i) => s3.inputOf(i).pr === 2363)).toBe(true);
  });

  it('after a restart with nothing in memory, green still closes the hold item (stable id, no memory needed); one red head = one item', async () => {
    const s = setup({ views: {} });
    await s.goRed(sha('e'), true);
    const s2 = setup({ views: {}, stateDir: s.stateDir });
    await s2.svc.boot();
    expect(s2.svc.mainHealth().state).toBe('main-red');
    s2.svc.noteMainHead(sha('f')); s2.advance(10 * MIN); s2.svc.noteMainHead(sha('f'));
    (s2.svc as unknown as { seams: { isAncestor: (a: string, d: string) => Promise<boolean | null> } }).seams.isAncestor = async () => true;
    const i = s2.spawned.findIndex((_, k) => s2.inputOf(k).kind === 'main' && s2.inputOf(k).headSha === sha('f'));
    expect(i).toBeGreaterThanOrEqual(0);
    await s2.finish(i, ok(mainRecord(sha('f'), 'success')));
    expect(s2.svc.mainHealth().state).toBe('healthy');
    expect(s2.cleared).toEqual([{ key: HOLD_KEY, resolution: 'main is green again' }]);
  });

  it('the kill switch (monitoring.localVerify.mainRedHold: false) restores the old order: every PR runs while red', async () => {
    let on = false;
    const s = setup({ views: { 2363: view(sha('1')) }, holdEnabled: () => on });
    await s.goRed(sha('e'), true);
    expect(await s.svc.request(2363)).toMatchObject({ ok: true, status: 'queued' });
    expect(s.inputOf(2)).toMatchObject({ pr: 2363 });
    expect(s.svc.snapshot().mainRedHold).toBeNull();
    // Flipped on live: the next unrelated PR waits.
    on = true;
    (s.svc as unknown as { seams: { prView: (pr: number) => Promise<PrView | null> } }).seams.prView = async (pr) => (pr === 2364 ? view(sha('2')) : null);
    await s.finish(2, ok(record({ pr: 2363, headSha: sha('1'), outcome: 'failure' })));
    expect((await s.svc.request(2364)).hold?.heldPrs).toEqual([2364]);
    expect(s.spawned).toHaveLength(3);
  });

  it('a failed main that names no file holds nothing (there is nothing to match a repair against)', async () => {
    const s = setup({ views: { 2363: view(sha('1')) } });
    s.svc.noteMainHead(sha('e'));
    await s.finish(0, { ...ok(mainRecord(sha('e'), 'failure')), reasons: ['dirty-tree'] });
    await s.finish(1, { ...ok(mainRecord(sha('e'), 'failure')), reasons: ['dirty-tree'] });
    expect(s.svc.mainHealth().state).toBe('main-red');
    expect(s.svc.snapshot().mainRedHold).toBeNull();
    expect(await s.svc.request(2363)).toMatchObject({ ok: true, status: 'queued' });
    expect(s.inputOf(2)).toMatchObject({ pr: 2363 });
  });
});
