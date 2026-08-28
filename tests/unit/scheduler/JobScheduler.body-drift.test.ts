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

  // ── W27 Observer 2 finding A: the body fallback must NOT weaken the
  //    disk-authoritative manifest gate. Both safety properties, side by side.

  it('a body fallback never overrides a live DISABLE on disk (manifest stays the truth)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // First trigger hydrates + runs normally.
    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');

    // Body breaks AND the operator disables the job on disk in the same window.
    fs.writeFileSync(bodyPath, 'not valid agentmd anymore\n');
    const manifestPath = path.join(project.stateDir, 'jobs', 'schedule', 'body-drift-probe.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, enabled: false }));

    const spawnsBefore = sessionManager._spawnCount;
    await expect(scheduler.triggerJob('body-drift-probe', 'test-after-disable')).resolves.toBe('skipped');
    expect(sessionManager._spawnCount).toBe(spawnsBefore);
    const skipped = project.state.queryEvents({}).filter((e) => e.type === 'job_skipped');
    expect(skipped.at(-1)?.metadata?.gateReason).toBe('disabled');
  });

  it('a body fallback never resurrects a job whose manifest was REMOVED from disk', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');

    SafeFsExecutor.safeUnlinkSync(bodyPath, {
      operation: 'tests/unit/scheduler/JobScheduler.body-drift.test.ts:remove-body',
    });
    SafeFsExecutor.safeUnlinkSync(path.join(project.stateDir, 'jobs', 'schedule', 'body-drift-probe.json'), {
      operation: 'tests/unit/scheduler/JobScheduler.body-drift.test.ts:remove-manifest',
    });

    const spawnsBefore = sessionManager._spawnCount;
    await expect(scheduler.triggerJob('body-drift-probe', 'test-after-removal')).resolves.toBe('skipped');
    expect(sessionManager._spawnCount).toBe(spawnsBefore);
    const skipped = project.state.queryEvents({}).filter((e) => e.type === 'job_skipped');
    expect(skipped.at(-1)?.metadata?.gateReason).toBe('job-missing');
  });

  it('a job that was never hydrated has no body to fall back to and stays refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A second agentmd manifest whose body never existed on disk.
    const scheduleDir = path.join(project.stateDir, 'jobs', 'schedule');
    fs.writeFileSync(path.join(scheduleDir, 'never-hydrated.json'), JSON.stringify({
      slug: 'never-hydrated',
      origin: 'user',
      schedule: '0 0 1 1 *',
      priority: 'low',
      model: 'haiku',
      expectedDurationMinutes: 1,
      enabled: true,
      execute: { type: 'agentmd' },
    }));

    await expect(scheduler.triggerJob('never-hydrated', 'test')).resolves.toBe('skipped');
    const skipped = project.state.queryEvents({}).filter((e) => e.type === 'job_skipped');
    expect(skipped.at(-1)?.metadata?.gateReason).toBe('job-missing');
  });

  it('the body fallback is bound to the current manifest path: an origin change with a broken new body never runs the old file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');
    expect(sessionManager._lastSpawnArgs?.prompt).toContain('Original cached instruction.');

    // Same slug, same schedule — but the manifest now points at the OTHER
    // origin's file, which does not exist. The old user-origin file is still
    // on disk and must NOT be what runs.
    const manifestPath = path.join(project.stateDir, 'jobs', 'schedule', 'body-drift-probe.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, origin: 'instar' }));

    const spawnsBefore = sessionManager._spawnCount;
    await expect(scheduler.triggerJob('body-drift-probe', 'test-after-origin-change')).resolves.toBe('skipped');
    expect(sessionManager._spawnCount).toBe(spawnsBefore);
    const skipped = project.state.queryEvents({}).filter((e) => e.type === 'job_skipped');
    expect(skipped.at(-1)?.metadata?.gateReason).toBe('job-missing');
  });

  it('a loader diagnostic that appears after boot is reported once, clears, and is reported again on recurrence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const skipLines = () => [...warn.mock.calls, ...error.mock.calls]
      .filter((c) => String(c[0]).includes('[JobLoader] Skipping invalid job'));
    const jobsJson = path.join(project.stateDir, 'jobs.json');

    await scheduler.triggerJob('body-drift-probe', 'boot');
    expect(skipLines()).toHaveLength(0);

    // A NEW invalid legacy entry lands after boot: reported exactly once, not
    // once per trigger (a legacy-validation class, not an agentmd problem).
    fs.writeFileSync(jobsJson, JSON.stringify([{ slug: 'broken-legacy' }]));
    await scheduler.triggerJob('body-drift-probe', 'one');
    await scheduler.triggerJob('body-drift-probe', 'two');
    expect(skipLines()).toHaveLength(1);

    // It clears …
    fs.writeFileSync(jobsJson, '[]');
    await scheduler.triggerJob('body-drift-probe', 'three');
    expect(skipLines()).toHaveLength(1);

    // … and a recurrence is reported again.
    fs.writeFileSync(jobsJson, JSON.stringify([{ slug: 'broken-legacy' }]));
    await scheduler.triggerJob('body-drift-probe', 'four');
    expect(skipLines()).toHaveLength(2);
  });

  it('re-reading the job set at each trigger does not re-print the loader audits every time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The probe job has no grounding config, so the loader's grounding audit
    // fires on the FIRST (boot-time) load. It must not fire again on every
    // trigger-boundary reload of an unchanged job set.
    await scheduler.triggerJob('body-drift-probe', 'one');
    const afterFirst = warn.mock.calls.filter((c) => String(c[0]).includes('[JobLoader]')).length;
    await scheduler.triggerJob('body-drift-probe', 'two');
    await scheduler.triggerJob('body-drift-probe', 'three');
    const afterThird = warn.mock.calls.filter((c) => String(c[0]).includes('[JobLoader]')).length;
    expect(afterThird).toBe(afterFirst);
  });

  it('a prose-only body edit does not rebuild the cron tasks (manifest-level signature)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const tasksBefore = (scheduler as unknown as { cronTasks: Map<string, unknown> }).cronTasks;
    const taskBefore = tasksBefore.get('body-drift-probe');
    expect(taskBefore).toBeDefined();

    fs.writeFileSync(bodyPath, agentMd('Prose-only edit.\n'));
    await expect(scheduler.triggerJob('body-drift-probe', 'test')).resolves.toBe('triggered');
    expect(sessionManager._lastSpawnArgs?.prompt).toContain('Prose-only edit.');

    const tasksAfter = (scheduler as unknown as { cronTasks: Map<string, unknown> }).cronTasks;
    // Same Cron instance: the reload saw no manifest change, so nothing was torn down.
    expect(tasksAfter.get('body-drift-probe')).toBe(taskBefore);
  });
});
