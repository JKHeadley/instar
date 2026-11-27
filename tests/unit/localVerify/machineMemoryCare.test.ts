// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Machine memory care (docs/specs/machine-memory-care.md), the Local Verify side:
 *  - a machine short of memory starts no test of its own, says so once, and resumes by itself;
 *  - a peer short of memory refuses a hand-off (back-pressure) and is skipped by the coordinator
 *    with one notice per episode, cleared when it recovers;
 *  - the backstop leftover sweep asks for the right folders at the right ages.
 * Real fs in temp state dirs; the child process, gh, the peer client and the clock are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, MEMORY_CARE, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { PeerClient, PeerRunRequest } from '../../../src/localVerify/peer.js';
import type { LeftoverPrefix, ReapOptions } from '../../../src/localVerify/leftoverReaper.js';
import { localVerifyAttentionItem } from '../../../src/localVerify/localVerifyWiring.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const POLICY = computePolicyHash();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'machineMemoryCare.test.ts' }); });

function view(over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

function harness(opts: { machineId?: string } = {}) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvmem-')));
  dirs.push(stateDir);
  fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
    v: 1, machineId: opts.machineId ?? 'coord', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
  }));
  const views: Record<number, PrView> = { 1: view(), 2: view({ headRefOid: sha('c') }) };
  const spawned: Array<{ pid: number; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const timers: Array<() => void> = [];
  const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
  const cleared: string[] = [];
  const reaps: Array<{ prefixes: LeftoverPrefix[]; opts?: ReapOptions }> = [];
  let t = Date.parse('2026-10-21T12:00:00.000Z');
  let pid = 7000;
  let memory: string | null = null;
  let foreignHolders: Array<{ pid: number }> = [];
  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async () => true,
    baseHead: async () => sha('b'),
    spawnRun: () => {
      const p = ++pid;
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      spawned.push({ pid: p, resolve });
      return { pid: p, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => foreignHolders,
    signal: (key, detail) => { signals.push({ key, detail }); },
    clearSignal: (key) => { cleared.push(key); },
    selfMemoryPressure: () => memory,
    reapLeftovers: async (prefixes, o) => { reaps.push({ prefixes, opts: o }); return { matched: 0, killed: 0, sample: [] }; },
    tempRoot: () => '/private/tmp',
    now: () => t,
    setTimer: (fn) => { timers.push(fn); },
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: opts.machineId ?? 'coord', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' },
  }, seams);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const runTimers = async () => { for (let k = 0; k < 5; k++) { const ts = timers.splice(0); for (const f of ts) f(); await flush(); } };
  const audit = () => { try { return fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8'); } catch { return ''; } };
  return {
    svc, spawned, signals, cleared, reaps, flush, runTimers, audit,
    setMemory: (m: string | null) => { memory = m; },
    setForeignHolders: (pids: number[]) => { foreignHolders = pids.map((p) => ({ pid: p })); },
    advance: (ms: number) => { t += ms; },
  };
}

describe('memory care — this machine (the coordinator, e.g. the Mac Studio)', () => {
  it('short of memory: no local start, one notice, and the start happens by itself once memory recovers', async () => {
    const h = harness();
    h.setMemory('17.0 GB of swap in use (35% of its memory), still paging out');
    await h.svc.request(1);
    await h.runTimers();
    expect(h.spawned).toHaveLength(0);
    const notices = h.signals.filter((s) => s.key === 'local-verify:memory-pressure:coord');
    expect(notices).toHaveLength(1);
    expect(notices[0].detail).toMatchObject({ who: 'self', machineId: 'coord' });
    expect(String(notices[0].detail.note)).toContain('17.0 GB of swap');
    // A second pump in the same episode: no second notice.
    await h.svc.tick();
    expect(h.signals.filter((s) => s.key.startsWith('local-verify:memory-pressure:'))).toHaveLength(1);
    expect(h.audit()).toContain('"event":"memory-hold"');
    // Recovery: the hold lifts at once (the queued PR starts); the notice closes after
    // MEMORY_CARE.clearAfterMs of fine readings, on the tick, with the queue empty.
    h.setMemory(null);
    await h.svc.tick();
    await h.runTimers();
    expect(h.spawned).toHaveLength(1);
    expect(h.audit()).toContain('"event":"memory-hold-cleared"');
    expect(h.cleared.filter((k) => k === 'local-verify:memory-pressure:coord' )).toHaveLength(0);
    h.advance(MEMORY_CARE.clearAfterMs);
    await h.svc.tick();
    expect(h.cleared).toContain('local-verify:memory-pressure:coord');
  });

  it('a long hold still lets ONE entry start per window, so main and replays can never wait forever', async () => {
    const h = harness();
    h.setMemory('17.0 GB of swap in use (35% of its memory), still paging out');
    await h.svc.request(1);
    await h.svc.request(2);
    await h.runTimers();
    expect(h.spawned).toHaveLength(0);
    h.advance(MEMORY_CARE.selfHoldMaxMs);
    await h.svc.tick();
    await h.runTimers();
    expect(h.spawned).toHaveLength(1);
    expect(h.audit()).toContain('"event":"memory-hold-window-start"');
  });

  it('a fine first reading after boot closes a notice an earlier process may have left open', async () => {
    const h = harness();
    await h.svc.tick();
    expect(h.cleared).toEqual(['local-verify:memory-pressure:coord']);
    await h.svc.tick();
    expect(h.cleared).toHaveLength(1);
  });

  it('a flapping machine keeps ONE notice open; a new one comes only after it closed', async () => {
    const h = harness();
    h.setForeignHolders([9001]); // the entry stays queued (never starts), so every pump re-reads memory
    h.setMemory('only 4% of memory available');
    await h.svc.request(1);
    await h.runTimers();
    h.setMemory(null); await h.svc.tick();
    h.setMemory('only 4% of memory available'); await h.svc.tick();
    expect(h.signals.filter((s) => s.key === 'local-verify:memory-pressure:coord')).toHaveLength(1);
    h.setMemory(null); await h.svc.tick();
    h.advance(MEMORY_CARE.clearAfterMs);
    await h.svc.tick(); // closed now
    expect(h.cleared).toContain('local-verify:memory-pressure:coord');
    h.setMemory('only 4% of memory available'); await h.svc.tick();
    expect(h.signals.filter((s) => s.key === 'local-verify:memory-pressure:coord')).toHaveLength(2);
  });

  it('a memory seam that throws never holds the line', async () => {
    const h = harness();
    (h.svc as unknown as { seams: LocalVerifyServiceSeams }).seams.selfMemoryPressure = () => { throw new Error('sampler gone'); };
    await h.svc.request(1);
    await h.runTimers();
    expect(h.spawned).toHaveLength(1);
  });
});

describe('memory care — peers', () => {
  const runReq = (): PeerRunRequest => ({
    attemptId: 'a'.repeat(32), pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY,
    coordinatorMachineId: 'coord', leaseEpoch: 7,
  });

  it('a peer short of memory refuses a hand-off as back-pressure, and accepts once it recovers', async () => {
    const h = harness({ machineId: 'peer1' });
    h.svc.setPeerWiring({ peerRoleEnabled: () => true });
    h.setMemory('17.0 GB of swap in use (35% of its memory)');
    expect(await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' })).toEqual({ ok: false, reason: 'peer-busy' });
    expect(h.audit()).toContain('"event":"peer-run-memory"');
    expect(h.spawned).toHaveLength(0);
    h.setMemory(null);
    expect(await h.svc.peerRun(runReq(), { holdsLease: false, holderMachineId: 'coord' })).toEqual({ ok: true, attemptId: 'a'.repeat(32) });
  });

  it('the coordinator skips a memory-pressured peer with one notice, sends to the healthy one, and clears on recovery', async () => {
    const h = harness();
    const sentTo: string[] = [];
    const client: PeerClient = {
      status: async () => ({ inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false, signerKeyHash: 'a'.repeat(64) }),
      run: async (p, req) => { sentTo.push(p.machineId); return { ok: true, attemptId: req.attemptId }; },
      result: async () => ({ state: 'running' }),
      cancel: async () => {},
    };
    let m5Memory: string | null = '17.0 GB of swap in use (35% of its memory)';
    h.svc.setPeerWiring({
      peers: () => [{ machineId: 'm5pro', url: 'http://m5pro:4042' }, { machineId: 'mini', url: 'http://mini:4042' }],
      client,
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' },
      // SEC-113 D1: both peers are pinned (this test is about placement, not signatures).
      keyLookupFactory: () => () => ({ status: 'ok', publicKeyPem: '' }),
      peerFit: (id) => (id === 'm5pro' && m5Memory
        ? { eligible: false, reason: 'memory-pressure', score: null, memoryReason: m5Memory }
        : { eligible: true, reason: 'fits', score: 0.5 }),
    });
    h.setForeignHolders([9001]); // the local slot is taken: work goes to peers
    await h.svc.request(1);
    await h.runTimers();
    expect(sentTo).toEqual(['mini']);
    const notices = h.signals.filter((s) => s.key === 'local-verify:memory-pressure:m5pro');
    expect(notices).toHaveLength(1);
    expect(notices[0].detail).toMatchObject({ who: 'peer', machineId: 'm5pro' });
    await h.svc.request(2);
    await h.runTimers();
    expect(h.signals.filter((s) => s.key === 'local-verify:memory-pressure:m5pro')).toHaveLength(1);
    m5Memory = null;
    await h.svc.request(2);
    await h.runTimers();
    h.advance(MEMORY_CARE.clearAfterMs);
    await h.svc.tick();
    await h.runTimers();
    expect(h.cleared).toContain('local-verify:memory-pressure:m5pro');
  });

  it('a held peer that is removed from the peer list has its notice closed', async () => {
    const h = harness();
    let peers = [{ machineId: 'm5pro', url: 'http://m5pro:4042' }];
    h.svc.setPeerWiring({
      peers: () => peers,
      client: { status: async () => null, run: async () => null, result: async () => null, cancel: async () => {} },
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' },
      peerFit: () => ({ eligible: false, reason: 'memory-pressure', score: null, memoryReason: 'only 3% of memory available' }),
    });
    h.setForeignHolders([9001]);
    await h.svc.request(1);
    await h.runTimers();
    expect(h.signals.some((s) => s.key === 'local-verify:memory-pressure:m5pro')).toBe(true);
    peers = [];
    await h.svc.tick();
    h.advance(MEMORY_CARE.clearAfterMs);
    await h.svc.tick();
    expect(h.cleared).toContain('local-verify:memory-pressure:m5pro');
  });
});

describe('memory care — backstop leftover sweep', () => {
  it('at boot, idle: own run and diagnosis worktrees at any age; shared temp folders only past the run ceiling; never newer than the sweep', async () => {
    const h = harness();
    await h.svc.boot();
    expect(h.reaps).toHaveLength(1);
    const { prefixes, opts } = h.reaps[0];
    expect(prefixes).toEqual([
      { prefix: '/agents/echo/.worktrees/.verify/runs/', minAgeS: 0 },
      { prefix: '/agents/echo/.worktrees/.verify/diagnosis/', minAgeS: 0 },
      { prefix: '/private/tmp/lv-', minAgeS: MEMORY_CARE.leftoverMinAgeS },
      { prefix: '/tmp/lv-', minAgeS: MEMORY_CARE.leftoverMinAgeS },
    ]);
    expect(typeof opts?.startedBeforeMs).toBe('number');
  });

  it('while a run is in flight: only processes older than any run can last', async () => {
    const h = harness();
    await h.svc.request(1);
    await h.runTimers();
    expect(h.spawned).toHaveLength(1);
    await h.svc.sweepLeftovers('tick');
    for (const p of h.reaps[0].prefixes) expect(p.minAgeS).toBe(MEMORY_CARE.leftoverMinAgeS);
  });

  it('the tick sweeps at most every sweepEveryMs', async () => {
    const h = harness();
    await h.svc.tick();
    await h.svc.tick();
    expect(h.reaps).toHaveLength(1);
    h.advance(MEMORY_CARE.sweepEveryMs);
    await h.svc.tick();
    expect(h.reaps).toHaveLength(2);
  });

  it('a sweep that matched something is audited', async () => {
    const h = harness();
    (h.svc as unknown as { seams: LocalVerifyServiceSeams }).seams.reapLeftovers = async () => ({ matched: 2, killed: 2, sample: [{ pid: 1, stat: 'T', ageS: 99, command: 'node x' }] });
    await h.svc.sweepLeftovers('tick');
    expect(h.audit()).toContain('"event":"leftovers-reaped"');
  });
});

describe('memory care — the notice', () => {
  it('maps to one HIGH item per machine that a later episode reopens', () => {
    const item = localVerifyAttentionItem('local-verify:memory-pressure:m5pro', { who: 'peer', machineId: 'm5pro', note: 'A test machine is short of memory.' });
    expect(item).toMatchObject({ id: 'local-verify:memory-pressure:m5pro', mode: 'upsert', priority: 'HIGH', summary: 'A test machine is short of memory.' });
    expect(localVerifyAttentionItem('local-verify:memory-pressure:coord', { who: 'self', note: 'x' }).title).toContain('this machine');
  });
});

describe('memory care — one voice', () => {
  it('a machine that does not hold the lease still holds its own starts, but raises and closes no notice', async () => {
    const h = harness({ machineId: 'peer1' });
    h.svc.setPeerWiring({ peers: () => [], lease: { holdsLease: () => false, leaseEpoch: () => 7, holderMachineId: () => 'coord' } });
    h.setMemory('only 3% of memory available');
    await h.svc.request(1);
    await h.runTimers();
    await h.svc.tick();
    expect(h.spawned).toHaveLength(0);
    expect(h.signals.filter((s) => s.key.startsWith('local-verify:memory-pressure:'))).toHaveLength(0);
    h.setMemory(null);
    await h.svc.tick();
    expect(h.cleared).toHaveLength(0);
  });
});
