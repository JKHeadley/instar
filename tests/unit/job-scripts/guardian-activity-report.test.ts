import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  calculateGuardianActivity, renderGuardianActivity,
} from '../../../src/scaffold/templates/jobs/instar/scripts/guardian-activity-report-script.mjs';

const saved = JSON.parse(readFileSync(new URL('../../fixtures/guardian-category-report.json', import.meta.url), 'utf8'));

describe('guardian activity report', () => {
  it('matches the saved category report and keeps missing per-job statistics visible', () => {
    const activity = calculateGuardianActivity(saved);
    expect([activity.jobs.length, activity.totalRuns, activity.totalFailures, activity.jobsSkipping]).toEqual([
      saved.summary.totalJobs, saved.summary.totalRuns, saved.summary.totalFailures, saved.summary.skipping,
    ]);
    const report = renderGuardianActivity(activity);
    expect(report).toContain('health-check (enabled): 278 runs, 1 failure, 0 consecutive failures, 9 skips (0 quota).');
    const unavailable = calculateGuardianActivity({ ...saved, jobs: [{ ...saved.jobs[0], stats: null }] });
    expect(renderGuardianActivity(unavailable)).toContain('run counts unavailable');
  });

  it('rejects an impossible quota skip count', () => {
    const job = { ...saved.jobs[0], skips: { total: 0, byReason: { quota: 1 } } };
    expect(() => calculateGuardianActivity({ ...saved, jobs: [job] })).toThrow('quota skips exceed skips');
  });

  it('ships disabled as a script job', () => {
    const template = new URL('../../../src/scaffold/templates/jobs/instar/guardian-activity-report-script.md', import.meta.url);
    const frontmatter = readFileSync(template, 'utf8').split('---')[1];
    expect(frontmatter).toMatch(/^enabled: false$/m);
    expect(frontmatter).toMatch(/^runner: script$/m);
  });
});
