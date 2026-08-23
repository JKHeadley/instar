/**
 * Branch-test lifecycle: real AgentServer + StateManager + SessionManager + tmux.
 * This verifies the branch assembly only; it is not a deployment assertion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { waitFor } from '../helpers/setup.js';

const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

describeMaybe('session output route branch-test lifecycle', () => {
  let projectDir: string;
  let state: StateManager;
  let manager: SessionManager;
  let server: AgentServer;
  let tmuxSession: string;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-route-branch-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });

    const mockCli = path.join(projectDir, 'mock-cli.sh');
    fs.writeFileSync(mockCli, '#!/bin/bash\necho "branch lifecycle output"\nwhile true; do sleep 1; done\n');
    fs.chmodSync(mockCli, 0o755);

    state = new StateManager(stateDir);
    const config: InstarConfig = {
      projectName: 'output-route-branch-test',
      projectDir,
      stateDir,
      port: 0,
      sessions: {
        tmuxPath: tmuxPath!, claudePath: mockCli, projectDir,
        maxSessions: 2, protectedSessions: [], completionPatterns: [],
      },
      scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      users: [], messaging: [],
      monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30_000 },
    };
    manager = new SessionManager(config.sessions, state);
    server = new AgentServer({ config, sessionManager: manager, state });
    tmuxSession = await manager.spawnInteractiveSession(undefined, 'output-route-live');
  });

  afterAll(async () => {
    if (tmuxSession && tmuxPath) {
      try { execFileSync(tmuxPath, ['kill-session', '-t', `=${tmuxSession}`], { timeout: 5_000 }); } catch {}
    }
    await server?.stop();
    if (projectDir) {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true,
        operation: 'tests/e2e/session-output-route-branch-lifecycle.test.ts:cleanup' });
    }
  });

  it('reads live output by logical name and UUID through the assembled server', async () => {
    const [record] = state.listSessions({ status: 'running' });
    expect(record.tmuxSession).toBe(tmuxSession);
    await waitFor(
      () => manager.captureOutput(tmuxSession, 10)?.includes('branch lifecycle output') ?? false,
      5_000,
    );

    for (const identifier of [record.name, record.id]) {
      const response = await request(server.getApp())
        .get(`/sessions/${identifier}/output?lines=10`);
      expect(response.status).toBe(200);
      expect(response.body.output).toContain('branch lifecycle output');
    }

    const unknown = await request(server.getApp())
      .get('/sessions/genuinely-unknown/output?lines=10');
    expect(unknown.status).toBe(404);
  });
});
