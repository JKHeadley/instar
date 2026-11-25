import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  calculateCategoryActivity, renderCategoryActivity,
} from '../../../src/scaffold/templates/jobs/instar/scripts/guardian-activity-report-script.mjs';

const saved = JSON.parse(readFileSync(new URL('../../fixtures/guardian-category-report.json', import.meta.url), 'utf8'));

describe('guardian activity report', () => {
  it('matches the saved category report and keeps missing per-job statistics visible', () => {
    const activity = calculateCategoryActivity(saved, 'guardian');
    expect([activity.jobs.length, activity.totalRuns, activity.totalFailures, activity.jobsSkipping]).toEqual([
      saved.summary.totalJobs, saved.summary.totalRuns, saved.summary.totalFailures, saved.summary.skipping,
    ]);
    const report = renderCategoryActivity(activity);
    expect(report).toContain('health-check (enabled): 278 runs, 1 failure, 0 consecutive failures, 9 skips (0 quota).');
    const unavailable = calculateCategoryActivity({ ...saved, jobs: [{ ...saved.jobs[0], stats: null }] }, 'guardian');
    expect(renderCategoryActivity(unavailable)).toContain('run counts unavailable');
  });

  it('matches the saved maintenance category at its 48-hour window', () => {
    const maintenance = JSON.parse(readFileSync(new URL('../../fixtures/maintenance-category-report.json', import.meta.url), 'utf8'));
    const activity = calculateCategoryActivity(maintenance, 'maintenance');
    expect([activity.jobs.length, activity.totalRuns, activity.totalFailures, activity.jobsSkipping]).toEqual([
      maintenance.summary.totalJobs, maintenance.summary.totalRuns, maintenance.summary.totalFailures, maintenance.summary.skipping,
    ]);
    expect(renderCategoryActivity(activity)).toContain('12 jobs, 28 runs, 0 failures, 1 job with skips.');
    expect(() => calculateCategoryActivity(maintenance, 'guardian')).toThrow('invalid activity report');
  });

  it('matches the saved learning category at its 48-hour window', () => {
    const learning = JSON.parse(readFileSync(new URL('../../fixtures/learning-category-report.json', import.meta.url), 'utf8'));
    const activity = calculateCategoryActivity(learning, 'learning');
    expect([activity.jobs.length, activity.totalRuns, activity.totalFailures, activity.jobsSkipping]).toEqual([
      learning.summary.totalJobs, learning.summary.totalRuns, learning.summary.totalFailures, learning.summary.skipping,
    ]);
    expect(renderCategoryActivity(activity)).toContain('14 jobs, 41 runs, 0 failures, 7 jobs with skips.');
  });

  it('rejects an impossible quota skip count', () => {
    const job = { ...saved.jobs[0], skips: { total: 0, byReason: { quota: 1 } } };
    expect(() => calculateCategoryActivity({ ...saved, jobs: [job] }, 'guardian')).toThrow('quota skips exceed skips');
  });

  it('ships disabled as a script job', () => {
    const template = new URL('../../../src/scaffold/templates/jobs/instar/guardian-activity-report-script.md', import.meta.url);
    const frontmatter = readFileSync(template, 'utf8').split('---')[1];
    expect(frontmatter).toMatch(/^enabled: false$/m);
    expect(frontmatter).toMatch(/^runner: script$/m);
  });
});
