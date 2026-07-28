import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('JobRunHistory budget outcome integration', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'job budget integration cleanup' });
  });

  it('persists and re-aggregates capped outcomes across process-shaped instances', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-budget-integration-'));
    dirs.push(stateDir);

    for (let i = 0; i < 4; i++) {
      const history = new JobRunHistory(stateDir);
      const runId = history.recordStart({ slug: 'large-output', sessionId: `session-${i}`, trigger: 'scheduled' });
      history.recordCompletion({ runId, result: 'failure', error: `HEAD-${'x'.repeat(4000)}-TAIL-${i}` });
    }

    const reopened = new JobRunHistory(stateDir);
    const stats = reopened.stats('large-output');
    expect(stats.totalRuns).toBe(4);
    expect(stats.budgetCondensedRuns).toBe(4);
    for (const run of reopened.query({ slug: 'large-output', limit: 10 }).runs) {
      expect(run.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(run), 'utf8')).toBeLessThanOrEqual(2048);
      expect(run.error).toContain('HEAD-');
      expect(run.error).toContain('-TAIL-');
    }
  });
});
