import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { StateManager } from '../../src/core/StateManager.js';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';

describe('failed native update through the production server', () => {
  it('keeps the old install and does not request a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-native-update-e2e-'));
    const stateDir = path.join(dir, '.instar');
    const statePath = path.join(stateDir, 'state');
    const activePkg = path.join(stateDir, 'shadow-install', 'node_modules', 'instar');
    fs.mkdirSync(statePath, { recursive: true });
    fs.mkdirSync(activePkg, { recursive: true });
    const checker = new UpdateChecker(stateDir);
    const runningVersion = checker.getInstalledVersion();
    const targetVersion = runningVersion.replace(/\d+$/, (patch) => String(Number(patch) + 1));
    fs.writeFileSync(path.join(activePkg, 'package.json'), JSON.stringify({ version: runningVersion }));
    fs.writeFileSync(path.join(statePath, 'auto-updater.json'), JSON.stringify({ pendingUpdate: targetVersion }));

    const state = new StateManager(stateDir);
    vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: runningVersion, latestVersion: targetVersion, updateAvailable: true, checkedAt: new Date().toISOString() });
    vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'install') {
        const candidate = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', 'instar');
        fs.mkdirSync(candidate, { recursive: true });
        fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ version: targetVersion }));
      }
      if (args[0] === 'rebuild') throw new Error('native compile failed');
      return '';
    });
    const updater = new AutoUpdater(checker, state, stateDir, { preRestartDelaySecs: 0, autoApply: false });
    updater.setSessionDeps({ listRunningSessions: () => [] });
    const config = {
      projectName: 'native-update-test', projectDir: dir, stateDir, port: 0,
      authToken: 'native-update-test',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      users: [], messaging: [], monitoring: {}, updates: { autoApply: false },
    } as InstarConfig;
    const app = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state, updateChecker: checker, autoUpdater: updater }).getApp();

    try {
      const response = await request(app).post('/updates/apply').set('Authorization', 'Bearer native-update-test').send({});
      expect(response.status).toBe(200);
      expect(checker.getShadowInstalledVersion()).toBe(runningVersion);
      expect(fs.existsSync(path.join(statePath, 'restart-requested.json'))).toBe(false);
      expect(updater.getStatus().lastError).toMatch(/native compile failed/);
      expect(updater.getStatus().pendingUpdate).toBe(targetVersion);
    } finally {
      updater.stop();
      vi.restoreAllMocks();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/update-native-candidate-lifecycle.test.ts' });
    }
  }, 45_000);
});
