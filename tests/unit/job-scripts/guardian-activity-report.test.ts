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

  it('matches the saved infrastructure category at its 48-hour window', () => {
    const infrastructure = JSON.parse(readFileSync(new URL('../../fixtures/infrastructure-category-report.json', import.meta.url), 'utf8'));
    const activity = calculateCategoryActivity(infrastructure, 'infrastructure');
    expect([activity.jobs.length, activity.totalRuns, activity.totalFailures, activity.jobsSkipping]).toEqual([
      infrastructure.summary.totalJobs, infrastructure.summary.totalRuns, infrastructure.summary.totalFailures, infrastructure.summary.skipping,
    ]);
    expect(renderCategoryActivity(activity)).toContain('8 jobs, 967 runs, 34 failures, 3 jobs with skips.');
  });

  it('reports an explicitly empty category and rejects an incomplete response for one with jobs', () => {
    const checkedAt = '2026-11-25T14:29:13.124Z';
    const empty = { category: 'infrastructure', jobs: [], summary: { totalJobs: 0, healthy: 0, failing: 0, skipping: 0 } };
    const activity = calculateCategoryActivity(empty, 'infrastructure', checkedAt);
    const report = renderCategoryActivity(activity);
    expect(report).toContain('48-hour counts as of 2026-11-25T14:29:13.124Z.');
    expect(report).toContain('0 jobs, 0 runs, 0 failures, 0 jobs with skips.');
    expect(() => calculateCategoryActivity({ ...empty, jobs: saved.jobs }, 'infrastructure', checkedAt))
      .toThrow('invalid activity report');
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
