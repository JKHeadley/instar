/**
 * job-mode-instructions (docs/specs/job-mode-instructions.md) through the real scheduler spawn path:
 * resolution, the rollout gate, the inline text handed to spawnSession, and the post-run check.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../../src/core/StateManager.js';
import { SessionManager } from '../../../src/core/SessionManager.js';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { SHARED_CLAUSE_PLAIN_COMPLETE_MESSAGES } from '../../../src/scaffold/templates.js';
import type { JobDefinition, JobSchedulerConfig, SessionManagerConfig } from '../../../src/core/types.js';

describe('job-mode through JobScheduler.spawnJobSession', () => {
  let stateDir: string;
  let scheduler: JobScheduler;
  let spawnSpy: ReturnType<typeof vi.fn>;
  let cfg: Record<string, unknown>;

  const schedulerConfig: JobSchedulerConfig = {
    jobsFile: '', enabled: true, maxParallelJobs: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jobmode-sched-'));
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    const state = new StateManager(stateDir);
    const sessionConfig: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: stateDir,
      maxSessions: 10, protectedSessions: [], completionPatterns: [], projectName: 'echo',
    };
    const sessionManager = new SessionManager(sessionConfig, state);
    (sessionManager as unknown as { claudeCliVersion: () => Promise<string> }).claudeCliVersion = async () => '2.1.330';
    spawnSpy = vi.fn().mockResolvedValue({ id: 'stub', name: 'stub', status: 'running', tmuxSession: 'stub-tmux', startedAt: new Date().toISOString() });
    (sessionManager as unknown as { spawnSession: typeof spawnSpy }).spawnSession = spawnSpy;
    scheduler = new JobScheduler({ ...schedulerConfig, projectName: 'echo' } as JobSchedulerConfig, sessionManager, state, stateDir);
    cfg = { developmentAgent: true };
    (scheduler as unknown as { configReader: () => Record<string, unknown> }).configReader = () => cfg;
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/scheduler/job-mode-scheduler.test.ts' });
  });

  function makeJob(slug: string, extra: Partial<JobDefinition> = {}): JobDefinition {
    return {
      slug, name: slug, description: slug, schedule: '*/5 * * * *', priority: 'low',
      expectedDurationMinutes: 1, model: 'haiku', enabled: true,
      execute: { type: 'prompt', value: 'do the thing' }, ...extra,
    };
  }

  async function trigger(job: JobDefinition): Promise<{ jobMode?: { text: string; markerVersion: string } }> {
    spawnSpy.mockClear();
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [job];
    await scheduler.triggerJob(job.slug, 'test');
    for (let i = 0; i < 20 && spawnSpy.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    return spawnSpy.mock.calls[0]?.[0] ?? {};
  }

  it('a user job opted in by override launches with the rendered job-mode text, including the disclosure clauses', async () => {
    cfg = { developmentAgent: true, scheduler: { instructionsOverrides: { 'user:commitment-detection': 'job-mode' } } };
    const call = await trigger(makeJob('commitment-detection'));
    expect(call.jobMode).toBeDefined();
    expect(call.jobMode!.text).toContain('JOB-MODE-MARKER instar ');
    expect(call.jobMode!.text).toContain(SHARED_CLAUSE_PLAIN_COMPLETE_MESSAGES);
  });

  it('a user job with no opt-in launches full', async () => {
    const call = await trigger(makeJob('plain-user-job'));
    expect(call.jobMode).toBeUndefined();
  });

  it('a jobs.json entry may opt in with its own instructions field', async () => {
    const call = await trigger(makeJob('field-job', { instructions: 'job-mode' }));
    expect(call.jobMode).toBeDefined();
  });

  it('the rollout gate off (fleet default) means full even with an override', async () => {
    cfg = { scheduler: { instructionsOverrides: { 'user:commitment-detection': 'job-mode' } } };
    const call = await trigger(makeJob('commitment-detection'));
    expect(call.jobMode).toBeUndefined();
  });

  it('an unreadable Claude Code version launches full and leaves the check state untouched', async () => {
    cfg = { developmentAgent: true, scheduler: { instructionsOverrides: { 'user:uv': 'job-mode' } } };
    const sm = (scheduler as unknown as { sessionManager: { claudeCliVersion: () => Promise<string> } }).sessionManager;
    sm.claudeCliVersion = async () => 'unknown';
    const call = await trigger(makeJob('uv'));
    expect(call.jobMode).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, 'state', 'job-mode-checks'))
      ? fs.readdirSync(path.join(stateDir, 'state', 'job-mode-checks')).filter(f => f.includes('uv')) : []).toEqual([]);
  });

  it('repeated rejected job-mode spawns fall back to full instructions instead of retrying the same flags', async () => {
    cfg = { developmentAgent: true, scheduler: { instructionsOverrides: { 'user:rj': 'job-mode' } } };
    const job = makeJob('rj');
    const seen: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      spawnSpy.mockReset();
      spawnSpy.mockRejectedValue(new Error('spawn refused'));
      (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [job];
      await scheduler.triggerJob('rj', 'test').catch(() => undefined);
      for (let k = 0; k < 20 && spawnSpy.mock.calls.length === 0; k++) await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 30));
      seen.push(!!spawnSpy.mock.calls[0]?.[0]?.jobMode);
    }
    expect(seen.slice(0, 3)).toEqual([true, true, true]);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('an invalid override launches full', async () => {
    cfg = { developmentAgent: true, scheduler: { instructionsOverrides: { 'user:x': 'trimmed' } } };
    const call = await trigger(makeJob('x'));
    expect(call.jobMode).toBeUndefined();
  });

  it('jobModeStatus reports the configured mode and source', () => {
    cfg = { developmentAgent: true, scheduler: { instructionsOverrides: { 'user:s': 'job-mode' } } };
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [makeJob('s')];
    expect(scheduler.jobModeStatus('s')).toMatchObject({ configured: 'job-mode', source: 'override' });
  });

  it('jobModeStatus reports the effective mode separately from the configured one', async () => {
    cfg = { developmentAgent: true, scheduler: { instructionsOverrides: { 'user:s': 'job-mode' } } };
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [makeJob('s')];
    expect(scheduler.jobModeStatus('s')).toMatchObject({ effective: { mode: 'job-mode', reason: 'claude-code-launches-only' }, lastRun: null });
    cfg = { developmentAgent: true, scheduler: { jobModeInstructions: false, instructionsOverrides: { 'user:s': 'job-mode' } } };
    expect(scheduler.jobModeStatus('s')).toMatchObject({ configured: 'job-mode', effective: { mode: 'full', reason: 'gate-off' } });
  });
});
