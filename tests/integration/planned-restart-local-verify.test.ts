// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/** Cross-component proof: the service's real child PID protects a restart in the separate supervisor. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { LocalVerifyService, type LocalVerifyServiceSeams, type PrView } from '../../src/localVerify/LocalVerifyService.js';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { computePolicyHash } from '../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
import type { PeerClient, PeerResult, PeerRunRequest } from '../../src/localVerify/peer.js';

const sha = (letter: string) => letter.repeat(40);
const view = (head: string): PrView => ({
  author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: `echo/${head}`,
  headRefOid: sha(head), baseRefName: 'main', baseRefOid: sha('b'),
});

describe('planned restart during a live local verification', () => {
  it('retains the request and preserves the next queued PR until the child exits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-verify-integration-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null,
      reason: 'green', updatedAt: new Date().toISOString(),
    }));
    const children: ChildProcess[] = [];
    const seams: LocalVerifyServiceSeams = {
      prView: async (pr) => pr === 1 ? view('a') : pr === 2 ? view('c') : null,
      isPrOpen: async () => true,
      spawnRun: () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        children.push(child);
        return { pid: child.pid!, exited: new Promise((resolve) => child.once('exit', (status, signal) => resolve({ status, signal }))) };
      },
      isGroupAlive: (pid) => children.some((child) => child.pid === pid && child.exitCode === null && child.signalCode === null),
      killGroup: (pid, signal) => { children.find((child) => child.pid === pid)?.kill(signal); },
      readProcessArgs: async () => null,
      foreignSuiteHolders: () => [],
      suiteCapacity: () => 1,
      setSuitePriority: () => {},
      setTimer: () => {},
    };
    const service = new LocalVerifyService({
      repo: 'JKHeadley/instar', stateDir, agentHome: dir, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      verifierVersion: '1.0.0', nodePath: process.execPath, mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
      remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: process.version,
      protectedList: ['.github/'], baseEnv: { PATH: process.env.PATH ?? '' },
    }, seams);
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
    const markerPath = path.join(stateDir, 'state', 'local-verify', 'inflight.json');
    try {
      await service.request(1);
      await service.request(2);
      expect(children).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).pid).toBe(children[0].pid);
      fs.writeFileSync(flagPath, JSON.stringify({
        requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        requestedBy: 'setting-change', plannedRestart: true,
      }));
      (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
      expect(restart).not.toHaveBeenCalled();
      expect(fs.existsSync(flagPath)).toBe(true);
      children[0].kill('SIGTERM');
      for (let i = 0; i < 40 && fs.existsSync(markerPath); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fs.existsSync(markerPath)).toBe(false);
      await service.tick();
      expect(children).toHaveLength(1);
      expect(service.snapshot().queue.map((entry) => entry.pr)).toContain(2);
      (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
      expect(restart).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath)).toBe(false);
    } finally {
      service.shutdown();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'planned-restart-local-verify.test.ts' });
      vi.restoreAllMocks();
    }
  }, 15_000);

  it('keeps the request pending for an accepted peer attempt and consumes it once the record imports', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-peer-integration-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null,
      reason: 'green', updatedAt: new Date().toISOString(),
    }));
    const policyHash = computePolicyHash();
    const timers: Array<() => void> = [];
    let requestSent: PeerRunRequest | null = null;
    let result: PeerResult = { state: 'running' };
    const client: PeerClient = {
      status: async () => ({ inFlight: null, verifierVersion: '1.0.0', policyHash, slotBusy: false }),
      run: async (_peer, req) => { requestSent = req; return { ok: true, attemptId: req.attemptId }; },
      result: async () => result,
      cancel: async () => {},
    };
    const seams: LocalVerifyServiceSeams = {
      prView: async (pr) => pr === 1 ? view('a') : null,
      isPrOpen: async () => true,
      baseHead: async () => sha('b'),
      spawnRun: () => { throw new Error('this PR runs on the peer'); },
      isGroupAlive: () => false,
      killGroup: () => {},
      readProcessArgs: async () => null,
      foreignSuiteHolders: () => [{ pid: 9001 }], // Studio's slot is taken, so the PR goes to the peer
      suiteCapacity: () => 1,
      setSuitePriority: () => {},
      setTimer: (fn) => { timers.push(fn); },
    };
    const service = new LocalVerifyService({
      repo: 'JKHeadley/instar', stateDir, agentHome: dir, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      verifierVersion: '1.0.0', nodePath: process.execPath, mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
      remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: process.version,
      protectedList: ['.github/'], baseEnv: { PATH: process.env.PATH ?? '' },
    }, seams);
    service.setPeerWiring({
      peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }], client,
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'm1' },
    });
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    const check = () => (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
    const settle = async () => { for (let k = 0; k < 5; k++) { for (const fn of timers.splice(0)) fn(); for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); } };
    try {
      await service.request(1);
      await service.tick();
      await settle();
      expect(requestSent).not.toBeNull();
      await service.tick();
      fs.writeFileSync(flagPath, JSON.stringify({
        requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        requestedBy: 'update', plannedRestart: true,
      }));
      check();
      expect(restart).not.toHaveBeenCalled();
      expect(fs.existsSync(flagPath)).toBe(true);

      const req = requestSent as unknown as PeerRunRequest;
      const now = new Date().toISOString();
      result = { state: 'done', record: {
        repo: 'JKHeadley/instar', pr: 1, headSha: req.headSha, baseSha: req.baseSha, baseRefName: 'main', mergeTree: sha('d'),
        lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
        nodeVersion: 'v24', machineId: 'peer1', startedAt: now, finishedAt: now, outcome: 'success',
        harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
        verifierVersion: '1.0.0', policyHash, attempt: { id: req.attemptId, coordinatorMachineId: 'm1', leaseEpoch: 7 },
      } as LocalVerifyRecord };
      (service as unknown as { remotePolledAt: Map<string, number> }).remotePolledAt.clear(); // the next poll is due
      await service.tick();
      expect(service.getRecord(1, sha('a'), 'main')).toMatchObject({ outcome: 'success', machineId: 'peer1' });
      await service.tick();
      check();
      expect(restart).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath)).toBe(false);
    } finally {
      service.shutdown();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'planned-restart-local-verify.test.ts' });
      vi.restoreAllMocks();
    }
  }, 15_000);
});
