import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createMockSessionManager, createTempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

it('compares actual startup usage and falls back when the installed skill is missing', async () => {
  const project = createTempProject();
  cleanup.push(project.cleanup);
  const slug = 'memory-hygiene';
  const jobsFile = path.join(project.stateDir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify([{
    slug, name: 'Memory hygiene', description: 'Fixture', schedule: '0 0 1 1 *',
    priority: 'low', expectedDurationMinutes: 1, model: 'haiku', enabled: true,
    execute: { type: 'skill', value: slug },
  }]));
  const sessions = createMockSessionManager();
  const spawn = sessions.spawnSession;
  const applied: boolean[] = [];
  sessions.spawnSession = async (opts) => {
    const session = await spawn(opts);
    const trial = (opts as typeof opts & { memoryHygieneIntegrationTrial?: true }).memoryHygieneIntegrationTrial === true;
    applied.push(trial);
    session.framework = 'claude-code';
    if (trial) session.memoryHygieneIntegrationTrialApplied = true;
    return session;
  };
  const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1,
    allowOnThrowawayAgent: true, startupGraceMs: 120_000,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  }, sessions as never, project.state, project.stateDir);
  let mode = 'without-project';
  scheduler.setConfigReader(() => ({ jobs: { memoryHygieneProjectIntegrationTrial: mode } }));
  scheduler.start();
  cleanup.push(() => scheduler.stop());
  const config = { projectName: 'memory-hygiene-trial-fixture', projectDir: project.dir,
    stateDir: project.stateDir, port: 0, authToken: 'memory-hygiene-trial-fixture',
    scheduler: { enabled: false }, monitoring: {}, messaging: [] } as InstarConfig;
  const server = new AgentServer({ config, state: project.state, scheduler, sessionManager: sessions as never });
  cleanup.push(() => server.stop());
  await server.start();
  const ledger = server.getTokenLedger();
  if (!ledger) throw new Error('fixture token ledger unavailable');
  const history = () => request(server.getApp()).get('/jobs/memory-hygiene/history')
    .set('Authorization', 'Bearer memory-hygiene-trial-fixture');
  async function runAndClose(tokens: number) {
    const result = await scheduler.triggerJob(slug, 'scheduled');
    const skip = result === 'skipped' ? project.state.queryEvents({ type: 'job_skipped', limit: 1 })[0]?.summary : undefined;
    expect(result, skip).toBe('triggered');
    await new Promise<void>(resolve => setImmediate(resolve));
    const session = sessions._sessions.at(-1);
    if (!session) throw new Error('fixture session was not launched');
    const transcriptId = 'transcript-' + session.id;
    session.claudeSessionId = transcriptId;
    ledger!.recordEvent({ requestId: transcriptId, sessionId: transcriptId, ts: Date.now(),
      inputTokens: tokens, outputTokens: 4, cacheCreationTokens: 10, cacheReadTokens: 20, model: 'haiku' });
    session.status = 'completed';
    project.state.saveSession(session);
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);
  }

  await runAndClose(90);
  expect((await history()).body.runs[0].memoryHygieneIntegrationTrial.variant).toBe('fallback');
  const skillDir = path.join(project.dir, '.claude', 'skills', slug);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Local skill fixture');
  mode = 'baseline';
  await runAndClose(80);
  mode = 'without-project';
  await runAndClose(45);
  const response = await history();
  expect(response.status).toBe(200);
  expect(applied).toEqual([false, false, true]);
  const compared = (variant: string) => response.body.runs.find((run: {
    memoryHygieneIntegrationTrial?: { variant: string };
  }) => run.memoryHygieneIntegrationTrial?.variant === variant)?.memoryHygieneIntegrationTrial;
  expect(compared('baseline')).toEqual({
    variant: 'baseline', startupUsage: { tokensIn: 80, tokensOut: 4, cacheRead: 20, cacheWrite: 10 },
  });
  expect(compared('without-project')).toEqual({
    variant: 'without-project', startupUsage: { tokensIn: 45, tokensOut: 4, cacheRead: 20, cacheWrite: 10 },
  });
  mode = 'off';
  await runAndClose(80);
  expect(applied).toEqual([false, false, true, false]);
  expect((await history()).body.runs[0]).not.toHaveProperty('memoryHygieneIntegrationTrial');
});
