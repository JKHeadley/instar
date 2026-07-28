/**
 * Regression (Codey gap-run F005): `script`-type jobs were dispatched by spawning
 * a model session with a "Run this script: ..." prompt. Two such jobs hung for ~9h
 * and ~16h holding live session slots with run-history stuck at `pending`. Script
 * jobs are zero-token shell work and must run directly in a bounded subprocess,
 * never a model session — and they must not consume session-capacity gating.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { JobDefinition, JobSchedulerConfig } from '../../src/core/types.js';

function config(jobsFile: string): JobSchedulerConfig {
  return {
    jobsFile,
    enabled: true,
    maxParallelJobs: 2,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('JobScheduler — script jobs run directly (no model session)', () => {
  let scheduler: JobScheduler | undefined;
  let project: TempProject | undefined;

  afterEach(() => {
    scheduler?.stop();
    project?.cleanup();
  });

  it('triggers a script job WITHOUT spawning a session, runs it, and records success', async () => {
    project = createTempProject();
    const mockSM = createMockSessionManager();
    const markerPath = path.join(project.stateDir, 'script-ran.txt');
    const jobs: JobDefinition[] = [{
      slug: 'script-job',
      name: 'Script Job',
      description: 'runs a shell script directly',
      schedule: '0 0 * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'script', value: `echo ran > "${markerPath}"` },
    }];
    const jobsFile = path.join(project.stateDir, 'script-jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

    scheduler = new JobScheduler(config(jobsFile), mockSM as any, project.state, project.stateDir);
    scheduler.start();

    const result = await scheduler.triggerJob('script-job', 'test');
    expect(result).toBe('triggered');

    // The core fix: a script job NEVER spawns a model session.
    expect(mockSM._spawnCount).toBe(0);

    // It actually executed directly in a subprocess.
    await waitFor(() => fs.existsSync(markerPath));
    expect(fs.readFileSync(markerPath, 'utf-8').trim()).toBe('ran');

    // And run-history / job-state is recorded as success (not left pending).
    await waitFor(() => project!.state.getJobState('script-job')?.lastResult === 'success');
    expect(project.state.getJobState('script-job')?.lastResult).toBe('success');
  });

  it('a script job does not count against session capacity (runs even at the parallel cap)', async () => {
    project = createTempProject();
    const mockSM = createMockSessionManager();
    // Saturate the session cap with non-script "running" sessions.
    mockSM.listRunningSessions = () => ([
      { tmuxSession: 'a', jobSlug: 'x' },
      { tmuxSession: 'b', jobSlug: 'y' },
    ]) as any;
    const markerPath = path.join(project.stateDir, 'cap-script-ran.txt');
    const jobs: JobDefinition[] = [{
      slug: 'cap-script',
      name: 'Cap Script',
      description: 'runs even at capacity',
      schedule: '0 0 * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'script', value: `echo ok > "${markerPath}"` },
    }];
    const jobsFile = path.join(project.stateDir, 'cap-jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

    scheduler = new JobScheduler({ ...config(jobsFile), maxParallelJobs: 2 }, mockSM as any, project.state, project.stateDir);
    scheduler.start();

    const result = await scheduler.triggerJob('cap-script', 'test');
    // Not queued/skipped despite the cap — script jobs bypass session capacity.
    expect(result).toBe('triggered');
    expect(mockSM._spawnCount).toBe(0);
    await waitFor(() => fs.existsSync(markerPath));
  });

  it('exposes authToken and projectName to script job shell', async () => {
    project = createTempProject();
    const mockSM = createMockSessionManager();
    const markerPath = path.join(project.stateDir, 'script-auth-env.txt');
    const jobs: JobDefinition[] = [{
      slug: 'script-auth-env',
      name: 'Script Auth Env',
      description: 'captures scheduler auth env',
      schedule: '0 0 * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'script', value: `printf 'token=%s agent=%s' "$INSTAR_AUTH_TOKEN" "$INSTAR_AGENT_ID" > "${markerPath}"` },
    }];
    const jobsFile = path.join(project.stateDir, 'script-auth-env-jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

    scheduler = new JobScheduler(
      { ...config(jobsFile), authToken: 'script-token', projectName: 'script-agent' },
      mockSM as any,
      project.state,
      project.stateDir,
    );
    scheduler.start();

    const result = await scheduler.triggerJob('script-auth-env', 'test');
    expect(result).toBe('triggered');
    await waitFor(() => fs.existsSync(markerPath));
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe('token=script-token agent=script-agent');
  });
});
