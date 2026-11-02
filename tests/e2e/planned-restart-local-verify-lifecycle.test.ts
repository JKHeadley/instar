// safe-fs-allow: isolated test state is removed through SafeFsExecutor.
/** Production Local Verify builder and HTTP server keep a live child across a planned restart request. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildLocalVerifyService } from '../../src/localVerify/localVerifyWiring.js';
import type { LocalVerifyServiceSeams, PrView } from '../../src/localVerify/LocalVerifyService.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';

describe('planned restart / Local Verify production lifecycle', () => {
  it('keeps the active child and HTTP feature alive, then consumes maintenance when the child ends', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-e2e-')));
    const stateDir = path.join(home, '.instar');
    const statePath = path.join(stateDir, 'state');
    fs.mkdirSync(path.join(home, '.git'));
    fs.mkdirSync(path.join(home, 'scripts'));
    fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// fixture\n');
    fs.mkdirSync(path.join(statePath, 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(statePath, 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm_e2e', state: 'healthy', redHead: null, lastGreenHead: null,
      reason: 'green', updatedAt: new Date().toISOString(),
    }));
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e',
      mainEntry: path.resolve(__dirname, '../../dist/localVerify/runVerifyMain.js'),
    });
    expect(built.service).not.toBeNull();
    const service = built.service!;
    const seams = (service as unknown as { seams: LocalVerifyServiceSeams }).seams;
    const head = 'a'.repeat(40);
    seams.prView = async () => ({
      author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/restart-proof',
      headRefOid: head, baseRefName: 'main', baseRefOid: 'b'.repeat(40),
    } as PrView);
    seams.isPrOpen = async () => true;
    seams.baseHead = async () => 'b'.repeat(40);
    let child: ReturnType<typeof spawn> | null = null;
    seams.spawnRun = () => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      return { pid: child.pid!, exited: new Promise((resolve) => child!.once('exit', (status, signal) => resolve({ status, signal }))) };
    };
    seams.isGroupAlive = (pid) => child?.pid === pid && child.exitCode === null && child.signalCode === null;
    seams.killGroup = (_pid, signal) => { child?.kill(signal); };
    seams.readProcessArgs = async () => null;
    seams.foreignSuiteHolders = () => [];
    seams.suiteCapacity = () => 1;
    seams.setSuitePriority = () => {};
    seams.setTimer = () => {};
    const config = {
      projectName: 'planned-restart-e2e', projectDir: home, stateDir, port: 0, authToken: 'test-token',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      users: [], messaging: [], monitoring: {}, updates: { autoApply: false },
    } as InstarConfig;
    const app = new AgentServer({
      config, sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir), localVerify: service,
    }).getApp();
    const watcher = new ForegroundRestartWatcher({ stateDir, exitOnRestart: false });
    const detected = vi.fn();
    watcher.on('restartDetected', detected);
    const flagPath = path.join(statePath, 'restart-requested.json');
    const markerPath = path.join(statePath, 'local-verify', 'inflight.json');
    try {
      await service.boot();
      const requested = await service.request(7);
      expect(requested.ok).toBe(true);
      expect(child).not.toBeNull();
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).pid).toBe(child!.pid);
      expect((await request(app).get('/local-verify').set('Authorization', 'Bearer test-token')).status).toBe(200);
      fs.writeFileSync(flagPath, JSON.stringify({
        plannedRestart: true, requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), requestedBy: 'setting-change',
      }));
      await (watcher as unknown as { check(): Promise<void> }).check();
      expect(detected).not.toHaveBeenCalled();
      expect(fs.existsSync(flagPath)).toBe(true);
      child!.kill('SIGTERM');
      for (let i = 0; i < 40 && fs.existsSync(markerPath); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fs.existsSync(markerPath)).toBe(false);
      await (watcher as unknown as { check(): Promise<void> }).check();
      expect(detected).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath)).toBe(false);
    } finally {
      service.shutdown();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'planned-restart-local-verify-lifecycle.test.ts' });
    }
  }, 15_000);
});
