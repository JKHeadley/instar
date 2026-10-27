// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 tests for LocalVerifyService (spec local-verify-merge-authority.md §2:
 * queue, Keys, Retry transitions, Single flight, the in-flight protocol, the
 * completion journal and its boot rebuild). Real fs in a temp state dir; the
 * child process, gh, ps and the clock are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  LocalVerifyService, checkEligibility, decideBaseRefresh, decideMergeHandoff, decideStarved, INTERRUPTION_LIMITS, MERGE_LINE,
  MERGE_THROUGHPUT_LABEL, QUEUE_PRIORITY, THROUGHPUT_AGING_MS, effectivePriority, prPriority,
  type LocalVerifyServiceSeams, type PrView, type InFlightIntent, type MergeHandoffResult,
} from '../../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS, computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'LocalVerifyService.test.ts' }); });

function view(over: Partial<PrView> = {}): PrView {
  return {
    author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x',
    headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b'), ...over,
  };
}

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
  };
}

interface Spawned { pid: number; args: string[]; resultPath: string; token: string; resolve: (x: { status: number | null; signal: string | null }) => void; intentAtSpawn: InFlightIntent | null }

function setup(opts: { views?: Record<number, PrView>; open?: Record<number, boolean | null>; stateDir?: string; verifierVersion?: string } = {}) {
  const stateDir = opts.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvsvc-')));
  if (!opts.stateDir) {
    dirs.push(stateDir);
    // A healthy main-health watermark for this machine (main health has its own tests).
    fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
    }));
  }
  const views: Record<number, PrView> = opts.views ?? {};
  const open: Record<number, boolean | null> = opts.open ?? {};
  const spawned: Spawned[] = [];
  const alive = new Set<number>();
  const stubborn = new Set<number>();
  const kills: Array<{ pgid: number; signal: string }> = [];
  const procArgs = new Map<number, string>();
  const timers: Array<() => void> = [];
  const starved: Array<{ pr: number }> = [];
  const records: LocalVerifyRecord[] = [];
  const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
  let holders: number[] = [];
  /** What the verifier files on disk compute right now; null (the default) = unknown, never holds. */
  let diskVersion: string | null = null;
  let t = Date.parse('2026-10-21T12:00:00.000Z');
  let pid = 5000;
  const intentPath = path.join(stateDir, 'state', 'local-verify', 'inflight.json');

  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async (pr) => (pr in open ? open[pr] : true),
    spawnRun: (a) => {
      const p = ++pid;
      alive.add(p);
      let intentAtSpawn: InFlightIntent | null = null;
      try { intentAtSpawn = JSON.parse(fs.readFileSync(intentPath, 'utf-8')); } catch { /* none */ }
      let resolve!: Spawned['resolve'];
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      const resultPath = a.args[a.args.indexOf('--result') + 1];
      const token = a.args[a.args.indexOf('--attempt-token') + 1];
      spawned.push({ pid: p, args: [a.command, ...a.args], resultPath, token, resolve, intentAtSpawn });
      return { pid: p, exited };
    },
    isGroupAlive: (g) => alive.has(g),
    killGroup: (g, s) => { kills.push({ pgid: g, signal: s }); if (!stubborn.has(g)) alive.delete(g); },
    readProcessArgs: async (p) => procArgs.get(p) ?? null,
    foreignSuiteHolders: () => holders.map((pid) => ({ pid })),
    onStarved: (i) => { starved.push(i); },
    onRecord: (r) => { records.push(r); },
    signal: (key, detail) => { signals.push({ key, detail }); },
    installedVerifierVersion: () => diskVersion,
    now: () => t,
    setTimer: (fn) => { timers.push(fn); },
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: opts.verifierVersion ?? '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' },
  }, seams);

  const flush = () => new Promise((r) => setImmediate(r));
  /** Finish spawned run `i` with a result (or none = crash). */
  const finish = async (i: number, result: VerifyRunResult | null) => {
    const s = spawned[i];
    if (result) fs.writeFileSync(s.resultPath, JSON.stringify(result));
    alive.delete(s.pid);
    s.resolve({ status: 0, signal: null });
    await flush();
  };
  return {
    svc, stateDir, views, open, spawned, alive, stubborn, kills, procArgs, timers, starved, records, signals, intentPath,
    setHolders: (h: number[]) => { holders = h; },
    setDiskVersion: (v: string | null) => { diskVersion = v; },
    advance: (ms: number) => { t += ms; },
    finish, flush,
  };
}

const ok = (r: LocalVerifyRecord): VerifyRunResult => ({ kind: 'record', record: r, reasons: [], overlaps: [], keptWorktree: null });

describe('checkEligibility', () => {
  const logins = { expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley' };
  it('trusted logins from this repository are eligible', () => {
    expect(checkEligibility(view(), logins)).toEqual({ eligible: true });
    expect(checkEligibility(view({ author: { login: 'JKHeadley' } }), logins)).toEqual({ eligible: true });
  });
  it('anyone else, a fork, or a missing author is untrusted-head', () => {
    expect(checkEligibility(view({ author: { login: 'stranger' } }), logins)).toEqual({ eligible: false, reason: 'untrusted-head' });
    expect(checkEligibility(view({ isCrossRepository: true }), logins)).toEqual({ eligible: false, reason: 'untrusted-head' });
    expect(checkEligibility(view({ author: null }), logins)).toEqual({ eligible: false, reason: 'untrusted-head' });
    expect(checkEligibility(view({ author: { login: 'JKHeadley' } }), { expectedGhLogin: 'EchoOfDawn' })).toEqual({ eligible: false, reason: 'untrusted-head' });
  });
});

describe('request + queue', () => {
  it("verifies against the base branch's CURRENT head, not the PR's stale baseRefOid", async () => {
    const s = setup({ views: { 1: view({ baseRefOid: sha('b') }) } });
    (s.svc as unknown as { seams: { baseHead?: (b: string) => Promise<string | null> } }).seams.baseHead = async (b) => (b === 'main' ? sha('c') : null);
    expect(await s.svc.request(1)).toMatchObject({ ok: true, status: 'queued' });
    const input = JSON.parse(fs.readFileSync(s.spawned[0].args[s.spawned[0].args.indexOf('--input') + 1], 'utf-8'));
    expect(input.baseSha).toBe(sha('c'));
  });

  it('refuses rather than fall back to the stale base when the current base cannot be read', async () => {
    const s = setup({ views: { 1: view() } });
    (s.svc as unknown as { seams: { baseHead?: (b: string) => Promise<string | null> } }).seams.baseHead = async () => null;
    expect(await s.svc.request(1)).toEqual({ ok: false, code: 'pr-unreadable' });
    expect(s.spawned).toHaveLength(0);
  });

  it('refuses an untrusted head, an unreadable PR and an invalid number', async () => {
    const s = setup({ views: { 1: view({ isCrossRepository: true }) } });
    expect(await s.svc.request(1)).toEqual({ ok: false, code: 'untrusted-head' });
    expect(await s.svc.request(2)).toEqual({ ok: false, code: 'pr-unreadable' });
    expect(await s.svc.request(0)).toEqual({ ok: false, code: 'invalid-pr' });
    expect(s.spawned).toHaveLength(0);
  });

  it('writes the intent before the spawn and patches pid after; spawns nice + node + token', async () => {
    const s = setup({ views: { 1: view() } });
    expect(await s.svc.request(1)).toMatchObject({ ok: true, status: 'queued' });
    const sp = s.spawned[0];
    expect(sp.intentAtSpawn).toMatchObject({ pr: 1, attemptToken: sp.token, pid: null, pgid: null });
    expect(JSON.parse(fs.readFileSync(s.intentPath, 'utf-8'))).toMatchObject({ pid: sp.pid, pgid: sp.pid });
    expect(sp.args.slice(0, 4)).toEqual(['nice', '-n', '10', '/usr/bin/node']);
    expect(sp.args).toContain('--attempt-token');
    await s.finish(0, ok(record()));
    expect(fs.existsSync(s.intentPath)).toBe(false);
  });

  it('one pending entry per PR, cap 10, one run at a time', async () => {
    const views: Record<number, PrView> = {};
    for (let i = 1; i <= 12; i++) views[i] = view({ headRefOid: sha(String(i % 10)), baseRefOid: sha('b') });
    views[12] = view({ headRefOid: sha('f') });
    views[11] = view({ headRefOid: sha('e') });
    const s = setup({ views });
    for (let i = 1; i <= 11; i++) expect((await s.svc.request(i)).ok).toBe(true);
    expect(s.spawned).toHaveLength(1);
    expect(s.svc.snapshot().queue).toHaveLength(10);
    expect(await s.svc.request(12)).toEqual({ ok: false, code: 'queue-full' });
    expect(await s.svc.request(5)).toMatchObject({ ok: true, status: 'already-queued' });
    expect(await s.svc.request(1)).toMatchObject({ ok: true, status: 'in-flight' });
  });

  it('a moved head replaces the pending entry', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    s.views[2] = view({ headRefOid: sha('e') });
    await s.svc.request(2);
    const q = s.svc.snapshot().queue;
    expect(q).toHaveLength(1);
    expect(q[0].headSha).toBe(sha('e'));
  });

  it('a moved head cancels the in-flight run for the old head; the cancelled run writes no record', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    s.views[1] = view({ headRefOid: sha('e') });
    await s.svc.request(1);
    expect(s.kills[0]).toEqual({ pgid: s.spawned[0].pid, signal: 'SIGTERM' });
    await s.finish(0, ok(record()));
    expect(s.records).toHaveLength(0);
    expect(s.spawned).toHaveLength(2);
    expect(s.spawned[1].args.join(' ')).toContain('--input');
    await s.finish(1, ok(record({ headSha: sha('e') })));
    expect(s.svc.getRecord(1, sha('e'), 'main')?.outcome).toBe('success');
    expect(s.svc.getRecord(1, sha('a'), 'main')).toBeNull();
  });

  it('the SIGKILL fallback fires after the grace when the group survives SIGTERM', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    s.stubborn.add(s.spawned[0].pid);
    s.views[1] = view({ headRefOid: sha('e') });
    await s.svc.request(1);
    s.timers.forEach((fn) => fn());
    expect(s.kills.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('merge-throughput label priority', () => {
  const MIN = 60_000;
  const labelled = (head: string) => view({ headRefOid: sha(head), labels: [{ name: MERGE_THROUGHPUT_LABEL }] });

  it('levels: the main verify > a labelled PR > an ordinary PR; labels come from the PR view', () => {
    expect(QUEUE_PRIORITY.main).toBeGreaterThan(QUEUE_PRIORITY.mergeThroughput);
    expect(QUEUE_PRIORITY.mergeThroughput).toBeGreaterThan(QUEUE_PRIORITY.ordinary);
    expect(prPriority(view({ labels: [{ name: 'hold' }, { name: MERGE_THROUGHPUT_LABEL }] }))).toBe(QUEUE_PRIORITY.mergeThroughput);
    expect(prPriority(view({ labels: [{ name: 'merge-throughput-ish' }] }))).toBe(QUEUE_PRIORITY.ordinary);
    expect(prPriority(view())).toBe(QUEUE_PRIORITY.ordinary);
    expect(prPriority(null)).toBe(QUEUE_PRIORITY.ordinary);
  });

  it('aging bounds the label: an ordinary PR that waited THROUGHPUT_AGING_MS (pauses excluded) ranks with it; main is never changed', () => {
    const t0 = 1_000_000;
    expect(effectivePriority({ priority: 0, firstQueuedAt: t0 }, t0 + THROUGHPUT_AGING_MS - 1)).toBe(0);
    expect(effectivePriority({ priority: 0, firstQueuedAt: t0 }, t0 + THROUGHPUT_AGING_MS)).toBe(QUEUE_PRIORITY.mergeThroughput);
    expect(effectivePriority({ priority: 0, firstQueuedAt: t0, pausedMs: 10 * MIN }, t0 + THROUGHPUT_AGING_MS)).toBe(0);
    expect(effectivePriority({ priority: QUEUE_PRIORITY.mergeThroughput, firstQueuedAt: t0 }, t0 + 10 * THROUGHPUT_AGING_MS)).toBe(QUEUE_PRIORITY.mergeThroughput);
    expect(effectivePriority({ priority: QUEUE_PRIORITY.main, kind: 'main', firstQueuedAt: t0 }, t0)).toBe(QUEUE_PRIORITY.main);
    // The bound sits well inside the starved alarm, which is unchanged.
    expect(THROUGHPUT_AGING_MS).toBeLessThan(LOCAL_VERIFY_LIMITS.starvedAfterMs);
  });

  it('a labelled PR queued after ordinary ones starts next', async () => {
    const s = setup({ views: { 1: view({ headRefOid: sha('1') }), 2: view({ headRefOid: sha('2') }), 3: labelled('3') } });
    for (const pr of [1, 2, 3]) expect((await s.svc.request(pr)).ok).toBe(true);
    expect(s.svc.snapshot().inFlight?.pr).toBe(1);
    expect(Object.fromEntries(s.svc.snapshot().queue.map((e) => [e.pr, e.priority]))).toEqual({ 2: 0, 3: QUEUE_PRIORITY.mergeThroughput });
    await s.finish(0, ok(record({ pr: 1, headSha: sha('1') })));
    expect(s.svc.snapshot().inFlight?.pr).toBe(3);
    await s.finish(1, ok(record({ pr: 3, headSha: sha('3') })));
    expect(s.svc.snapshot().inFlight?.pr).toBe(2);
  });

  it('an ordinary PR that has waited past the aging bound is not passed by a later labelled PR', async () => {
    const s = setup({ views: { 1: view({ headRefOid: sha('1') }), 2: view({ headRefOid: sha('2') }), 3: labelled('3') } });
    await s.svc.request(1);
    await s.svc.request(2);
    s.advance(THROUGHPUT_AGING_MS);
    await s.svc.request(3);
    await s.finish(0, ok(record({ pr: 1, headSha: sha('1') })));
    expect(s.svc.snapshot().inFlight?.pr).toBe(2);
  });

  it('a restore whose PR view cannot be read keeps the saved label level; a readable view re-reads it', async () => {
    const s = setup({ views: { 1: view({ headRefOid: sha('1') }), 2: labelled('2'), 3: labelled('3') } });
    for (const pr of [1, 2, 3]) await s.svc.request(pr);
    const saved = JSON.parse(fs.readFileSync(s.svc.queuePath, 'utf-8')) as { entries: Array<{ pr: number; priority?: number }> };
    expect(saved.entries.find((e) => e.pr === 2)?.priority).toBe(QUEUE_PRIORITY.mergeThroughput);
    expect(saved.entries.find((e) => e.pr === 1)?.priority).toBeUndefined();
    s.alive.clear();
    // PR 2's view is unreadable at boot; PR 3's label was removed meanwhile.
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view({ headRefOid: sha('1') }), 3: view({ headRefOid: sha('3') }) } });
    await s2.svc.boot();
    const pri = Object.fromEntries(s2.svc.snapshot().queue.map((e) => [e.pr, e.priority]));
    expect(pri).toMatchObject({ 2: QUEUE_PRIORITY.mergeThroughput, 3: QUEUE_PRIORITY.ordinary });
  });

  it('adding the label to an already-queued PR raises it in place; removing it lowers it', async () => {
    const s = setup({ views: { 1: view({ headRefOid: sha('1') }), 2: view({ headRefOid: sha('2') }), 3: view({ headRefOid: sha('3') }) } });
    for (const pr of [1, 2, 3]) await s.svc.request(pr);
    s.views[3] = labelled('3');
    expect(await s.svc.request(3)).toMatchObject({ ok: true, status: 'already-queued' });
    await s.finish(0, ok(record({ pr: 1, headSha: sha('1') })));
    expect(s.svc.snapshot().inFlight?.pr).toBe(3);
    s.views[2] = labelled('2');
    await s.svc.request(2);
    s.views[2] = view({ headRefOid: sha('2') });
    await s.svc.request(2);
    expect(s.svc.snapshot().queue.find((e) => e.pr === 2)?.priority).toBe(QUEUE_PRIORITY.ordinary);
  });
});

