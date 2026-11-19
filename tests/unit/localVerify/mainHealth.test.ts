// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 tests for main health (spec local-verify-merge-authority.md §2
 * "Post-merge verify of main", "Restarts", §3 main-red admission, Self-heal (c)):
 * the MainHealth state machine and watermark, and the service's `main` verify
 * queue (priority, outside the cap, one pending, replace, never cancel running),
 * debounce/cap, re-run-once, red→green re-runs of failed PR verifies.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { MainHealth, SUPERSEDED_HEADS_KEPT, decideMainHeadEnqueue, decideMainRearmAfterGreen, noteHeadSuperseded, oldestUnverifiedAfterGreen, supersededAtFor, patchChangesOnlyVersion, releaseCollapsesInto, type CommitInfo, type MainHealthSnapshot } from '../../../src/localVerify/mainHealth.js';
import { LocalVerifyService, MAIN_FAIR_SHARE_MS, MAIN_VERIFY_LIMITS, decideFlakyEscalation, decideStart, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS, computePolicyHash } from '../../../src/localVerify/policy.js';
import { validateRecord, type LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'mainHealth.test.ts' }); });

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvmh-')));
  dirs.push(d);
  return d;
}

function watermark(dir: string, o: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, 'state', 'local-verify'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
    v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z', ...o,
  }));
}

function health(dir: string, opts: { ancestor?: (a: string, d: string) => boolean | null } = {}) {
  const signals: string[] = [];
  const changes: Array<{ to: string; from: string }> = [];
  const h = new MainHealth(dir, 'm1', {
    now: () => 1_000,
    isAncestor: async (a, d) => (opts.ancestor ? opts.ancestor(a, d) : false),
    signal: (k) => { signals.push(k); },
    onChange: (s: MainHealthSnapshot, p: MainHealthSnapshot) => { changes.push({ to: s.state, from: p.state }); },
    audit: () => {},
  });
  return { h, signals, changes };
}

describe('MainHealth — boot and the watermark', () => {
  it('a readable healthy watermark of this machine keeps healthy (no main-suspect at boot)', () => {
    const d = tmp(); watermark(d, {});
    expect(health(d).h.load().state).toBe('healthy');
  });

  it('a missing, unreadable, or other-machine watermark enters main-suspect', () => {
    const d1 = tmp();
    expect(health(d1).h.load()).toMatchObject({ state: 'main-suspect', reason: 'boot-unknown' });
    const d2 = tmp(); fs.mkdirSync(path.join(d2, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(d2, 'state', 'local-verify', 'main-health.json'), '{not json');
    expect(health(d2).h.load().state).toBe('main-suspect');
    const d3 = tmp(); watermark(d3, { machineId: 'm_other' });
    expect(health(d3).h.load().state).toBe('main-suspect');
  });

  it('lease acquisition after a different machine held it enters main-suspect even with a healthy file', () => {
    const d = tmp(); watermark(d, {});
    expect(health(d).h.load({ foreignHolder: true })).toMatchObject({ state: 'main-suspect', reason: 'lease-foreign' });
  });

  it('a red freeze survives a restart (the file only makes admission stricter)', () => {
    const d = tmp(); watermark(d, { state: 'main-red', redHead: sha('r'), reason: 'rerun-failed' });
    expect(health(d).h.load()).toMatchObject({ state: 'main-red', redHead: sha('r') });
  });
});

describe('MainHealth — watermark epoch and unwritable stricter state', () => {
  it('stores the lease epoch and holder; the next epoch (same machine re-acquiring) keeps healthy', () => {
    const d = tmp(); watermark(d, {});
    const { h } = health(d);
    h.load({ epoch: 5 });
    expect(JSON.parse(fs.readFileSync(h.watermarkPath, 'utf-8'))).toMatchObject({ leaseEpoch: 5, holderMachineId: 'm1' });
    expect(health(d).h.load({ epoch: 6 }).state).toBe('healthy');
    expect(health(d).h.load({ epoch: 6 }).state).toBe('healthy'); // same epoch
  });

  it('a boot (no epoch) keeps the stored epoch; a gap at acquisition means another holder came between ⇒ main-suspect', () => {
    const d = tmp(); watermark(d, { leaseEpoch: 5 });
    const a = health(d).h;
    expect(a.load().state).toBe('healthy'); // boot: epoch unknown, watermark decides
    expect(JSON.parse(fs.readFileSync(a.watermarkPath, 'utf-8')).leaseEpoch).toBe(5);
    expect(health(d).h.load({ epoch: 9 })).toMatchObject({ state: 'main-suspect', reason: 'lease-epoch-gap' });
  });

  it('a watermark without an epoch never manufactures a gap', () => {
    const d = tmp(); watermark(d, {});
    expect(health(d).h.load({ epoch: 40 }).state).toBe('healthy');
  });

  it('if a stricter state cannot be written, the watermark is deleted so the next boot enters main-suspect', async () => {
    const d = tmp(); watermark(d, {});
    const audits: Array<Record<string, unknown>> = [];
    const h = new MainHealth(d, 'm1', { now: () => 1, isAncestor: async () => null, audit: (e) => { audits.push(e); } });
    h.load();
    fs.mkdirSync(`${h.watermarkPath}.tmp`); // the atomic write's temp path is now a directory ⇒ write fails
    await h.onVerify(sha('1'), 'failure');
    expect(h.snapshot().state).toBe('main-suspect');
    expect(fs.existsSync(h.watermarkPath)).toBe(false);
    expect(audits.map((a) => a.event)).toEqual(expect.arrayContaining(['main-health-write-failed', 'main-health-watermark-removed']));
    expect(health(d).h.load().state).toBe('main-suspect');
  });
});

describe('MainHealth — transitions', () => {
  it('first failure → main-suspect (no signal) and a re-run; re-run fails → main-red, ONE signal', async () => {
    const d = tmp(); watermark(d, {});
    const { h, signals, changes } = health(d);
    h.load();
    expect(await h.onVerify(sha('1'), 'failure')).toBe('rerun');
    expect(h.snapshot()).toMatchObject({ state: 'main-suspect', redHead: sha('1') });
    expect(signals).toEqual([]);
    expect(await h.onVerify(sha('1'), 'failure')).toBe('none');
    expect(h.snapshot().state).toBe('main-red');
    expect(await h.onVerify(sha('2'), 'failure')).toBe('none');
    expect(h.snapshot().redHead).toBe(sha('2'));
    expect(signals).toEqual(['local-verify:main-red']);
    expect(changes.map((c) => c.to)).toEqual(['main-suspect', 'main-red', 'main-red']);
    // The watermark was written before the hook ran and holds the newest red head.
    expect(JSON.parse(fs.readFileSync(h.watermarkPath, 'utf-8'))).toMatchObject({ state: 'main-red', redHead: sha('2'), machineId: 'm1' });
  });

  it('a passing re-run clears the suspect as a flake (no signal)', async () => {
    const d = tmp(); watermark(d, {});
    const { h, signals } = health(d);
    h.load();
    await h.onVerify(sha('1'), 'failure');
    expect(await h.onVerify(sha('1'), 'success')).toBe('cleared');
    expect(h.snapshot().state).toBe('healthy');
    expect(signals).toEqual([]);
  });

  it('red is cleared only by a green verify of the red head or a descendant; an older head never clears it', async () => {
    const d = tmp(); watermark(d, { state: 'main-red', redHead: sha('r') });
    const { h } = health(d, { ancestor: (a, x) => (x === sha('n') ? true : x === sha('o') ? false : null) });
    h.load();
    expect(await h.onVerify(sha('o'), 'success')).toBe('none'); // older / unrelated
    expect(h.snapshot().state).toBe('main-red');
    expect(await h.onVerify(sha('u'), 'success')).toBe('none'); // ancestry unknown ⇒ stays red
    expect(h.snapshot().state).toBe('main-red');
    expect(await h.onVerify(sha('n'), 'success')).toBe('cleared');
    expect(h.snapshot()).toMatchObject({ state: 'healthy', redHead: null, lastGreenHead: sha('n') });
  });

  it('an error never counts as red', async () => {
    const d = tmp(); watermark(d, {});
    const { h } = health(d);
    h.load();
    expect(await h.onVerify(sha('1'), 'error')).toBe('none');
    expect(h.snapshot().state).toBe('healthy');
  });

  it('an unknown-state suspect (boot) is cleared by any green main verify', async () => {
    const d = tmp();
    const { h } = health(d);
    h.load();
    await h.onVerify(sha('1'), 'success');
    expect(h.snapshot().state).toBe('healthy');
  });

  it('main unverified for more than 3 hours → main-suspect + one main-unverified signal', () => {
    const d = tmp(); watermark(d, {});
    const { h, signals } = health(d);
    h.load();
    h.noteUnverifiedAge(1_000 - 2 * 60 * MIN);
    expect(h.snapshot().state).toBe('healthy');
    h.noteUnverifiedAge(1_000 - 4 * 60 * MIN);
    h.noteUnverifiedAge(1_000 - 5 * 60 * MIN);
    expect(h.snapshot()).toMatchObject({ state: 'main-suspect', reason: 'unverified-too-long' });
    expect(signals).toEqual(['local-verify:main-unverified']);
  });
});

// ── the service's main verify queue ────────────────────────────────────

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
  };
}
const mainRecord = (head: string, outcome: 'success' | 'failure' | 'error'): LocalVerifyRecord =>
  record({ kind: 'main', pr: 0, headSha: head, baseSha: head, outcome, ...(outcome === 'error' ? { errorStep: 'fetch', mergeTree: '' } : {}) });

