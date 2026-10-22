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
  LocalVerifyService, checkEligibility,
  type LocalVerifyServiceSeams, type PrView, type InFlightIntent,
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

function setup(opts: { views?: Record<number, PrView>; open?: Record<number, boolean | null>; stateDir?: string } = {}) {
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
  let holders: number[] = [];
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
    now: () => t,
    setTimer: (fn) => { timers.push(fn); },
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
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
    svc, stateDir, views, open, spawned, alive, stubborn, kills, procArgs, timers, starved, records, intentPath,
    setHolders: (h: number[]) => { holders = h; },
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
    expect(s.starved).toEqual([{ pr: 1, headSha: sha('a'), waitedMs: LOCAL_VERIFY_LIMITS.starvedAfterMs + 1000 }]);
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
