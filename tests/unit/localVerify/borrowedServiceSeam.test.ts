// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: how LocalVerifyService uses the borrowed-helper seam (docs/specs/local-verify-borrowed-slices-count.md, F):
 *  - with no seam wired (the setting absent) a main verify's run input and record are what they were;
 *  - a wired seam is told when a verify starts (with the attempt token and the commits of the
 *    server's own record) and ends, is asked whether per-file counts are wanted, and receives a
 *    green main verify's counts; a red one gives it none;
 *  - a seam that throws from every method changes nothing about the verify (wiring integrity);
 *  - the seam's extras ride the peer status, its summary rides GET /local-verify, and the service's
 *    tick reaches it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type LocalVerifyServiceSeams } from '../../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import type { BorrowedRunSeam } from '../../../src/localVerify/mainRunObserver.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedServiceSeam.test.ts' }); });

function mainRecord(head: string, outcome: 'success' | 'failure' = 'success'): LocalVerifyRecord {
  return {
    repo: REPO, pr: 0, headSha: head, baseSha: head, baseRefName: 'main', mergeTree: sha('d'), kind: 'main',
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: outcome === 'success' ? 3 : 2, failed: outcome === 'success' ? 0 : 1, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-11-18T10:00:00.000Z', finishedAt: '2026-11-18T10:40:00.000Z',
    outcome, harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(),
  };
}

const COUNTS = { 'tests/unit/a.test.ts': [3, 0, 0, 0, 'a'.repeat(64)] };

function recordingSeam(over: Partial<BorrowedRunSeam> = {}) {
  const calls: Array<{ name: string; arg?: unknown }> = [];
  const seam: BorrowedRunSeam = {
    onVerifyStart: (e) => { calls.push({ name: 'start', arg: e }); },
    onVerifyEnd: (e) => { calls.push({ name: 'end', arg: e }); },
    wantsMainFileCounts: () => true,
    onGreenMain: (e) => { calls.push({ name: 'green', arg: e }); },
    peerStatusExtras: () => ({ wantsBaseline: true, helpers: ['m_laptop'], helperEvents: [] }),
    onPeerStatus: (p, x) => { calls.push({ name: 'peer-status', arg: { p, x } }); },
    knownHelper: () => true,
    tick: () => { calls.push({ name: 'tick' }); },
    info: () => ({ mode: 'practice', from: 'seam' }),
    proxy: async () => ({ status: 200, body: {} }),
    decide: () => ({ status: 200, body: {} }),
    dryRun: () => ({ status: 202, body: {} }),
    helperHere: () => ({ status: 200, body: {} }),
    acceptPeerBaseline: (body) => { calls.push({ name: 'peer-baseline', arg: body }); return { status: 200, body: { ok: true } }; },
    ...over,
  };
  return { seam, calls };
}