function svcSetup(opts: { healthy?: boolean; views?: Record<number, PrView>; ancestor?: (a: string, d: string) => boolean | null; commitInfo?: (sha: string) => Promise<CommitInfo | null>; wm?: Record<string, unknown> } = {}) {
  const stateDir = tmp();
  if (opts.healthy !== false) watermark(stateDir, opts.wm ?? {});
  const spawned: Array<{ inputPath: string; resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const signals: string[] = [];
  const signalDetails: Array<{ key: string; detail: Record<string, unknown> }> = [];
  const healthChanges: string[] = [];
  let t = Date.parse('2026-10-21T12:00:00.000Z');
  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => opts.views?.[pr] ?? null,
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
    isAncestor: async (a, d) => (opts.ancestor ? opts.ancestor(a, d) : false),
    signal: (k, d) => { signals.push(k); signalDetails.push({ key: k, detail: d }); },
    ...(opts.commitInfo ? { commitInfo: opts.commitInfo } : {}),
    onMainHealthChange: (s) => { healthChanges.push(s.state); },
    now: () => t,
    setTimer: () => {},
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/x/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, seams);
  const finish = async (i: number, result: VerifyRunResult | null) => {
    if (result) fs.writeFileSync(spawned[i].resultPath, JSON.stringify(result));
    spawned[i].resolve({ status: 0, signal: null });
    await new Promise((r) => setImmediate(r));
    await svc.settle();
  };
  const inputOf = (i: number) => JSON.parse(fs.readFileSync(spawned[i].inputPath, 'utf-8')) as { pr: number; headSha: string; baseSha: string; kind?: string };
  const auditLines = () => fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { svc, spawned, signals, signalDetails, healthChanges, finish, inputOf, auditLines, advance: (ms: number) => { t += ms; } };
}
const ok = (r: LocalVerifyRecord): VerifyRunResult => ({ kind: 'record', record: r, reasons: [], overlaps: [], keptWorktree: null });
const view = (pr: number, head: string): PrView => ({ author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: head, baseRefName: 'main', baseRefOid: sha('b') });

describe('record validation for a main verify', () => {
  it('kind main needs pr 0 and head == base; PR records are unchanged', () => {
    expect(validateRecord(mainRecord(sha('f'), 'success')).ok).toBe(true);
    expect(validateRecord({ ...mainRecord(sha('f'), 'success'), baseSha: sha('e') }).ok).toBe(false);
    expect(validateRecord({ ...mainRecord(sha('f'), 'success'), pr: 3 }).ok).toBe(false);
    expect(validateRecord(record({ pr: 0 })).ok).toBe(false);
    expect(validateRecord({ ...record(), kind: 'other' }).ok).toBe(false);
  });
});

