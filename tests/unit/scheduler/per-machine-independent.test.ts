/**
 * perMachineIndependent job flag — JobScheduler regression (spec §2.8 / D11).
 *
 * A perMachineIndependent job (the doorway scan, whose result is a physical fact
 * of THIS machine's own disk) MUST skip the global jobSlug claim/lease so every
 * machine runs its own scan. A job WITHOUT the flag must keep today's exact
 * behavior — yield when hasRemoteClaim(slug) === true.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../../helpers/setup.js';
import type { JobDefinition } from '../../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';

describe('JobScheduler — perMachineIndependent claim/lease short-circuit (D11)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let hasRemoteClaimCalls: string[];

  const makeJob = (slug: string, overrides?: Partial<JobDefinition>): JobDefinition => ({
    slug,
    name: slug,
    description: `Test job: ${slug}`,
    schedule: '0 * * * *',
    priority: 'medium',
    expectedDurationMinutes: 5,
    model: 'sonnet',
    enabled: true,
    execute: { type: 'prompt', value: 'do something' },
    ...overrides,
  }) as JobDefinition;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    hasRemoteClaimCalls = [];
    const jobsFile = path.join(project.stateDir, 'test-jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([]));
    scheduler = new JobScheduler(
      { jobsFile, enabled: true, maxParallelJobs: 0, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as any,
      project.state,
      project.stateDir,
    );
    // Populate jobs directly (avoid start()'s cron wiring).
    (scheduler as any).jobs = [
      makeJob('normal-job'),
      makeJob('pmi-job', { perMachineIndependent: true }),
    ];
    // A claim manager that ALWAYS reports a remote claim, recording who it was asked about.
    scheduler.setJobClaimManager({
      hasRemoteClaim: (slug: string) => { hasRemoteClaimCalls.push(slug); return true; },
      getClaim: () => ({ machineId: 'other-machine' }),
      tryClaim: async () => {},
      completeClaim: async () => {},
    } as any);
  });

  afterEach(() => {
    scheduler?.stop();
    project.cleanup();
  });

  it('a job WITHOUT the flag still yields when hasRemoteClaim === true (today\'s exact behavior)', async () => {
    const result = await scheduler.triggerJob('normal-job', 'test');
    expect(result).toBe('skipped');
    expect(hasRemoteClaimCalls).toContain('normal-job');
  });

  it('a perMachineIndependent job does NOT consult the claim path and proceeds', async () => {
    const result = await scheduler.triggerJob('pmi-job', 'test');
    // It got PAST the claim gate (queued at the 0-capacity session gate, never spawned here).
    expect(result).not.toBe('skipped');
    // The load-bearing assertion: the claim path was never consulted for this slug.
    expect(hasRemoteClaimCalls).not.toContain('pmi-job');
  });
});
