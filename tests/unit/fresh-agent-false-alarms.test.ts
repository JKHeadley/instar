/**
 * A brand-new agent with no SSH server and no Telegram must not report itself
 * as degraded or failing (Windows dress rehearsal, 2026-11-20).
 *
 * 1. No sshd host key → the direct SSH recovery route is NOT APPLICABLE: no
 *    degradation, and the verdict is readable. An unreadable key that does
 *    exist is still a real fault and still reported.
 * 2. POST /telegram/dashboard-refresh on an agent with no Telegram configured
 *    answers a clean skip (200), so the dashboard-link-refresh job script exits
 *    0. Telegram that is configured but not running stays a 503 failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { readHostSshKey, recoveryDirectSshRoute } from '../../src/commands/recoveryMainWiring.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createTempProject, createMockSessionManager, type TempProject } from '../helpers/setup.js';
import type { InstarConfig, MessagingAdapterConfig } from '../../src/core/types.js';

const hostSsh = () => DegradationReporter.getInstance().getEvents().filter(e => e.feature === 'ServerDownRecovery.hostSshKey');

describe('readHostSshKey — no SSH server is not a degradation', () => {
  let dir: string;
  beforeEach(() => {
    DegradationReporter.resetForTesting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-ssh-key-'));
  });
  afterEach(() => {
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/fresh-agent-false-alarms.test.ts' });
  });

  it('missing key file → not applicable, empty key, no degradation', () => {
    expect(readHostSshKey(path.join(dir, 'ssh_host_ed25519_key.pub'))).toBe('');
    expect(recoveryDirectSshRoute()).toBe('not-applicable');
    expect(hostSsh()).toHaveLength(0);
  });

  it('missing /etc/ssh directory (a path component is a file) → not applicable', () => {
    const notADir = path.join(dir, 'etc-ssh');
    fs.writeFileSync(notADir, 'x');
    expect(readHostSshKey(path.join(notADir, 'ssh_host_ed25519_key.pub'))).toBe('');
    expect(recoveryDirectSshRoute()).toBe('not-applicable');
    expect(hostSsh()).toHaveLength(0);
  });

  it('readable key → available, key returned, no degradation', () => {
    const keyPath = path.join(dir, 'ssh_host_ed25519_key.pub');
    fs.writeFileSync(keyPath, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample host\n');
    expect(readHostSshKey(keyPath)).toContain('ssh-ed25519');
    expect(recoveryDirectSshRoute()).toBe('available');
    expect(hostSsh()).toHaveLength(0);
  });

  it('a key that exists but cannot be read is still a reported degradation', () => {
    // A directory at the key path reads as EISDIR: the file is there, the read fails.
    const keyPath = path.join(dir, 'ssh_host_ed25519_key.pub');
    fs.mkdirSync(keyPath);
    expect(readHostSshKey(keyPath)).toBe('');
    expect(recoveryDirectSshRoute()).toBe('unreadable');
    const events = hostSsh();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain('EISDIR');
  });
});

describe('POST /telegram/dashboard-refresh — no Telegram is a clean skip', () => {
  const AUTH = 'fresh-agent-refresh-token';
  let project: TempProject;
  beforeEach(() => { project = createTempProject(); });
  afterEach(() => { project.cleanup(); });

  const app = (messaging: MessagingAdapterConfig[]) => new AgentServer({
    config: {
      projectName: 'fresh-agent', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: project.dir, maxSessions: 1, protectedSessions: [], completionPatterns: [] },
      scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      users: [], messaging, monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
    } as InstarConfig,
    sessionManager: createMockSessionManager() as never, state: project.state,
  }).getApp();

  it('no Telegram configured → 200 skipped telegram-not-configured', async () => {
    const res = await request(app([])).post('/telegram/dashboard-refresh').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'skipped', reason: 'telegram-not-configured' });
  });

  it('a disabled Telegram entry counts as not configured', async () => {
    const res = await request(app([{ type: 'telegram', enabled: false, config: {} }]))
      .post('/telegram/dashboard-refresh').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('telegram-not-configured');
  });

  it('Telegram configured but not running → still a 503 failure', async () => {
    const res = await request(app([{ type: 'telegram', enabled: true, config: { token: 'x', chatId: '-1' } }]))
      .post('/telegram/dashboard-refresh').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ action: 'failed', stage: 'precondition' });
    expect(res.body.detail).toContain('not running');
  });
});