describe('LocalVerifyService — the main verify', () => {
  it('boot skips the debounce: the first observed head is verified at once, as kind main (head == base)', async () => {
    const s = svcSetup();
    await s.svc.boot();
    s.svc.noteMainHead(sha('f'));
    expect(s.spawned).toHaveLength(1);
    expect(s.inputOf(0)).toMatchObject({ kind: 'main', pr: 0, headSha: sha('f'), baseSha: sha('f') });
  });

  it('debounced: starts once the head is unchanged 10 minutes; capped at 30 minutes from the first unverified head', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1')); // immediate (boot)
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    s.svc.noteMainHead(sha('2'));
    s.advance(9 * MIN); s.svc.noteMainHead(sha('2'));
    expect(s.spawned).toHaveLength(1);
    s.advance(1 * MIN); s.svc.noteMainHead(sha('2'));
    expect(s.spawned).toHaveLength(2);
    await s.finish(1, ok(mainRecord(sha('2'), 'success')));
    // A steady stream of merges cannot keep resetting it.
    s.svc.noteMainHead(sha('3')); // the first unverified head
    for (const h of ['4', '5', '6']) { s.advance(8 * MIN); s.svc.noteMainHead(sha(h)); }
    expect(s.spawned).toHaveLength(2); // 24 min since the first unverified head, each head < 10 min old
    s.advance(6 * MIN); s.svc.noteMainHead(sha('7'));
    expect(s.spawned).toHaveLength(3); // the 30-minute cap fired
    expect(s.inputOf(2).headSha).toBe(sha('7'));
  });

  it('priority over PR verifies, outside the cap of 10, at most one pending; a newer head replaces a pending one; a running one is never cancelled', async () => {
    const views: Record<number, PrView> = {};
    for (let i = 1; i <= 12; i++) views[i] = view(i, (i.toString(16).padStart(2, '0')).repeat(20));
    // Head 1 is the stored last green head, so this process sees main leave green and knows the age
    // of what follows (a boot that finds an unverified head with no stored age reads it as unknown).
    const s = svcSetup({ views, wm: { lastGreenHead: sha('1') } });
    s.svc.noteMainHead(sha('1')); // running
    for (let i = 1; i <= 10; i++) expect((await s.svc.request(i)).ok).toBe(true);
    expect(await s.svc.request(11)).toEqual({ ok: false, code: 'queue-full' });
    s.svc.noteMainHead(sha('2')); s.advance(10 * MIN); s.svc.noteMainHead(sha('2')); // queued despite a full PR queue
    expect(s.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => e.headSha)).toEqual([sha('2')]);
    s.svc.noteMainHead(sha('3')); s.advance(10 * MIN); s.svc.noteMainHead(sha('3')); // replaces the pending main entry
    const q = s.svc.snapshot().queue;
    expect(q.filter((e) => e.kind === 'main').map((e) => e.headSha)).toEqual([sha('3')]);
    expect(s.svc.snapshot().inFlight).toMatchObject({ kind: 'main', headSha: sha('1') });
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    // Fair share: a main verify finished just now and PRs wait, so the oldest PR goes first…
    expect(s.inputOf(1)).toMatchObject({ pr: 1 });
    // …and once no main verify has finished in the last 2 hours, the pending main goes ahead of the other 9.
    s.advance(2 * 60 * MIN);
    await s.finish(1, ok(record({ pr: 1, headSha: views[1].headRefOid })));
    expect(s.inputOf(2)).toMatchObject({ kind: 'main', headSha: sha('3') });
  });

  it('red: re-run once in main-suspect, then main-red with ONE signal; the watcher requests no PR verifies while unhealthy, POSTs still run', async () => {
    const s = svcSetup({ views: { 5: view(5, sha('a')) } });
    s.svc.noteMainHead(sha('1'));
    await s.finish(0, ok(mainRecord(sha('1'), 'failure')));
    expect(s.svc.mainHealth().state).toBe('main-suspect');
    expect(s.signals).toEqual([]);
    expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: sha('1') }); // the one re-run
    expect(await s.svc.request(5, { explicit: false })).toEqual({ ok: false, code: 'main-unhealthy' });
    await s.finish(1, ok(mainRecord(sha('1'), 'failure')));
    expect(s.svc.mainHealth().state).toBe('main-red');
    expect(s.signals).toEqual(['local-verify:main-red']);
    expect(s.healthChanges).toEqual(['main-suspect', 'main-red']);
    expect((await s.svc.request(5, { explicit: true })).ok).toBe(true);
  });

  it('red→green re-runs failed PR verifies, oldest first, up to the queue cap (overflow stays failed)', async () => {
    const views: Record<number, PrView> = {};
    for (let i = 1; i <= 12; i++) views[i] = view(i, (i.toString(16).padStart(2, '0')).repeat(20));
    const s = svcSetup({ views, ancestor: () => true });
    s.svc.noteMainHead(sha('1'));
    await s.finish(0, ok(mainRecord(sha('1'), 'failure')));
    await s.finish(1, ok(mainRecord(sha('1'), 'failure'))); // main-red; nothing else queued
    // 12 failed PR records (POSTed while red), finished in reverse PR order.
    for (let i = 12; i >= 1; i--) {
      const r = await s.svc.request(i);
      if (!r.ok || r.status !== 'queued') throw new Error(`pr ${i}: ${JSON.stringify(r)} ${JSON.stringify(s.svc.snapshot())}`);
      const idx = s.spawned.length - 1;
      await s.finish(idx, ok(record({ pr: i, headSha: views[i].headRefOid, outcome: 'failure', finishedAt: `2026-10-21T11:${String(60 - i).padStart(2, '0')}:00.000Z` })));
    }
    const before = s.spawned.length;
    s.svc.noteMainHead(sha('2')); s.advance(10 * MIN); s.svc.noteMainHead(sha('2'));
    await s.finish(before, ok(mainRecord(sha('2'), 'success')));
    expect(s.svc.mainHealth().state).toBe('healthy');
    const prs = s.svc.snapshot().queue.filter((e) => e.kind !== 'main').map((e) => e.pr);
    const running = s.svc.snapshot().inFlight?.pr;
    const all = [running, ...prs];
    expect(all).toHaveLength(LOCAL_VERIFY_LIMITS.queueCap + 1); // one in flight + the 10-cap queue; the 12th overflows
    expect(all.slice(0, 3)).toEqual([12, 11, 10]); // oldest finishedAt first
  });

  it('an error re-queues with backoff, at most 3 times per head, and never turns main red', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    for (let n = 0; n < MAIN_VERIFY_LIMITS.errorRetries; n++) {
      await s.finish(n, ok(mainRecord(sha('1'), 'error')));
      expect(s.spawned).toHaveLength(n + 1); // backoff: not yet
      s.advance(MAIN_VERIFY_LIMITS.errorBackoffMs * (n + 1));
      await s.svc.tick();
      expect(s.spawned).toHaveLength(n + 2);
    }
    await s.finish(MAIN_VERIFY_LIMITS.errorRetries, ok(mainRecord(sha('1'), 'error')));
    s.advance(60 * MIN); await s.svc.tick();
    expect(s.spawned).toHaveLength(MAIN_VERIFY_LIMITS.errorRetries + 1);
    expect(s.svc.mainHealth().state).toBe('healthy');
  });

  it('after the error retries run out, a green PR run re-arms one main verify (the waiting-line wedge, 2026-11-12)', async () => {
    const s = svcSetup({ views: { 7: view(7, sha('7')) } });
    s.svc.noteMainHead(sha('1'));
    for (let n = 0; n <= MAIN_VERIFY_LIMITS.errorRetries; n++) {
      await s.finish(n, ok(mainRecord(sha('1'), 'error')));
      s.advance(MAIN_VERIFY_LIMITS.errorBackoffMs * (n + 1));
      await s.svc.tick();
    }
    const exhausted = s.spawned.length;
    expect(exhausted).toBe(MAIN_VERIFY_LIMITS.errorRetries + 1);
    // main stays unverified long enough to become suspect; nothing re-queues it on its own.
    s.advance(4 * 60 * MIN); await s.svc.tick();
    expect(s.svc.mainHealth().state).toBe('main-suspect');
    expect(s.spawned).toHaveLength(exhausted);
    // A PR run on this machine goes green: one main verify is queued again.
    await s.svc.request(7, { explicit: true });
    await s.svc.tick();
    expect(s.spawned).toHaveLength(exhausted + 1);
    expect(s.inputOf(exhausted).pr).toBe(7);
    await s.finish(exhausted, ok(record({ pr: 7, headSha: sha('7'), baseSha: sha('b') })));
    await s.svc.tick();
    expect(s.auditLines().some((l) => l.event === 'main-retry-rearmed-after-green' && l.afterPr === 7)).toBe(true);
    expect(s.spawned).toHaveLength(exhausted + 2);
    expect(s.inputOf(exhausted + 1)).toMatchObject({ kind: 'main', headSha: sha('1') });
  });

  it('sustained merging: green verifies of heads that have already moved on keep main healthy past the 3 h alarm', async () => {
    // 2026-11-14: a verify takes ~35 min and merges landed every 20-40, so no verify was ever of the
    // current head; the unverified clock was never cleared and every merge stopped 3 h after a restart.
    const s = svcSetup();
    let now = Date.parse('2026-10-21T12:00:00.000Z');
    const adv = (ms: number) => { s.advance(ms); now += ms; };
    const heads = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(sha);
    s.svc.noteMainHead(heads[0]);
    expect(s.spawned).toHaveLength(1);
    for (let i = 0; i < 8; i++) {
      const startedAt = now;
      adv(5 * MIN); s.svc.noteMainHead(heads[i + 1]); // a merge lands 5 minutes into the run
      adv(30 * MIN); await s.svc.tick();
      expect(s.inputOf(i)).toMatchObject({ kind: 'main', headSha: heads[i] });
      await s.finish(i, ok({ ...mainRecord(heads[i], 'success'), startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(now).toISOString() }));
      s.svc.noteMainHead(heads[i + 1]); // unchanged for 30 minutes: its verify is queued
      await s.svc.tick();
      expect(s.spawned).toHaveLength(i + 2);
      expect(s.svc.mainHealth().state).toBe('healthy');
    }
    // 8 runs of 35 minutes = 4 h 40 min of merging with a green verify every 35 minutes.
    expect(s.signals).not.toContain('local-verify:main-unverified');
  });

  it('the alarm still fires: the clock moves to when the last verified head was replaced, and 3 h after that main is suspect', async () => {
    const s = svcSetup();
    const t0 = Date.parse('2026-10-21T12:00:00.000Z');
    let now = t0;
    const adv = (ms: number) => { s.advance(ms); now += ms; };
    const iso = (ms: number) => new Date(ms).toISOString();
    s.svc.noteMainHead(sha('1'));                     // run 0: head 1, starts at t0
    adv(5 * MIN); s.svc.noteMainHead(sha('2'));       // merge during run 0
    adv(30 * MIN);
    await s.finish(0, ok({ ...mainRecord(sha('1'), 'success'), startedAt: iso(t0), finishedAt: iso(now) }));
    s.svc.noteMainHead(sha('2')); await s.svc.tick(); // run 1: head 2 (current), starts at t0+35
    expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: sha('2') });
    const run1Start = now;
    adv(5 * MIN); s.svc.noteMainHead(sha('3'));       // merge during run 1: nothing will ever cover it
    adv(30 * MIN);
    await s.finish(1, ok({ ...mainRecord(sha('2'), 'success'), startedAt: iso(run1Start), finishedAt: iso(now) }));
    // 3 h after t0 (the old, never-moved clock) main is still healthy: runs 0 and 1 covered everything up to t0+35.
    adv(t0 + 3 * 60 * MIN + 10 * MIN - now); await s.svc.tick();
    expect(s.svc.mainHealth().state).toBe('healthy');
    expect(s.signals).not.toContain('local-verify:main-unverified');
    // Head 3 was first seen 5 minutes into run 1. Run 1 covers head 2, so the clock is at the moment head 2
    // was replaced (run1Start+5), which is later and more exact than run 1's start: still healthy 3 h after
    // run 1 started, suspect 3 h after head 3 was seen.
    adv(run1Start + 3 * 60 * MIN + MIN - now); await s.svc.tick();
    expect(s.svc.mainHealth().state).toBe('healthy');
    adv(5 * MIN); await s.svc.tick();
    expect(s.svc.mainHealth()).toMatchObject({ state: 'main-suspect', reason: 'unverified-too-long' });
    expect(s.signals).toContain('local-verify:main-unverified');
  });

  it('a green run that STARTED on a head main had already moved past does not move the clock (the re-run after a first failure)', async () => {
    const s = svcSetup();
    const t0 = Date.parse('2026-10-21T12:00:00.000Z');
    let now = t0;
    const adv = (ms: number) => { s.advance(ms); now += ms; };
    const iso = (ms: number) => new Date(ms).toISOString();
    s.svc.noteMainHead(sha('1'));                     // run 0: head 1
    adv(5 * MIN); s.svc.noteMainHead(sha('2'));       // main moves on during run 0
    adv(30 * MIN);
    await s.finish(0, ok({ ...mainRecord(sha('1'), 'failure'), startedAt: iso(t0), finishedAt: iso(now) }));
    await s.svc.tick();
    // The re-run is of head 1 again, started at t0+35, AFTER head 2 was observed.
    expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: sha('1') });
    const rerunStart = now;
    adv(35 * MIN);
    await s.finish(1, ok({ ...mainRecord(sha('1'), 'success'), startedAt: iso(rerunStart), finishedAt: iso(now) }));
    expect(s.svc.mainHealth().state).toBe('healthy');
    // Head 2 (observed at t0+5) is in no green verify. The green re-run covers head 1 only, so the clock
    // moves to the moment head 1 was replaced (t0+5), NOT to the re-run's start (t0+35): the alarm fires
    // 3 h after t0+5.
    adv(t0 + 5 * MIN + 3 * 60 * MIN - MIN - now); await s.svc.tick();
    expect(s.svc.mainHealth().state).toBe('healthy');
    adv(2 * MIN); await s.svc.tick();
    expect(s.svc.mainHealth()).toMatchObject({ state: 'main-suspect', reason: 'unverified-too-long' });
  });

  it('2026-11-15: a merge replaces every queued head before it can start; each main verify starts on the head current at its start and main stays healthy', async () => {
    const s = svcSetup();
    const t0 = Date.parse('2026-10-21T12:00:00.000Z'); // the harness clock
    let now = t0;
    const adv = (ms: number) => { s.advance(ms); now += ms; };
    const iso = (ms: number) => new Date(ms).toISOString();
    const h = (n: number) => n.toString(16).padStart(2, '0').repeat(20);
    s.svc.noteMainHead(h(1));                           // boot: run 0 on head 1, the current head
    let run = 0; let runHead = 1; let runStart = now; let next = 2;
    for (let round = 1; round <= 7; round++) {
      adv(5 * MIN); s.svc.noteMainHead(h(next));        // a merge 5 minutes into the run
      adv(10 * MIN); s.svc.noteMainHead(h(next));       // unchanged 10 minutes: queued behind the running verify
      adv(5 * MIN); s.svc.noteMainHead(h(next + 1));    // the next merge replaces it before it can start
      adv(15 * MIN);
      await s.finish(run, ok({ ...mainRecord(h(runHead), 'success'), startedAt: iso(runStart), finishedAt: iso(now) }));
      await s.svc.tick();
      run = s.spawned.length - 1;
      // The queued verify starts now, on main's head as observed now (not the queued head main already left).
      expect(s.inputOf(run), `round ${round}`).toMatchObject({ kind: 'main', headSha: h(next + 1), baseSha: h(next + 1) });
      runHead = next + 1; runStart = now; next += 2;
      expect(s.svc.mainHealth().state, `round ${round} at +${Math.round((now - t0) / MIN)} min`).toBe('healthy');
    }
    expect(now - t0).toBeGreaterThan(4 * 60 * MIN);     // over four hours, never suspect (the old clock alarmed at three)
    expect(s.signals).not.toContain('local-verify:main-unverified');
  });

  it('a verified head that was replaced only by its own release commit covers up to the release commit being replaced', async () => {
    const info: Record<string, CommitInfo> = {
      [sha('b')]: { subject: 'chore: release v1.3.1800 [skip ci]', parents: [sha('a')], files: [{ filename: 'package.json', patch: '@@ -1 +1 @@\n-  "version": "1.3.1799",\n+  "version": "1.3.1800",' }] },
    };
    const s = svcSetup({ commitInfo: async (x) => info[x] ?? { subject: 'feat: x', parents: [sha('0')], files: [{ filename: 'src/x.ts' }] } });
    const t0 = Date.parse('2026-10-21T12:00:00.000Z'); // the harness clock
    let now = t0;
    const adv = (ms: number) => { s.advance(ms); now += ms; };
    const iso = (ms: number) => new Date(ms).toISOString();
    s.svc.noteMainHead(sha('a')); await s.svc.settle(); // run 0 starts on the merge, the current head, at t0
    expect(s.inputOf(0)).toMatchObject({ kind: 'main', headSha: sha('a') });
    adv(2 * MIN); s.svc.noteMainHead(sha('b'));         // its release commit appears at t0+2
    adv(10 * MIN); s.svc.noteMainHead(sha('b')); await s.svc.settle(); // unchanged 10 minutes: collapses into the running verify
    expect(s.spawned).toHaveLength(1);
    adv(10 * MIN); s.svc.noteMainHead(sha('c'));        // the next merge replaces the release commit at t0+22
    adv(13 * MIN);
    await s.finish(0, ok({ ...mainRecord(sha('a'), 'success'), startedAt: iso(t0), finishedAt: iso(now) }));
    // Covered: the merge and its release commit. Oldest uncovered: head c, first observed at t0+22.
    adv(t0 + 22 * MIN + 3 * 60 * MIN - MIN - now); await s.svc.tick();
    expect(s.svc.mainHealth().state).toBe('healthy');
    adv(2 * MIN); await s.svc.tick();
    expect(s.svc.mainHealth()).toMatchObject({ state: 'main-suspect', reason: 'unverified-too-long' });
  });

  it('a record whose start time is in the future cannot park the clock there', async () => {
    const s = svcSetup();
    const t0 = Date.parse('2026-10-21T12:00:00.000Z');
    s.svc.noteMainHead(sha('1'));
    s.advance(5 * MIN); s.svc.noteMainHead(sha('2'));
    s.advance(30 * MIN);
    await s.finish(0, ok({ ...mainRecord(sha('1'), 'success'), startedAt: '2026-11-15T09:51:00.000Z', finishedAt: '2026-11-15T10:24:00.000Z' }));
    // Head 2 (seen at t0+5) is uncovered; the clock is at most "now" (t0+35), so the alarm comes by t0+35+3h.
    s.advance(3 * 60 * MIN + MIN); await s.svc.tick();
    expect(s.svc.mainHealth()).toMatchObject({ state: 'main-suspect', reason: 'unverified-too-long' });
    expect(t0).toBeLessThan(Date.parse('2026-11-15T09:51:00.000Z'));
  });

  it('a main record never enters the PR index or journal', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    expect(s.svc.snapshot().records).toBe(0);
  });

  it('a failed main-head read clears the current head, so the repair exception has nothing to match', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    expect(s.svc.mainHealth().currentMainHead).toBe(sha('1'));
    s.svc.noteMainHead(null);
    expect(s.svc.mainHealth().currentMainHead).toBeNull();
  });

  it('lease acquisition from a foreign holder enters main-suspect and re-verifies main at once', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    s.svc.onLeaseAcquired({ foreignHolder: true });
    expect(s.svc.mainHealth().state).toBe('main-suspect');
    s.svc.noteMainHead(sha('1'));
    expect(s.spawned).toHaveLength(2);
    await s.finish(1, ok(mainRecord(sha('1'), 'success')));
    expect(s.svc.mainHealth().state).toBe('healthy');
  });
});