describe('keys and execution dedupe', () => {
  it('a success record answers a repeat request without a run', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(record()));
    expect(await s.svc.request(1)).toMatchObject({ ok: true, status: 'recorded' });
    expect(s.spawned).toHaveLength(1);
  });

  it('a second PR with the same head and base gets a derived record, not a second run', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefName: 'echo/y' }) } });
    await s.svc.request(1);
    await s.svc.request(2); // queued behind the same execution
    await s.finish(0, ok(record()));
    expect(s.spawned).toHaveLength(1);
    expect(s.svc.getRecord(2, sha('a'), 'main')).toMatchObject({ pr: 2, outcome: 'success' });
    const s3 = await s.svc.request(2);
    expect(s3).toMatchObject({ status: 'recorded' });
  });

  it('a retargeted PR (new baseRefName) has no matching record and is verified on its own', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(record()));
    s.views[1] = view({ baseRefName: 'release', baseRefOid: sha('c') });
    expect(await s.svc.request(1)).toMatchObject({ status: 'queued' });
    expect(s.svc.getRecord(1, sha('a'), 'release')).toBeNull();
  });
});

describe('retry table', () => {
  it('an error re-runs once automatically, then stays until someone asks', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(record({ outcome: 'error', errorStep: 'npm-ci', mergeTree: '' })));
    expect(s.spawned).toHaveLength(2);
    await s.finish(1, ok(record({ outcome: 'error', errorStep: 'npm-ci', mergeTree: '' })));
    expect(s.spawned).toHaveLength(2);
    expect(s.svc.getRecord(1, sha('a'), 'main')?.outcome).toBe('error');
    // A non-explicit (watcher) request leaves it; an explicit one re-runs.
    expect(await s.svc.request(1, { explicit: false })).toMatchObject({ status: 'recorded' });
    expect(await s.svc.request(1)).toMatchObject({ status: 'queued' });
    expect(s.spawned).toHaveLength(3);
  });

  it('a crash without a result is an error record with step crash, auto-retried once', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, null);
    expect(s.records[0]).toMatchObject({ outcome: 'error', errorStep: 'crash' });
    expect(s.spawned).toHaveLength(2);
  });

  it('a failure re-runs only on an explicit request against a new base, once per base', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(record({ outcome: 'failure' })));
    expect(await s.svc.request(1)).toMatchObject({ status: 'recorded' }); // same base
    s.views[1] = view({ baseRefOid: sha('c') });
    expect(await s.svc.request(1, { explicit: false })).toMatchObject({ status: 'recorded' }); // not asked
    expect(await s.svc.request(1)).toMatchObject({ status: 'queued' }); // asked, new base
    await s.finish(1, ok(record({ outcome: 'failure', baseSha: sha('c') })));
    expect(await s.svc.request(1)).toMatchObject({ status: 'recorded' }); // same new base again
    expect(s.spawned).toHaveLength(2);
  });

  it('a failure re-runs when the head moves', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(record({ outcome: 'failure' })));
    s.views[1] = view({ headRefOid: sha('e') });
    expect(await s.svc.request(1, { explicit: false })).toMatchObject({ status: 'queued' });
  });

  it('a requeue result (capacity) is not an attempt and keeps the queue position', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    s.setHolders([999]);
    await s.finish(0, { kind: 'requeue', reason: 'foreign-suite-wait-exceeded', overlaps: [] });
    expect(s.spawned).toHaveLength(1); // a foreign suite is still there: nothing starts
    const q = s.svc.snapshot().queue;
    expect(q.map((e) => e.pr)).toEqual([1, 2]);
    expect(q[0].attempts).toBe(0);
    s.setHolders([]);
    await s.svc.tick();
    expect(s.spawned).toHaveLength(2);
    expect(s.spawned[1].args.join(' ')).toContain('--input');
    expect(s.records).toHaveLength(0);
  });
});

describe('single flight and starvation', () => {
  it('does not start while a foreign full suite holds the slot; starts once it is gone', async () => {
    const s = setup({ views: { 1: view() } });
    s.setHolders([4242]);
    await s.svc.request(1);
    expect(s.spawned).toHaveLength(0);
    const audit = fs.readFileSync(s.svc.auditPath, 'utf-8');
    expect(audit).toContain('"event":"overlap"');
    s.setHolders([]);
    await s.svc.tick();
    expect(s.spawned).toHaveLength(1);
  });

  it('raises local-verify:starved once when the oldest entry has waited over 3 hours', async () => {
    const s = setup({ views: { 1: view() } });
    s.setHolders([4242]);
    await s.svc.request(1);
    s.advance(LOCAL_VERIFY_LIMITS.starvedAfterMs - 1000);
    await s.svc.tick();
    expect(s.starved).toHaveLength(0);
    s.advance(2000);
    await s.svc.tick();
    await s.svc.tick();
    expect(s.starved).toEqual([{ pr: 1, headSha: sha('a'), waitedMs: LOCAL_VERIFY_LIMITS.starvedAfterMs + 1000, interruptions: 0, reason: 'waited' }]);
  });
});

describe('journal and boot rebuild', () => {
  it('the completion path journals every record; boot keeps only matching version + policy + open PR', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(record()));
    const lines = fs.readFileSync(s.svc.journalPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    // Append foreign-version, foreign-policy, closed-PR and open-PR entries.
    const extra = [
      record({ pr: 2, verifierVersion: '0.9.0' }),
      record({ pr: 3, policyHash: 'x'.repeat(64) }),
      record({ pr: 4 }),
      record({ pr: 5, headSha: sha('e') }),
    ].map((r) => JSON.stringify({ v: 1, writtenAt: new Date().toISOString(), record: r }));
    fs.appendFileSync(s.svc.journalPath, extra.join('\n') + '\n{torn');

    // A fresh service (a restart) over the same state dir.
    const svc2 = setup({ stateDir: s.stateDir, open: { 4: false } }).svc;
    const res = await svc2.rebuildIndex();
    expect(res).toMatchObject({ loaded: 2, skippedVersion: 2, skippedClosed: 1 });
    expect(svc2.getRecord(1, sha('a'), 'main')).not.toBeNull();
    expect(svc2.getRecord(5, sha('e'), 'main')).not.toBeNull();
    expect(svc2.getRecord(2, sha('a'), 'main')).toBeNull();
    expect(svc2.getRecord(3, sha('a'), 'main')).toBeNull();
    expect(svc2.getRecord(4, sha('a'), 'main')).toBeNull();
    // The torn line was dropped by compaction; closed PR 4 is kept (within 14 days).
    const after = fs.readFileSync(svc2.journalPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).record.pr);
    expect(after.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('a closed PR record is dropped from the journal 14 days after it was first seen closed; cap 500', async () => {
    const s = setup({ open: { 7: false } });
    fs.mkdirSync(path.dirname(s.svc.journalPath), { recursive: true });
    const many = Array.from({ length: 510 }, (_, i) => JSON.stringify({ v: 1, writtenAt: new Date(1_700_000_000_000 + i).toISOString(), record: record({ pr: 100 + i }) }));
    many.push(JSON.stringify({ v: 1, writtenAt: new Date(1_800_000_000_000).toISOString(), record: record({ pr: 7 }) }));
    fs.writeFileSync(s.svc.journalPath, many.join('\n') + '\n');
    await s.svc.rebuildIndex();
    let prs = fs.readFileSync(s.svc.journalPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).record.pr);
    expect(prs).toHaveLength(500);
    expect(prs).toContain(7);
    s.advance(LOCAL_VERIFY_LIMITS.retentionAfterCloseMs + 1);
    await s.svc.rebuildIndex();
    prs = fs.readFileSync(s.svc.journalPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).record.pr);
    expect(prs).not.toContain(7);
  });
});

