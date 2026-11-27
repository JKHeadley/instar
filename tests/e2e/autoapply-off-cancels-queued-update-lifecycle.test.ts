/**
 * E2E lifecycle — the production wiring from server.ts (a started LiveConfig
 * handed to the AutoUpdater, the AutoUpdater handed to the AgentServer) keeps
 * `updates.autoApply: false` written to config.json AFTER a check queued an
 * update from installing it. This is the Windows dress-rehearsal sequence:
 * check queues v1.3.1940 → the config file is edited (not the API) → the
 * coalescing delay ends → nothing installs. Real timers, real files.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { StateManager } from '../../src/core/StateManager.js';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scenario(editConfigOff: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoapply-cancel-e2e-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ updates: { autoApply: true } }));
  const state = new StateManager(stateDir);
  const checker = new UpdateChecker(stateDir);
  let applied = 0;
  checker.check = async () => ({ currentVersion: '1.3.1939', latestVersion: '1.3.1940', updateAvailable: true, checkedAt: new Date().toISOString() });
  checker.getInstalledVersion = () => '1.3.1939';
  checker.applyUpdate = async () => { applied++; return { success: true, previousVersion: '1.3.1939', newVersion: '1.3.1940', message: 'Updated', restartNeeded: false, healthCheck: 'skipped' }; };
  const liveConfig = new LiveConfig(stateDir, { checkIntervalMs: 50 });
  liveConfig.start();
  // 0.02 min = 1.2 s coalescing delay.
  const updater = new AutoUpdater(checker, state, stateDir,
    { autoApply: true, applyDelayMinutes: 0.02, preRestartDelaySecs: 0, autoRestart: false }, null, liveConfig);
  updater.setSessionDeps({ listRunningSessions: () => [] });
  const config = {
    projectName: 'autoapply-e2e', projectDir: dir, stateDir, port: 0, authToken: 'autoapply-e2e',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    users: [], messaging: [], monitoring: {}, updates: { autoApply: true },
  } as InstarConfig;
  const app = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state, updateChecker: checker, autoUpdater: updater }).getApp();
  try {
    await (updater as any).tick();
    const queued = await request(app).get('/updates/auto').set('Authorization', 'Bearer autoapply-e2e');
    if (editConfigOff) {
      await sleep(100); // distinct mtime
      fs.writeFileSync(configPath, JSON.stringify({ updates: { autoApply: false } }));
      await sleep(300); // LiveConfig's poll sees it
    }
    const afterEdit = updater.getStatus();
    await sleep(1_800); // past the coalescing delay
    return { applied, queued, afterEdit, final: updater.getStatus() };
  } finally {
    updater.stop();
    liveConfig.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/autoapply-off-cancels-queued-update-lifecycle.test.ts' });
  }
}

describe('autoApply off cancels a queued update — production wiring lifecycle', () => {
  it('a config-file edit after the check cancels the queued apply; nothing installs', async () => {
    const r = await scenario(true);
    expect(r.queued.status).toBe(200);
    expect(r.queued.body.coalescingUntil).toBeTruthy(); // the check really queued it
    expect(r.afterEdit.config.autoApply).toBe(false);
    expect(r.afterEdit.coalescingUntil).toBeNull(); // cancelled before the delay ended
    expect(r.applied).toBe(0);
    expect(r.final.pendingUpdate).toBe('1.3.1940'); // still offered for a manual apply
  }, 20_000);

  it('positive control: left on, the same wiring installs the queued update', async () => {
    const r = await scenario(false);
    expect(r.applied).toBe(1);
  }, 20_000);
});
