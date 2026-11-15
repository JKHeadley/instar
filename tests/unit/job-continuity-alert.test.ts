import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createMockSessionManager, createSampleJobsFile, createTempProject } from '../helpers/setup.js';
import type { JobDefinition } from '../../src/core/types.js';
import type { TempProject } from '../helpers/setup.js';

const job: JobDefinition = {
  slug: 'gci-review', name: 'GCI review', description: 'Review client work',
  schedule: '* * * * *', enabled: true, priority: 'medium', model: 'sonnet',
  execute: { type: 'prompt', value: 'review' },
};

describe('job continuity alerts', () => {
  let project: TempProject;
  let scheduler: JobScheduler;
  let raise: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    project = createTempProject();
    raise = vi.fn().mockResolvedValue({});
    clear = vi.fn();
    project.state.set('agent-attention-topic', 42);
    const jobsFile = createSampleJobsFile(project.stateDir, [job]);
    scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1, startupGraceMs: 60_000 },
      createMockSessionManager() as any, project.state, project.stateDir);
    scheduler.setTelegram({ sendToTopic: raise, clearAttentionCondition: clear } as any);
  });

  afterEach(() => { scheduler.stop(); project.cleanup(); });

  it('keeps a quiet result separate from notified and observes its daily cadence', async () => {
    raise.mockResolvedValue({ delivered: false, recorded: true, quietId: 'continuity-q' });
    (scheduler as any).raiseContinuityAlert(job, 'fixture', 'job-silence-gci-review');
    await vi.waitFor(() => expect(project.state.get<any>('job-silence-gci-review')?.recordedAt).toBeDefined());
    expect(project.state.get<any>('job-silence-gci-review')?.lastNotified).toBeUndefined();
    expect(project.state.queryEvents({ type: 'job_alert_delivered' })).toHaveLength(0);
    (scheduler as any).raiseContinuityAlert(job, 'fixture', 'job-silence-gci-review'); expect(raise).toHaveBeenCalledOnce();
  });
  it('uses newer quiet recording time even when an older delivered timestamp exists', async () => {
    project.state.set('job-silence-gci-review', { count: 3, lastSkip: new Date().toISOString(), lastNotified: new Date(Date.now() - 2 * 86400000).toISOString(), recordedAt: new Date(Date.now() - 60000).toISOString() });
    (scheduler as any).raiseContinuityAlert(job, 'fixture', 'job-silence-gci-review');
    await Promise.resolve(); expect(raise).not.toHaveBeenCalled();
  });

  it('alerts after three gate skips and clears only after completed success', async () => {
    scheduler.start();
    for (let i = 0; i < 3; i++) scheduler.getSkipLedger().recordSkip(job.slug, 'gate');
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(1));
    expect(raise.mock.calls[0][0]).toBe(42);
    expect(raise.mock.calls[0][1]).toContain('GCI review');
    expect(project.state.get<{ count: number }>('job-silence-gci-review')?.count).toBe(3);
    (scheduler as any).noteContinuitySuccess(job.slug);
    expect(project.state.get('job-silence-gci-review')).toBeNull();
    expect(clear).not.toHaveBeenCalled();
  });

  it('alerts for an enabled job with no completed run beyond its interval', async () => {
    project.state.saveJobState({ slug: job.slug, firstSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(), consecutiveFailures: 0 });
    scheduler.start();
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(1));
  });

  it('does not let a recent skipped attempt hide an old absence of success', async () => {
    project.state.saveJobState({ slug: job.slug, lastRun: new Date().toISOString(), lastResult: 'skipped', consecutiveFailures: 0 });
    project.state.set(`job-continuity-first-seen-${job.slug}`, new Date(Date.now() - 10 * 60_000).toISOString());
    scheduler.start();
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(1));
  });

  it('retries a rejected operator send instead of marking it delivered', async () => {
    project.state.saveJobState({ slug: job.slug, firstSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(), consecutiveFailures: 0 });
    raise.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ messageId: 1 });
    scheduler.start();
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(1));
    expect(project.state.get<{ lastNotified?: string }>('job-silence-gci-review')?.lastNotified).toBeUndefined();
    await vi.waitFor(() => expect((scheduler as any).silenceAlertsInFlight.size).toBe(0));
    const episode = project.state.get<Record<string, unknown>>('job-silence-gci-review')!;
    project.state.set('job-silence-gci-review', { ...episode, lastAttemptAt: new Date(Date.now() - 61 * 60_000).toISOString() });
    (scheduler as any).checkSilentJobs();
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(project.state.get<{ lastNotified?: string }>('job-silence-gci-review')?.lastNotified).toBeTruthy());
  });

  it('alerts when the serving machine cannot run a pinned job', async () => {
    const jobsFile = createSampleJobsFile(project.stateDir, [{ ...job, machines: ['other-machine'] }]);
    scheduler.stop();
    scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1, startupGraceMs: 60_000 },
      createMockSessionManager() as any, project.state, project.stateDir);
    scheduler.setTelegram({ sendToTopic: raise } as any);
    scheduler.setMachineIdentity('this-machine', 'This Machine');
    scheduler.start();
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(1));
    expect(raise.mock.calls[0][1]).toContain('set to run only on another machine');
    // The notice names where the job is pinned, this machine, and how to fix it.
    expect(raise.mock.calls[0][1]).toContain('another machine (other-machine)');
    expect(raise.mock.calls[0][1]).toContain('this machine (This Machine)');
    expect(raise.mock.calls[0][1]).toContain('"machines" list');
  });

  it('does not send a queued alert after demotion', async () => {
    scheduler.start();
    for (let i = 0; i < 3; i++) scheduler.getSkipLedger().recordSkip(job.slug, 'gate');
    project.state.setReadOnly(true);
    await Promise.resolve();
    expect(raise).not.toHaveBeenCalled();
    project.state.setReadOnly(false);
  });

  it('does not write or alert after demotion to read-only standby', () => {
    scheduler.start();
    project.state.setReadOnly(true);
    for (let i = 0; i < 3; i++) scheduler.getSkipLedger().recordSkip(job.slug, 'gate');
    expect(raise).not.toHaveBeenCalled();
    project.state.setReadOnly(false);
  });

  it('treats a gate that answers "nothing to do" (exit 1) as a healthy check, not lost coverage', async () => {
    (scheduler as any).config.gateRetries = 1;
    scheduler.start();
    const polling: JobDefinition = { ...job, gate: 'exit 1' };
    for (let i = 0; i < 4; i++) await (scheduler as any).runGateAsync(polling);
    expect(raise).not.toHaveBeenCalled();
    expect(project.state.get('job-silence-gci-review')).toBeNull();
    expect(project.state.get('job-last-success-gci-review')).toBeTruthy();
  }, 60_000);

  it('still warns when the gate itself is broken, in plain words with a direct link to the job', async () => {
    scheduler.setOperatorLinkOrigin(() => 'https://agent.example.dev');
    (scheduler as any).config.gateRetries = 1;
    project.state.set('job-last-success-gci-review', new Date().toISOString());
    scheduler.start();
    const broken: JobDefinition = { ...job, gate: 'exit 127' };
    for (let i = 0; i < 3; i++) await (scheduler as any).runGateAsync(broken);
    await vi.waitFor(() => expect(raise).toHaveBeenCalledTimes(1));
    const text = String(raise.mock.calls[0][1]);
    expect(text).toContain('"GCI review" is not running');
    expect(text).toContain('has failed 3 times in a row');
    expect(text).toContain('https://agent.example.dev/dashboard/console/#/work/schedule?job=gci-review');
    expect(text).not.toContain('Check its gate');
  }, 60_000);

  it('waits for the public link instead of sending a warning with no link', async () => {
    scheduler.setOperatorLinkOrigin(() => null);
    (scheduler as any).raiseContinuityAlert(job, 'fixture', 'job-silence-gci-review');
    await Promise.resolve();
    expect(raise).not.toHaveBeenCalled();
  });
});
