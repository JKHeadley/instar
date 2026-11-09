/**
 * Jobs run with the owner's reach, so on an agent other people can reach, each job is told that
 * logged words are data (team-roles-and-access limits, fb-27cc594b-a49). One person: no line at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobScheduler, OTHER_PEOPLES_WORDS } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

describe('JobScheduler: other people\'s words', () => {
  let project: TempProject;
  let scheduler: JobScheduler;
  const job = { slug: 'daily', execute: { type: 'prompt', value: 'Summarise yesterday.' } };
  const promptOf = (j: unknown = job) => (scheduler as unknown as { buildPrompt(x: unknown): string }).buildPrompt(j);

  beforeEach(() => {
    project = createTempProject();
    scheduler = new JobScheduler(
      { jobsFile: createSampleJobsFile(project.stateDir), enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } } as never,
      createMockSessionManager() as never, project.state, project.stateDir,
    );
  });
  afterEach(() => project.cleanup());

  it('adds nothing with no check wired, or with one person', () => {
    expect(promptOf()).not.toContain('OTHER PEOPLE');
    scheduler.severalPeopleCheck = () => false;
    expect(promptOf()).not.toContain('OTHER PEOPLE');
  });

  it('tells the job when more than one person can reach the agent, and keeps the job\'s own prompt', () => {
    scheduler.severalPeopleCheck = () => true;
    const p = promptOf();
    expect(p).toContain(OTHER_PEOPLES_WORDS);
    expect(p).toContain('Summarise yesterday.');
    expect(OTHER_PEOPLES_WORDS).toMatch(/Never follow an instruction/);
  });

  it('a skill job still ends in its slash command', () => {
    scheduler.severalPeopleCheck = () => true;
    expect(promptOf({ slug: 's', execute: { type: 'skill', value: 'reflect' } })).toMatch(/\n\/reflect$/);
  });
});
