/**
 * Integration — a fresh agent with no SSH server and no Telegram reports
 * /health "ok" through the full route stack, and the scheduler-facing
 * refresh route answers a clean skip. A real unreadable host key still turns
 * /health degraded (the real-failure path keeps reporting).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { readHostSshKey } from '../../src/commands/recoveryMainWiring.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createTempProject, createMockSessionManager, type TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'fresh-agent-health-token';

describe('fresh agent health has no false alarms (integration)', () => {
  let project: TempProject;
  let dir: string;
  beforeEach(() => {
    DegradationReporter.resetForTesting();
    project = createTempProject();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-health-'));
  });
  afterEach(() => {
    DegradationReporter.resetForTesting();
    project.cleanup();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/fresh-agent-health-no-false-alarms.test.ts' });
  });

  const app = () => new AgentServer({
    config: {
      projectName: 'fresh-agent', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: project.dir, maxSessions: 1, protectedSessions: [], completionPatterns: [] },
      scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
    } as InstarConfig,
    sessionManager: createMockSessionManager() as never, state: project.state,
  }).getApp();

  it('no sshd host key → /health carries no hostSshKey degradation', async () => {
    readHostSshKey(path.join(dir, 'missing.pub'));
    const res = await request(app()).get('/health').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.degradationFeatures ?? []).not.toContain('ServerDownRecovery.hostSshKey');
    expect(res.body.degradations).toBe(0);
  });

  it('positive control: an unreadable host key still makes /health degraded', async () => {
    const keyPath = path.join(dir, 'ssh_host_ed25519_key.pub');
    fs.mkdirSync(keyPath);
    readHostSshKey(keyPath);
    const res = await request(app()).get('/health').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body.status).toBe('degraded');
    expect(res.body.degradations).toBeGreaterThan(0);
  });

  it('the refresh route the job calls answers a clean skip with no Telegram', async () => {
    const res = await request(app()).post('/telegram/dashboard-refresh').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'skipped', reason: 'telegram-not-configured' });
  });
});