describe('a pending main verify starts on the head current at its start (2026-11-16)', () => {
  const A = sha('a'); const B = sha('b');
  const staleAtStart = (s: ReturnType<typeof svcSetup>) => s.auditLines().filter((l) => l.event === 'main-replaced' && l.why === 'stale-at-start');
  const mainQueue = (s: ReturnType<typeof svcSetup>) => s.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => e.headSha);
  /** Run 0 (head 1) is in flight and a `main` entry for head A is pending behind it. */
  const pendingA = async (opts: Parameters<typeof svcSetup>[0] = {}) => {
    const s = svcSetup(opts);
    s.svc.noteMainHead(sha('1')); await s.svc.settle();
    s.svc.noteMainHead(A); s.advance(10 * MIN); s.svc.noteMainHead(A); await s.svc.settle();
    return s;
  };

  it('healthy, main moved to B while A waited: the run starts on B, audited, and its green leaves no second main verify due', async () => {
    const s = await pendingA();
    await s.svc.settle();
    expect(mainQueue(s)).toEqual([A]);
    s.advance(MIN); s.svc.noteMainHead(B); // too fresh to be queued on its own: the pending entry still says A
    expect(mainQueue(s)).toEqual([A]);
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    expect(s.spawned).toHaveLength(2);
    expect(s.inputOf(1)).toMatchObject({ kind: 'main', pr: 0, headSha: B, baseSha: B });
    expect(staleAtStart(s)).toEqual([expect.objectContaining({ oldHead: A, newHead: B })]);
    // B is being verified: its own debounce does not queue it again, during the run or after the green.
    s.advance(10 * MIN); s.svc.noteMainHead(B);
    expect(mainQueue(s)).toEqual([]);
    await s.finish(1, ok(mainRecord(B, 'success')));
    s.advance(30 * MIN); s.svc.noteMainHead(B); await s.svc.tick();
    expect(s.spawned).toHaveLength(2);
    expect(mainQueue(s)).toEqual([]);
    // Nothing is left unverified: main is still healthy long past the 3 h alarm.
    s.advance(4 * 60 * MIN); s.svc.noteMainHead(B); await s.svc.tick();
    expect(s.svc.mainHealth().state).toBe('healthy');
    expect(s.spawned).toHaveLength(2);
  });

  it('healthy, main still at A: starts on A, no main-replaced event', async () => {
    const s = await pendingA();
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: A, baseSha: A });
    expect(staleAtStart(s)).toEqual([]);
  });

  it('main head unreadable at start: starts on A as queued', async () => {
    const s = await pendingA();
    s.svc.noteMainHead(B);
    s.svc.noteMainHead(null);
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: A, baseSha: A });
    expect(staleAtStart(s)).toEqual([]);
  });

  it('main suspect: the re-run of the failed head is not retargeted to the newer head', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    s.advance(5 * MIN); s.svc.noteMainHead(B);
    await s.finish(0, ok(mainRecord(sha('1'), 'failure')));
    expect(s.svc.mainHealth().state).toBe('main-suspect');
    expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: sha('1'), baseSha: sha('1') });
    expect(staleAtStart(s)).toEqual([]);
  });

  it('main red: a pending entry for A is not retargeted to the newer head B', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    await s.finish(0, ok(mainRecord(sha('1'), 'failure'))); // suspect; the re-run of head 1 is in flight
    s.svc.noteMainHead(A); s.advance(10 * MIN); s.svc.noteMainHead(A);
    expect(mainQueue(s)).toEqual([A]);
    s.svc.noteMainHead(B);
    expect(mainQueue(s)).toEqual([A]);
    await s.finish(1, ok(mainRecord(sha('1'), 'failure')));
    expect(s.svc.mainHealth().state).toBe('main-red');
    expect(s.inputOf(2)).toMatchObject({ kind: 'main', headSha: A, baseSha: A });
    expect(staleAtStart(s)).toEqual([]);
  });

  describe('release commits', () => {
    const R = sha('e');
    const rel = (parent: string): CommitInfo => ({ subject: 'chore: release v1.3.1800 [skip ci]', parents: [parent], files: [{ filename: 'package.json', patch: '@@ -1 +1 @@\n-  "version": "1.3.1799",\n+  "version": "1.3.1800",' }] });
    const feat: CommitInfo = { subject: 'feat: x', parents: [sha('0')], files: [{ filename: 'src/x.ts' }] };

    it('the current head is the release commit of the queued head A: the alias target is A, nothing changes', async () => {
      const s = await pendingA({ commitInfo: async (x) => (x === R ? rel(A) : feat) });
      await s.svc.settle();
      expect(mainQueue(s)).toEqual([A]);
      s.svc.noteMainHead(R); s.advance(10 * MIN); s.svc.noteMainHead(R); await s.svc.settle();
      expect(s.auditLines().some((l) => l.event === 'main-release-collapsed' && l.headSha === R && l.into === A)).toBe(true);
      await s.finish(0, ok(mainRecord(sha('1'), 'success')));
      expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: A, baseSha: A });
      expect(staleAtStart(s)).toEqual([]);
      // The green run of A covers its release commit: nothing further is queued or started.
      await s.finish(1, ok(mainRecord(A, 'success')));
      s.advance(30 * MIN); s.svc.noteMainHead(R); await s.svc.tick();
      expect(s.spawned).toHaveLength(2);
      expect(mainQueue(s)).toEqual([]);
    });

    it('the current head is a release commit of a head already verified: the queued head runs, no main run is spent on a green head', async () => {
      // R collapses into head 1 (in flight, then green) while the pending entry still says A.
      const s = await pendingA({ commitInfo: async (x) => (x === R ? rel(sha('1')) : feat) });
      await s.svc.settle();
      expect(mainQueue(s)).toEqual([A]);
      s.svc.noteMainHead(R); s.advance(10 * MIN); s.svc.noteMainHead(R); await s.svc.settle();
      expect(s.auditLines().some((l) => l.event === 'main-release-collapsed' && l.headSha === R && l.into === sha('1'))).toBe(true);
      await s.finish(0, ok(mainRecord(sha('1'), 'success')));
      expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: A, baseSha: A });
      expect(staleAtStart(s)).toEqual([]);
    });

    it('one stale read of the last green head just before the start does not move the run backward', async () => {
      const s = await pendingA();
      await s.svc.settle();
      expect(mainQueue(s)).toEqual([A]);
      s.advance(MIN); s.svc.noteMainHead(sha('1')); // a stale read: main is really at A
      await s.finish(0, ok(mainRecord(sha('1'), 'success')));
      expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: A, baseSha: A });
      expect(staleAtStart(s)).toEqual([]);
    });
  });
});

// ── flake isolation (2026-10-22), fair share, release collapse ──

describe('flaky files, main run-detail (ACT-151)', () => {
  const flaky = (file: string) => [{ file, lane: 'e2e', firstMessage: 't0: boom' }];
  it('a main verify emits the same bounded run-detail as a PR verify, and main-red carries it', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    const fail = (): VerifyRunResult => ({ kind: 'record', record: mainRecord(sha('1'), 'failure'), reasons: ['file-failed:tests/e2e/x.test.ts:1'], overlaps: [], keptWorktree: null, failures: [{ file: 'tests/e2e/x.test.ts', lane: 'e2e', failed: 1, message: 't0: boom', rerunMessage: 't0: boom again' }] });
    await s.finish(0, fail());
    const d = s.auditLines().find((l) => l.event === 'run-detail' && l.kind === 'main');
    expect(d).toMatchObject({ headSha: sha('1'), outcome: 'failure', reasons: ['file-failed:tests/e2e/x.test.ts:1'], failures: [expect.objectContaining({ file: 'tests/e2e/x.test.ts', rerunMessage: 't0: boom again' })] });
    await s.finish(1, fail());
    const red = s.signalDetails.find((x) => x.key === 'local-verify:main-red')!;
    expect(red.detail.runDetail).toMatchObject({ outcome: 'failure', failures: [expect.objectContaining({ file: 'tests/e2e/x.test.ts' })] });
  });

  it('a record with flakyRetried raises ONE signal per file (deduped) and counts it in flakyFiles; PR and main alike', async () => {
    const s = svcSetup({ views: { 4: view(4, sha('c')) } });
    s.svc.noteMainHead(sha('1'));
    await s.finish(0, ok({ ...mainRecord(sha('1'), 'success'), flakyRetried: flaky('tests/e2e/stop-gate.test.ts') }));
    s.advance(3 * 60 * MIN);
    await s.svc.request(4);
    await s.finish(1, ok(record({ pr: 4, headSha: sha('c'), finishedAt: '2026-10-21T15:00:00.000Z', flakyRetried: flaky('tests/e2e/stop-gate.test.ts') })));
    expect(s.signals.filter((k) => k === 'local-verify:flaky:tests/e2e/stop-gate.test.ts')).toHaveLength(1);
    expect(s.svc.flakyFiles()).toEqual({ 'tests/e2e/stop-gate.test.ts': { count: 2, lastSeen: '2026-10-21T15:00:00.000Z', lane: 'e2e' } });
    expect(s.svc.snapshot().flakyFiles).toHaveProperty(['tests/e2e/stop-gate.test.ts']);
    // A main verify whose only failures were flakes is green: main health never moved.
    expect(s.healthChanges).toEqual([]);
    expect(s.svc.mainHealth().state).toBe('healthy');
  });

  it('a record without flakyRetried raises no flaky signal', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    expect(s.signals.some((k) => k.startsWith('local-verify:flaky:'))).toBe(false);
    expect(s.auditLines().some((l) => l.event === 'run-detail')).toBe(false);
  });
});

