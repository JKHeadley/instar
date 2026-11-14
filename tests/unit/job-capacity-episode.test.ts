import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { RerouteRefusedError } from '../../src/core/rerouteRefusedError.js';
import { SessionCapacityRefusedError } from '../../src/core/sessionCapacityRefusedError.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';

const job = (slug: string, priority: 'critical' | 'low') => ({
  slug, name: slug === 'health-check' ? 'Health Check' : 'Topic issue tracker',
  description: 'Check', schedule: '0 0 1 1 *', priority, enabled: true,
  expectedDurationMinutes: 5, model: 'haiku', execute: { type: 'prompt', value: 'check' },

});

describe('job reroute capacity episode', () => {
  let project: TempProject;
  let sessions: MockSessionManager;
  let scheduler: JobScheduler;
  let available: boolean;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T02:00:00Z'));
    project = createTempProject();
    sessions = createMockSessionManager();
    available = false;
    (sessions as any).confinedRerouteCapacity = () => available ? 'available' : 'saturated';
    (sessions as any).purgeDeadSessions = vi.fn().mockResolvedValue(0);
    const jobsFile = path.join(project.stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([job('health-check', 'critical'), job('topic-issues', 'low')]));
    scheduler = new JobScheduler({ jobsFile, maxParallelJobs: 2, startupGraceMs: 4 * 3_600_000 }, sessions as any, project.state, project.stateDir);
    send = vi.fn().mockResolvedValue(undefined);
    scheduler.setMessenger({ send } as any);
    scheduler.start();
  });

  afterEach(() => { scheduler.stop(); project.cleanup(); vi.useRealTimers(); });

  it('classifies only the typed refusal as waiting; a same-text Error is a real failure', async () => {
    sessions.spawnSession = vi.fn().mockRejectedValueOnce(new RerouteRefusedError('cap'))
      .mockRejectedValueOnce(new Error('Reroute refused (force-mode): cap'));
    await scheduler.triggerJob('health-check', 'manual');
    await vi.waitFor(() => expect(project.state.queryEvents({ type: 'job_waited_for_room' })).toHaveLength(1));
    expect(project.state.getJobState('health-check')?.consecutiveFailures ?? 0).toBe(0);
    expect(project.state.queryEvents({ type: 'job_error' })).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    await scheduler.triggerJob('topic-issues', 'manual');
    await vi.waitFor(() => expect(project.state.getJobState('topic-issues')?.consecutiveFailures).toBe(1));
    expect(project.state.queryEvents({ type: 'job_error' })).toHaveLength(1);
  });

  it('treats the global session cap as a quiet wait and retries when room opens', async () => {
    sessions.spawnSession = vi.fn().mockRejectedValueOnce(new SessionCapacityRefusedError(20, 20))
      .mockRejectedValueOnce(new Error('Max sessions (20) reached with 20 running'))
      .mockImplementation(createMockSessionManager().spawnSession);
    await scheduler.triggerJob('health-check', 'scheduled');
    await vi.waitFor(() => expect(scheduler.getQueue()).toHaveLength(1));
    expect(project.state.getJobState('health-check')?.consecutiveFailures ?? 0).toBe(0);
    expect(send).not.toHaveBeenCalled();
    await scheduler.triggerJob('topic-issues', 'scheduled');
    await vi.waitFor(() => expect(project.state.getJobState('topic-issues')?.consecutiveFailures).toBe(1));
    expect(scheduler.getQueue()).toHaveLength(1);
    available = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(scheduler.getQueue()).toHaveLength(0);
    expect(sessions.spawnSession).toHaveBeenCalledTimes(3);
  });

  it('warns once after ten minutes for a blocked critical job, then starts it when room opens', async () => {
    sessions.spawnSession = vi.fn().mockRejectedValueOnce(new RerouteRefusedError('cap'))
      .mockImplementation(createMockSessionManager().spawnSession);
    await scheduler.triggerJob('health-check', 'scheduled');
    await vi.waitFor(() => expect(scheduler.getQueue()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].content).toContain('Health Check');
    expect(send.mock.calls[0][0].content).toContain('10 minutes');
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    available = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(scheduler.getQueue()).toHaveLength(0);
    expect(sessions.spawnSession).toHaveBeenCalledTimes(2);
    expect(project.state.getJobState('health-check')?.consecutiveFailures ?? 0).toBe(0);
  });
  it('persists the waiting episode across restart and keeps low-priority waits quiet until thirty minutes', async () => {
    sessions.spawnSession = vi.fn().mockRejectedValue(new RerouteRefusedError('cap'));
    await scheduler.triggerJob('topic-issues', 'scheduled');
    await vi.waitFor(() => expect(scheduler.getQueue()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(send).not.toHaveBeenCalled();
    scheduler.stop();
    const jobsFile = path.join(project.stateDir, 'jobs.json');
    scheduler = new JobScheduler({ jobsFile, maxParallelJobs: 2, startupGraceMs: 4 * 3_600_000 }, sessions as any, project.state, project.stateDir);
    scheduler.setMessenger({ send } as any);
    scheduler.start();
    expect(scheduler.getQueue()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].content).toContain('Topic issue tracker');
  });

  it('runs a critical waiting job before a low-priority waiting job, one at a time', async () => {
    const calls: string[] = [];
    sessions.spawnSession = vi.fn().mockImplementation(async (options) => {
      calls.push(options.jobSlug);
      if (!available) throw new RerouteRefusedError('cap');
      return createMockSessionManager().spawnSession(options);
    });
    await scheduler.triggerJob('topic-issues', 'scheduled');
    await scheduler.triggerJob('health-check', 'scheduled');
    await vi.waitFor(() => expect(scheduler.getQueue()).toHaveLength(2));
    expect(scheduler.getQueue().map(j => j.slug)).toEqual(['health-check', 'topic-issues']);
    available = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.at(-1)).toBe('health-check');
    expect(scheduler.getQueue()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.at(-1)).toBe('topic-issues');
    expect(scheduler.getQueue()).toHaveLength(0);
  });

  it('reclaims a proven dead session before any alert and stays silent when room opens', async () => {
    sessions.spawnSession = vi.fn().mockRejectedValueOnce(new RerouteRefusedError('cap'))
      .mockImplementation(createMockSessionManager().spawnSession);
    (sessions as any).purgeDeadSessions = vi.fn().mockImplementation(async () => { available = true; return 1; });
    await scheduler.triggerJob('health-check', 'scheduled');
    await vi.waitFor(() => expect(scheduler.getQueue()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((sessions as any).purgeDeadSessions).toHaveBeenCalledWith(true);
    expect(send).not.toHaveBeenCalled();
    expect(sessions.spawnSession).toHaveBeenCalledTimes(2);
  });



  it('closes a capacity wait when the retried launch has a real error', async () => {
    sessions.spawnSession = vi.fn().mockRejectedValueOnce(new RerouteRefusedError('cap'))
      .mockRejectedValueOnce(new Error('Session killed before startup'));
    await scheduler.triggerJob('health-check', 'scheduled');
    await vi.waitFor(() => expect(scheduler.getQueue()).toHaveLength(1));
    available = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(project.state.getJobState('health-check')?.consecutiveFailures).toBe(1);
    expect(project.state.get('job-capacity-episode')).toBeNull();
    expect(scheduler.getQueue()).toHaveLength(0);
  });

  it('does not give a new critical wait the age of an older low-priority wait', async () => {
    sessions.spawnSession = vi.fn().mockRejectedValue(new RerouteRefusedError('cap'));
    await scheduler.triggerJob('topic-issues', 'scheduled');
    await vi.waitFor(() => expect(scheduler.getQueue()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    await scheduler.triggerJob('health-check', 'scheduled');
    await vi.waitFor(() => expect(scheduler.getQueue()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].content).toContain('the first wait began 30 minutes ago');
  });

});