describe('in-flight protocol at boot', () => {
  const intent = (over: Partial<InFlightIntent> = {}): InFlightIntent => ({
    pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', attemptToken: 'ab'.repeat(16),
    startedAt: 0, pid: 7001, pgid: 7001, ...over,
  });
  const write = (s: ReturnType<typeof setup>, i: InFlightIntent) => {
    fs.mkdirSync(path.dirname(s.intentPath), { recursive: true });
    fs.writeFileSync(s.intentPath, JSON.stringify(i));
  };

  it('a pid-less intent is cleared', async () => {
    const s = setup();
    write(s, intent({ pid: null, pgid: null }));
    expect(await s.svc.reapOrphan()).toBe('cleared-pidless');
    expect(fs.existsSync(s.intentPath)).toBe(false);
  });

  it('a recorded group that is gone is cleared without a kill', async () => {
    const s = setup();
    write(s, intent());
    expect(await s.svc.reapOrphan()).toBe('gone');
    expect(s.kills).toHaveLength(0);
  });

  it('a live group is killed only after its attempt token is corroborated on argv', async () => {
    const s = setup();
    const i = intent();
    write(s, i);
    s.alive.add(7001);
    s.procArgs.set(7001, `node runVerifyMain.js --input x --result y --attempt-token ${i.attemptToken}`);
    expect(await s.svc.reapOrphan()).toBe('reaped');
    expect(s.kills).toEqual([{ pgid: 7001, signal: 'SIGKILL' }]);
    expect(fs.existsSync(s.intentPath)).toBe(false);
  });

  it('an uncorroborated live group is kept, audited orphan-reap-incomplete, and blocks new runs until it is gone', async () => {
    const s = setup({ views: { 1: view() } });
    write(s, intent());
    s.alive.add(7001);
    s.procArgs.set(7001, 'some unrelated process');
    await s.svc.boot();
    expect(s.kills).toHaveLength(0);
    expect(fs.existsSync(s.intentPath)).toBe(true);
    expect(fs.readFileSync(s.svc.auditPath, 'utf-8')).toContain('orphan-reap-incomplete');
    expect(s.svc.snapshot().blocked).toBe(true);
    await s.svc.request(1);
    expect(s.spawned).toHaveLength(0);
    s.alive.delete(7001);
    await s.svc.tick();
    expect(s.svc.snapshot().blocked).toBe(false);
    expect(s.spawned).toHaveLength(1);
  });
});

// ── Restart safety (2026-10-22: three releases, each auto-update restart lost work) ──

import { AutoUpdater } from '../../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../../src/core/UpdateChecker.js';
import type { StateManager } from '../../../src/core/StateManager.js';
import { restartHoldUntil } from '../../../src/localVerify/LocalVerifyService.js';
import { registerLocalVerifyRestartHold } from '../../../src/localVerify/localVerifyWiring.js';
import { LOCAL_VERIFY_DEADLINES } from '../../../src/localVerify/policy.js';
import { computeVerifierVersion } from '../../../src/localVerify/verifierVersion.js';
import { vi } from 'vitest';

describe('restart hold', () => {
  const H = 3_600_000;
  it('holds while a verify runs, until the run ceiling (active budget + two in-place waits), capped by max deferral', async () => {
    const s = setup({ views: { 1: view() } });
    expect(s.svc.restartHolds(4 * H)).toEqual([]);
    await s.svc.request(1);
    const ceiling = Date.parse('2026-10-21T12:00:00.000Z') + LOCAL_VERIFY_DEADLINES.totalActiveMs + 2 * LOCAL_VERIFY_LIMITS.waitInPlaceMs;
    expect(s.svc.restartHolds(4 * H)).toEqual([{ name: 'local-verify:pr-1', until: ceiling, reason: expect.stringContaining('PR #1') }]);
    s.advance(60_000);
    expect(s.svc.restartHolds(10 * 60_000)[0].until).toBe(Date.parse('2026-10-21T12:00:00.000Z') + 60_000 + 10 * 60_000);
    await s.finish(0, ok(record()));
    expect(s.svc.restartHolds(4 * H)).toEqual([]);
    expect(restartHoldUntil(0, 0, 4 * H)).toBe(LOCAL_VERIFY_DEADLINES.totalActiveMs + 2 * LOCAL_VERIFY_LIMITS.waitInPlaceMs);
  });

  describe('through the real AutoUpdater', () => {
    let tmp: string;
    const checker = () => ({ getInstalledVersion: vi.fn().mockReturnValue('0.9.8'), check: vi.fn(), applyUpdate: vi.fn(), getLastCheck: vi.fn().mockReturnValue(null) } as unknown as UpdateChecker);
    const state = () => ({ get: vi.fn().mockReturnValue(997), set: vi.fn() } as unknown as StateManager);
    const gated = (u: AutoUpdater, bypass: boolean) => (u as unknown as { gatedRestart(v: string, b?: boolean): Promise<void> }).gatedRestart('0.9.9', bypass);

    it('an automatic update waits for a running verify; a manual apply is not held', async () => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-au-')));
      dirs.push(tmp);
      fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const s = setup({ views: { 1: view() } });
        s.advance(Date.now() - Date.parse('2026-10-21T12:00:00.000Z')); // the AutoUpdater reads the real clock
        await s.svc.request(1);
        const u = new AutoUpdater(checker(), state(), tmp, { preRestartDelaySecs: 0 });
        u.setSessionDeps({ listRunningSessions: () => [] });
        registerLocalVerifyRestartHold(u, s.svc);
        await gated(u, false);
        expect(u.getStatus().restartDeferral).toMatchObject({ active: true, currentBlockers: ['local-verify:pr-1'] });
        expect(fs.existsSync(path.join(tmp, 'state', 'restart-requested.json'))).toBe(false);
        u.stop();
        const m = new AutoUpdater(checker(), state(), tmp, { preRestartDelaySecs: 0 });
        m.setSessionDeps({ listRunningSessions: () => [] });
        registerLocalVerifyRestartHold(m, s.svc);
        await gated(m, true);
        await new Promise((r) => setTimeout(r, 50));
        expect(fs.existsSync(path.join(tmp, 'state', 'restart-requested.json'))).toBe(true);
        m.stop();
      } finally {
        log.mockRestore();
      }
    });
  });
});

describe('shutdown', () => {
  it('cancels the in-flight run, starts nothing new, arms no timer, and puts the entry back at the head of the durable queue', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    s.svc.shutdown();
    expect(s.kills).toEqual([{ pgid: s.spawned[0].pid, signal: 'SIGTERM' }]);
    expect(s.timers).toHaveLength(0);
    await s.finish(0, null); // the child dies of the SIGTERM
    await s.svc.tick();
    expect(s.spawned).toHaveLength(1); // PR 2 did NOT start during shutdown
    expect(s.records).toHaveLength(0);
    expect(s.svc.restartHolds(3_600_000)).toEqual([]);
    expect(await s.svc.request(3)).toEqual({ ok: false, code: 'stopping' });
    const q = JSON.parse(fs.readFileSync(s.svc.queuePath, 'utf-8'));
    // The killed run stays counted (attempt 1) and is recorded as an interruption.
    expect(q.entries.map((e: { pr: number; attempts: number; interruptions?: number }) => [e.pr, e.attempts, e.interruptions ?? 0])).toEqual([[1, 1, 1], [2, 0, 0]]);
    expect(q.entries[0].resumeFirst).toBe(true);
  });
});

describe('decideStarved', () => {
  const H = 60 * 60_000;
  it('by the clock: past starvedAfterMs, once', () => {
    expect(decideStarved({ firstQueuedAt: 0, starvedRaised: false }, 3 * H + 1)).toMatchObject({ raise: true, reason: 'waited' });
    expect(decideStarved({ firstQueuedAt: 0, starvedRaised: false }, 3 * H)).toMatchObject({ raise: false, reason: null });
    expect(decideStarved({ firstQueuedAt: 0, starvedRaised: true }, 9 * H)).toMatchObject({ raise: false });
  });
  it('by interruptions: at INTERRUPTION_LIMITS.starvedAfter, without waiting for the clock', () => {
    expect(INTERRUPTION_LIMITS.starvedAfter).toBe(2);
    expect(decideStarved({ firstQueuedAt: 0, starvedRaised: false, interruptions: 1 }, H)).toMatchObject({ raise: false });
    expect(decideStarved({ firstQueuedAt: 0, starvedRaised: false, interruptions: 2 }, H)).toMatchObject({ raise: true, reason: 'interrupted' });
    expect(decideStarved({ firstQueuedAt: 0, starvedRaised: true, interruptions: 5 }, H)).toMatchObject({ raise: false });
  });
});