describe('fair share between main and PR verifies', () => {
  const q = (...kinds: Array<'main' | 'pr'>) => kinds.map((k) => (k === 'main' ? { kind: 'main' as const } : {}));
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');
  const fsh = (oldestUnverifiedMainAt: number | null, over: Partial<{ mainHealthy: boolean; lastStartWasMain: boolean }> = {}) =>
    ({ mainHealthy: true, oldestUnverifiedMainAt, lastStartWasMain: false, ...over });
  it('healthy: main goes first once its oldest unverified merge is ≥ 90 min old; before that PRs go first', () => {
    expect(MAIN_FAIR_SHARE_MS).toBe(90 * MIN);
    expect(decideStart({ foreignHolders: 0, queue: q('main', 'pr'), now: NOW, fairShare: fsh(NOW - 89 * MIN) })).toEqual({ kind: 'start', index: 1 });
    expect(decideStart({ foreignHolders: 0, queue: q('main', 'pr'), now: NOW, fairShare: fsh(NOW - 90 * MIN) })).toEqual({ kind: 'start', index: 0 });
    expect(decideStart({ foreignHolders: 0, queue: q('main', 'pr'), now: NOW, fairShare: fsh(null) })).toEqual({ kind: 'start', index: 1 });
    expect(decideStart({ foreignHolders: 0, queue: q('main'), now: NOW, fairShare: fsh(NOW) })).toEqual({ kind: 'start', index: 0 }); // no PR waiting
  });
  it('suspect or red: main keeps priority, but at most every other start while PRs wait', () => {
    expect(decideStart({ foreignHolders: 0, queue: q('pr', 'main'), now: NOW, fairShare: fsh(NOW, { mainHealthy: false }) })).toEqual({ kind: 'start', index: 1 });
    expect(decideStart({ foreignHolders: 0, queue: q('main', 'pr'), now: NOW, fairShare: fsh(NOW, { mainHealthy: false, lastStartWasMain: true }) })).toEqual({ kind: 'start', index: 1 });
    expect(decideStart({ foreignHolders: 0, queue: q('main'), now: NOW, fairShare: fsh(NOW, { mainHealthy: false, lastStartWasMain: true }) })).toEqual({ kind: 'start', index: 0 });
  });
  it('an interrupted PR (resumeFirst) goes ahead of main unless main is known red', () => {
    const qi = [{ kind: 'main' as const }, { resumeFirst: true as const }];
    expect(decideStart({ foreignHolders: 0, queue: qi, now: NOW, fairShare: fsh(NOW - 120 * MIN) })).toEqual({ kind: 'start', index: 1 });
    expect(decideStart({ foreignHolders: 0, queue: qi, now: NOW, fairShare: fsh(NOW, { mainHealthy: false }) })).toEqual({ kind: 'start', index: 1 });
    expect(decideStart({ foreignHolders: 0, queue: qi, now: NOW, fairShare: { ...fsh(NOW, { mainHealthy: false }), mainRed: true } })).toEqual({ kind: 'start', index: 0 });
    // With no `main` queued (or main in backoff) it still goes ahead of other PRs.
    expect(decideStart({ foreignHolders: 0, queue: [{}, { resumeFirst: true as const }], now: NOW, fairShare: fsh(null) })).toEqual({ kind: 'start', index: 1 });
    expect(decideStart({ foreignHolders: 0, queue: [{ kind: 'main' as const, notBefore: NOW + 1 }, {}, { resumeFirst: true as const }], now: NOW, fairShare: fsh(NOW) })).toEqual({ kind: 'start', index: 2 });
    // Anywhere among the ready PRs, not only the first one.
    expect(decideStart({ foreignHolders: 0, queue: [{ kind: 'main' as const }, {}, { resumeFirst: true as const }], now: NOW, fairShare: fsh(NOW, { mainHealthy: false }) })).toEqual({ kind: 'start', index: 2 });
    // Not ready yet (backoff) ⇒ it does not jump.
    expect(decideStart({ foreignHolders: 0, queue: [{ kind: 'main' as const }, { resumeFirst: true as const, notBefore: NOW + 1 }], now: NOW, fairShare: fsh(NOW, { mainHealthy: false }) })).toEqual({ kind: 'start', index: 0 });
  });
  it('without fair-share inputs the order is unchanged (first ready entry)', () => {
    expect(decideStart({ foreignHolders: 0, queue: q('main', 'pr'), now: NOW })).toEqual({ kind: 'start', index: 0 });
  });
  it('in the service: a young unverified main waits behind PRs, an old one goes first', async () => {
    const views: Record<number, PrView> = { 1: view(1, sha('c')), 2: view(2, sha('e')) };
    // Head 1 is the stored last green head: the age of head 2 is known (first seen by this process).
    const s = svcSetup({ views, wm: { lastGreenHead: sha('1') } });
    s.svc.noteMainHead(sha('1'));
    await s.svc.request(1);
    await s.svc.request(2);
    s.svc.noteMainHead(sha('2')); s.advance(10 * MIN); s.svc.noteMainHead(sha('2')); // queued while main sha1 runs
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    // sha2 has been unverified 10 minutes: PR 1 goes first.
    expect(s.inputOf(1)).toMatchObject({ pr: 1 });
    s.advance(85 * MIN); // now 95 minutes
    await s.finish(1, ok(record({ pr: 1, headSha: sha('c') })));
    expect(s.inputOf(2)).toMatchObject({ kind: 'main', headSha: sha('2') });
  });
});

describe('release commits collapse into the verify of their parent', () => {
  const VERSION_PATCH = '@@ -1,6 +1,6 @@\n {\n   "name": "instar",\n-  "version": "1.3.1398",\n+  "version": "1.3.1399",\n   "type": "module",';
  const REL = (parent: string, files: string[] = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'upgrades/1.3.1399.md']): CommitInfo =>
    ({ subject: 'chore: release v1.3.1399 [skip ci]', parents: [parent], files: files.map((f) => ({ filename: f, patch: f.endsWith('package.json') ? VERSION_PATCH : '+x' })) });
  it('releaseCollapsesInto: both sides', () => {
    const covered = new Set([sha('1')]);
    expect(releaseCollapsesInto(REL(sha('1')), covered)).toBe(sha('1'));
    expect(releaseCollapsesInto(REL(sha('2')), covered)).toBeNull(); // parent not queued or verified
    expect(releaseCollapsesInto({ subject: 'fix: something', parents: [sha('1')] }, covered)).toBeNull();
    expect(releaseCollapsesInto({ subject: 'chore: release v1 [skip ci]', parents: [sha('1'), sha('2')] }, covered)).toBeNull(); // a merge commit
    expect(releaseCollapsesInto(null, covered)).toBeNull();
    expect(releaseCollapsesInto(REL(sha('1'), ['package.json', 'src/core/x.ts']), covered)).toBeNull(); // touches code
    expect(releaseCollapsesInto(REL(sha('1'), []), covered)).toBeNull(); // unknown diff
    expect(releaseCollapsesInto({ ...REL(sha('1')), files: null }, covered)).toBeNull();
    expect(releaseCollapsesInto(REL(sha('1'), Array.from({ length: 300 }, () => 'package.json')), covered)).toBeNull(); // possibly truncated
    expect(releaseCollapsesInto(REL(sha('1'), ['pnpm-lock.yaml', 'CHANGELOG-2026.md']), covered)).toBe(sha('1'));
  });
  it('a package.json (root or workspace) is release-only only when its patch changes just the version line', () => {
    const covered = new Set([sha('1')]);
    const withPkg = (filename: string, patch: string | null) => ({ subject: 'chore: release v1.3.1399 [skip ci]', parents: [sha('1')], files: [{ filename, patch }] });
    expect(releaseCollapsesInto(withPkg('package.json', VERSION_PATCH), covered)).toBe(sha('1'));
    expect(releaseCollapsesInto(withPkg('packages/threadline-core/package.json', VERSION_PATCH), covered)).toBe(sha('1'));
    expect(releaseCollapsesInto(withPkg('package.json', VERSION_PATCH + '\n-    "test": "vitest run",\n+    "test": "exit 0",'), covered)).toBeNull();
    expect(releaseCollapsesInto(withPkg('package.json', null), covered)).toBeNull(); // GitHub omitted the patch
    expect(releaseCollapsesInto(withPkg('package.json', '@@ -1 +1 @@\n {'), covered)).toBeNull(); // no changed line
    expect(patchChangesOnlyVersion('-  "version": "1.0.0",\n+  "version": "1.0.1",')).toBe(true);
    expect(patchChangesOnlyVersion('+  "versionX": "1",')).toBe(false);
  });
  it('a release whose parent this machine has no main record for (a force-pushed main) is verified', async () => {
    const s = svcSetup({ commitInfo: async () => REL(sha('9')) });
    s.svc.noteMainHead(sha('1'));
    await s.svc.settle();
    s.svc.noteMainHead(sha('2')); s.advance(10 * MIN); s.svc.noteMainHead(sha('2'));
    await s.svc.settle();
    expect(s.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => e.headSha)).toEqual([sha('2')]);
  });
  it('a release commit whose parent was already queued triggers no main verify of its own', async () => {
    const s = svcSetup({ commitInfo: async (x) => (x === sha('2') ? REL(sha('1')) : { subject: 'feat: x (#1)', parents: [sha('0')] }) });
    s.svc.noteMainHead(sha('1'));
    await s.svc.settle();
    expect(s.spawned).toHaveLength(1);
    s.svc.noteMainHead(sha('2')); s.advance(10 * MIN); s.svc.noteMainHead(sha('2'));
    await s.svc.settle();
    expect(s.svc.snapshot().queue.filter((e) => e.kind === 'main')).toHaveLength(0);
    expect(s.auditLines().some((l) => l.event === 'main-release-collapsed' && l.into === sha('1'))).toBe(true);
    // A non-release head still verifies.
    s.svc.noteMainHead(sha('3')); s.advance(10 * MIN); s.svc.noteMainHead(sha('3'));
    await s.svc.settle();
    expect(s.svc.snapshot().queue.filter((e) => e.kind === 'main').map((e) => e.headSha)).toEqual([sha('3')]);
  });
});

