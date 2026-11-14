/**
 * CMT-1586 (fb-13940f65-ead) — full HTTP path for the runner a converted
 * built-in reports. On Echo, health-check was removed from
 * `jobs.scriptRunners.disabledSlugs`, yet `GET /jobs` kept showing
 * `runner: session-rollback` and a Haiku session ran every 5 minutes: the
 * code-owned audit gate held every first-wave slug except llm-decision-grading.
 * health-check makes no model call as a script (its triage is code-dark), so
 * it now joins the no-model allowlist. The fleet is unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { SCRIPT_RUNNER_FIRST_WAVE_DISABLED_SLUGS } from '../../src/config/ConfigDefaults.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('GET /jobs — health-check runner (integration)', () => {
  let project: TempProject;
  let scheduler: JobScheduler;
  let app: ReturnType<AgentServer['getApp']>;
  let agentConfig: Record<string, unknown> = {};
  const AUTH_TOKEN = 'health-check-runner-token';
  const auth = { Authorization: `Bearer ${AUTH_TOKEN}` };

  beforeAll(() => {
    project = createTempProject();
    const installed = installBuiltinJobs({ agentStateDir: project.stateDir, packageRoot: process.cwd(), port: 4042 });
    expect(installed.errors).toEqual([]);
    const jobsFile = path.join(project.stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]');
    const sm = createMockSessionManager();
    const schedulerConfig = {
      jobsFile, enabled: true, maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    };
    scheduler = new JobScheduler(schedulerConfig, sm as any, project.state, project.stateDir);
    scheduler.setConfigReader(() => agentConfig);
    scheduler.start();
    const config: InstarConfig = {
      projectName: 'health-check-runner', agentName: 'Runner Test', projectDir: project.dir,
      stateDir: project.stateDir, port: 0, authToken: AUTH_TOKEN, scheduler: schedulerConfig,
    };
    app = new AgentServer({ config, sessionManager: sm as any, state: project.state, scheduler }).getApp();
  });

  afterAll(() => {
    scheduler?.stop();
    project?.cleanup();
  });

  async function runnerOf(slug: string): Promise<unknown> {
    const res = await request(app).get('/jobs').set(auth);
    expect(res.status).toBe(200);
    const jobs = (res.body.jobs ?? res.body) as Array<{ slug: string; runner?: string }>;
    const job = jobs.find(j => j.slug === slug);
    expect(job, `${slug} listed`).toBeDefined();
    return job!.runner;
  }

  it('requires auth', async () => {
    expect((await request(app).get('/jobs')).status).toBe(401);
  });

  it('reports script once a development agent stops excluding health-check', async () => {
    agentConfig = {
      developmentAgent: true,
      jobs: { scriptRunners: { disabledSlugs: SCRIPT_RUNNER_FIRST_WAVE_DISABLED_SLUGS.filter(s => s !== 'health-check') } },
    };
    expect(await runnerOf('health-check')).toBe('script');
    // A later-wave slug the operator also removed still runs its session.
    agentConfig = { developmentAgent: true, jobs: { scriptRunners: { disabledSlugs: [] } } };
    expect(await runnerOf('health-check')).toBe('script');
    expect(await runnerOf('feedback-factory-process')).toBe('session-rollback');
  });

  it('reports session-rollback while health-check is still listed (the live rollback)', async () => {
    agentConfig = { developmentAgent: true, jobs: { scriptRunners: { disabledSlugs: ['health-check'] } } };
    expect(await runnerOf('health-check')).toBe('session-rollback');
  });

  it('keeps fleet agents on the session path', async () => {
    agentConfig = {};
    expect(await runnerOf('health-check')).toBe('session-rollback');
    agentConfig = { jobs: { scriptRunners: { disabledSlugs: [] } } };
    expect(await runnerOf('health-check')).toBe('session-rollback');
  });
});
