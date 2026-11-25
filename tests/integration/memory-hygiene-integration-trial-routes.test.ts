import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createMockSessionManager, createTempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

it.each([
  ['memory-hygiene', 'memoryHygieneIntegrationTrial'],
  ['session-continuity-check', 'sessionContinuityIntegrationTrial'],
] as const)('%s history shows unknown usage for an absent transcript', async (slug, trialKey) => {
  const project = createTempProject();
  cleanup.push(project.cleanup);
  const sessions = createMockSessionManager();
  const scheduler = new JobScheduler({ jobsFile: '', enabled: false, maxParallelJobs: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  }, sessions as never, project.state, project.stateDir);
  const config = { projectName: 'memory-trial-routes', projectDir: project.dir, stateDir: project.stateDir,
    port: 0, authToken: 'memory-trial-routes', scheduler: { enabled: false }, monitoring: {}, messaging: [],
  } as InstarConfig;
  const server = new AgentServer({ config, state: project.state, scheduler, sessionManager: sessions as never });
  cleanup.push(() => server.stop());
  scheduler.getRunHistory().recordStart({ slug, sessionId: 'job-fixture', trigger: 'scheduled',
    [trialKey]: { variant: 'fallback', nativeSessionId: 'internal-binding' } });
  const endpoint = `/jobs/${slug}/history`;
  expect((await request(server.getApp()).get(endpoint)).status).toBe(401);
  const response = await request(server.getApp()).get(endpoint).set('Authorization', 'Bearer memory-trial-routes');
  expect(response.status).toBe(200);
  expect(response.body.runs[0][trialKey]).toEqual({ variant: 'fallback', startupUsage: null });
  expect(response.body.stats.lastRun[trialKey]).toEqual({ variant: 'fallback', startupUsage: null });
  expect(JSON.stringify(response.body)).not.toContain('internal-binding');
});
