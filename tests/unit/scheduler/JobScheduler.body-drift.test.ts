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

describe('JobScheduler agentmd body live refresh', () => {
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
      maxParallelJobs: 5,
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

  it('reloads each validated disk edit for the run being triggered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reloadLogs = () => log.mock.calls.filter((call) =>
      String(call[0] ?? '').includes('reloaded the validated body'),
    );
    fs.writeFileSync(bodyPath, agentMd('First on-disk edit.\n'));

    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');

    expect(reloadLogs()).toHaveLength(1);
    expect(reloadLogs()[0]?.[0]).toContain('changed on disk after scheduler start');
    expect(sessionManager._lastSpawnArgs?.prompt).toContain('First on-disk edit.');
    expect(sessionManager._lastSpawnArgs?.prompt).not.toContain('Original cached instruction.');

    await scheduler.triggerJob('body-drift-probe', 'test-again');
    expect(reloadLogs()).toHaveLength(1);

    fs.writeFileSync(bodyPath, agentMd('Second on-disk edit.\n'));
    await scheduler.triggerJob('body-drift-probe', 'test-after-second-edit');
    expect(reloadLogs()).toHaveLength(2);
    const hydratedJobs = (scheduler as unknown as { jobs: Array<{ body?: string }> }).jobs;
    expect(hydratedJobs[0]?.body).toContain('Second on-disk edit.');
  });

  it('warns without blocking when the body file becomes unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    SafeFsExecutor.safeUnlinkSync(bodyPath, {
      operation: 'tests/unit/scheduler/JobScheduler.body-drift.test.ts:remove-body',
    });

    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('body cannot be checked on disk');
    expect(warn.mock.calls[0][0]).toContain('continuing to use the last validated body');
    expect(sessionManager._lastSpawnArgs?.prompt).toContain('Original cached instruction.');
  });

  it('retains the last validated body when an edit breaks frontmatter boundaries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(bodyPath, 'not valid agentmd anymore\nReplacement instruction.\n');

    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('valid frontmatter boundaries');
    expect(sessionManager._lastSpawnArgs?.prompt).toContain('Original cached instruction.');
    expect(sessionManager._lastSpawnArgs?.prompt).not.toContain('Replacement instruction.');
  });
});
