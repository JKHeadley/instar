// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 tests for the Local Verify waiting list inside LocalVerifyService (fb-7fde7f49-8ee):
 * a PR refused for a full queue keeps its place; when a slot frees, the oldest live waiter
 * goes first and a newer PR does not take the slot; a closed waiter is removed; a stale
 * waiter cannot stall admission; the list and the carried firstRefusedAt survive a restart;
 * and repair admission, the merge-throughput overflow and keptPlace re-queues are unchanged.
 * Real fs in a temp state dir; the child process, gh and the clock are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, MERGE_THROUGHPUT_LABEL, THROUGHPUT_AGING_MS, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS, computePolicyHash } from '../../../src/localVerify/policy.js';
import { WAITING_LIST_LIMITS } from '../../../src/localVerify/waitingList.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';

const REPO = 'JKHeadley/instar';
const MIN = 60_000;
const CAP = LOCAL_VERIFY_LIMITS.queueCap;
const FILE = 'tests/unit/no-silent-fallbacks.test.ts';
const sha = (c: string) => c.repeat(40);
/** A distinct valid head per PR number. */
const head = (pr: number, v = 0) => `${'d'.repeat(34)}${v.toString(16).padStart(2, '0')}${pr.toString(16).padStart(4, '0')}`;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'waitingListService.test.ts' }); });

const view = (pr: number, over: Partial<PrView> = {}): PrView => ({
  author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: `echo/pr-${pr}`, headRefOid: head(pr), baseRefName: 'main', baseRefOid: sha('b'),
  title: 'chore: unrelated', body: 'nothing about the check', files: [{ path: 'src/core/Foo.ts' }], ...over,
});

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-11-07T10:00:00.000Z', finishedAt: '2026-11-07T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
  };
}
const ok = (r: LocalVerifyRecord): VerifyRunResult => ({ kind: 'record', record: r, reasons: [], overlaps: [], keptWorktree: null });
const mainRecord = (h: string, outcome: 'success' | 'failure'): LocalVerifyRecord => record({ kind: 'main', pr: 0, headSha: h, baseSha: h, outcome });
const redMain = (h: string): VerifyRunResult => ({
  kind: 'record', record: mainRecord(h, 'failure'), overlaps: [], keptWorktree: null,
  reasons: ['lane-failed:unit:1', `file-failed:${FILE}:1`],
  failures: [{ file: FILE, lane: 'unit', failed: 1, message: 'expected 495 to be less than or equal to 494' }],
});

function setup(opts: { views: Record<number, PrView>; stateDir?: string; startAt?: number }) {
  const stateDir = opts.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvwait-')));
  if (!opts.stateDir) {
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-11-07T00:00:00.000Z',
    }));
  }
  const open: Record<number, boolean> = {};
  const spawned: Array<{ inputPath: string; resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  let t = opts.startAt ?? Date.parse('2026-11-07T12:00:00.000Z');
  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => opts.views[pr] ?? null,
    isPrOpen: async (pr) => open[pr] ?? true,
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
    signal: () => {},
    clearSignal: () => {},
    now: () => t,
    setTimer: () => {},
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/x/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, seams);
  const flush = async () => { await new Promise((r) => setImmediate(r)); await svc.settle(); await new Promise((r) => setImmediate(r)); };
  const finish = async (i: number, result: VerifyRunResult) => {
    fs.writeFileSync(spawned[i].resultPath, JSON.stringify(result));
    spawned[i].resolve({ status: 0, signal: null });
    await flush();
  };
  const inputOf = (i: number) => JSON.parse(fs.readFileSync(spawned[i].inputPath, 'utf-8')) as { pr: number; headSha: string; kind?: string };
  const audit = () => fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const prQueue = () => svc.snapshot().queue.filter((e) => e.kind !== 'main').map((e) => e.pr);
  /** Finish whichever PR run is in flight (green), freeing one queue slot as the next starts. */
  const finishCurrent = async () => {
    const i = spawned.length - 1;
    const input = inputOf(i);
    await finish(i, ok(record({ pr: input.pr, headSha: input.headSha })));
  };
  return { svc, stateDir, open, spawned, finish, finishCurrent, inputOf, audit, prQueue, advance: (ms: number) => { t += ms; }, now: () => t };
}