describe('interrupted runs (2026-10-26: restarts killed PR 2350 four times with 0 recorded attempts)', () => {
  const watermark = (dir: string, state: 'healthy' | 'main-suspect' | 'main-red') => {
    fs.writeFileSync(path.join(dir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state, redHead: state === 'main-red' ? sha('8') : null, lastGreenHead: null, reason: state === 'healthy' ? 'green' : 'boot-unknown', updatedAt: '2026-10-21T00:00:00.000Z',
    }));
  };
  /** Run PR 1, stop the server mid-run, boot a fresh service on the same state dir. */
  const interruptOnce = async (stateDir?: string) => {
    const s = setup({ views: { 1: view() }, ...(stateDir ? { stateDir } : {}) });
    if (stateDir) await s.svc.boot();
    await s.svc.request(1);
    await s.svc.tick();
    s.svc.shutdown();
    await s.finish(s.spawned.length - 1, null);
    return s;
  };

  it('a stop records an interruption and keeps the attempt; the boot restores both', async () => {
    const s = await interruptOnce();
    const audit = fs.readFileSync(s.svc.auditPath, 'utf-8');
    expect(audit).toContain('"event":"interrupted"');
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    await s2.svc.boot();
    expect(s2.svc.snapshot().queue[0]).toMatchObject({ pr: 1, attempts: 1, interruptions: 1, resumeFirst: true });
  });

  it('one interruption does not raise starved; the second does, at once, with reason interrupted', async () => {
    const s = await interruptOnce();
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    await s2.svc.boot();
    await s2.svc.tick();
    expect(s2.starved).toHaveLength(0);
    expect(s2.spawned).toHaveLength(1); // it resumed
    s2.svc.shutdown();
    await s2.finish(0, null);
    const s3 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    await s3.svc.boot();
    await s3.svc.tick();
    expect(s3.starved).toEqual([expect.objectContaining({ pr: 1, interruptions: 2, reason: 'interrupted' })]);
    await s3.svc.tick();
    expect(s3.starved).toHaveLength(1); // once per entry
  });

  it('an interrupted PR starts ahead of a main verify queued at boot (main suspect)', async () => {
    const s = await interruptOnce();
    watermark(s.stateDir, 'main-suspect');
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    await s2.svc.boot();
    s2.svc.noteMainHead(sha('9'));
    await s2.svc.settle();
    await s2.svc.tick();
    expect(s2.spawned).toHaveLength(1);
    expect(s2.spawned[0].args.join(' ')).not.toContain(sha('9'));
    expect(s2.svc.snapshot().inFlight).toMatchObject({ pr: 1 });
    expect(s2.svc.snapshot().queue.map((e) => e.kind ?? e.pr)).toEqual(['main']);
  });

  it('without an interruption, the same boot starts main first (the suspect repair path is unchanged)', async () => {
    const s = setup({ views: { 1: view() } });
    s.setHolders([1]); // queued, never started
    await s.svc.request(1);
    s.svc.shutdown();
    watermark(s.stateDir, 'main-suspect');
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    await s2.svc.boot();
    s2.svc.noteMainHead(sha('9'));
    await s2.svc.settle();
    await s2.svc.tick();
    expect(s2.svc.snapshot().inFlight).toMatchObject({ kind: 'main' });
  });

  it('with main known red, main keeps priority even over an interrupted PR', async () => {
    const s = await interruptOnce();
    watermark(s.stateDir, 'main-red');
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    await s2.svc.boot();
    s2.svc.noteMainHead(sha('9'));
    await s2.svc.settle();
    await s2.svc.tick();
    expect(s2.svc.snapshot().inFlight).toMatchObject({ kind: 'main' });
  });

  it('resumeFirst is cleared once it starts (it does not keep jumping ahead)', async () => {
    const s = await interruptOnce();
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    await s2.svc.boot();
    await s2.svc.tick();
    expect(s2.spawned).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(s2.svc.queuePath, 'utf-8'));
    expect(saved.entries[0].resumeFirst).toBeUndefined();
    expect(saved.entries[0].interruptions).toBe(1);
  });

  it('a twice-interrupted PR alarms at boot, before a main observation can start it ahead of the first tick', async () => {
    const s = await interruptOnce();
    const s2 = await interruptOnce(s.stateDir);
    const s3 = setup({ stateDir: s2.stateDir, views: { 1: view() } });
    await s3.svc.boot();
    expect(s3.starved).toEqual([expect.objectContaining({ pr: 1, interruptions: 2, reason: 'interrupted' })]);
    expect(JSON.parse(fs.readFileSync(s3.svc.queuePath, 'utf-8')).entries[0]).toMatchObject({ pr: 1, starvedRaised: true });
    s3.svc.noteMainHead(sha('9')); // pumps at once: the interrupted PR starts before any tick
    await s3.svc.settle();
    expect(s3.svc.snapshot().inFlight).toMatchObject({ pr: 1 });
    await s3.svc.tick();
    expect(s3.starved).toHaveLength(1); // once
  });

  it('the running entry is part of the starved check (an entry that reached two interruptions while in flight)', async () => {
    const s = await interruptOnce();
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    await s2.svc.boot();
    await s2.svc.tick();
    expect(s2.svc.snapshot().inFlight).toMatchObject({ pr: 1 });
    // Simulate the count crossing the threshold while it runs (a second interruption recorded on the live entry).
    const live = (s2.svc as unknown as { inFlight: { entry: { interruptions?: number } } }).inFlight.entry;
    live.interruptions = 2;
    await s2.svc.tick();
    expect(s2.starved).toEqual([expect.objectContaining({ pr: 1, interruptions: 2 })]);
  });

  it('a push while an interrupted PR waits keeps its turn (resumeFirst) and starts its interruptions over', async () => {
    const s = await interruptOnce();
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    s2.setHolders([1]); // a foreign suite holds the slot: nothing starts, the entry stays queued
    await s2.svc.boot();
    s2.views[1] = view({ headRefOid: sha('c') });
    await s2.svc.request(1); // the new head takes the old entry's slot
    const e = s2.svc.snapshot().queue.find((q) => q.pr === 1)!;
    expect(e).toMatchObject({ headSha: sha('c'), resumeFirst: true });
    expect(e.interruptions).toBeUndefined();
  });

  it('a second unclean exit raises starved before the entry is dropped with its error record', async () => {
    const s = setup({ views: { 1: view() } });
    fs.writeFileSync(s.svc.queuePath, JSON.stringify({ v: 1, entries: [{ pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', firstQueuedAt: Date.parse('2026-10-21T11:00:00.000Z'), attempts: 2, errorRetries: 1, starvedRaised: false, interruptions: 1, inFlight: true }] }));
    await s.svc.boot();
    expect(s.svc.snapshot().queue).toHaveLength(0);
    expect(s.svc.getRecord(1, sha('a'), 'main')).toMatchObject({ outcome: 'error', errorStep: 'server-restarted' });
    expect(s.starved).toEqual([expect.objectContaining({ pr: 1, interruptions: 2, reason: 'interrupted' })]);
  });

  it('an unclean exit (server died mid-run) also counts as an interruption', async () => {
    const s = setup({ views: { 1: view() } });
    fs.writeFileSync(s.svc.queuePath, JSON.stringify({ v: 1, entries: [{ pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', firstQueuedAt: Date.parse('2026-10-21T11:00:00.000Z'), attempts: 1, errorRetries: 0, starvedRaised: false, inFlight: true }] }));
    await s.svc.boot();
    expect(s.svc.snapshot().queue[0]).toMatchObject({ pr: 1, interruptions: 1, resumeFirst: true, errorRetries: 1 });
  });
});

describe('durable queue', () => {
  it('persists every change and restores at boot, dropping closed PRs and moved heads', async () => {
    const views = { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('e') }), 4: view({ headRefOid: sha('f') }) };
    const s = setup({ views });
    for (const pr of [1, 2, 3, 4]) await s.svc.request(pr);
    s.advance(1000);
    const saved = JSON.parse(fs.readFileSync(s.svc.queuePath, 'utf-8'));
    expect(saved.entries.map((e: { pr: number }) => e.pr)).toEqual([1, 2, 3, 4]); // in-flight first
    // Crash: no shutdown; PR 1's child is gone by the next boot.
    s.alive.clear();
    const s2 = setup({ stateDir: s.stateDir, views: { ...views, 3: view({ headRefOid: sha('9') }) }, open: { 4: false } });
    await s2.svc.boot();
    const q = s2.svc.snapshot().queue.map((e) => [e.pr, e.headSha]);
    expect(q).toEqual([[1, sha('a')], [2, sha('c')]]); // 3 head moved, 4 closed
    expect(s2.svc.snapshot().queue[0].firstQueuedAt).toBe(saved.entries[0].firstQueuedAt);
    await s2.svc.tick();
    expect(s2.spawned).toHaveLength(1);
    expect(s2.spawned[0].args.join(' ')).toContain('--input');
  });

  it('restored entries wait for the orphan reap before starting', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1); // in flight, intent written
    const pgid = s.spawned[0].pid;
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view() } });
    s2.alive.add(pgid); // the old group still runs; its identity is unconfirmed
    await s2.svc.boot();
    await s2.svc.tick();
    expect(s2.svc.snapshot().blocked).toBe(true);
    expect(s2.svc.snapshot().queue.map((e) => e.pr)).toEqual([1]);
    expect(s2.spawned).toHaveLength(0);
    s2.alive.delete(pgid);
    await s2.svc.tick();
    expect(s2.spawned).toHaveLength(1);
  });

  it('a restored entry already recorded green is not re-queued', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    await s.finish(0, ok(record()));
    // PR 2 now in flight; a crash leaves it in the queue file.
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s2.svc.boot();
    expect(s2.svc.snapshot().queue.map((e) => e.pr)).toEqual([2]);
  });
});

// ── Second pass (2026-10-22): indefinite hold, crash re-run loop, restore race, version hash, corrupt queue, write-on-change ──

import { decideUpdatePause, UPDATE_PAUSE_MAX_MS, type UpdatePendingState } from '../../../src/localVerify/LocalVerifyService.js';
import { updatePendingFromAutoUpdater } from '../../../src/localVerify/localVerifyWiring.js';
import { localImportGraph } from '../../../src/localVerify/verifierVersion.js';
import { checkVerifierVersion, main as runVerifyMainEntry } from '../../../src/localVerify/runVerifyMain.js';

const T0 = Date.parse('2026-10-21T12:00:00.000Z');

describe('rule (b): a pending update pauses NEW starts so the queue cannot hold updates forever', () => {
  const pending = (over: Partial<UpdatePendingState> = {}): UpdatePendingState => ({ pending: true, pendingSinceMs: T0, otherBlockers: false, ...over });

  it('decideUpdatePause: both sides of every condition', () => {
    expect(decideUpdatePause(null, T0)).toBe(false);
    expect(decideUpdatePause(pending({ pending: false }), T0)).toBe(false);
    expect(decideUpdatePause(pending({ otherBlockers: true }), T0)).toBe(false);
    expect(decideUpdatePause(pending(), T0 + UPDATE_PAUSE_MAX_MS)).toBe(true);
    expect(decideUpdatePause(pending(), T0 + UPDATE_PAUSE_MAX_MS + 1)).toBe(false);
    expect(decideUpdatePause(pending({ pendingSinceMs: null }), T0 + 10 * UPDATE_PAUSE_MAX_MS)).toBe(true);
  });

  it('updatePendingFromAutoUpdater reads autoApply, pendingUpdate, coalescingUntil and the other blockers', () => {
    const base = { config: { autoApply: true }, pendingUpdate: null, coalescingUntil: null, pendingUpdateDetectedAt: '2026-10-21T12:00:00.000Z' };
    expect(updatePendingFromAutoUpdater({ ...base, pendingUpdate: '1.3.1395' }, [])).toEqual({ pending: true, pendingSinceMs: T0, otherBlockers: false });
    expect(updatePendingFromAutoUpdater({ ...base, coalescingUntil: '2026-10-21T12:10:00.000Z' }, []).pending).toBe(true);
    expect(updatePendingFromAutoUpdater({ ...base, coalescingUntil: 'notified' }, []).pending).toBe(false);
    expect(updatePendingFromAutoUpdater({ ...base, config: { autoApply: false }, pendingUpdate: '1.3.1395' }, []).pending).toBe(false);
    expect(updatePendingFromAutoUpdater({ ...base, pendingUpdate: 'x' }, ['hold:local-verify:pr-1']).otherBlockers).toBe(false);
    expect(updatePendingFromAutoUpdater({ ...base, pendingUpdate: 'x' }, ['echo-topic-123', 'hold:local-verify:pr-1']).otherBlockers).toBe(true);
    expect(updatePendingFromAutoUpdater({ ...base, pendingUpdate: 'x' }, ['hold:pairing-invite:ab']).otherBlockers).toBe(true);
    expect(updatePendingFromAutoUpdater({ ...base, pendingUpdate: 'x' }, null).otherBlockers).toBe(true);
  });

  it('the running verify finishes, the next does not start while the update waits only on us; starts resume after 120 min', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    let state: UpdatePendingState | null = null;
    s.svc.setUpdatePendingProvider(() => state);
    await s.svc.request(1);
    await s.svc.request(2);
    state = pending();
    await s.finish(0, ok(record()));
    await s.svc.tick();
    expect(s.spawned).toHaveLength(1); // PR 2 waits: the restart can go ahead
    expect(s.svc.restartHolds(4 * 3_600_000)).toEqual([]);
    s.advance(UPDATE_PAUSE_MAX_MS + 1);
    await s.svc.tick();
    await s.flush(); // it waited past the pre-start window: the open/base check runs first
    expect(s.spawned).toHaveLength(2);
  });

  it('starts are not paused when something else delays the restart anyway', async () => {
    const s = setup({ views: { 1: view() } });
    s.svc.setUpdatePendingProvider(() => pending({ otherBlockers: true }));
    await s.svc.request(1);
    expect(s.spawned).toHaveLength(1);
  });

  it('time paused for a pending update never counts toward starved', async () => {
    const s = setup({ views: { 1: view() } });
    s.svc.setUpdatePendingProvider(() => pending({ pendingSinceMs: null }));
    await s.svc.request(1);
    expect(s.spawned).toHaveLength(0);
    for (let i = 0; i < 8; i++) { s.advance(30 * 60_000); await s.svc.tick(); } // 4 h paused
    expect(s.starved).toHaveLength(0);
    s.svc.setUpdatePendingProvider(() => null);
    s.setHolders([4242]); // now a plain capacity wait, which does count
    for (let i = 0; i < 8; i++) { s.advance(30 * 60_000); await s.svc.tick(); }
    expect(s.starved).toHaveLength(1);
  });
});

describe('unclean exit: the restored in-flight entry counts one error retry, then stops', () => {
  const writeQueue = (dir: string, entries: unknown[]) => {
    fs.mkdirSync(path.join(dir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'local-verify', 'queue.json'), JSON.stringify({ v: 1, entries }));
  };
  const e = (over: Record<string, unknown> = {}) => ({ pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', firstQueuedAt: T0, attempts: 1, errorRetries: 0, starvedRaised: false, ...over });

  it('the running entry is written with an inFlight marker; a clean shutdown re-queues it unmarked', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    expect(JSON.parse(fs.readFileSync(s.svc.queuePath, 'utf-8')).entries[0]).toMatchObject({ pr: 1, inFlight: true });
    s.svc.shutdown();
    expect(JSON.parse(fs.readFileSync(s.svc.queuePath, 'utf-8')).entries[0].inFlight).toBeUndefined();
  });

  it('first unclean exit: restored as one error retry', async () => {
    const s = setup({ views: { 1: view() } });
    writeQueue(s.stateDir, [e({ inFlight: true })]);
    await s.svc.boot();
    expect(s.svc.snapshot().queue[0]).toMatchObject({ pr: 1, errorRetries: 1 });
  });

  it('past the limit: no re-run; an error record with errorStep server-restarted', async () => {
    const s = setup({ views: { 1: view() } });
    writeQueue(s.stateDir, [e({ inFlight: true, errorRetries: 1 })]);
    await s.svc.boot();
    await s.svc.tick();
    expect(s.svc.snapshot().queue).toHaveLength(0);
    expect(s.spawned).toHaveLength(0);
    expect(s.svc.getRecord(1, sha('a'), 'main')).toMatchObject({ outcome: 'error', errorStep: 'server-restarted' });
  });

  it('an unmarked entry restores with its counters unchanged', async () => {
    const s = setup({ views: { 1: view() } });
    writeQueue(s.stateDir, [e({ errorRetries: 1 })]);
    await s.svc.boot();
    expect(s.svc.snapshot().queue[0]).toMatchObject({ pr: 1, errorRetries: 1 });
  });
});

describe('restore race', () => {
  it('a POST during the restore waits behind it; queue.json never loses unrestored entries', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 5: view({ headRefOid: sha('e') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    s.alive.clear();
    // A fresh service whose GitHub reads are slow during restore.
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view(), 2: view({ headRefOid: sha('c') }), 5: view({ headRefOid: sha('e') }) } });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const svc2 = s2.svc as unknown as { seams: LocalVerifyServiceSeams };
    const orig = svc2.seams.isPrOpen;
    svc2.seams.isPrOpen = async (pr) => { await gate; return orig(pr); };
    const booting = s2.svc.boot();
    await s2.flush();
    const posting = s2.svc.request(5);
    s2.svc.noteMainHead(sha('7')); // a main verify enqueued mid-restore pumps: it must not rewrite queue.json
    await s2.flush();
    expect(s2.spawned).toHaveLength(0); // nothing started mid-restore
    const onDisk = JSON.parse(fs.readFileSync(s2.svc.queuePath, 'utf-8')).entries.map((x: { pr: number }) => x.pr);
    expect(onDisk).toEqual([1, 2]); // not rewritten without the unrestored entries
    release();
    await booting;
    await posting;
    const snap = s2.svc.snapshot();
    const prs = snap.queue.filter((x) => x.kind !== 'main').map((x) => x.pr)
      .concat(snap.inFlight && snap.inFlight.kind !== 'main' ? [snap.inFlight.pr] : []).sort();
    expect(prs).toEqual([1, 2, 5]);
    // FIFO kept: the restored entries are ahead of the POST that arrived during the restore.
    // (the running one, if a PR, came off the head of that order)
    const order = (snap.inFlight && snap.inFlight.kind !== 'main' ? [snap.inFlight.pr] : []).concat(snap.queue.filter((x) => x.kind !== 'main').map((x) => x.pr));
    expect(order).toEqual([1, 2, 5]);
    const after = JSON.parse(fs.readFileSync(s2.svc.queuePath, 'utf-8')).entries.map((x: { pr: number }) => x.pr).sort();
    expect(after).toEqual([1, 2, 5]);
  });
});

