/**
 * Integration — PATCH /updates/config { autoApply: false } cancels an update a
 * check already queued, through the full AgentServer route stack with a real
 * AutoUpdater. Before the fix the route poked `config.autoApply` and left the
 * armed coalescing timer to install the update anyway.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-autoapply-cancel-token';

function build(project: TempProject) {
  const checker = new UpdateChecker(project.stateDir);
  vi.spyOn(checker, 'check').mockResolvedValue({
    currentVersion: '1.3.1939', latestVersion: '1.3.1940', updateAvailable: true,
    checkedAt: new Date().toISOString(),
  });
  const apply = vi.spyOn(checker, 'applyUpdate').mockResolvedValue({
    success: true, previousVersion: '1.3.1939', newVersion: '1.3.1940',
    message: 'Updated', restartNeeded: true, healthCheck: 'skipped',
  });
  vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('1.3.1939');
  fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify({ updates: { autoApply: true } }));
  const updater = new AutoUpdater(checker, project.state, project.stateDir,
    { autoApply: true, applyDelayMinutes: 5, preRestartDelaySecs: 0 });
  updater.setSessionDeps({ listRunningSessions: () => [] } as never);
  const config = {
    projectName: 'autoapply-cancel', projectDir: project.dir, stateDir: project.stateDir, port: 0,
    authToken: AUTH,
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: project.dir, maxSessions: 1, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
    updates: { autoApply: true },
  } as InstarConfig;
  const app = new AgentServer({
    config, sessionManager: createMockSessionManager() as never, state: project.state,
    updateChecker: checker, autoUpdater: updater,
  }).getApp();
  return { app, updater, apply };
}

describe('PATCH /updates/config cancels a queued auto-apply (integration)', () => {
  let project: TempProject | null = null;
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    project?.cleanup();
    project = null;
  });

  it('autoApply:false after the check cancels the armed timer and the update never installs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    project = createTempProject();
    const { app, updater, apply } = build(project);
    await (updater as any).tick();
    expect(updater.getStatus().coalescingUntil).not.toBeNull();

    const res = await request(app).patch('/updates/config')
      .set('Authorization', `Bearer ${AUTH}`).send({ autoApply: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ autoApply: false, persisted: true, cancelledQueuedUpdate: true });
    expect(updater.getStatus().coalescingUntil).toBeNull();
    expect(updater.getStatus().config.autoApply).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(project.stateDir, 'config.json'), 'utf-8'));
    expect(onDisk.updates.autoApply).toBe(false);

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(apply).not.toHaveBeenCalled();
    updater.stop();
  });

  it('positive control: with no PATCH the same queued update installs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    project = createTempProject();
    const { updater, apply } = build(project);
    await (updater as any).tick();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(apply).toHaveBeenCalledTimes(1);
    updater.stop();
  });

  it('autoApply:false with nothing queued reports nothing cancelled; turning it on cancels nothing', async () => {
    project = createTempProject();
    const { app, updater } = build(project);
    const off = await request(app).patch('/updates/config')
      .set('Authorization', `Bearer ${AUTH}`).send({ autoApply: false });
    expect(off.body).toMatchObject({ autoApply: false, cancelledQueuedUpdate: false });
    const on = await request(app).patch('/updates/config')
      .set('Authorization', `Bearer ${AUTH}`).send({ autoApply: true });
    expect(on.body).toMatchObject({ autoApply: true, cancelledQueuedUpdate: false });
    expect(updater.getStatus().config.autoApply).toBe(true);
    updater.stop();
  });
});
