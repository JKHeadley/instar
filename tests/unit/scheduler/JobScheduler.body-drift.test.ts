import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import { createMockSessionManager, createTempProject } from '../../helpers/setup.js';
import type { MockSessionManager, TempProject } from '../../helpers/setup.js';

function agentMd(body: string): string {
  return [
    '---',
    'name: "Body Drift Probe"',
    'description: "Detects stale cached prompts."',
    '---',
    body,
  ].join('\n');
}

describe('JobScheduler agentmd body drift warning', () => {
  let project: TempProject;
  let sessionManager: MockSessionManager;
  let scheduler: JobScheduler;
  let bodyPath: string;

  beforeEach(() => {
    project = createTempProject();
    sessionManager = createMockSessionManager();

    const jobsRoot = path.join(project.stateDir, 'jobs');
    const scheduleDir = path.join(jobsRoot, 'schedule');
    const userDir = path.join(jobsRoot, 'user');
    fs.mkdirSync(scheduleDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'jobs.json'), '[]');
    fs.writeFileSync(path.join(scheduleDir, 'body-drift-probe.json'), JSON.stringify({
      slug: 'body-drift-probe',
      origin: 'user',
      schedule: '0 0 1 1 *',
      priority: 'low',
      model: 'haiku',
      expectedDurationMinutes: 1,
      enabled: true,
      execute: { type: 'agentmd' },
    }));
    bodyPath = path.join(userDir, 'body-drift-probe.md');
    fs.writeFileSync(bodyPath, agentMd('Original cached instruction.\n'));

    scheduler = new JobScheduler({
      jobsFile: path.join(project.stateDir, 'jobs.json'),
      enabled: true,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      startupGraceMs: 60_000,
    }, sessionManager as any, project.state, project.stateDir);
    scheduler.start();
  });

  afterEach(() => {
    scheduler.stop();
    project.cleanup();
    vi.restoreAllMocks();
  });

  it('warns once per changed disk body while continuing with the cached prompt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(bodyPath, agentMd('First on-disk edit.\n'));

    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('changed on disk after scheduler start');
    expect(warn.mock.calls[0][0]).toContain('Restart the server to apply the edit');
    expect(sessionManager._lastSpawnArgs?.prompt).toContain('Original cached instruction.');
    expect(sessionManager._lastSpawnArgs?.prompt).not.toContain('First on-disk edit.');

    await scheduler.triggerJob('body-drift-probe', 'test-again');
    expect(warn).toHaveBeenCalledTimes(1);

    fs.writeFileSync(bodyPath, agentMd('Second on-disk edit.\n'));
    await scheduler.triggerJob('body-drift-probe', 'test-after-second-edit');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns without blocking when the body file becomes unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    SafeFsExecutor.safeUnlinkSync(bodyPath, {
      operation: 'tests/unit/scheduler/JobScheduler.body-drift.test.ts:remove-body',
    });

    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('body cannot be checked on disk');
    expect(warn.mock.calls[0][0]).toContain('continuing to use the body cached');
    expect(sessionManager._lastSpawnArgs?.prompt).toContain('Original cached instruction.');
  });
});