/** PR 1 runs; PRs 2..CAP+1 fill the queue. */
async function fill(s: ReturnType<typeof setup>): Promise<void> {
  for (let pr = 1; pr <= CAP + 1; pr++) expect((await s.svc.request(pr, { explicit: false })).ok).toBe(true);
  expect(s.prQueue()).toHaveLength(CAP);
}

function views(...prs: number[]): Record<number, PrView> {
  const v: Record<number, PrView> = {};
  for (let pr = 1; pr <= CAP + 1; pr++) v[pr] = view(pr);
  for (const pr of prs) v[pr] = view(pr);
  return v;
}

describe('Local Verify waiting list (fb-7fde7f49-8ee)', () => {
  it('the oldest waiter is admitted first; a newer PR does not take the freed slot', async () => {
    const s = setup({ views: views(50, 60, 70) });
    await fill(s);
    expect(await s.svc.request(50, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    s.advance(MIN);
    expect(await s.svc.request(60, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(s.svc.snapshot().waiting.map((w) => w.pr)).toEqual([50, 60]);
    s.advance(10 * MIN);
    // Refused again on the next pass: the first refusal time is kept.
    expect(await s.svc.request(60, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(await s.svc.request(50, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    const first50 = s.svc.snapshot().waiting.find((w) => w.pr === 50)!;
    expect(first50).toMatchObject({ refusals: 2, live: true });

    await s.finishCurrent(); // one slot frees
    expect(s.prQueue()).toHaveLength(CAP - 1);
    // A newer PR and the second waiter both ask first: neither takes the slot.
    expect(await s.svc.request(70, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(await s.svc.request(60, { explicit: true })).toEqual({ ok: false, code: 'queue-full' });
    expect(s.audit().filter((l) => l.event === 'queue-full-waiting').map((l) => [l.pr, l.waitPosition])).toEqual([[70, 3], [60, 2]]);
    expect(s.prQueue()).toHaveLength(CAP - 1);
    // The oldest waiter gets it, carrying its first refusal onto the entry and the audit.
    expect(await s.svc.request(50, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    const entry = s.svc.snapshot().queue.find((e) => e.pr === 50)!;
    expect(entry.firstRefusedAt).toBe(first50.firstRefusedAt);
    const queued = s.audit().filter((l) => l.event === 'queued' && l.pr === 50).at(-1)!;
    expect(queued).toMatchObject({ firstRefusedAt: first50.firstRefusedAt, refusedWaitMs: 11 * MIN });
    expect(s.svc.snapshot().waiting.map((w) => w.pr)).toEqual([60, 70]);

    // The next slot goes to 60 (refused before 70), and the start audit carries the wait.
    await s.finishCurrent();
    expect(await s.svc.request(70, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(await s.svc.request(60, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
  });

  it('two free slots admit a non-oldest waiter while one slot is left for the oldest', async () => {
    const s = setup({ views: views(50, 60) });
    await fill(s);
    await s.svc.request(50, { explicit: false });
    await s.svc.request(60, { explicit: false });
    // Remove two queued PRs (closed) so two slots are free.
    s.open[2] = false; s.open[3] = false;
    await s.svc.request(2); await s.svc.request(3);
    expect(s.prQueue()).toHaveLength(CAP - 2);
    expect(await s.svc.request(60, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    expect(await s.svc.request(50, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
  });

  it('a closed or merged waiter is removed (on its next offer, and by the tick sweep without one)', async () => {
    const s = setup({ views: views(50, 60, 70) });
    await fill(s);
    for (const pr of [50, 60]) await s.svc.request(pr, { explicit: false });
    s.open[50] = false;
    expect(await s.svc.request(50)).toEqual({ ok: false, code: 'pr-closed' });
    expect(s.svc.snapshot().waiting.map((w) => w.pr)).toEqual([60]);
    // 60 merges and is never offered again: the sweep finds it.
    s.open[60] = false;
    s.advance(WAITING_LIST_LIMITS.closedSweepEveryMs);
    await s.svc.tick();
    expect(s.svc.snapshot().waiting).toEqual([]);
    expect(s.audit().filter((l) => l.event === 'waiter-removed').map((l) => [l.pr, l.reason])).toEqual([[50, 'closed'], [60, 'closed']]);
    // With no waiter left, a freed slot goes to whoever asks.
    await s.finishCurrent();
    expect(await s.svc.request(70, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
  });

  it('a stale waiter (no longer offered) cannot stall the queue', async () => {
    const s = setup({ views: views(50, 70) });
    await fill(s);
    await s.svc.request(50, { explicit: false });
    await s.finishCurrent();
    // While 50 is live, 70 waits.
    expect(await s.svc.request(70, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    // 50 stops being offered (lost its approval, say). Past the stale window it reserves nothing.
    s.advance(WAITING_LIST_LIMITS.staleAfterMs + MIN);
    expect(s.svc.snapshot().waiting.find((w) => w.pr === 50)?.live).toBe(false);
    expect(await s.svc.request(70, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    // 70's own first refusal is carried, 50 keeps its (stale) place and regains it if offered again.
    expect(s.svc.snapshot().queue.find((e) => e.pr === 70)?.firstRefusedAt).toBeDefined();
    expect(s.svc.snapshot().waiting.map((w) => w.pr)).toEqual([50]);
    // Idle long enough, it is dropped.
    s.advance(WAITING_LIST_LIMITS.dropAfterMs);
    await s.svc.tick();
    expect(s.svc.snapshot().waiting).toEqual([]);
  });

  it('a waiter never holds a slot while nothing is queued, nor while main is unhealthy', async () => {
    const s = setup({ views: views(50, 70) });
    await fill(s);
    await s.svc.request(50, { explicit: false });
    // Drain the queue completely (all queued PRs close): the verifier must not idle for a reservation.
    for (let pr = 2; pr <= CAP + 1; pr++) { s.open[pr] = false; await s.svc.request(pr); }
    expect(s.prQueue()).toHaveLength(0);
    expect(await s.svc.request(70, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
  });

  it('the one-shot red→green failure re-run is not held back by the waiting list (nothing would offer it again)', async () => {
    const s = setup({ views: views(50) });
    await fill(s);
    await s.svc.request(50, { explicit: false }); // a live waiter
    await s.finish(0, ok(record({ pr: 1, headSha: head(1), outcome: 'failure' }))); // PR 1 fails; one slot frees
    expect(s.prQueue()).toHaveLength(CAP - 1);
    await (s.svc as unknown as { rerunFailures: () => Promise<void> }).rerunFailures();
    expect(s.audit().filter((l) => l.event === 'rerun-after-green').at(-1)).toMatchObject({ pr: 1, result: 'queued' });
    expect(s.prQueue()).toContain(1);
    expect(s.svc.snapshot().waiting.map((w) => w.pr)).toEqual([50]);
  });

  it('an explicit re-request of a failed PR refused for a waiter does not spend its one re-run on the new base', async () => {
    const v = views(50);
    const s = setup({ views: v });
    await fill(s);
    await s.svc.request(50, { explicit: false });
    s.advance(MIN);
    await s.finish(0, ok(record({ pr: 1, headSha: head(1), outcome: 'failure' })));
    v[1] = view(1, { baseRefOid: sha('c') }); // main moved: a new base for PR 1
    expect(await s.svc.request(1)).toEqual({ ok: false, code: 'queue-full' }); // 50 is ahead
    expect(await s.svc.request(50, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    await s.finishCurrent(); // a slot frees again
    expect(await s.svc.request(1)).toMatchObject({ ok: true, status: 'queued' }); // the re-run was not used up
  });

  it('a moved head keeps the PR its place in line', async () => {
    const v = views(50, 60);
    const s = setup({ views: v });
    await fill(s);
    await s.svc.request(50, { explicit: false });
    const first = s.svc.snapshot().waiting[0].firstRefusedAt;
    s.advance(MIN);
    await s.svc.request(60, { explicit: false });
    s.advance(5 * MIN);
    v[50] = view(50, { headRefOid: head(50, 1) }); // a new push
    expect(await s.svc.request(50, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(s.svc.snapshot().waiting.map((w) => [w.pr, w.firstRefusedAt])).toEqual([[50, first], [60, first + MIN]]);
    await s.finishCurrent();
    expect(await s.svc.request(60, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(await s.svc.request(50, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    expect(s.svc.snapshot().queue.find((e) => e.pr === 50)).toMatchObject({ headSha: head(50, 1), firstRefusedAt: first });
  });

  it('the list survives a restart (downtime is not idleness), and firstRefusedAt survives in the saved queue', async () => {
    const v = views(50, 60, 70);
    const s = setup({ views: v });
    await fill(s);
    await s.svc.request(50, { explicit: false });
    s.advance(MIN);
    await s.svc.request(60, { explicit: false });
    const saved = s.svc.snapshot().waiting.map((w) => [w.pr, w.firstRefusedAt]);
    s.svc.shutdown();
    expect(JSON.parse(fs.readFileSync(path.join(s.stateDir, 'state', 'local-verify', 'waiting.json'), 'utf-8')).waiters).toHaveLength(2);
    // Down for two hours (longer than the stale window): the waiters are still live after boot.
    const s2 = setup({ views: v, stateDir: s.stateDir, startAt: s.now() + 2 * 60 * MIN });
    await s2.svc.boot();
    expect(s2.svc.snapshot().waiting.map((w) => [w.pr, w.firstRefusedAt, w.live])).toEqual(saved.map(([pr, at]) => [pr, at, true]));
    s2.open[2] = false; await s2.svc.request(2); // a queued PR closes: one slot frees
    expect(await s2.svc.request(70, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(await s2.svc.request(60, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    expect(await s2.svc.request(50, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    // The admitted entry's firstRefusedAt is in the durable queue and comes back after another restart.
    s2.svc.shutdown();
    const q = JSON.parse(fs.readFileSync(path.join(s.stateDir, 'state', 'local-verify', 'queue.json'), 'utf-8')) as { entries: Array<{ pr: number; firstRefusedAt?: number }> };
    expect(q.entries.find((e) => e.pr === 50)?.firstRefusedAt).toBe(saved[0][1]);
    const s3 = setup({ views: v, stateDir: s.stateDir, startAt: s2.now() + MIN });
    await s3.svc.boot();
    expect(s3.svc.snapshot().queue.find((e) => e.pr === 50)?.firstRefusedAt).toBe(saved[0][1]);
  });

  it('an unreadable waiting file is moved aside and the list starts empty', async () => {
    const s = setup({ views: views() });
    fs.writeFileSync(path.join(s.stateDir, 'state', 'local-verify', 'waiting.json'), '{not json');
    await s.svc.boot();
    expect(s.svc.snapshot().waiting).toEqual([]);
    expect(s.audit().some((l) => l.event === 'waiting-restore-unreadable')).toBe(true);
    expect(fs.readdirSync(path.join(s.stateDir, 'state', 'local-verify')).some((f) => f.startsWith('waiting.json.corrupt-'))).toBe(true);
  });

  it('merge-throughput admission is unchanged: the overflow past a full queue, and no wait below the cap', async () => {
    const s = setup({ views: { ...views(50), 80: view(80, { labels: [{ name: MERGE_THROUGHPUT_LABEL }] }), 81: view(81, { labels: [{ name: MERGE_THROUGHPUT_LABEL }] }) } });
    await fill(s);
    await s.svc.request(50, { explicit: false }); // a live ordinary waiter
    expect(await s.svc.request(80, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    expect(s.audit().filter((l) => l.event === 'queue-full-throughput-admitted').map((l) => l.pr)).toEqual([80]);
    // Below the ordinary cap with a live waiter ahead, a labelled PR still gets in as before.
    await s.finishCurrent(); await s.finishCurrent();
    expect(s.prQueue().length).toBeLessThan(CAP);
    expect(await s.svc.request(81, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    expect(s.audit().some((l) => l.event === 'queue-full-waiting' && l.pr === 81)).toBe(false);
  });

  it('an ordinary waiter refused THROUGHPUT_AGING_MS ago shares the throughput overflow, bounded by the same cap', async () => {
    const labelled = (pr: number) => view(pr, { labels: [{ name: MERGE_THROUGHPUT_LABEL }] });
    const v: Record<number, PrView> = { ...views(50, 51) };
    for (let pr = 80; pr < 80 + LOCAL_VERIFY_LIMITS.throughputOverflow; pr++) v[pr] = labelled(pr);
    const s = setup({ views: v });
    await fill(s);
    expect(await s.svc.request(50, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    // Offered every 10 min (stays live): refused until it has waited the aging window.
    for (let waited = 10; waited < THROUGHPUT_AGING_MS / MIN; waited += 10) {
      s.advance(10 * MIN);
      expect(await s.svc.request(50, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    }
    s.advance(10 * MIN);
    expect(await s.svc.request(50, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    expect(s.audit().filter((l) => l.event === 'queue-full-throughput-admitted').at(-1)).toMatchObject({ pr: 50, agedWaiter: true });
    expect(s.svc.snapshot().waiting.map((w) => w.pr)).toEqual([]);
    // The overflow stays bounded: labelled PRs fill what is left, then an aged waiter is refused too.
    for (let pr = 80; pr < 80 + LOCAL_VERIFY_LIMITS.throughputOverflow - 1; pr++) {
      expect(await s.svc.request(pr, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    }
    expect(s.prQueue()).toHaveLength(CAP + LOCAL_VERIFY_LIMITS.throughputOverflow);
    expect(await s.svc.request(51, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
    s.advance(THROUGHPUT_AGING_MS);
    expect(await s.svc.request(51, { explicit: false })).toEqual({ ok: false, code: 'queue-full' });
  });

  it('a keptPlace re-queue (a pushed head of a queued PR) is never refused or made to wait', async () => {
    const v = views(50);
    const s = setup({ views: v });
    await fill(s);
    await s.svc.request(50, { explicit: false });
    const before = s.prQueue();
    v[5] = view(5, { headRefOid: head(5, 1) });
    expect(await s.svc.request(5, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    expect(s.prQueue()).toEqual(before);
    expect(s.audit().filter((l) => l.event === 'queued' && l.pr === 5).at(-1)).toMatchObject({ keptPlace: true });
  });

  it('repair admission during a main-red hold is unchanged; a refused non-repair joins the list', async () => {
    const v = views(50);
    v[12] = view(12, { files: [{ path: FILE }] }); // touches the failing file
    v[13] = view(13);
    const s = setup({ views: v });
    // Drive main red (first failure, then the failed re-run).
    const red = sha('e');
    s.svc.noteMainHead(red);
    await s.finish(s.spawned.length - 1, redMain(red));
    await s.finish(s.spawned.length - 1, redMain(red));
    expect(s.svc.mainHealth().state).toBe('main-red');
    for (let pr = 1; pr <= CAP; pr++) expect((await s.svc.request(pr)).ok).toBe(true);
    expect(s.prQueue()).toHaveLength(CAP);
    expect(await s.svc.request(13)).toEqual({ ok: false, code: 'queue-full' });
    expect(await s.svc.request(12)).toMatchObject({ ok: true, status: 'queued' });
    expect(s.audit().filter((l) => l.event === 'queue-full-repair-admitted').map((l) => l.pr)).toEqual([12]);
    expect(s.audit().filter((l) => l.event === 'queue-full').at(-1)).toMatchObject({ pr: 13, mainRedHold: true });
    expect(s.svc.snapshot().waiting.map((w) => w.pr)).toEqual([13]);
  });
});