describe('green main record feeds PR isolation; repeat flakes escalate', () => {
  it('PR verifies get isolation allowed only after this machine has a green main record', async () => {
    const s = svcSetup({ views: { 3: view(3, sha('c')), 4: view(4, sha('e')) } });
    await s.svc.request(3);
    expect((s.inputOf(0) as unknown as { isolation: unknown }).isolation).toEqual({ allowed: false, notCleanOnGreenMain: [] });
    await s.finish(0, ok(record({ pr: 3, headSha: sha('c') })));
    s.svc.noteMainHead(sha('1'));
    await s.finish(1, ok({ ...mainRecord(sha('1'), 'success'), flakyRetried: [{ file: 'tests/e2e/x.test.ts', lane: 'e2e', firstMessage: 'boom' }] }));
    await s.svc.request(4);
    expect((s.inputOf(2) as unknown as { isolation: unknown }).isolation).toEqual({ allowed: true, notCleanOnGreenMain: ['tests/e2e/x.test.ts'] });
  });
  it('the same file re-run-passed 3 times within 7 days re-raises its item as a new episode, with the count; once per window', async () => {
    const views: Record<number, PrView> = {};
    for (let i = 1; i <= 6; i++) views[i] = view(i, (i.toString(16).padStart(2, '0')).repeat(20));
    const s = svcSetup({ views });
    const fl = [{ file: 'tests/e2e/f.test.ts', lane: 'e2e', firstMessage: 'boom' }];
    for (let i = 1; i <= 6; i++) {
      await s.svc.request(i);
      await s.finish(s.spawned.length - 1, ok(record({ pr: i, headSha: views[i].headRefOid, finishedAt: new Date(Date.parse('2026-10-21T12:00:00.000Z') + i * 60 * MIN).toISOString(), flakyRetried: fl })));
      s.advance(60 * MIN);
    }
    expect(s.signals.filter((k) => k === 'local-verify:flaky:tests/e2e/f.test.ts')).toHaveLength(1);
    const repeats = s.signalDetails.filter((x) => x.key.startsWith('local-verify:flaky:tests/e2e/f.test.ts:repeat-'));
    expect(repeats).toHaveLength(1); // the 3rd pass escalates; 4th–6th are inside the same window
    expect(repeats[0].detail).toMatchObject({ count: 3, windowDays: 7 });
  });
  it('decideFlakyEscalation: both sides', () => {
    const now = Date.parse('2026-10-21T12:00:00.000Z');
    const ago = (d: number) => new Date(now - d * 24 * 60 * MIN).toISOString();
    expect(decideFlakyEscalation({ seen: [ago(1), ago(2)], escalatedAt: null }, now)).toEqual({ escalate: false, count: 2 });
    expect(decideFlakyEscalation({ seen: [ago(1), ago(2), ago(3)], escalatedAt: null }, now)).toEqual({ escalate: true, count: 3 });
    expect(decideFlakyEscalation({ seen: [ago(1), ago(2), ago(8)], escalatedAt: null }, now)).toEqual({ escalate: false, count: 2 }); // outside the window
    expect(decideFlakyEscalation({ seen: [ago(1), ago(2), ago(3)], escalatedAt: ago(2) }, now).escalate).toBe(false);
    expect(decideFlakyEscalation({ seen: [ago(1), ago(2), ago(3)], escalatedAt: ago(8) }, now).escalate).toBe(true);
  });
});

describe('a main that is not healthy is re-verified after a short wait (2026-11-15: 111 minutes closed after the repair merged)', () => {
  const obs = (over: Partial<Parameters<typeof decideMainHeadEnqueue>[0]> = {}) => ({ head: sha('1'), since: 0, firstUnverifiedAt: null, handled: sha('1'), immediate: false, ...over });
  const UNHEALTHY = { healthy: false };

  it('pure: a new head is ready after 2 unchanged minutes when unhealthy; 10 when healthy or unstated', () => {
    const seen = decideMainHeadEnqueue(obs(), sha('2'), 5 * MIN, MAIN_VERIFY_LIMITS, UNHEALTHY);
    expect(seen.enqueue).toBe(false); // first sight: not at once
    expect(decideMainHeadEnqueue(seen.next, sha('2'), 6 * MIN, MAIN_VERIFY_LIMITS, UNHEALTHY).enqueue).toBe(false);
    const d = decideMainHeadEnqueue(seen.next, sha('2'), 7 * MIN, MAIN_VERIFY_LIMITS, UNHEALTHY);
    expect(d.enqueue).toBe(true);
    expect(d.next).toMatchObject({ head: sha('2'), handled: sha('2'), firstUnverifiedAt: null, immediate: false });
    expect(decideMainHeadEnqueue(seen.next, sha('2'), 7 * MIN).enqueue).toBe(false);
    expect(decideMainHeadEnqueue(seen.next, sha('2'), 7 * MIN, MAIN_VERIFY_LIMITS, { healthy: true }).enqueue).toBe(false);
    expect(decideMainHeadEnqueue(seen.next, sha('2'), 15 * MIN).enqueue).toBe(true);
  });

  it('pure: one stale read of the failed head between two reads of the repair starts no verify of it', () => {
    // reads a minute apart: repair, failed head (stale), repair, repair, repair
    let o = obs({ handled: null }); // even with the failed head not remembered as handled
    const reads: Array<[string, number]> = [[sha('2'), 1], [sha('1'), 2], [sha('2'), 3], [sha('2'), 4], [sha('2'), 5]];
    const enqueued: string[] = [];
    for (const [h, m] of reads) { const d = decideMainHeadEnqueue(o, h, m * MIN, MAIN_VERIFY_LIMITS, UNHEALTHY); o = d.next; if (d.enqueue) enqueued.push(h); }
    expect(enqueued).toEqual([sha('2')]); // only the repair, once it read the same for 2 minutes
  });

  it('pure: a head that never settles is capped at one verify per 10 minutes when unhealthy', () => {
    let o = obs();
    const at: number[] = [];
    for (let m = 1; m <= 25; m++) { const d = decideMainHeadEnqueue(o, m.toString(16).padStart(40, '0'), m * MIN, MAIN_VERIFY_LIMITS, UNHEALTHY); o = d.next; if (d.enqueue) at.push(m); }
    expect(at).toEqual([11, 22]); // 10 minutes after each first unverified head (minutes 1 and 12)
  });

  it('pure: the short wait never lengthens limits a caller already made shorter', () => {
    const quick = { debounceMs: 30_000, debounceCapMs: 60_000 };
    const seen = decideMainHeadEnqueue(obs(), sha('2'), 0, quick, UNHEALTHY);
    expect(decideMainHeadEnqueue(seen.next, sha('2'), 30_000, quick, UNHEALTHY).enqueue).toBe(true);
  });

  it('pure: still once per head: a head already handled is not enqueued again, healthy or not', () => {
    expect(decideMainHeadEnqueue(obs(), sha('1'), 99 * MIN, MAIN_VERIFY_LIMITS, UNHEALTHY).enqueue).toBe(false);
  });

  it('service: after main goes red, the repair head is verified once it has read the same for 2 minutes (a stale read of the red head in between restarts the count), not 10', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1')); // boot: immediate
    await s.finish(0, ok(mainRecord(sha('1'), 'failure')));
    expect(s.inputOf(1)).toMatchObject({ kind: 'main', headSha: sha('1') }); // the one re-run
    await s.finish(1, ok(mainRecord(sha('1'), 'failure')));
    expect(s.svc.mainHealth().state).toBe('main-red');
    s.svc.noteMainHead(sha('2')); // the repair landed
    s.advance(1 * MIN); s.svc.noteMainHead(sha('1')); // one stale read of the red head
    s.advance(1 * MIN); s.svc.noteMainHead(sha('2'));
    expect(s.spawned).toHaveLength(2);
    s.advance(1 * MIN); s.svc.noteMainHead(sha('2'));
    expect(s.spawned).toHaveLength(2);
    s.advance(1 * MIN); s.svc.noteMainHead(sha('2'));
    expect(s.spawned).toHaveLength(3);
    expect(s.inputOf(2)).toMatchObject({ kind: 'main', headSha: sha('2') });
  });

  it('service: a healthy main keeps the 10-minute debounce for a new head', async () => {
    const s = svcSetup();
    s.svc.noteMainHead(sha('1'));
    await s.finish(0, ok(mainRecord(sha('1'), 'success')));
    s.svc.noteMainHead(sha('2'));
    s.advance(2 * MIN); s.svc.noteMainHead(sha('2'));
    expect(s.spawned).toHaveLength(1);
  });
});

describe('decideMainRearmAfterGreen', () => {
  const base = { priorRetries: MAIN_VERIFY_LIMITS.errorRetries + 1, mainPending: false, mainInFlight: false, healthState: 'main-suspect' as const };
  it('re-arms only once the error retries are spent, with nothing main queued or running', () => {
    expect(decideMainRearmAfterGreen(base)).toBe(true);
    expect(decideMainRearmAfterGreen({ ...base, priorRetries: MAIN_VERIFY_LIMITS.errorRetries })).toBe(false);
    expect(decideMainRearmAfterGreen({ ...base, mainPending: true })).toBe(false);
    expect(decideMainRearmAfterGreen({ ...base, mainInFlight: true })).toBe(false);
  });
  it('never for a healthy main (nothing to do) or a red one (the red-main hold owns it)', () => {
    expect(decideMainRearmAfterGreen({ ...base, healthState: 'healthy' })).toBe(false);
    expect(decideMainRearmAfterGreen({ ...base, healthState: 'main-red' })).toBe(false);
  });
});

