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
import { MainHealth, patchChangesOnlyVersion, releaseCollapsesInto, type CommitInfo, type MainHealthSnapshot } from '../../../src/localVerify/mainHealth.js';
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

function svcSetup(opts: { healthy?: boolean; views?: Record<number, PrView>; ancestor?: (a: string, d: string) => boolean | null; commitInfo?: (sha: string) => Promise<CommitInfo | null> } = {}) {
  const stateDir = tmp();
  if (opts.healthy !== false) watermark(stateDir, {});
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
    const s = svcSetup({ views });
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
    const s = svcSetup({ views });
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