async function runMainVerify(seam: BorrowedRunSeam | null, o: { outcome?: 'success' | 'failure'; fileCounts?: unknown } = {}) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvseam-')));
  dirs.push(stateDir);
  fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({ v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-11-18T00:00:00.000Z' }));
  const spawned: Array<{ args: string[]; input: Record<string, unknown>; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  let t = Date.parse('2026-11-18T13:00:00.000Z');
  const seams: LocalVerifyServiceSeams = {
    prView: async () => null, isPrOpen: async () => true,
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      spawned.push({ args: a.args, input: JSON.parse(fs.readFileSync(a.args[a.args.indexOf('--input') + 1], 'utf-8')) as Record<string, unknown>, resolve });
      return { pid: 7000 + spawned.length, exited };
    },
    isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [],
    isAncestor: async () => false, now: () => t, setTimer: () => {},
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/x/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, seams);
  if (seam) svc.setBorrowedRunSeam(seam);
  svc.noteMainHead(sha('e'));
  expect(spawned.length).toBe(1);
  const token = spawned[0].args[spawned[0].args.indexOf('--attempt-token') + 1];
  t += 40 * 60_000;
  const result = { kind: 'record', record: mainRecord(sha('e'), o.outcome ?? 'success'), reasons: [], overlaps: [], keptWorktree: null, ...(o.fileCounts !== undefined ? { fileCounts: o.fileCounts } : {}) } as VerifyRunResult;
  fs.writeFileSync(spawned[0].args[spawned[0].args.indexOf('--result') + 1], JSON.stringify(result));
  spawned[0].resolve({ status: 0, signal: null });
  await new Promise((r) => setImmediate(r));
  await svc.settle();
  await new Promise((r) => setImmediate(r));
  const audit = fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    .map((r) => ('runLog' in r ? { ...r, runLog: '<run-token>.log' } : r));
  return { svc, token, input: spawned[0].input, audit, health: svc.mainHealth().state, stateDir };
}

describe('LocalVerifyService and the borrowed-helper seam', () => {
  it('with no seam wired the run input carries no fileCounts and no borrowed call is made', async () => {
    const off = await runMainVerify(null, { fileCounts: COUNTS });
    expect('fileCounts' in off.input).toBe(false);
    expect(off.audit.some((r) => String(r.event).startsWith('borrowed'))).toBe(false);
    expect(off.svc.borrowedRunSeam()).toBeNull();
    expect(off.svc.borrowedInfo()).toBeNull();
    expect(off.svc.peerBaseline({}, { holdsLease: false, holderMachineId: 'm1' })).toEqual({ status: 404, body: { error: 'not found' } });
    expect(Object.keys(off.svc.peerStatus()).sort()).toEqual(['enabled', 'inFlight', 'policyHash', 'slotBusy', 'verifierVersion']);
  });

  it('a wired seam is told of the start (token, kind, the record\'s commits) and the end, and gets a green main verify\'s per-file counts', async () => {
    const { seam, calls } = recordingSeam();
    const r = await runMainVerify(seam, { fileCounts: COUNTS });
    expect(r.input.fileCounts).toBe(true); // asked of the child because the seam wants them
    expect(calls.find((c) => c.name === 'start')!.arg).toMatchObject({ token: r.token, kind: 'main', pr: 0, baseSha: sha('e'), headSha: sha('e') });
    expect(calls.find((c) => c.name === 'end')!.arg).toMatchObject({ token: r.token, cancelled: false });
    expect(calls.find((c) => c.name === 'green')!.arg).toEqual({ commit: sha('e'), finishedAt: '2026-11-18T10:40:00.000Z', machineId: 'm1', fileCounts: COUNTS });
    // The order: started, ended (the token is dead), then the green main.
    expect(calls.map((c) => c.name).filter((n) => ['start', 'end', 'green'].includes(n))).toEqual(['start', 'end', 'green']);
  });

  it('a seam that does not want the counts is not asked for them, and a red main verify hands over none', async () => {
    const quiet = recordingSeam({ wantsMainFileCounts: () => false });
    const r = await runMainVerify(quiet.seam, { fileCounts: COUNTS });
    expect('fileCounts' in r.input).toBe(false);
    const red = recordingSeam();
    await runMainVerify(red.seam, { outcome: 'failure', fileCounts: COUNTS });
    expect(red.calls.some((c) => c.name === 'green')).toBe(false);
    expect(red.calls.some((c) => c.name === 'end')).toBe(true);
  });

  it('a seam that throws from every method leaves the main record, main health and the audit log as with no seam', async () => {
    const boom = () => { throw new Error('seam boom'); };
    const throwing: BorrowedRunSeam = {
      onVerifyStart: boom, onVerifyEnd: boom, wantsMainFileCounts: boom, onGreenMain: boom, peerStatusExtras: boom, onPeerStatus: boom, knownHelper: boom, tick: boom, info: boom,
      proxy: async () => boom(), decide: boom, dryRun: boom, helperHere: boom, acceptPeerBaseline: boom,
    };
    const off = await runMainVerify(null);
    const on = await runMainVerify(throwing);
    expect(on.health).toBe(off.health);
    expect(on.input).toEqual(off.input); // an unreadable wish for counts reads as "not wanted"
    expect(on.audit.filter((r) => r.event !== 'borrowed-seam-error')).toEqual(off.audit);
    expect(on.audit.filter((r) => r.event === 'borrowed-seam-error').map((r) => r.step)).toEqual(expect.arrayContaining(['wants-file-counts', 'verify-start', 'verify-end', 'green-main']));
    // The read paths answer their fallbacks.
    expect(on.svc.borrowedInfo()).toBeNull();
    expect(on.svc.peerStatus().helperEvents).toBeUndefined();
    await on.svc.tick();
    expect(on.svc.peerBaseline({}, { holdsLease: false, holderMachineId: 'm1' }).status).toBe(404);
  });

  it('the seam\'s extras ride the peer status, its summary rides GET /local-verify, the peer baseline reaches it, and every tick reaches it', async () => {
    const { seam, calls } = recordingSeam();
    const r = await runMainVerify(seam, { fileCounts: COUNTS });
    expect(r.svc.peerStatus()).toMatchObject({ wantsBaseline: true, helpers: ['m_laptop'], helperEvents: [] });
    expect(r.svc.borrowedInfo()).toEqual({ mode: 'practice', from: 'seam', mainObserver: null });
    expect(r.svc.peerBaseline({ file: 1 }, { holdsLease: false, holderMachineId: 'm_studio' })).toEqual({ status: 200, body: { ok: true } });
    expect(calls.find((c) => c.name === 'peer-baseline')!.arg).toEqual({ file: 1 });
    const before = calls.filter((c) => c.name === 'tick').length;
    await r.svc.tick();
    expect(calls.filter((c) => c.name === 'tick').length).toBe(before + 1);
  });
});