describe('oldestUnverifiedAfterGreen', () => {
  it('a green verify of the current head clears the clock', () => {
    expect(oldestUnverifiedAfterGreen(1_000, true, 5_000)).toBeNull();
    expect(oldestUnverifiedAfterGreen(null, true, 5_000)).toBeNull();
  });
  it('a green verify of an older head moves the clock to the run start, never backwards', () => {
    expect(oldestUnverifiedAfterGreen(1_000, false, 5_000)).toBe(5_000);
    expect(oldestUnverifiedAfterGreen(9_000, false, 5_000)).toBe(9_000);
  });
  it('the time the verified head was replaced moves the clock too, whatever the run start says; the later of the two wins', () => {
    expect(oldestUnverifiedAfterGreen(1_000, false, null, 7_000)).toBe(7_000);
    expect(oldestUnverifiedAfterGreen(1_000, false, 5_000, 7_000)).toBe(7_000);
    expect(oldestUnverifiedAfterGreen(1_000, false, 8_000, 7_000)).toBe(8_000);
    expect(oldestUnverifiedAfterGreen(9_000, false, null, 7_000)).toBe(9_000); // never backwards
    expect(oldestUnverifiedAfterGreen(1_000, false, null, Number.NaN)).toBe(1_000);
    expect(oldestUnverifiedAfterGreen(1_000, true, null, 7_000)).toBeNull();
    expect(oldestUnverifiedAfterGreen(null, false, null, 7_000)).toBeNull();
  });
  it('noteHeadSuperseded keeps the FIRST replacement time of a head, ignores no-change and null, and stays bounded', () => {
    const m = new Map<string, number>();
    noteHeadSuperseded(m, null, 'a', 10);
    noteHeadSuperseded(m, 'a', 'a', 20);
    expect(m.size).toBe(0);
    noteHeadSuperseded(m, 'a', 'b', 30);
    noteHeadSuperseded(m, 'b', 'a', 40);                // a stale read shows a again: b was not replaced by anything newer
    noteHeadSuperseded(m, 'a', 'b', 50);                // …and moves on: a keeps 30 (earlier is the strict direction)
    expect([...m]).toEqual([['a', 30]]);
    noteHeadSuperseded(m, 'b', 'c', 60);
    expect([...m]).toEqual([['a', 30], ['b', 60]]);
    for (let i = 0; i < SUPERSEDED_HEADS_KEPT + 20; i++) noteHeadSuperseded(m, `h${i}`, `h${i + 1}`, 100 + i);
    expect(m.size).toBe(SUPERSEDED_HEADS_KEPT);
    expect(m.has('a')).toBe(false);
  });
  it('supersededAtFor: the head itself, or the latest of its release commits; null when never replaced', () => {
    const m = new Map([['a', 30], ['rel-a', 90], ['x', 5]]);
    const alias = new Map([['rel-a', 'a'], ['rel-x', 'x']]);
    expect(supersededAtFor('a', m, alias)).toBe(90);    // a → its release commit → replaced at 90
    expect(supersededAtFor('x', m, alias)).toBe(5);     // rel-x is still the head (no entry): x's own time
    expect(supersededAtFor('a', m, new Map())).toBe(30);
    expect(supersededAtFor('zzz', m, alias)).toBeNull();
  });
  it('with nothing unverified there is nothing to move; an unreadable start time leaves the clock alone', () => {
    expect(oldestUnverifiedAfterGreen(null, false, 5_000)).toBeNull();
    expect(oldestUnverifiedAfterGreen(1_000, false, null)).toBe(1_000);
    expect(oldestUnverifiedAfterGreen(1_000, false, Number.NaN)).toBe(1_000);
  });
});

// ── the age of an unverified main survives a restart ───────────────────
// spec docs/specs/local-verify-main-age-survives-restart.md