describe('corrupt queue.json and restore audit', () => {
  it('an unreadable file is moved aside and audited; nothing is restored', async () => {
    const s = setup({ views: { 1: view() } });
    fs.mkdirSync(path.dirname(s.svc.queuePath), { recursive: true });
    fs.writeFileSync(s.svc.queuePath, '{not json');
    await s.svc.boot();
    const names = fs.readdirSync(path.dirname(s.svc.queuePath));
    expect(names.some((n) => n.startsWith('queue.json.corrupt-'))).toBe(true);
    expect(fs.readFileSync(s.svc.auditPath, 'utf-8')).toContain('"event":"queue-restore-unreadable"');
  });
  it('the restore audit carries the per-reason drop counts', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('9') }) }, open: { 2: false } });
    fs.mkdirSync(path.dirname(s.svc.queuePath), { recursive: true });
    const q = (pr: number, h: string) => ({ pr, headSha: sha(h), baseSha: sha('b'), baseRefName: 'main', firstQueuedAt: T0, attempts: 0, errorRetries: 0, starvedRaised: false });
    fs.writeFileSync(s.svc.queuePath, JSON.stringify({ v: 1, entries: [q(1, 'a'), q(2, 'c'), q(3, 'e')] }));
    await s.svc.boot();
    const line = fs.readFileSync(s.svc.auditPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'queue-restored');
    expect(line).toMatchObject({ restored: 1, dropped: 2, drops: { closed: 1, 'head-or-base-moved': 1, 'already-recorded': 0 } });
  });
});

describe('queue.json is written only when it changes', () => {
  it('ticks with no queue change do not rewrite the file', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    const ino = fs.statSync(s.svc.queuePath).ino;
    await s.svc.tick();
    await s.svc.tick();
    expect(fs.statSync(s.svc.queuePath).ino).toBe(ino);
    await s.finish(0, ok(record()));
    expect(fs.statSync(s.svc.queuePath).ino).not.toBe(ino); // the run ended: the content changed
  });
});

describe('verifierVersion: the real import graph, node, and a child-side check', () => {
  function pkg(files: Record<string, string>, under?: string) {
    const root = under
      ? (fs.mkdirSync(under, { recursive: true }), fs.realpathSync(under))
      : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-ver-')));
    if (!under) dirs.push(root);
    for (const [rel, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), c);
    }
    return { root, dir: path.join(root, 'dist', 'localVerify') };
  }
  const files = () => ({
    'dist/localVerify/runVerifyMain.js': "import { x } from '../core/SafeGitExecutor.js';\nimport type { T } from '../core/typesOnly.js';\n",
    'dist/localVerify/record.js': "export const r = 1;\n",
    'dist/localVerify/localVerifyWiring.js': "import '../core/Config.js';\n",
    'dist/core/SafeGitExecutor.js': "import { y } from './SourceTreeGuard.js';\nexport const x = 1;\n",
    'dist/core/SourceTreeGuard.js': "export const y = 1;\n",
    'dist/core/typesOnly.js': "export {};\n",
    'dist/core/Config.js': "export const c = 1;\n",
  });
  const v = (dir: string, over: Parameters<typeof computeVerifierVersion>[2] = {}) =>
    computeVerifierVersion(dir, 'p', { nodeVersion: 'v24.1.0', protectedList: ['.github/'], ...over });

  it('follows relative imports through core, skipping type-only imports', () => {
    const { root, dir } = pkg(files());
    const g = localImportGraph([path.join(dir, 'runVerifyMain.js')]).map((f) => path.relative(root, f));
    expect(g).toEqual(['dist/core/SafeGitExecutor.js', 'dist/core/SourceTreeGuard.js', 'dist/localVerify/runVerifyMain.js']);
  });
  it('a change anywhere in the graph changes the version; wiring-only and unreachable files do not', () => {
    const a = pkg(files());
    const base = v(a.dir);
    expect(base).toMatch(/^vh3:[0-9a-f]{32}$/);
    const deep = pkg({ ...files(), 'dist/core/SourceTreeGuard.js': 'export const y = 2;\n' });
    expect(v(deep.dir)).not.toBe(base);
    const wiringOnly = pkg({ ...files(), 'dist/core/Config.js': 'export const c = 2;\n', 'dist/localVerify/localVerifyWiring.js': '// changed\n' });
    expect(v(wiringOnly.dir)).toBe(base);
    const unrelated = pkg({ ...files(), 'dist/core/Other.js': 'x' });
    expect(v(unrelated.dir)).toBe(base);
  });
  it('node, the protected list and the policy each change it', () => {
    const { dir } = pkg(files());
    const base = v(dir);
    expect(v(dir, { nodeVersion: 'v24.2.0' })).not.toBe(base);
    expect(v(dir, { protectedList: ['.github/', 'x'] })).not.toBe(base);
    expect(computeVerifierVersion(dir, 'p2', { nodeVersion: 'v24.1.0', protectedList: ['.github/'] })).not.toBe(base);
  });
  it('an ambient typescript install above the package does not change it (the 2026-10-24 flip)', () => {
    // An install lives at <agent home>/.instar/shadow-install/node_modules/instar; Node's lookup from
    // it walks UP into <agent home>/node_modules, which `npm ci` there empties and refills. The old
    // `typescript:` input read that folder, so the version flipped with the state of an unrelated dir.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-ver-home-')));
    dirs.push(base);
    const { root, dir } = pkg(files(), path.join(base, 'shadow-install', 'node_modules', 'instar'));
    const before = v(dir);
    // Two levels above the package root (base/node_modules), and inside the package root too.
    for (const planted of [path.join(base, 'node_modules'), path.join(root, 'node_modules')]) {
      fs.mkdirSync(path.join(planted, 'typescript'), { recursive: true });
      fs.writeFileSync(path.join(planted, 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3' }));
      expect(v(dir)).toBe(before);
      fs.writeFileSync(path.join(planted, 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.4' }));
      expect(v(dir)).toBe(before);
      SafeFsExecutor.safeRmSync(planted, { recursive: true, force: true, operation: 'LocalVerifyService.test.ts' });
      expect(v(dir)).toBe(before);
    }
  });
  it('the installed verifier hashes to vh3 and is not the package version', () => {
    expect(computeVerifierVersion()).toMatch(/^vh3:/);
  });

  it('the child refuses to run when its own code differs from what the server passed', async () => {
    const { dir } = pkg(files());
    const server = computeVerifierVersion(dir, undefined, { protectedList: ['.github/'] });
    expect(checkVerifierVersion({ verifierVersion: server, protectedList: ['.github/'] }, dir)).toEqual({ ok: true });
    fs.writeFileSync(path.join(dir, '..', 'core', 'SafeGitExecutor.js'), "import { y } from './SourceTreeGuard.js';\nexport const x = 2;\n"); // npm replaced dist
    const r = checkVerifierVersion({ verifierVersion: server, protectedList: ['.github/'] }, dir);
    expect(r.ok).toBe(false);
    // Through the entry: a crash result whose detail the service maps to errorStep verifier-mismatch.
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-main-')));
    dirs.push(work);
    const input = path.join(work, 'in.json');
    const result = path.join(work, 'out.json');
    fs.writeFileSync(input, JSON.stringify({ verifierVersion: server, protectedList: ['.github/'], agentHome: work, headSha: sha('a') }));
    const errs = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runVerifyMainEntry(['--input', input, '--result', result, '--attempt-token', 'ab'.repeat(16)], dir)).toBe(1);
    } finally { errs.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(result, 'utf-8'))).toMatchObject({ kind: 'crash', detail: expect.stringMatching(/^verifier-mismatch/) });
  });

  it('the service treats a verifier-mismatch crash as a hold, never an error record (see "verifier changed on disk")', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, { kind: 'crash', detail: 'verifier-mismatch: server vh3:a, child vh3:b' } as unknown as VerifyRunResult);
    expect(s.records).toEqual([]);
    expect(s.svc.snapshot().verifierHold).toMatchObject({ where: 'run', detail: 'verifier-mismatch: server vh3:a, child vh3:b' });
  });

  it('records survive a boot whose verifier content is unchanged, and re-verify when it changed', async () => {
    const { dir } = pkg(files());
    const version = v(dir);
    const s = setup({ views: { 1: view() } });
    fs.mkdirSync(path.dirname(s.svc.journalPath), { recursive: true });
    fs.appendFileSync(s.svc.journalPath, JSON.stringify({ v: 1, writtenAt: new Date().toISOString(), record: record({ verifierVersion: version }) }) + '\n');
    expect((await setup({ stateDir: s.stateDir, verifierVersion: v(dir) }).svc.rebuildIndex()).loaded).toBe(1);
    fs.writeFileSync(path.join(dir, 'runVerifyMain.js'), "import { x } from '../core/SafeGitExecutor.js';\n// changed\n");
    expect(await setup({ stateDir: s.stateDir, verifierVersion: v(dir) }).svc.rebuildIndex()).toMatchObject({ loaded: 0, skippedVersion: 1 });
  });
});

