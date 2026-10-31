// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { FailedFileDiagnosisPeerService } from '../../../src/localVerify/FailedFileDiagnosisPeerService.js';
import type { DiagnosisPeerRequest } from '../../../src/localVerify/failedFileDiagnosisPeer.js';

const req: DiagnosisPeerRequest = { repo: 'JKHeadley/instar', pr: 9, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  baseRefName: 'main', verifierVersion: 'v1', policyHash: 'c'.repeat(64), failedFiles: ['tests/unit/a.test.ts'],
  attemptId: '1'.repeat(32), coordinatorMachineId: 'studio', leaseEpoch: 7 };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true,
  operation: 'FailedFileDiagnosisPeerService.test.ts' }); });

function harness(onOpen?: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-diag-peer-'));
  roots.push(root);
  let mode: 'off' | 'auto' = 'auto', fullBusy = false, alive = true, liveLease = ctx;
  let resolveExit!: (value: { status: number; signal: null }) => void;
  let resultPath = '';
  const killed: string[] = [];
  const cfg = { stateDir: root, agentHome: root, repo: req.repo,
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm5', verifierVersion: 'v1',
    policyHash: req.policyHash, nodePath: '/usr/bin/node', childEntry: '/installed/runFailedFileDiagnosisMain.js',
    protectedList: ['.github/'], baseEnv: {} };
  const deps = {
    now: () => 1000, mode: () => mode, fullVerifyBusy: () => fullBusy, updatePending: () => false,
    prView: async () => ({ headRefOid: req.headSha, baseRefName: req.baseRefName }),
    baseHead: async () => req.baseSha, isPrOpen: async () => { onOpen?.(); return true; },
    currentLease: () => liveLease,
    spawnRun: (arg) => { resultPath = arg.args[arg.args.indexOf('--result') + 1];
      return { pid: 1234, exited: new Promise((resolve) => { resolveExit = resolve; }) }; },
    isGroupAlive: () => alive,
    killGroup: (_pgid, signal) => { killed.push(signal); alive = false; },
    readProcessArgs: async () => `node /installed/runFailedFileDiagnosisMain.js --attempt-token ${req.attemptId}`,
    audit: () => undefined,
  };
  const peer = new FailedFileDiagnosisPeerService(cfg, deps);
  return { peer, root, reboot: () => new FailedFileDiagnosisPeerService(cfg, deps), killed, resultPath: () => resultPath,
    exit: async () => {
      alive = false;
      resolveExit({ status: 0, signal: null });
      // The child exit starts asynchronous result validation and private-tree
      // cleanup. Wait for that observable lifecycle boundary, not one event-loop
      // turn, which can finish before filesystem cleanup does.
      for (let n = 0; n < 100 && peer.busy(); n++) await new Promise((r) => setTimeout(r, 10));
      if (peer.busy()) throw new Error('diagnosis peer did not settle after child exit');
    },
    setMode: (v: typeof mode) => { mode = v; }, setFullBusy: (v: boolean) => { fullBusy = v; },
    setLease: (v: typeof ctx) => { liveLease = v; } };
}

const ctx = { holdsLease: false, holderMachineId: 'studio', leaseEpoch: 7 };

describe('peer failed-file diagnosis lifecycle', () => {
  it('persists intent before spawn, serves an exact advisory result, and remains dark after mode off', async () => {
    const h = harness();
    expect(await h.peer.accept(req, ctx)).toEqual({ accepted: true });
    expect(h.peer.result(req.attemptId)).toEqual({ state: 'running' });
    const state = JSON.parse(fs.readFileSync(path.join(roots.at(-1)!, 'state/local-verify/failed-file-diagnosis-peer.json'), 'utf8'));
    expect(state.current.request.attemptId).toBe(req.attemptId);
    h.setMode('off');
    fs.writeFileSync(h.resultPath(), JSON.stringify({ kind: 'done', answer: {
      attemptId: req.attemptId, identity: { repo: req.repo, pr: req.pr, headSha: req.headSha,
        baseSha: req.baseSha, baseRefName: req.baseRefName, verifierVersion: req.verifierVersion,
        policyHash: req.policyHash, failedFiles: req.failedFiles }, peerMachineId: 'm5',
      coordinatorMachineId: 'studio', leaseEpoch: 7, classification: 'machine-or-flake',
      files: [{ file: req.failedFiles[0], originalPr: 'assertion-fail', peerPr: 'pass', peerBase: 'pass' }], machineMinutes: 1,
    } }));
    await h.exit();
    expect(h.peer.result(req.attemptId)).toMatchObject({ state: 'done', answer: { classification: 'machine-or-flake' } });
    expect(h.peer.status().enabled).toBe(false);
  });

  it('preempts a diagnosis before full verification and tombstones its attempt', async () => {
    const h = harness();
    await h.peer.accept(req, ctx);
    h.setFullBusy(true);
    expect(await h.peer.preempt()).toBe(true);
    expect(h.killed).toContain('SIGTERM');
    expect(h.peer.busy()).toBe(false);
    expect(h.peer.result(req.attemptId)).toEqual({ state: 'unknown' });
    expect(await h.peer.accept(req, ctx)).toEqual({ accepted: false, reason: 'attempt-tombstoned' });
  });

  it('refuses a moved lease or version before starting any child', async () => {
    const h = harness();
    expect(await h.peer.accept(req, { ...ctx, leaseEpoch: 8 })).toEqual({ accepted: false, reason: 'lease-mismatch' });
    expect(await h.peer.accept({ ...req, verifierVersion: 'v2' }, ctx)).toEqual({ accepted: false, reason: 'verifier-or-policy-mismatch' });
    expect(h.peer.busy()).toBe(false);
  });

  it('rechecks the lease after asynchronous PR validation before spawning', async () => {
    let move!: () => void;
    const h = harness(() => move());
    move = () => h.setLease({ ...ctx, leaseEpoch: 8 });
    expect(await h.peer.accept(req, ctx)).toEqual({ accepted: false, reason: 'lease-mismatch' });
    expect(h.peer.busy()).toBe(false);
  });

  it('cleans the private attempt tree after an unexpected child exit', async () => {
    const h = harness();
    await h.peer.accept(req, ctx);
    const attempt = path.join(h.root, '.worktrees', '.verify', 'diagnosis', req.attemptId);
    fs.mkdirSync(path.join(attempt, 'pr', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(attempt, 'pr', 'node_modules', 'package.json'), '{}');
    const shortTemps = path.join('/tmp', `lv-${req.attemptId}`);
    fs.mkdirSync(shortTemps, { mode: 0o700 });
    roots.push(shortTemps);
    fs.writeFileSync(path.join(shortTemps, '.owner'), req.attemptId);
    fs.mkdirSync(path.join(shortTemps, 't-private'));
    await h.exit(); // no result file: child crash
    expect(h.peer.result(req.attemptId)).toMatchObject({ state: 'done', answer: { classification: 'inconclusive' } });
    expect(fs.existsSync(attempt)).toBe(false);
    expect(fs.existsSync(shortTemps)).toBe(false);
  });

  it('retires a restart intent whose child never started or created a worktree', async () => {
    const h = harness();
    await h.peer.accept(req, ctx);
    const statePath = path.join(h.root, 'state/local-verify/failed-file-diagnosis-peer.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.current.pid = null; // crash between durable intent and child spawn
    fs.writeFileSync(statePath, JSON.stringify(state));
    const restarted = h.reboot();
    await restarted.boot();
    expect(restarted.busy()).toBe(false);
    expect(await restarted.accept(req, ctx)).toEqual({ accepted: false, reason: 'attempt-tombstoned' });
  });
});
