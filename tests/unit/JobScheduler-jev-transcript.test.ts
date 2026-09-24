/**
 * Wiring: notifyJobComplete hands the Jev audit the job's TRANSCRIPT evidence
 * (the pane is gone at completion), falls back to the pane capture when no
 * transcript is found, and leaves run history on the pane capture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const transcript = vi.hoisted(() => ({ path: null as string | null, text: '' }));
vi.mock('../../src/scheduler/jobTranscriptEvidence.js', () => ({
  findClaudeJobTranscript: vi.fn(() => transcript.path),
  readJobTranscriptEvidence: vi.fn((p: string | null) => (p ? transcript.text : '')),
}));

import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { findClaudeJobTranscript } from '../../src/scheduler/jobTranscriptEvidence.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';

describe('JobScheduler → Jev audit transcript evidence', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let captured: Array<{ output: string }>;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    const jobsFile = createSampleJobsFile(project.stateDir);
    for (const slug of ['health-check', 'email-check']) {
      project.state.saveJobState({ slug, lastRun: new Date().toISOString(), lastResult: 'success', runCount: 1, consecutiveFailures: 0 });
    }
    scheduler = new JobScheduler(
      { jobsFile, enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as any, project.state, project.stateDir,
    );
    captured = [];
    scheduler.setJevAudit({ capture: (input: { output: string }) => { captured.push(input); } } as any);
    transcript.path = null;
    transcript.text = '';
  });

  afterEach(() => { scheduler?.stop(); project.cleanup(); vi.clearAllMocks(); });

  async function completeHealthCheck(claudeSessionId?: string, framework?: string) {
    scheduler.start();
    await scheduler.triggerJob('health-check', 'test');
    await new Promise(r => setTimeout(r, 50));
    const session = mockSM._sessions[mockSM._sessions.length - 1];
    session.status = 'completed';
    if (claudeSessionId) session.claudeSessionId = claudeSessionId;
    if (framework) session.framework = framework;
    project.state.saveSession(session);
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);
  }

  it('passes the transcript trace when the transcript is found', async () => {
    transcript.path = '/x/t.jsonl';
    transcript.text = '[job transcript: 1 tool step(s)]\n[step] $ df -h\n[final reply] fine';
    await completeHealthCheck('83b5539f-a945-4ff5-ad8d-22b0d609e38c');
    expect(captured).toHaveLength(1);
    expect(captured[0].output).toContain('[step] $ df -h');
    expect(findClaudeJobTranscript).toHaveBeenCalledWith('83b5539f-a945-4ff5-ad8d-22b0d609e38c', expect.any(String));
  });

  it('falls back to the pane capture when no transcript is found', async () => {
    await completeHealthCheck('83b5539f-a945-4ff5-ad8d-22b0d609e38c');
    expect(captured).toHaveLength(1);
    expect(captured[0].output).not.toContain('[job transcript');
  });

  it('does not look for a transcript without a session id', async () => {
    await completeHealthCheck(undefined);
    expect(findClaudeJobTranscript).not.toHaveBeenCalled();
  });

  it('does not look for a claude transcript for a codex job', async () => {
    transcript.path = '/x/t.jsonl';
    transcript.text = 'SHOULD-NOT-APPEAR';
    await completeHealthCheck('83b5539f-a945-4ff5-ad8d-22b0d609e38c', 'codex-cli');
    expect(findClaudeJobTranscript).not.toHaveBeenCalled();
    expect(captured[0].output).not.toContain('SHOULD-NOT-APPEAR');
  });
});