describe('merge line (CMT-980): queue place, pre-start base refresh, merge hand-off', () => {
  type S = ReturnType<typeof setup>;
  const withBaseHead = (s: S, fn: (b: string) => Promise<string | null>) => {
    (s.svc as unknown as { seams: { baseHead?: (b: string) => Promise<string | null> } }).seams.baseHead = fn;
  };
  const inputOf = (s: S, i: number) => JSON.parse(fs.readFileSync(s.spawned[i].args[s.spawned[i].args.indexOf('--input') + 1], 'utf-8')) as { baseSha: string; headSha: string; pr: number };
  const auditLines = (s: S) => fs.readFileSync(path.join(s.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

  it('decideBaseRefresh and decideMergeHandoff: both sides of every rule', () => {
    const e = { baseRefName: 'main', firstQueuedAt: 1_000, baseResolvedAt: 5_000 };
    expect(decideBaseRefresh(e, { now: 6_000, mainMovedAt: null })).toBe(false);
    expect(decideBaseRefresh(e, { now: 6_000, mainMovedAt: 4_000 })).toBe(false); // moved BEFORE the base was resolved
    expect(decideBaseRefresh(e, { now: 6_000, mainMovedAt: 5_500 })).toBe(true);  // moved after
    expect(decideBaseRefresh({ ...e, baseRefName: 'dev' }, { now: 6_000, mainMovedAt: 5_500 })).toBe(false); // main is not its base
    expect(decideBaseRefresh(e, { now: 5_000 + MERGE_LINE.baseRefreshAfterMs, mainMovedAt: null })).toBe(true); // waited long enough
    expect(decideBaseRefresh({ baseRefName: 'main', firstQueuedAt: 1_000 }, { now: 1_000 + MERGE_LINE.baseRefreshAfterMs - 1, mainMovedAt: null })).toBe(false); // falls back to firstQueuedAt
    const base = { outcome: 'success' as const, wired: true, stopped: false, holdOpen: false };
    expect(decideMergeHandoff(base)).toEqual({ handoff: true });
    expect(decideMergeHandoff({ ...base, wired: false })).toEqual({ handoff: false, skip: 'no-watcher' });
    expect(decideMergeHandoff({ ...base, stopped: true })).toEqual({ handoff: false, skip: 'stopping' });
    expect(decideMergeHandoff({ ...base, kind: 'main' })).toEqual({ handoff: false, skip: 'main-record' });
    expect(decideMergeHandoff({ ...base, outcome: 'failure' })).toEqual({ handoff: false, skip: 'not-success' });
    expect(decideMergeHandoff({ ...base, outcome: 'error' })).toEqual({ handoff: false, skip: 'not-success' });
    expect(decideMergeHandoff({ ...base, holdOpen: true })).toEqual({ handoff: false, skip: 'hold-active' });
    expect(decideMergeHandoff({ ...base, enabled: false })).toEqual({ handoff: false, skip: 'disabled' });
    expect(decideMergeHandoff({ ...base, enabled: true })).toEqual({ handoff: true });
  });

  it('a head pushed during its own run keeps the FRONT of the line (the cancelled run\'s firstQueuedAt), not the back', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s.svc.request(1);
    s.advance(60_000);
    await s.svc.request(2);
    const t1 = s.spawned.length; // PR 1 running
    expect(t1).toBe(1);
    s.views[1] = view({ headRefOid: sha('f') });
    s.advance(60_000);
    expect(await s.svc.request(1)).toMatchObject({ ok: true, status: 'queued', position: 0 });
    expect(s.svc.snapshot().queue.map((e) => [e.pr, e.headSha])).toEqual([[1, sha('f')], [2, sha('c')]]);
    expect(s.svc.snapshot().queue[0].firstQueuedAt).toBe(Date.parse('2026-10-21T12:00:00.000Z'));
    // The cancelled run exits: PR 1's new head starts next, ahead of PR 2.
    s.alive.delete(s.spawned[0].pid);
    s.spawned[0].resolve({ status: null, signal: 'SIGTERM' });
    await s.flush();
    expect(inputOf(s, 1)).toMatchObject({ pr: 1 });
    expect(s.spawned[1].args.join(' ')).toContain('--input');
  });

  it('a moved-head request during the pre-start base read never yields two runs for one PR', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    let release!: (b: string) => void;
    let reads = 0;
    // Reads 1–2 serve the two requests; read 3 is PR 2's pre-start read (held); later reads (the moved-head request) answer at once.
    withBaseHead(s, () => { reads += 1; if (reads <= 2) return Promise.resolve(sha('b')); if (reads === 3) return new Promise((r) => { release = r; }); return Promise.resolve(sha('e')); });
    await s.svc.request(1);
    await s.svc.request(2);
    s.advance(MERGE_LINE.baseRefreshAfterMs);
    await s.finish(0, ok(record())); // PR 2's pre-start read is now pending (release not called)
    expect(s.spawned).toHaveLength(1);
    s.views[2] = view({ headRefOid: sha('f') }); // the head moves while the read is pending
    await s.svc.request(2);
    expect(s.svc.snapshot().queue.map((e) => [e.pr, e.headSha])).toEqual([[2, sha('f')]]);
    release(sha('e')); // the stale read completes: the old entry is gone, nothing starts from it
    await s.flush();
    await s.flush();
    // Exactly one run for PR 2, for its NEW head, on the base its request just read; the queue is empty.
    expect(s.spawned).toHaveLength(2);
    expect(inputOf(s, 1)).toMatchObject({ pr: 2, headSha: sha('f'), baseSha: sha('e') });
    expect(s.svc.snapshot().queue).toHaveLength(0);
    expect(s.svc.snapshot().inFlight).toEqual({ pr: 2, headSha: sha('f') });
  });

  it('the live switch: off ⇒ no hold, no counter, no watcher call, and mergeLine says so; on again ⇒ hands off', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('d') }) } });
    const calls: number[] = [];
    let on = false;
    s.svc.setMergeHandoff(async (rec) => { calls.push(rec.pr); return { acted: false, reason: 'handoff-not-eligible:held' }; }, { enabled: () => on });
    expect(s.svc.snapshot().mergeLine).toMatchObject({ wired: true, enabled: false });
    await s.svc.request(1);
    await s.svc.request(2);
    await s.svc.request(3);
    await s.finish(0, ok(record()));
    expect(calls).toEqual([]);
    expect(s.spawned).toHaveLength(2); // PR 2 started at once: nothing was held
    expect(s.svc.snapshot().mergeLine).toMatchObject({ enabled: false, hold: null, handoffs: 0 });
    expect(auditLines(s).some((l) => l.event === 'merge-handoff')).toBe(false);
    on = true;
    await s.finish(1, ok(record({ pr: 2, headSha: sha('c') })));
    expect(calls).toEqual([2]);
    expect(s.svc.snapshot().mergeLine).toMatchObject({ enabled: true, handoffs: 1 });
  });

  it('a watcher answer after the hold timed out does not reopen the hold; a late merge still makes the next start re-read its base', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('d') }) } });
    let base = sha('b');
    withBaseHead(s, async () => base);
    let answer!: (r: MergeHandoffResult) => void;
    s.svc.setMergeHandoff(() => new Promise((r) => { answer = r; }));
    await s.svc.request(1);
    await s.svc.request(2);
    await s.svc.request(3);
    await s.finish(0, ok(record()));
    s.advance(MERGE_LINE.handoffMaxMs);
    s.timers[0]();
    await s.flush();
    expect(s.spawned).toHaveLength(2); // PR 2 started on the timeout
    expect(s.svc.snapshot().mergeLine).toMatchObject({ hold: null, lastOutcome: 'timeout', merged: 0 });
    base = sha('e');
    s.advance(1_000);
    answer({ acted: true, reason: 'merged' }); // late
    await s.flush();
    expect(s.svc.snapshot().mergeLine).toMatchObject({ hold: null, lastOutcome: 'timeout', merged: 0 });
    expect(auditLines(s).some((l) => l.event === 'merge-handoff-late-answer' && l.acted === true)).toBe(true);
    await s.finish(1, ok(record({ pr: 2, headSha: sha('c'), outcome: 'failure' })));
    await s.flush();
    expect(inputOf(s, 2)).toMatchObject({ pr: 3, baseSha: sha('e') }); // the late merge moved main: PR 3 re-read its base
  });

  it('CMT-973: a base that moved under a queued PR is refreshed in place — same slot, same firstQueuedAt, never dequeued', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('d') }) } });
    await s.svc.request(1); // runs
    await s.svc.request(2);
    s.advance(60_000);
    await s.svc.request(3);
    const t2 = s.svc.snapshot().queue[0].firstQueuedAt;
    s.views[2] = view({ headRefOid: sha('c'), baseRefOid: sha('e') }); // main moved
    s.advance(60_000);
    expect(await s.svc.request(2, { explicit: false })).toEqual({ ok: true, status: 'already-queued', position: 0 });
    const q = s.svc.snapshot().queue;
    expect(q.map((e) => e.pr)).toEqual([2, 3]);
    expect(q[0]).toMatchObject({ baseSha: sha('e'), firstQueuedAt: t2 });
    const events = auditLines(s).map((l) => l.event);
    expect(events).toContain('base-updated');
    expect(events).not.toContain('dequeued');
    // The durable queue carries the refreshed base and when it was resolved.
    const saved = JSON.parse(fs.readFileSync(s.svc.queuePath, 'utf-8')) as { entries: Array<{ pr: number; baseSha: string; baseResolvedAt?: number }> };
    expect(saved.entries.find((e) => e.pr === 2)).toMatchObject({ baseSha: sha('e'), baseResolvedAt: expect.any(Number) });
  });

  it('a moved head takes the old entry\'s slot and keeps its firstQueuedAt (attempts start over)', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('d') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    s.advance(60_000);
    await s.svc.request(3);
    const t2 = s.svc.snapshot().queue[0].firstQueuedAt;
    s.views[2] = view({ headRefOid: sha('f') });
    s.advance(60_000);
    expect(await s.svc.request(2)).toEqual({ ok: true, status: 'queued', position: 0 });
    const q = s.svc.snapshot().queue;
    expect(q.map((e) => [e.pr, e.headSha])).toEqual([[2, sha('f')], [3, sha('d')]]);
    expect(q[0]).toMatchObject({ firstQueuedAt: t2, attempts: 0, errorRetries: 0 });
    expect(auditLines(s).some((l) => l.event === 'queued' && l.pr === 2 && l.keptPlace === true && l.firstQueuedAt === t2)).toBe(true);
  });

  it('an entry that waited re-reads the base head right before it starts (the merge is tested with today\'s base)', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    let base = sha('b');
    withBaseHead(s, async () => base);
    await s.svc.request(1);
    await s.svc.request(2);
    expect(inputOf(s, 0).baseSha).toBe(sha('b'));
    base = sha('e');
    s.advance(MERGE_LINE.baseRefreshAfterMs);
    await s.finish(0, ok(record()));
    await s.flush();
    expect(s.spawned).toHaveLength(2);
    expect(inputOf(s, 1)).toMatchObject({ pr: 2, baseSha: sha('e') });
    expect(auditLines(s).some((l) => l.event === 'base-refreshed' && l.pr === 2 && l.newBase === sha('e'))).toBe(true);
    expect(s.svc.snapshot().inFlight).toEqual({ pr: 2, headSha: sha('c') });
  });

  it('the reconcile loop seeing a new main head makes the next PR start re-read its base; a failed read starts on the last known base (audited)', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    let base: string | null = sha('b');
    withBaseHead(s, async () => base);
    await s.svc.request(1);
    await s.svc.request(2);
    s.svc.noteMainHead(sha('b'));
    s.advance(1_000);
    s.svc.noteMainHead(sha('e')); // main moved after PR 2's base was resolved
    await s.svc.settle();
    base = null; // and now the base cannot be read
    await s.finish(0, ok(record()));
    await s.flush();
    expect(s.spawned).toHaveLength(2); // PR 2 (the `main` entry the observation queued waits its fair-share turn)
    expect(inputOf(s, 1)).toMatchObject({ pr: 2, baseSha: sha('b') });
    expect(auditLines(s).some((l) => l.event === 'base-refresh-failed' && l.pr === 2)).toBe(true);
  });

  it('identical merge inputs already verified green derive a record at start instead of a second run', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('a') }) } }); // same head, a different PR
    let base = sha('9');
    withBaseHead(s, async () => base);
    base = sha('b');
    await s.svc.request(1); // runs with base b
    base = sha('9');
    await s.svc.request(2); // queued with base z (no dedupe: different inputs)
    base = sha('b');
    s.advance(MERGE_LINE.baseRefreshAfterMs);
    await s.finish(0, ok(record()));
    await s.flush();
    expect(s.spawned).toHaveLength(1);
    expect(s.svc.getRecord(2, sha('a'), 'main')).toMatchObject({ pr: 2, outcome: 'success' });
    expect(auditLines(s).some((l) => l.event === 'derived-at-start' && l.pr === 2)).toBe(true);
    expect(s.svc.snapshot().queue).toHaveLength(0);
  });

  it('a green record is handed to the watcher at once and the queue is held until it answers; a merge makes the next verify re-read its base', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    let base = sha('b');
    withBaseHead(s, async () => base);
    const calls: Array<{ pr: number; ctx: unknown }> = [];
    let answer!: (r: MergeHandoffResult) => void;
    s.svc.setMergeHandoff((rec, ctx) => { calls.push({ pr: rec.pr, ctx }); return new Promise((r) => { answer = r; }); });
    expect(s.svc.snapshot().mergeLine).toMatchObject({ wired: true, hold: null, handoffs: 0, merged: 0 });
    await s.svc.request(1);
    await s.svc.request(2);
    await s.finish(0, ok(record()));
    expect(calls).toEqual([{ pr: 1, ctx: { baseIsCurrentMain: null, currentMainHead: null } }]);
    expect(s.spawned).toHaveLength(1); // PR 2 waits behind the hold
    expect(s.svc.snapshot().inFlight).toBeNull();
    expect(s.svc.snapshot().mergeLine).toMatchObject({ hold: { pr: 1, headSha: sha('a') }, handoffs: 1, merged: 0, lastPr: 1 });
    await s.svc.tick(); // a tick during the hold starts nothing
    expect(s.spawned).toHaveLength(1);
    base = sha('e'); // the merge moved main
    s.advance(1_000);
    answer({ acted: true, reason: 'merged' });
    await s.flush();
    await s.flush();
    expect(s.spawned).toHaveLength(2);
    expect(inputOf(s, 1)).toMatchObject({ pr: 2, baseSha: sha('e') }); // tested on top of the merge (well inside the 5-min refresh window)
    expect(s.svc.snapshot().mergeLine).toMatchObject({ hold: null, handoffs: 1, merged: 1, lastOutcome: 'merged' });
    const ev = auditLines(s);
    expect(ev.some((l) => l.event === 'merge-handoff' && l.pr === 1)).toBe(true);
    expect(ev.some((l) => l.event === 'merge-handoff-result' && l.pr === 1 && l.acted === true && l.outcome === 'merged')).toBe(true);
    expect(ev.some((l) => l.event === 'base-refreshed' && l.pr === 2)).toBe(true);
  });

  it('the hand-off context says whether the record\'s base is the current main head', async () => {
    const s = setup({ views: { 1: view() } });
    const ctxs: unknown[] = [];
    s.svc.setMergeHandoff(async (_r, ctx) => { ctxs.push(ctx); return { acted: false, reason: 'handoff-not-eligible:held' }; });
    await s.svc.request(1); // in flight first, so the `main` verify the observation enqueues waits behind it
    s.svc.noteMainHead(sha('b'));
    await s.svc.settle();
    await s.finish(0, ok(record()));
    expect(ctxs).toEqual([{ baseIsCurrentMain: true, currentMainHead: sha('b') }]);
  });

  it('a refused hand-off releases the hold with no retry; failure, error and main records are never offered; a second green record during a hold is left to the watcher', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('a') }), 4: view({ headRefOid: sha('d') }) } });
    const calls: number[] = [];
    let answer!: (r: MergeHandoffResult) => void;
    s.svc.setMergeHandoff((rec) => { calls.push(rec.pr); return new Promise((r) => { answer = r; }); });
    await s.svc.request(1);
    await s.svc.request(2);
    await s.finish(0, ok(record()));
    expect(calls).toEqual([1]);
    // PR 3 shares PR 1's merge inputs: its derived green record arrives during the hold and is NOT offered.
    expect(await s.svc.request(3)).toMatchObject({ ok: true, status: 'recorded' });
    expect(calls).toEqual([1]);
    expect(auditLines(s).some((l) => l.event === 'merge-handoff-skipped' && l.pr === 3 && l.reason === 'hold-active')).toBe(true);
    answer({ acted: false, reason: 'handoff-not-eligible:held' });
    await s.flush();
    expect(calls).toEqual([1]); // no retry inside the line
    expect(s.svc.snapshot().mergeLine).toMatchObject({ hold: null, handoffs: 1, merged: 0, lastOutcome: 'handoff-not-eligible:held' });
    expect(s.spawned).toHaveLength(2); // PR 2 started once the hold was released
    await s.finish(1, ok(record({ pr: 2, headSha: sha('c'), outcome: 'failure' })));
    expect(calls).toEqual([1]); // a failure is never offered
    await s.svc.request(4);
    await s.finish(2, null); // crash → error record
    expect(calls).toEqual([1]);
    expect(s.svc.snapshot().mergeLine.hold).toBeNull();
  });

  it('the hold is bounded: the timer releases it and the next verify starts; a hand-off that throws releases it too', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    s.svc.setMergeHandoff(() => new Promise(() => { /* never answers */ }));
    await s.svc.request(1);
    await s.svc.request(2);
    await s.finish(0, ok(record()));
    expect(s.spawned).toHaveLength(1);
    expect(s.timers).toHaveLength(1);
    s.advance(MERGE_LINE.handoffMaxMs);
    s.timers[0]();
    await s.flush();
    expect(s.spawned).toHaveLength(2);
    expect(s.svc.snapshot().mergeLine).toMatchObject({ hold: null, lastOutcome: 'timeout' });
    expect(auditLines(s).some((l) => l.event === 'merge-handoff-result' && l.outcome === 'timeout' && l.heldMs === MERGE_LINE.handoffMaxMs)).toBe(true);

    const s2 = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    s2.svc.setMergeHandoff(async () => { throw new Error('watcher down'); });
    await s2.svc.request(1);
    await s2.svc.request(2);
    await s2.finish(0, ok(record()));
    await s2.flush();
    expect(s2.spawned).toHaveLength(2);
    expect(s2.svc.snapshot().mergeLine.lastOutcome).toBe('error:watcher down');
  });

  it('with no watcher attached (or detached again) records are left to the watcher\'s ticks and nothing is held', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    s.svc.setMergeHandoff(async () => ({ acted: true, reason: 'merged' }));
    s.svc.setMergeHandoff(null);
    expect(s.svc.snapshot().mergeLine.wired).toBe(false);
    await s.svc.request(1);
    await s.svc.request(2);
    await s.finish(0, ok(record()));
    expect(s.spawned).toHaveLength(2);
    expect(s.svc.snapshot().mergeLine).toMatchObject({ wired: false, hold: null, handoffs: 0 });
  });

  it('shutdown during a hold: nothing starts afterwards and the waiting entry is in the durable queue', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    let answer!: (r: MergeHandoffResult) => void;
    s.svc.setMergeHandoff(() => new Promise((r) => { answer = r; }));
    await s.svc.request(1);
    await s.svc.request(2);
    await s.finish(0, ok(record()));
    s.svc.shutdown();
    answer({ acted: true, reason: 'merged' });
    await s.flush();
    expect(s.spawned).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(s.svc.queuePath, 'utf-8')) as { entries: Array<{ pr: number }> };
    expect(saved.entries.map((e) => e.pr)).toEqual([2]);
  });
});

