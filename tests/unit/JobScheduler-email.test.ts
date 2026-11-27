/**
 * docs/specs/backup-email-sending.md, Using it: a job with `deliver: ['email']` hands its report to the email
 * sender in the same completion bookkeeping that records the run, with the row id on the run record
 * (`emailOutboxId`); the body is the transcript's final message; Quiet by Default holds (a quiet run is marked
 * `quiet` and nothing is sent); an email-only job sends nothing to Telegram; the topic copy is redacted where the
 * topic has other readers; and the reconciliation sweep finds an unmarked completed run exactly once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const transcript = vi.hoisted(() => ({ owner: '' }));
vi.mock('../../src/scheduler/jobTranscriptEvidence.js', () => ({
  findClaudeJobTranscript: vi.fn(() => null),
  readJobTranscriptEvidence: vi.fn(() => ''),
  renderJobReportForOwner: vi.fn(() => transcript.owner),
}));

import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobDefinition } from '../../src/core/types.js';

const job = (over: Partial<JobDefinition>): JobDefinition => ({
  slug: 'daily-report', name: 'Daily Report', description: 'd', schedule: '0 9 * * *', priority: 'medium',
  expectedDurationMinutes: 5, model: 'sonnet', enabled: true, execute: { type: 'prompt', value: 'report' }, ...over,
} as JobDefinition);

describe('JobScheduler → email reports', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let submitted: Array<{ executionId: string; subject: string; ownerText: string; topicText: string; reconcile?: boolean }>;
  let telegramSends: Array<{ topicId: number; text: string }>;

  const setUp = (jobs: JobDefinition[]) => {
    const jobsFile = createSampleJobsFile(project.stateDir, jobs);
    scheduler = new JobScheduler(
      { jobsFile, enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as any, project.state, project.stateDir,
    );
    scheduler.setTelegram({
      sendToTopic: async (topicId: number, text: string) => { telegramSends.push({ topicId, text }); return { messageId: telegramSends.length }; },
      findOrCreateForumTopic: async () => ({ topicId: 77 }),
      closeForumTopic: async () => undefined,
    } as any);
    scheduler.emailReports = { submitReport: (input) => { submitted.push(input); return `em-run-${input.executionId.slice(-8)}`.toLowerCase().replace(/[^a-z0-9-]/g, '0'); } };
  };

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    submitted = [];
    telegramSends = [];
    transcript.owner = '';
  });
  afterEach(() => { scheduler?.stop(); project.cleanup(); vi.clearAllMocks(); });

  async function complete(slug: string, opts: { output?: string; failed?: boolean } = {}) {
    scheduler.start();
    await scheduler.triggerJob(slug, 'test');
    await new Promise(r => setTimeout(r, 50));
    const session = mockSM._sessions[mockSM._sessions.length - 1];
    session.status = opts.failed ? 'failed' : 'completed';
    session.claudeSessionId = '83b5539f-a945-4ff5-ad8d-22b0d609e38c';
    project.state.saveSession(session);
    if (opts.output !== undefined) mockSM.captureOutput = (() => opts.output) as any;
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);
  }
  const lastRun = (slug: string) => new JobRunHistory(project.stateDir).query({ slug }).runs[0];

  it('emails the transcript’s final message, marks the run, and an email-only job sends nothing to Telegram', async () => {
    setUp([job({ deliver: ['email'], telegramNotify: true, topicId: 12 })]);
    transcript.owner = 'The full report: three things happened.';
    await complete('daily-report', { output: 'pane tail' });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ subject: 'Daily Report: Done', ownerText: 'The full report: three things happened.' });
    expect(submitted[0].topicText).toContain('The full report');
    expect(lastRun('daily-report').emailOutboxId).toMatch(/^em-run-/);
    expect(telegramSends).toHaveLength(0);
  });

  it('telegram and email: both', async () => {
    setUp([job({ deliver: ['telegram', 'email'], telegramNotify: true, topicId: 12 })]);
    transcript.owner = 'report';
    await complete('daily-report', { output: 'pane tail with content' });
    expect(submitted).toHaveLength(1);
    expect(telegramSends).toHaveLength(1);
  });

  it('Quiet by Default holds: a routine on-alert run is marked quiet and nothing is emailed', async () => {
    setUp([job({ deliver: ['email'] })]);
    transcript.owner = 'all fine';
    await complete('daily-report', { output: 'all fine' });
    expect(submitted).toHaveLength(0);
    expect(lastRun('daily-report').emailOutboxId).toBe('quiet');
  });

  it('an on-alert run that fails, or signals attention, is emailed', async () => {
    setUp([job({ deliver: ['email'] })]);
    transcript.owner = 'Something needs you.\n[ATTENTION]';
    await complete('daily-report', { output: '' });
    expect(submitted).toHaveLength(1);
  });

  it('with no transcript text the email carries the status line', async () => {
    setUp([job({ deliver: ['email'], telegramNotify: true })]);
    await complete('daily-report', { output: '' });
    expect(submitted[0].ownerText).toBe('Daily Report: Done');
  });

  it('the topic copy is redacted where the topic has other readers; the owner text is not', async () => {
    setUp([job({ deliver: ['email'], telegramNotify: true, topicId: 12 })]);
    scheduler.notifyDestinationHasOtherReaders = () => true;
    transcript.owner = 'private owner detail';
    await complete('daily-report', { output: 'x' });
    expect(submitted[0].ownerText).toBe('private owner detail');
    expect(submitted[0].topicText).not.toContain('private owner detail');
    expect(submitted[0].topicText).toContain('available to the agent owner');
  });

  it('an email-only job whose row was not written (no run id after a restart) still reaches Telegram', async () => {
    setUp([job({ deliver: ['email'], telegramNotify: true, topicId: 12 })]);
    scheduler.emailReports = { submitReport: () => null };
    transcript.owner = 'report';
    await complete('daily-report', { output: 'pane tail' });
    expect(telegramSends).toHaveLength(1);
  });

  it('a job without deliver never touches the email sender', async () => {
    setUp([job({ telegramNotify: true, topicId: 12 })]);
    await complete('daily-report', { output: 'some output' });
    expect(submitted).toHaveLength(0);
    expect(lastRun('daily-report').emailOutboxId).toBeUndefined();
    expect(telegramSends).toHaveLength(1);
  });

  it('the reconciliation sweep gives an unmarked completed run one status-line row, and never again', async () => {
    setUp([job({ deliver: ['email'], telegramNotify: true })]);
    const history = new JobRunHistory(project.stateDir);
    const runId = history.recordStart({ slug: 'daily-report', sessionId: 's1', trigger: 'scheduled' } as any);
    history.recordCompletion({ runId, result: 'success' });
    // The scheduler reads its own history instance; reload it from disk through a fresh scheduler.
    setUp([job({ deliver: ['email'], telegramNotify: true })]);
    scheduler.start();
    expect(scheduler.reconcileEmailReports(0)).toBe(1);
    expect(submitted[0]).toMatchObject({ reconcile: true, subject: 'Daily Report: Done' });
    expect(scheduler.reconcileEmailReports(0)).toBe(0);
  });

  it('deliverJobReport creates the topic lazily and is ok only on Telegram’s acknowledgment', async () => {
    setUp([job({})]);
    scheduler.start();
    const j = scheduler.getJobs()[0];
    expect(await scheduler.deliverJobReport(j, 'copy')).toEqual({ ok: true, messageId: 1 });
    expect(j.topicId).toBe(77);
    scheduler.setTelegram({ sendToTopic: async () => { throw new Error('down'); }, findOrCreateForumTopic: async () => { throw new Error('down'); } } as any);
    expect(await scheduler.deliverJobReport(j, 'copy')).toEqual({ ok: false });
  });
});
