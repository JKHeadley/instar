import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createMockSessionManager, createTempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

it('preserves older rows and never substitutes usage from another run of the same job', async () => {
  const project = createTempProject();
  cleanup.push(project.cleanup);
  const sessions = createMockSessionManager();
  const scheduler = new JobScheduler({ jobsFile: '', enabled: false, maxParallelJobs: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  }, sessions as never, project.state, project.stateDir);
  const config = { projectName: 'development-review-routes', projectDir: project.dir,
    stateDir: project.stateDir, port: 0, authToken: 'development-review-routes',
    scheduler: { enabled: false }, monitoring: {}, messaging: [] } as InstarConfig;
  const server = new AgentServer({ config, state: project.state, scheduler, sessionManager: sessions as never });
  cleanup.push(() => server.stop());
  const slug = 'overseer-development';
  const history = scheduler.getRunHistory();
  const oldRun = history.recordStart({ slug, sessionId: 'old-run', trigger: 'scheduled' });
  const newRun = history.recordStart({ slug, sessionId: 'new-run', trigger: 'scheduled',
    developmentReviewObservation: { wouldSkip: false, nativeSessionId: 'unknown-native' } });
  const ledger = server.getTokenLedger();
  if (!ledger) throw new Error('fixture token ledger unavailable');
  ledger.recordJobSession('unrelated-native', slug, null, Date.now());
  ledger.recordEvent({ requestId: 'unrelated-usage', sessionId: 'unrelated-native',
    ts: Date.now(), inputTokens: 99, outputTokens: 3, model: 'haiku' });

  const response = await request(server.getApp()).get(`/jobs/${slug}/history`)
    .set('Authorization', 'Bearer development-review-routes');
  expect(response.status).toBe(200);
  const oldRow = response.body.runs.find((row: { runId: string }) => row.runId === oldRun);
  expect(oldRow).toMatchObject({ runId: oldRun, sessionId: 'old-run' });
  expect(oldRow).not.toHaveProperty('developmentReviewObservation');
  expect(response.body.runs.find((row: { runId: string }) => row.runId === newRun))
    .toMatchObject({ developmentReviewObservation: { wouldSkip: false, actualUsage: null } });
  expect(JSON.stringify(response.body)).not.toContain('unknown-native');
});