// ── Verifier changed on disk (2026-10-24: 00:12:52Z, 10:36:40Z, 2026-10-25T02:59:55Z): an update replaced the dist under the running server ──
import { VERIFIER_HOLD_SIGNAL_MS, isVerifierMismatch } from '../../../src/localVerify/LocalVerifyService.js';

describe('verifier changed on disk: a verifier-mismatch holds the queue for the restart instead of erroring every entry', () => {
  const mismatch = (child = 'vh2:new') => ({ kind: 'crash', detail: `verifier-mismatch: server 1.0.0, child ${child}` } as unknown as VerifyRunResult);
  const audit = (dir: string) => fs.readFileSync(path.join(dir, 'logs', 'local-verify.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const queueOnDisk = (dir: string) => (JSON.parse(fs.readFileSync(path.join(dir, 'state', 'local-verify', 'queue.json'), 'utf-8')) as { entries: Array<{ pr: number; attempts: number; errorRetries: number }> }).entries;

  it('isVerifierMismatch: the child\'s refusal and nothing else', () => {
    expect(isVerifierMismatch({ kind: 'crash', detail: 'verifier-mismatch: server a, child b' })).toBe(true);
    expect(isVerifierMismatch({ kind: 'crash', detail: 'ENOSPC' })).toBe(false);
    expect(isVerifierMismatch({ kind: 'crash', detail: '' })).toBe(false);
    expect(isVerifierMismatch(null)).toBe(false);
    expect(isVerifierMismatch(ok(record()))).toBe(false);
  });

  it('(a) the mismatch puts the entry back at the head with its attempts unchanged, audits one event, and starts nothing further', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('e') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    await s.svc.request(3);
    expect(s.spawned).toHaveLength(1); // PR 1 running (attempts 1)
    await s.finish(0, mismatch());
    // Back at the head, in order, the attempt not counted; no retry counter burned.
    expect(s.svc.snapshot().queue.map((e) => [e.pr, e.attempts, e.errorRetries])).toEqual([[1, 0, 0], [2, 0, 0], [3, 0, 0]]);
    expect(s.svc.snapshot().inFlight).toBeNull();
    expect(s.svc.snapshot().verifierHold).toMatchObject({ where: 'run', detail: expect.stringMatching(/^verifier-mismatch/) });
    // Nothing more starts, however many ticks and requests: the cascade that burned 10 PRs in one second is closed.
    for (let i = 0; i < 5; i++) { s.advance(30_000); await s.svc.tick(); }
    expect(await s.svc.request(4)).toEqual({ ok: false, code: 'pr-unreadable' }); // an unknown PR is still refused as usual…
    s.views[4] = view({ headRefOid: sha('f') });
    expect(await s.svc.request(4)).toMatchObject({ ok: true, status: 'queued' }); // …a readable one still queues (behind the held ones)
    expect(s.spawned).toHaveLength(1);
    expect(s.svc.snapshot().queue.map((e) => e.pr)).toEqual([1, 2, 3, 4]);
    expect(audit(s.stateDir).filter((l) => l.event === 'verifier-changed')).toHaveLength(1);
    expect(audit(s.stateDir).filter((l) => l.event === 'verifier-changed')[0]).toMatchObject({ where: 'run', pr: 1, headSha: sha('a'), serverVersion: '1.0.0' });
    expect(audit(s.stateDir).some((l) => l.event === 'run-error' || l.event === 'error-auto-retry' || l.event === 'record')).toBe(false);
    // The durable queue carries every entry, intact, for the next boot.
    expect(queueOnDisk(s.stateDir).map((e) => [e.pr, e.attempts, e.errorRetries])).toEqual([[1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
  });

  it('(c) no error record is written for a mismatch: the journal stays empty, GET record is null, and the next boot drops nothing as already-recorded', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    await s.finish(0, mismatch());
    expect(s.records).toEqual([]);
    expect(s.svc.getRecord(1, sha('a'), 'main')).toBeNull();
    expect(fs.existsSync(s.svc.journalPath)).toBe(false);
    expect(s.svc.snapshot().records).toBe(0);
  });

  it('(b) after the restart the restored queue runs again, in order, on the new verifier version', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('e') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    await s.svc.request(3);
    await s.finish(0, mismatch('vh2:new'));
    s.svc.shutdown(); // the update's restart
    expect(queueOnDisk(s.stateDir).map((e) => e.pr)).toEqual([1, 2, 3]);
    // The new process computes its verifierVersion from the new files; no hold is carried over.
    const s2 = setup({ stateDir: s.stateDir, views: s.views, verifierVersion: 'vh2:new' });
    await s2.svc.boot();
    expect(s2.svc.snapshot().verifierHold).toBeNull();
    expect(s2.svc.snapshot().queue.map((e) => [e.pr, e.attempts])).toEqual([[1, 0], [2, 0], [3, 0]]); // nothing dropped as already-recorded
    expect(audit(s.stateDir).filter((l) => l.event === 'queue-restored').pop()).toMatchObject({ restored: 3, dropped: 0 });
    await s2.svc.tick();
    expect(s2.spawned).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(s2.spawned[0].args[s2.spawned[0].args.indexOf('--input') + 1], 'utf-8'))).toMatchObject({ pr: 1, verifierVersion: 'vh2:new' });
    await s2.finish(0, ok(record({ verifierVersion: 'vh2:new' })));
    expect(s2.records).toHaveLength(1);
    expect(s2.spawned).toHaveLength(2); // PR 2 follows
  });

  it('a `main` entry is handled the same way: re-queued, no main record, no main error retry', async () => {
    const s = setup({ views: {} });
    s.svc.noteMainHead(sha('7'));
    await s.svc.settle();
    await s.svc.tick();
    expect(s.spawned).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(s.spawned[0].args[s.spawned[0].args.indexOf('--input') + 1], 'utf-8'))).toMatchObject({ kind: 'main', headSha: sha('7') });
    const before = s.svc.mainHealth();
    await s.finish(0, mismatch());
    expect(s.svc.snapshot().queue.map((e) => [e.kind, e.headSha, e.attempts])).toEqual([['main', sha('7'), 0]]);
    expect(s.svc.mainHealth()).toMatchObject({ state: before.state, redHead: before.redHead, lastGreenHead: before.lastGreenHead });
    expect(audit(s.stateDir).some((l) => l.event === 'main-record' || l.event === 'main-error-retry' || l.event === 'run-error')).toBe(false);
    expect(audit(s.stateDir).filter((l) => l.event === 'verifier-changed')[0]).toMatchObject({ where: 'run', kind: 'main', headSha: sha('7') });
    for (let i = 0; i < 3; i++) { s.advance(30_000); await s.svc.tick(); }
    expect(s.spawned).toHaveLength(1);
  });

  it('pre-start check: files that no longer compute the server\'s version enter the hold without spawning; matching files again release it', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    s.setDiskVersion('1.0.0'); // in step: starts as usual
    await s.svc.request(1);
    expect(s.spawned).toHaveLength(1);
    await s.svc.request(2);
    s.setDiskVersion('vh2:replaced'); // npm replaced the dist while PR 1 runs
    await s.finish(0, ok(record()));
    expect(s.records).toHaveLength(1); // the finished run is recorded under the version it ran as
    expect(s.spawned).toHaveLength(1); // PR 2 is NOT spawned into a child that would refuse
    expect(s.svc.snapshot().verifierHold).toMatchObject({ where: 'before-start', detail: 'verifier-mismatch: server 1.0.0, disk vh2:replaced' });
    expect(s.svc.snapshot().queue.map((e) => [e.pr, e.attempts])).toEqual([[2, 0]]);
    expect(audit(s.stateDir).filter((l) => l.event === 'verifier-changed')).toEqual([expect.objectContaining({ where: 'before-start', serverVersion: '1.0.0' })]);
    for (let i = 0; i < 3; i++) { s.advance(30_000); await s.svc.tick(); }
    expect(s.spawned).toHaveLength(1);
    // The files compute the server's version again (a flip that undid itself): the hold lifts, the queue resumes.
    s.setDiskVersion('1.0.0');
    s.advance(30_000);
    await s.svc.tick();
    expect(s.svc.snapshot().verifierHold).toBeNull();
    expect(s.spawned).toHaveLength(2);
    expect(audit(s.stateDir).filter((l) => l.event === 'verifier-hold-released')).toHaveLength(1);
  });

  it('an unknown on-disk version (no seam answer, or a read error) never holds: the child\'s own check decides', async () => {
    const s = setup({ views: { 1: view() } });
    s.setDiskVersion(null);
    await s.svc.request(1);
    expect(s.spawned).toHaveLength(1);
    const s2 = setup({ views: { 1: view() } });
    (s2.svc as unknown as { seams: LocalVerifyServiceSeams }).seams.installedVerifierVersion = () => { throw new Error('ENOENT mid-replacement'); };
    await s2.svc.request(1);
    expect(s2.spawned).toHaveLength(1);
    expect(s2.svc.snapshot().verifierHold).toBeNull();
  });

  it('a hold that outlives the restart it waits for is signalled once (local-verify:verifier-hold), then stays quiet', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s.svc.request(1);
    await s.svc.request(2);
    await s.finish(0, mismatch());
    s.advance(VERIFIER_HOLD_SIGNAL_MS - 1);
    await s.svc.tick();
    expect(s.signals).toEqual([]);
    s.advance(1);
    await s.svc.tick();
    expect(s.signals).toEqual([{ key: 'local-verify:verifier-hold', detail: expect.objectContaining({ heldMs: VERIFIER_HOLD_SIGNAL_MS, queued: 2, serverVersion: '1.0.0' }) }]);
    for (let i = 0; i < 4; i++) { s.advance(VERIFIER_HOLD_SIGNAL_MS); await s.svc.tick(); }
    expect(s.signals).toHaveLength(1);
    expect(audit(s.stateDir).filter((l) => l.event === 'verifier-hold-overdue')).toHaveLength(1);
    expect(s.spawned).toHaveLength(1); // still held: only a restart (or the files matching again) resumes
  });

  it('an ordinary crash is still an error record with one automatic re-run (the mismatch path changed nothing else)', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, { kind: 'crash', detail: 'spawn ENOMEM' } as unknown as VerifyRunResult);
    expect(s.spawned).toHaveLength(2); // the error auto-retry
    await s.finish(1, null);
    expect(s.records.map((r) => r.errorStep)).toEqual(['crash', 'crash']);
    expect(s.svc.snapshot().verifierHold).toBeNull();
  });
});