describe('MainHealth: the age of the oldest unverified merge is kept in the watermark', () => {
  const T = Date.parse('2026-11-18T12:00:00.000Z');
  const G = sha('9'); // the last green head
  function aged(dir: string, machineId = 'm1') {
    const clock = { now: T };
    const audits: Array<Record<string, unknown>> = [];
    const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
    const h = new MainHealth(dir, machineId, {
      now: () => clock.now, isAncestor: async () => false,
      signal: (key, detail) => { signals.push({ key, detail }); }, audit: (e) => { audits.push(e); },
    });
    return { h, clock, audits, signals, unknownLines: () => audits.filter((a) => a.event === 'main-age-unknown') };
  }
  const stored = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'local-verify', 'main-health.json'), 'utf-8')) as Record<string, unknown>;

  it('writes oldestUnverifiedAt when it changes and not when it is unchanged', () => {
    const d = tmp(); watermark(d, { lastGreenHead: G });
    const a = aged(d);
    a.h.load();
    a.h.noteHeadObserved(G); // nothing unverified at boot
    expect(stored(d)).not.toHaveProperty('oldestUnverifiedAt');
    a.clock.now = T + 5 * MIN;
    a.h.noteHeadObserved(sha('1')); // this process saw the head leave green: the age starts now
    expect(stored(d)).toMatchObject({ oldestUnverifiedAt: T + 5 * MIN, lastGreenHead: G });
    expect(stored(d)).not.toHaveProperty('unknownSince');
    const writtenAt = stored(d).updatedAt;
    a.clock.now = T + 20 * MIN;
    a.h.noteHeadObserved(sha('2')); // a later merge: the oldest one is unchanged, nothing is written
    a.h.noteHeadObserved(sha('2'));
    expect(stored(d).updatedAt).toBe(writtenAt);
    expect(a.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: T + 5 * MIN, unknownSince: null });
    expect(a.unknownLines()).toEqual([]);
  });

  it('a green verify writes the cleared age with lastGreenHead in one write', async () => {
    const d = tmp(); watermark(d, { lastGreenHead: G, oldestUnverifiedAt: T - 30 * MIN });
    const a = aged(d);
    a.h.load();
    a.clock.now = T + MIN;
    await a.h.onVerify(sha('1'), 'success', undefined, { oldestUnverifiedAt: null });
    const w = stored(d);
    expect(w).toMatchObject({ lastGreenHead: sha('1'), updatedAt: new Date(T + MIN).toISOString() });
    expect(w).not.toHaveProperty('oldestUnverifiedAt');
    // A green verify of an older head moves the age instead; that lands with lastGreenHead too.
    a.clock.now = T + 2 * MIN;
    a.h.noteHeadObserved(sha('2'));
    a.clock.now = T + 9 * MIN;
    await a.h.onVerify(sha('2'), 'success', undefined, { oldestUnverifiedAt: T + 8 * MIN });
    expect(stored(d)).toMatchObject({ lastGreenHead: sha('2'), oldestUnverifiedAt: T + 8 * MIN, updatedAt: new Date(T + 9 * MIN).toISOString() });
    // An older build's caller (no age passed) leaves the age as it is.
    await a.h.onVerify(sha('3'), 'success');
    expect(stored(d)).toMatchObject({ lastGreenHead: sha('3'), oldestUnverifiedAt: T + 8 * MIN });
  });

  it('a green verify that cannot clear a red main still records the age it settled', async () => {
    const d = tmp(); watermark(d, { state: 'main-red', redHead: sha('r'), reason: 'rerun-failed', oldestUnverifiedAt: T - 30 * MIN });
    const a = aged(d);
    a.h.load();
    expect(await a.h.onVerify(sha('1'), 'success', undefined, { oldestUnverifiedAt: null })).toBe('none');
    expect(stored(d)).toMatchObject({ state: 'main-red', redHead: sha('r') });
    expect(stored(d)).not.toHaveProperty('oldestUnverifiedAt');
  });

  it("load restores a finite past value from this machine's watermark", () => {
    const d = tmp(); watermark(d, { lastGreenHead: G, oldestUnverifiedAt: T - 50 * MIN });
    const a = aged(d);
    a.h.load();
    expect(a.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: T - 50 * MIN, unknownSince: null });
    a.h.noteHeadObserved(sha('1')); // the first observation after boot keeps the restored value
    expect(a.h.unverifiedAge().oldestUnverifiedAt).toBe(T - 50 * MIN);
    expect(a.unknownLines()).toEqual([]);
    // A value exactly at now is not in the future.
    const d2 = tmp(); watermark(d2, { oldestUnverifiedAt: T });
    const b = aged(d2); b.h.load();
    expect(b.h.unverifiedAge().oldestUnverifiedAt).toBe(T);
  });

  it('load drops a future, non-finite or other-machine value', () => {
    const cases: Array<{ w: Record<string, unknown>; raw?: string; reason: string }> = [
      { w: { oldestUnverifiedAt: T + 1 }, reason: 'future' },
      { w: { oldestUnverifiedAt: 'yesterday' }, reason: 'non-finite' },
      { w: {}, raw: '"oldestUnverifiedAt":1e999', reason: 'non-finite' }, // parses to Infinity
      { w: { machineId: 'm_other', oldestUnverifiedAt: T - 50 * MIN }, reason: 'other-machine' },
      { w: {}, reason: 'field-absent' },
    ];
    for (const c of cases) {
      const d = tmp(); watermark(d, { lastGreenHead: G, ...c.w });
      const file = path.join(d, 'state', 'local-verify', 'main-health.json');
      if (c.raw) fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/\}$/, `,${c.raw}}`));
      const a = aged(d);
      a.h.load();
      expect(a.h.unverifiedAge().oldestUnverifiedAt, c.reason).toBeNull();
      a.clock.now = T + 3 * MIN;
      a.h.noteHeadObserved(sha('1')); // the first unverified head after boot: unknown, never `now` as an age
      expect(a.h.unverifiedAge(), c.reason).toEqual({ oldestUnverifiedAt: null, unknownSince: T + 3 * MIN });
      expect(a.unknownLines(), c.reason).toEqual([{ event: 'main-age-unknown', reason: c.reason, unknownSince: T + 3 * MIN }]);
      expect(stored(d), c.reason).toMatchObject({ unknownSince: T + 3 * MIN });
      expect(stored(d), c.reason).not.toHaveProperty('oldestUnverifiedAt');
    }
    // An unreadable file, and no file at all.
    const d1 = tmp(); fs.mkdirSync(path.join(d1, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(d1, 'state', 'local-verify', 'main-health.json'), '{not json');
    const u = aged(d1); u.h.load(); u.h.noteHeadObserved(sha('1'));
    expect(u.unknownLines()).toEqual([{ event: 'main-age-unknown', reason: 'file-unreadable', unknownSince: T }]);
    const n = aged(tmp()); n.h.load(); n.h.noteHeadObserved(sha('1'));
    expect(n.unknownLines()).toEqual([{ event: 'main-age-unknown', reason: 'field-absent', unknownSince: T }]);
    // With no usable value but nothing unverified at boot, a later merge is seen by this process: now.
    const d3 = tmp(); watermark(d3, { lastGreenHead: G });
    const s = aged(d3); s.h.load(); s.h.noteHeadObserved(G);
    s.clock.now = T + 7 * MIN; s.h.noteHeadObserved(sha('1'));
    expect(s.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: T + 7 * MIN, unknownSince: null });
    expect(s.unknownLines()).toEqual([]);
  });

  it("three boots: load's own rewrite keeps both fields", () => {
    const d = tmp(); watermark(d, { lastGreenHead: G, oldestUnverifiedAt: T - 50 * MIN });
    for (let boot = 0; boot < 3; boot++) {
      const a = aged(d);
      a.clock.now = T + boot * 20 * MIN;
      a.h.load();          // the constructor's read
      a.h.load();          // boot()
      a.h.load({ epoch: 4 + boot }); // lease acquisition by this machine
      expect(stored(d)).toMatchObject({ oldestUnverifiedAt: T - 50 * MIN, lastGreenHead: G });
      expect(a.h.unverifiedAge().oldestUnverifiedAt).toBe(T - 50 * MIN);
    }
    const d2 = tmp(); watermark(d2, { lastGreenHead: G, unknownSince: T - 70 * MIN });
    for (let boot = 0; boot < 3; boot++) {
      const a = aged(d2);
      a.clock.now = T + boot * 20 * MIN;
      a.h.load(); a.h.load(); a.h.load({ epoch: 4 + boot });
      a.h.noteHeadObserved(sha('1'));
      expect(stored(d2)).toMatchObject({ unknownSince: T - 70 * MIN });
      expect(a.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: null, unknownSince: T - 70 * MIN });
      expect(a.unknownLines()).toEqual([{ event: 'main-age-unknown', reason: 'carried', unknownSince: T - 70 * MIN }]); // once per process start
    }
  });

  it('unknownSince is set once and cleared in the write that settles the age', async () => {
    const d = tmp(); watermark(d, { lastGreenHead: G });
    const a = aged(d);
    a.h.load();
    a.h.noteHeadObserved(sha('1'));
    expect(stored(d)).toMatchObject({ unknownSince: T });
    a.clock.now = T + 40 * MIN;
    a.h.noteHeadObserved(sha('2'));
    a.h.load({ epoch: 1 }); // this machine again
    expect(a.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: null, unknownSince: T });
    // An error and a failure settle nothing.
    await a.h.onVerify(sha('2'), 'error');
    await a.h.onVerify(sha('2'), 'failure');
    expect(stored(d)).toMatchObject({ unknownSince: T, state: 'main-suspect' });
    // A green verify settles it: gone from the same write that records the green head.
    a.clock.now = T + 60 * MIN;
    await a.h.onVerify(sha('2'), 'success', undefined, { oldestUnverifiedAt: null });
    const w = stored(d);
    expect(w).toMatchObject({ state: 'healthy', lastGreenHead: sha('2'), updatedAt: new Date(T + 60 * MIN).toISOString() });
    expect(w).not.toHaveProperty('unknownSince');
    expect(w).not.toHaveProperty('oldestUnverifiedAt');
    expect(a.unknownLines()).toHaveLength(1);
  });

  it('an unusable stored unknownSince is still unknown, and the bound starts again at now', () => {
    for (const bad of [T + 60 * MIN, 'soon']) {
      const d = tmp(); watermark(d, { lastGreenHead: G, unknownSince: bad, oldestUnverifiedAt: T - 10 * MIN });
      const a = aged(d);
      a.h.load();
      expect(a.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: null, unknownSince: T });
      expect(a.unknownLines()).toEqual([{ event: 'main-age-unknown', reason: typeof bad === 'number' ? 'future' : 'non-finite', unknownSince: T }]);
      expect(stored(d)).toMatchObject({ unknownSince: T });
    }
  });

  it('a foreign holder or an epoch gap makes the age unknown, bounded by this machine\'s own earlier age', () => {
    // In a running process, with an age in memory.
    const d = tmp(); watermark(d, { lastGreenHead: G, oldestUnverifiedAt: T - 50 * MIN, leaseEpoch: 5 });
    const a = aged(d);
    a.h.load();
    a.clock.now = T + 10 * MIN;
    a.h.load({ foreignHolder: true, epoch: 6 });
    expect(a.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: null, unknownSince: T - 50 * MIN });
    expect(stored(d)).toMatchObject({ unknownSince: T - 50 * MIN, state: 'main-suspect' });
    expect(stored(d)).not.toHaveProperty('oldestUnverifiedAt'); // cleared in the same write
    expect(a.unknownLines()).toEqual([{ event: 'main-age-unknown', reason: 'other-machine', unknownSince: T - 50 * MIN }]);
    // A second flap keeps the bound; it never restarts at now.
    a.clock.now = T + 30 * MIN;
    a.h.load({ foreignHolder: true, epoch: 9 });
    expect(a.h.unverifiedAge().unknownSince).toBe(T - 50 * MIN);
    expect(a.unknownLines()).toHaveLength(1);
    // At boot, through an epoch gap, with the age only on disk.
    const d2 = tmp(); watermark(d2, { lastGreenHead: G, oldestUnverifiedAt: T - 20 * MIN, leaseEpoch: 5 });
    const b = aged(d2);
    b.h.load({ epoch: 9 });
    expect(b.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: null, unknownSince: T - 20 * MIN });
    // With no own age at all the bound is now.
    const d3 = tmp(); watermark(d3, { lastGreenHead: G });
    const c = aged(d3);
    c.h.load(); c.h.noteHeadObserved(G);
    c.clock.now = T + 4 * MIN;
    c.h.load({ foreignHolder: true });
    expect(c.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: null, unknownSince: T + 4 * MIN });
  });

  it('a release collapse clears the age and an unknown one, and writes only when something changed', () => {
    const d = tmp(); watermark(d, { lastGreenHead: G, oldestUnverifiedAt: T - 50 * MIN });
    const a = aged(d);
    a.h.load();
    a.clock.now = T + MIN;
    a.h.clearUnverifiedAge();
    expect(stored(d)).not.toHaveProperty('oldestUnverifiedAt');
    expect(stored(d).updatedAt).toBe(new Date(T + MIN).toISOString());
    a.clock.now = T + 2 * MIN;
    a.h.clearUnverifiedAge();
    expect(stored(d).updatedAt).toBe(new Date(T + MIN).toISOString());
    const d2 = tmp(); watermark(d2, { lastGreenHead: G, unknownSince: T - 50 * MIN });
    const b = aged(d2);
    b.h.load(); b.h.clearUnverifiedAge();
    expect(b.h.unverifiedAge()).toEqual({ oldestUnverifiedAt: null, unknownSince: null });
    expect(stored(d2)).not.toHaveProperty('unknownSince');
  });

  it('the 3-hour signal says "at least" when the time given is a lower bound', () => {
    const d = tmp(); watermark(d, { lastGreenHead: G });
    const a = aged(d);
    a.h.load();
    a.h.noteUnverifiedAge(T - 4 * 60 * MIN, { atLeast: true });
    expect(a.signals).toEqual([{ key: 'local-verify:main-unverified', detail: { ageMs: 4 * 60 * MIN, atLeast: true } }]);
    const d2 = tmp(); watermark(d2, { lastGreenHead: G });
    const b = aged(d2);
    b.h.load();
    b.h.noteUnverifiedAge(T - 4 * 60 * MIN);
    expect(b.signals).toEqual([{ key: 'local-verify:main-unverified', detail: { ageMs: 4 * 60 * MIN } }]);
  });
});

describe('decideStart: an unknown age of unverified main is due', () => {
  const NOW = 1_000_000_000;
  const queue = [{ kind: undefined }, { kind: 'main' as const }];
  it('healthy main: unknown goes first; no age waits; a young known age waits', () => {
    const base = { mainHealthy: true, lastStartWasMain: false };
    expect(decideStart({ foreignHolders: 0, queue, now: NOW, fairShare: { ...base, oldestUnverifiedMainAt: null, oldestUnverifiedMainUnknown: true } })).toEqual({ kind: 'start', index: 1 });
    expect(decideStart({ foreignHolders: 0, queue, now: NOW, fairShare: { ...base, oldestUnverifiedMainAt: null, oldestUnverifiedMainUnknown: false } })).toEqual({ kind: 'start', index: 0 });
    expect(decideStart({ foreignHolders: 0, queue, now: NOW, fairShare: { ...base, oldestUnverifiedMainAt: null } })).toEqual({ kind: 'start', index: 0 });
    expect(decideStart({ foreignHolders: 0, queue, now: NOW, fairShare: { ...base, oldestUnverifiedMainAt: NOW - MAIN_FAIR_SHARE_MS + 1 } })).toEqual({ kind: 'start', index: 0 });
    expect(decideStart({ foreignHolders: 0, queue, now: NOW, fairShare: { ...base, oldestUnverifiedMainAt: NOW - MAIN_FAIR_SHARE_MS } })).toEqual({ kind: 'start', index: 1 });
  });
  it('a resumed PR run still goes ahead of an unknown-age main', () => {
    const q = [{ kind: undefined, resumeFirst: true as const }, { kind: 'main' as const }];
    expect(decideStart({ foreignHolders: 0, queue: q, now: NOW, fairShare: { mainHealthy: true, lastStartWasMain: false, oldestUnverifiedMainAt: null, oldestUnverifiedMainUnknown: true } })).toEqual({ kind: 'start', index: 0 });
  });
});
