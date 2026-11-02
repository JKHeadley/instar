/**
 * The production AgentServer route, real AutoUpdater, and Local Verify restart-hold
 * registration together keep a manual update from cancelling an active verify.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { StateManager } from '../../src/core/StateManager.js';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { registerLocalVerifyRestartHold } from '../../src/localVerify/localVerifyWiring.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';
import type { LocalVerifyService } from '../../src/localVerify/LocalVerifyService.js';
import type { RestartHold } from '../../src/core/UpdateGate.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';

describe('manual update preserves Local Verify E2E lifecycle', () => {
  it('keeps peer admission paused after a successful apply until this server process restarts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-verify-activation-e2e-'));
    const stateDir = path.join(dir, '.instar');
    const statePath = path.join(stateDir, 'state');
    fs.mkdirSync(statePath, { recursive: true });
    fs.writeFileSync(path.join(statePath, 'auto-updater.json'), JSON.stringify({ pendingUpdate: '0.9.9' }));
    const state = new StateManager(stateDir);
    const checker = new UpdateChecker(stateDir);
    checker.applyUpdate = async () => ({
      success: true, previousVersion: '0.9.8', newVersion: '0.9.9',
      message: 'Updated', restartNeeded: true, healthCheck: 'skipped',
    });
    const updater = new AutoUpdater(checker, state, stateDir, { preRestartDelaySecs: 0, autoApply: false });
    updater.setSessionDeps({ listRunningSessions: () => [] });
    let updatePending: (() => { pending: boolean }) | null = null;
    registerLocalVerifyRestartHold(updater, {
      restartHolds: () => [], setRunEndedListener: () => {},
      setUpdatePendingProvider: (provider: () => { pending: boolean }) => { updatePending = provider; },
    } as unknown as LocalVerifyService);
    const config = {
      projectName: 'update-verify-e2e', projectDir: dir, stateDir, port: 0,
      authToken: 'update-verify-test',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      users: [], messaging: [], monitoring: {}, updates: { autoApply: false },
    } as InstarConfig;
    const app = new AgentServer({
      config, sessionManager: createMockSessionManager() as never,
      state, updateChecker: checker, autoUpdater: updater,
    }).getApp();
    // A restart flag can be published while a full verify child is alive.
    // The production watcher must leave that flag for later.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const markerPath = path.join(statePath, 'local-verify', 'inflight.json');
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ attemptToken: 'e2e-active-child', startedAt: Date.now(), pid: child.pid, pgid: child.pid }));
    const watcher = new ForegroundRestartWatcher({ stateDir, exitOnRestart: false });
    let detected = 0;
    watcher.on('restartDetected', () => { detected++; });

    try {
      const applied = await request(app).post('/updates/apply')
        .set('Authorization', 'Bearer update-verify-test').send({});
      expect(applied.status).toBe(200);
      expect(applied.body.pendingUpdate).toBeNull();
      expect(applied.body.restartDeferral).toBeNull();
      expect(fs.existsSync(path.join(statePath, 'restart-requested.json'))).toBe(true);
      const status = await request(app).get('/updates/status').set('Authorization', 'Bearer update-verify-test');
      expect(status.body.updateActivationPendingSince).toBeTypeOf('string');
      expect(updatePending).toBeTypeOf('function');
      expect(updatePending!().pending).toBe(true);
      await (watcher as unknown as { check(): Promise<void> }).check();
      expect(fs.existsSync(path.join(statePath, 'restart-requested.json'))).toBe(true);
      expect(detected).toBe(0);
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      SafeFsExecutor.safeUnlinkSync(markerPath, { operation: 'tests/e2e/update-apply-verification-hold-lifecycle.test.ts:completed-marker' });
      await (watcher as unknown as { check(): Promise<void> }).check();
      expect(detected).toBe(1);
      expect(fs.existsSync(path.join(statePath, 'restart-requested.json'))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      updater.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/update-apply-verification-hold-lifecycle.test.ts' });
    }
  }, 15_000);

  it('keeps an active verify on a normal apply and allows an explicit forced restart later', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-verify-e2e-'));
    const stateDir = path.join(dir, '.instar');
    const statePath = path.join(stateDir, 'state');
    fs.mkdirSync(statePath, { recursive: true });
    fs.writeFileSync(path.join(statePath, 'auto-updater.json'), JSON.stringify({ pendingUpdate: '0.9.9' }));
    const state = new StateManager(stateDir);
    const checker = new UpdateChecker(stateDir);
    checker.applyUpdate = async () => ({
      success: true, previousVersion: '0.9.8', newVersion: '0.9.9',
      message: 'Updated', restartNeeded: true, healthCheck: 'skipped',
    });
    const updater = new AutoUpdater(checker, state, stateDir, { preRestartDelaySecs: 0 });
    updater.setSessionDeps({ listRunningSessions: () => [] });
    let holds: RestartHold[] = [{
      name: 'local-verify:pr-7', until: Date.now() + 60 * 60_000,
      reason: 'a local verify of PR #7 is running',
    }];
    let holdReads = 0;
    let runEnded: (() => void) | null = null;
    let updatePending: (() => unknown) | null = null;
    registerLocalVerifyRestartHold(updater, {
      restartHolds: () => { holdReads++; return holds; },
      setRunEndedListener: (listener: () => void) => { runEnded = listener; },
      setUpdatePendingProvider: (provider: () => unknown) => { updatePending = provider; },
    } as unknown as LocalVerifyService);
    const config = {
      projectName: 'update-verify-e2e', projectDir: dir, stateDir, port: 0,
      authToken: 'update-verify-test',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      users: [], messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    const app = new AgentServer({
      config, sessionManager: createMockSessionManager() as never,
      state, updateChecker: checker, autoUpdater: updater,
    }).getApp();

    try {
      const ordinary = await request(app).post('/updates/apply')
        .set('Authorization', 'Bearer update-verify-test').send({});
      expect(ordinary.status).toBe(200);
      expect(holdReads).toBeGreaterThan(0);
      expect(runEnded).toBeTypeOf('function');
      expect(updatePending).toBeTypeOf('function');
      expect(ordinary.body.restartDeferral?.currentBlockers).toEqual(['local-verify:pr-7']);
      expect(fs.existsSync(path.join(statePath, 'restart-requested.json'))).toBe(false);

      // The update is already installed, so a forced second call must use the
      // durable deferral rather than silently report "no pending update".
      const forced = await request(app).post('/updates/apply')
        .set('Authorization', 'Bearer update-verify-test').send({ forceRestart: true });
      expect(forced.status).toBe(200);
      expect(fs.existsSync(path.join(statePath, 'restart-requested.json'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(statePath, 'restart-requested.json'), 'utf8')).bypassHolds).toBe(true);
      expect(forced.body.restartDeferral).toBeNull();
      holds = [];
    } finally {
      updater.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/update-apply-verification-hold-lifecycle.test.ts' });
    }
  }, 15_000);
});