// ── 2026-10-25: a restart deferred only for this verifier pauses new starts; closed PRs are skipped ──

describe('a deferred restart is a pending update (the applied-but-not-restarted gap)', () => {
  it('updatePendingFromAutoUpdater: an active restartDeferral with pendingUpdate cleared is pending, timed from firstDeferredAt', () => {
    const base = { config: { autoApply: true }, pendingUpdate: null, coalescingUntil: null, pendingUpdateDetectedAt: null };
    const deferral = { active: true, firstDeferredAt: '2026-10-21T12:00:00.000Z' };
    expect(updatePendingFromAutoUpdater({ ...base, restartDeferral: deferral }, ['hold:local-verify:pr-1']))
      .toEqual({ pending: true, pendingSinceMs: T0, otherBlockers: false });
    // Not active, absent or null: not pending (both sides of the boundary).
    expect(updatePendingFromAutoUpdater({ ...base, restartDeferral: { ...deferral, active: false } }, []).pending).toBe(false);
    expect(updatePendingFromAutoUpdater({ ...base, restartDeferral: null }, []).pending).toBe(false);
    expect(updatePendingFromAutoUpdater(base, []).pending).toBe(false);
    // The earlier of detection and first deferral starts the 120-minute cap.
    expect(updatePendingFromAutoUpdater({ ...base, pendingUpdateDetectedAt: '2026-10-21T11:00:00.000Z', restartDeferral: deferral }, []).pendingSinceMs)
      .toBe(T0 - 3_600_000);
    // Something else delaying the restart still never pauses.
    expect(updatePendingFromAutoUpdater({ ...base, restartDeferral: deferral }, ['echo-topic-1', 'hold:local-verify:pr-1']).otherBlockers).toBe(true);
  });

  it('through the real AutoUpdater: once the restart is deferred only for a running verify, the next queued verify does not start; the restart then goes ahead', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-au-gap-')));
    dirs.push(tmp);
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const checker = { getInstalledVersion: vi.fn().mockReturnValue('0.9.8'), check: vi.fn(), applyUpdate: vi.fn(), getLastCheck: vi.fn().mockReturnValue(null) } as unknown as UpdateChecker;
    const st = { get: vi.fn().mockReturnValue(997), set: vi.fn() } as unknown as StateManager;
    const u = new AutoUpdater(checker, st, tmp, { preRestartDelaySecs: 0 });
    try {
      const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
      s.advance(Date.now() - T0); // the AutoUpdater reads the real clock
      await s.svc.request(1);
      await s.svc.request(2);
      u.setSessionDeps({ listRunningSessions: () => [] });
      registerLocalVerifyRestartHold(u, s.svc);
      const gated = () => (u as unknown as { gatedRestart(v: string, b?: boolean): Promise<void> }).gatedRestart('0.9.9', false);
      await gated();
      // The apply already cleared pendingUpdate: only the deferral says the update is waiting.
      expect(u.getStatus().pendingUpdate).toBeNull();
      expect(u.getStatus().restartDeferral).toMatchObject({ active: true, currentBlockers: ['local-verify:pr-1'] });
      await s.finish(0, ok(record()));
      await s.svc.tick();
      expect(s.spawned).toHaveLength(1); // PR 2 waits: the running one finished, nothing new started
      expect(s.svc.snapshot().queue.map((e) => e.pr)).toEqual([2]);
      expect(fs.readFileSync(s.svc.auditPath, 'utf-8')).toContain('"event":"update-pause"');
      expect(s.svc.restartHolds(4 * 3_600_000)).toEqual([]);
      await gated(); // the 5-minute retry: nothing holds it now
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(path.join(tmp, 'state', 'restart-requested.json'))).toBe(true);
      // The deferral is gone (on a real server the process restarts here); the queue resumes.
      await s.svc.tick();
      expect(s.spawned).toHaveLength(2);
    } finally {
      u.stop();
      log.mockRestore();
    }
  });
});

describe('closed PRs are skipped', () => {
  it('POST for a merged or closed PR answers pr-closed and queues nothing; an unknown answer queues it', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) }, open: { 1: false, 2: null } });
    expect(await s.svc.request(1)).toEqual({ ok: false, code: 'pr-closed' });
    expect(s.spawned).toHaveLength(0);
    expect(fs.readFileSync(s.svc.auditPath, 'utf-8')).toContain('"reason":"pr-closed"');
    expect(await s.svc.request(2)).toMatchObject({ ok: true, status: 'queued' });
    expect(s.spawned).toHaveLength(1);
  });

  it('a pr-closed refusal also drops the queued entry for that PR; a run in flight carries on', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }) } });
    await s.svc.request(1); // in flight
    await s.svc.request(2); // queued
    s.open[1] = false;
    s.open[2] = false;
    expect(await s.svc.request(2)).toEqual({ ok: false, code: 'pr-closed' });
    expect(s.svc.snapshot().queue.map((e) => e.pr)).toEqual([]);
    expect(await s.svc.request(1)).toEqual({ ok: false, code: 'pr-closed' });
    expect(s.svc.snapshot().inFlight?.pr).toBe(1); // not cancelled
    const rows = fs.readFileSync(s.svc.auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.some((r) => r.event === 'dequeued' && r.pr === 2 && r.reason === 'closed')).toBe(true);
  });

  it('a PR that closed while it waited is dequeued (reason closed) at pick time, not started; an unknown answer still starts', async () => {
    const s = setup({ views: { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('e') }), 4: view({ headRefOid: sha('f') }) } });
    for (const pr of [1, 2, 3, 4]) await s.svc.request(pr);
    s.advance(MERGE_LINE.baseRefreshAfterMs + 60_000); // they waited: the pre-start check runs
    s.open[2] = false; // merged while it waited
    s.open[3] = null; // GitHub unreadable: keeps its place
    await s.finish(0, ok(record()));
    await s.flush();
    await s.flush();
    expect(s.spawned).toHaveLength(2);
    const started = JSON.parse(fs.readFileSync(s.spawned[1].args[s.spawned[1].args.indexOf('--input') + 1], 'utf-8'));
    expect(started.pr).toBe(3);
    expect(s.svc.snapshot().queue.map((e) => e.pr)).toEqual([4]);
    const audit = fs.readFileSync(s.svc.auditPath, 'utf-8');
    const rows = audit.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.some((r) => r.event === 'dequeued' && r.pr === 2 && r.reason === 'closed')).toBe(true);
    expect(rows.some((r) => r.event === 'dequeued' && r.pr === 3)).toBe(false);
  });
});

describe('fail-fast switch (monitoring.localVerify.failFast)', () => {
  const inputOf = (s: ReturnType<typeof setup>) => JSON.parse(fs.readFileSync(s.spawned[0].args[s.spawned[0].args.indexOf('--input') + 1], 'utf-8'));
  it('a PR verify carries failFast when the switch is absent (on by default)', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    expect(inputOf(s).failFast).toBe(true);
  });
  it('the switch read false turns it off at the next start', async () => {
    const s = setup({ views: { 1: view() } });
    s.svc.setFailFastEnabled(() => false);
    await s.svc.request(1);
    expect(inputOf(s).failFast).toBeUndefined();
  });
  it('an unreadable switch reads as off (every lane runs)', async () => {
    const s = setup({ views: { 1: view() } });
    s.svc.setFailFastEnabled(() => { throw new Error('config unreadable'); });
    await s.svc.request(1);
    expect(inputOf(s).failFast).toBeUndefined();
  });
});

describe('lane shard setting (monitoring.localVerify.laneShards)', () => {
  const inputOf = (s: ReturnType<typeof setup>) => JSON.parse(fs.readFileSync(s.spawned[0].args[s.spawned[0].args.indexOf('--input') + 1], 'utf-8'));
  it('absent ⇒ no override in the run input (the policy defaults apply)', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    expect(inputOf(s).laneShards).toBeUndefined();
  });
  it('valid counts pass through; invalid ones are dropped', async () => {
    const s = setup({ views: { 1: view() } });
    s.svc.setLaneShards(() => ({ integration: 1, e2e: 7 }));
    await s.svc.request(1);
    expect(inputOf(s).laneShards).toEqual({ integration: 1 });
  });
  it('an unreadable setting means the defaults', async () => {
    const s = setup({ views: { 1: view() } });
    s.svc.setLaneShards(() => { throw new Error('nope'); });
    await s.svc.request(1);
    expect(inputOf(s).laneShards).toBeUndefined();
  });
});
