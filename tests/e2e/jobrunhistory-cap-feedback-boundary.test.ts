import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('JobRunHistory cap to feedback boundary', () => {
  const dirs: string[] = [];
  afterEach(() => {
    DegradationReporter.resetForTesting();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'job cap e2e cleanup' });
  });

  it('never forwards successful budget enforcement after restart or elapsed legacy window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T20:00:00.000Z'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-cap-feedback-e2e-'));
    dirs.push(stateDir);
    const submitted: unknown[] = [];
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir, agentName: 'e2e-agent', instarVersion: 'test' });
    reporter.connectDownstream({ feedbackSubmitter: async (feedback) => { submitted.push(feedback); } });

    for (let i = 0; i < 3; i++) {
      const history = new JobRunHistory(stateDir);
      const runId = history.recordStart({ slug: 'dashboard-link-refresh', sessionId: `session-${i}`, trigger: 'scheduled' });
      history.recordCompletion({ runId, result: 'failure', error: `BEGIN-${'z'.repeat(3500)}-END-${i}` });
      vi.advanceTimersByTime(61 * 60 * 1000);
    }
    await Promise.resolve();

    expect(reporter.getEvents()).toEqual([]);
    expect(submitted).toEqual([]);
    expect(new JobRunHistory(stateDir).stats('dashboard-link-refresh').budgetCondensedRuns).toBe(3);
  });
});
