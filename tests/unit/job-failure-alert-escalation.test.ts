import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import type { JobDefinition, MessagingAdapter, Session, SessionManagerConfig } from '../../src/core/types.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { loadJobs } from '../../src/scheduler/JobLoader.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
  execFile: vi.fn(),
}));

vi.mock('croner', () => ({
  Cron: class {
    stop = vi.fn();
    nextRun = vi.fn().mockReturnValue(new Date('2026-08-03T17:00:00.000Z'));
    nextRuns = vi.fn().mockReturnValue([
      new Date('2026-08-03T17:00:00.000Z'),
      new Date('2026-08-03T17:05:00.000Z'),
    ]);
  },
}));

vi.mock('../../src/scheduler/JobLoader.js', () => ({
  loadJobs: vi.fn().mockReturnValue([]),
}));

interface AlertState {
  lastObservedFailures: number;
  deliveryAttempts: number;
  deliveredCount: number;
  nextEligibleAt: string;
}

describe('JobScheduler bounded failure escalation', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let sessions: SessionManager;
  let scheduler: JobScheduler;

  const job: JobDefinition = {
    slug: 'health-check',
    name: 'Health Check',
    description: 'health',
    schedule: '*/5 * * * *',
    enabled: true,
    priority: 'critical',
    model: 'haiku',
    execute: { type: 'prompt', value: 'health' },
  };

  const alert = async (target: JobScheduler, failures: number): Promise<void> => {
    await (target as unknown as {
      alertOnConsecutiveFailures(j: JobDefinition, n: number, error: string): Promise<void>;
    }).alertOnConsecutiveFailures(job, failures, 'spawn refused');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T16:45:00.000Z'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-job-alert-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const jobsFile = path.join(tmpDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]');
    state = new StateManager(stateDir);
    const sessionConfig: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: [],
    };
    sessions = new SessionManager(sessionConfig, state);
    vi.spyOn(sessions, 'captureOutput').mockReturnValue('healthy');
    vi.mocked(loadJobs).mockReturnValue([job]);
    scheduler = new JobScheduler({ jobsFile, projectDir: tmpDir, startupGraceMs: 0 }, sessions, state, stateDir);
    scheduler.start();
    scheduler.activateFailureAlertDelivery();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/job-failure-alert-escalation.test.ts' });
  });

  it('repairs a historically missed alert when the count is already past threshold', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    scheduler.setMessenger({ send } as MessagingAdapter);

    await alert(scheduler, 253);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].content).toContain('253 consecutive failures');
  });

  it('records a missing sink durably and retries on 5m, 15m, then 1h-capped backoff', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await alert(scheduler, 2);

    expect(error).toHaveBeenCalled();
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(1);
    const persisted = state.get<AlertState>('job-failure-alert-health-check');
    expect(persisted?.deliveryAttempts).toBe(1);
    expect(persisted?.nextEligibleAt).toBe('2026-08-03T16:50:00.000Z');

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_999);
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.get<AlertState>('job-failure-alert-health-check')?.nextEligibleAt)
      .toBe('2026-08-03T17:05:00.000Z');

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(state.get<AlertState>('job-failure-alert-health-check')?.nextEligibleAt)
      .toBe('2026-08-03T18:05:00.000Z');

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(state.get<AlertState>('job-failure-alert-health-check')?.nextEligibleAt)
      .toBe('2026-08-03T19:05:00.000Z');

    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(4);
  });

  it('widens successful reminder cadence instead of alerting every run', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    scheduler.setMessenger({ send } as MessagingAdapter);

    await alert(scheduler, 2);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 1);
    expect(send).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 1);
    expect(send).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('persists cadence across scheduler reconstruction', async () => {
    const firstSend = vi.fn().mockResolvedValue(undefined);
    scheduler.setMessenger({ send: firstSend } as MessagingAdapter);
    await alert(scheduler, 2);

    const jobsFile = path.join(tmpDir, 'jobs.json');
    scheduler.stop();
    const reconstructed = new JobScheduler({ jobsFile, projectDir: tmpDir, startupGraceMs: 0 }, sessions, state, stateDir);
    const secondSend = vi.fn().mockResolvedValue(undefined);
    reconstructed.setMessenger({ send: secondSend } as MessagingAdapter);
    reconstructed.start();

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect(secondSend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(secondSend).toHaveBeenCalledTimes(1);
    expect(firstSend).toHaveBeenCalledTimes(1);
    reconstructed.stop();
  });

  it('rehydrates a missing-sink retry after scheduler reconstruction', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await alert(scheduler, 2);
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(1);
    expect(state.get<AlertState>('job-failure-alert-health-check')?.nextEligibleAt)
      .toBe('2026-08-03T16:50:00.000Z');

    const jobsFile = path.join(tmpDir, 'jobs.json');
    scheduler.stop();
    const reconstructed = new JobScheduler({ jobsFile, projectDir: tmpDir, startupGraceMs: 0 }, sessions, state, stateDir);
    reconstructed.start();
    reconstructed.activateFailureAlertDelivery();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(2);
    expect(state.get<AlertState>('job-failure-alert-health-check')?.nextEligibleAt)
      .toBe('2026-08-03T17:05:00.000Z');
    reconstructed.stop();
  });

  it('does not wake a persisted episode before startup composition is finalized', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await alert(scheduler, 2);

    const jobsFile = path.join(tmpDir, 'jobs.json');
    scheduler.stop();
    const reconstructed = new JobScheduler({ jobsFile, projectDir: tmpDir, startupGraceMs: 0 }, sessions, state, stateDir);
    reconstructed.start();
    reconstructed.pause();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    reconstructed.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(1);

    reconstructed.activateFailureAlertDelivery();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(2);
    reconstructed.stop();
  });

  it('re-arms an overdue alert when the scheduler resumes from pause', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    scheduler.setMessenger({ send } as MessagingAdapter);
    await alert(scheduler, 2);

    scheduler.pause();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);

    scheduler.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('re-arms an overdue missing-sink retry when the scheduler resumes from pause', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await alert(scheduler, 2);
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(1);

    scheduler.pause();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(1);

    scheduler.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.queryEvents({ type: 'job_alert_delivery_failed' })).toHaveLength(2);
    expect(state.get<AlertState>('job-failure-alert-health-check')?.nextEligibleAt)
      .toBe('2026-08-03T17:05:00.000Z');
  });

  it('uses exactly one sink when Telegram and messenger are both present', async () => {
    const topicSend = vi.fn().mockResolvedValue(undefined);
    const genericSend = vi.fn().mockResolvedValue(undefined);
    scheduler.setTelegram({ sendToTopic: topicSend } as unknown as import('../../src/messaging/TelegramAdapter.js').TelegramAdapter);
    scheduler.setMessenger({ send: genericSend });

    await (scheduler as unknown as {
      alertOnConsecutiveFailures(j: JobDefinition, n: number, error: string): Promise<void>;
    }).alertOnConsecutiveFailures({ ...job, topicId: 88 }, 2, 'spawn refused');

    expect(topicSend).toHaveBeenCalledTimes(1);
    expect(genericSend).not.toHaveBeenCalled();
  });

  it('coalesces overlapping callbacks into one delivery', async () => {
    let releaseSend!: () => void;
    const send = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      releaseSend = resolve;
    }));
    scheduler.setMessenger({ send } as MessagingAdapter);

    const first = alert(scheduler, 2);
    expect(send).toHaveBeenCalledTimes(1);
    const overlapping = alert(scheduler, 3);
    expect(send).toHaveBeenCalledTimes(1);

    releaseSend();
    await Promise.all([first, overlapping]);
    expect(state.queryEvents({ type: 'job_alert_delivered' })).toHaveLength(1);
  });

  it('does not resurrect a reminder when recovery races a pending send', async () => {
    let releaseSend!: () => void;
    const send = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      releaseSend = resolve;
    }));
    scheduler.setMessenger({ send } as MessagingAdapter);

    const pendingAlert = alert(scheduler, 2);
    const session: Session = {
      id: 'health-race-recovery',
      name: 'health-race-recovery',
      tmuxSession: 'health-race-recovery',
      status: 'completed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      jobSlug: job.slug,
    };
    state.saveSession(session);
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    releaseSend();
    await pendingAlert;
    expect(state.get('job-failure-alert-health-check')).toBeNull();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('clears the durable episode on recovery', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    scheduler.setMessenger({ send });
    await alert(scheduler, 2);
    expect(state.get('job-failure-alert-health-check')).not.toBeNull();

    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [job];
    const session: Session = {
      id: 'health-success',
      name: 'health-success',
      tmuxSession: 'health-success',
      status: 'completed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      jobSlug: job.slug,
    };
    state.saveSession(session);
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);

    expect(state.get('job-failure-alert-health-check')).toBeNull();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
