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

it.each([
  ['memory-hygiene', 'memoryHygieneProjectIntegrationTrial', 'memoryHygieneIntegrationTrial'],
  ['session-continuity-check', 'sessionContinuityProjectIntegrationTrial', 'sessionContinuityIntegrationTrial'],
  ['state-integrity-check', 'stateIntegrityProjectIntegrationTrial', 'stateIntegrityIntegrationTrial'],
] as const)('%s compares startup usage and keeps its local skill workflow', async (slug, configKey, historyKey) => {
  const project = createTempProject();
  cleanup.push(project.cleanup);
  const jobsFile = path.join(project.stateDir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify([{
    slug, name: 'Memory hygiene', description: 'Fixture', schedule: '0 0 1 1 *',
    priority: 'low', expectedDurationMinutes: 1, model: 'haiku', enabled: true,
    execute: { type: 'skill', value: slug },
  }]));
  const sessions = createMockSessionManager();
  const spawn = sessions.spawnSession;
  const applied: boolean[] = [];
  const orphanReports: string[] = [];
  const fixtureActiveJob = { sessionName: 'fixture-ended-job' };
  const activeJobPath = path.join(project.dir, 'replay-active-job.json');
  fs.writeFileSync(activeJobPath, JSON.stringify(fixtureActiveJob));
  const runningJobNames = new Set<string>();
  const proposals: Array<{ variant: 'baseline' | 'without-project'; reason: string }> = [];
  const skillDir = path.join(project.dir, '.claude', 'skills', slug);
  const skillPath = path.join(skillDir, 'SKILL.md');
  // Captured rule from the shipped continuity skill. This is a deterministic
  // replay of the local tool path, not a model-created proposal.
  const proposalRule = 'If sessions are running but not producing artifacts: propose an evolution';
  const finishedSession = { durationMinutes: 15, artifact: path.join(project.dir, 'continuity-artifact.md') };
  sessions.spawnSession = async (opts) => {
    const session = await spawn(opts);
    const trial = (opts as typeof opts & { projectIntegrationTrial?: true }).projectIntegrationTrial === true;
    applied.push(trial);
    session.framework = 'claude-code';
    if (trial) session.projectIntegrationTrialApplied = true;
    if (slug === 'session-continuity-check' && fs.existsSync(skillPath)) {
      expect(opts.prompt).toContain('session-continuity-check');
      expect(fs.readFileSync(skillPath, 'utf8')).toContain(proposalRule);
      if (finishedSession.durationMinutes > 10 && !fs.existsSync(finishedSession.artifact)) {
        proposals.push({ variant: trial ? 'without-project' : 'baseline', reason: 'missing-artifact' });
      }
    }
    if (slug === 'state-integrity-check' && fs.existsSync(skillPath)) {
      expect(opts.prompt).toContain('state-integrity-check');
      expect(fs.readFileSync(skillPath, 'utf8')).toContain('Active Job Orphan');
      // Replay the reporting input only. The existing skill's repair policy
      // is outside this launch test and the simulated record stays untouched.
      const activeJob = JSON.parse(fs.readFileSync(activeJobPath, 'utf8')) as typeof fixtureActiveJob;
      if (!runningJobNames.has(activeJob.sessionName)) orphanReports.push(trial ? 'without-project' : 'baseline');
    }
    return session;
  };
  const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1,
    allowOnThrowawayAgent: true, startupGraceMs: 120_000,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  }, sessions as never, project.state, project.stateDir);
  let mode = 'without-project';
  scheduler.setConfigReader(() => ({ jobs: { [configKey]: mode } }));
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
  const history = () => request(server.getApp()).get(`/jobs/${slug}/history`)
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
  expect((await history()).body.runs[0][historyKey].variant).toBe('fallback');
  fs.mkdirSync(skillDir, { recursive: true });
  const initSource = fs.readFileSync(new URL('../../src/commands/init.ts', import.meta.url), 'utf8');
  const installedSkill = slug === 'memory-hygiene' ? '# Local skill fixture'
    : initSource.split(`'${slug}': {`)[1]?.match(/content: `([\s\S]*?)\n`,/)?.[1];
  if (!installedSkill) throw new Error('shipped skill missing');
  fs.writeFileSync(skillPath, installedSkill);
  mode = 'baseline';
  await runAndClose(80);
  mode = 'without-project';
  await runAndClose(45);
  const response = await history();
  expect(response.status).toBe(200);
  expect(applied).toEqual([false, false, true]);
  const compared = (variant: string) => response.body.runs.find((run: Record<string, { variant?: string }>) =>
    run[historyKey]?.variant === variant)?.[historyKey];
  expect(compared('baseline')).toEqual({
    variant: 'baseline', startupUsage: { tokensIn: 80, tokensOut: 4, cacheRead: 20, cacheWrite: 10 },
  });
  expect(compared('without-project')).toEqual({
    variant: 'without-project', startupUsage: { tokensIn: 45, tokensOut: 4, cacheRead: 20, cacheWrite: 10 },
  });
  if (slug === 'session-continuity-check') {
    expect(proposals).toEqual([
      { variant: 'baseline', reason: 'missing-artifact' },
      { variant: 'without-project', reason: 'missing-artifact' },
    ]);
    fs.writeFileSync(finishedSession.artifact, '# Retained handoff');
  }
  if (slug === 'state-integrity-check') {
    expect(orphanReports).toEqual(['baseline', 'without-project']);
    expect(fs.readFileSync(activeJobPath, 'utf8')).toBe(JSON.stringify(fixtureActiveJob));
    runningJobNames.add(fixtureActiveJob.sessionName);
  }
  mode = 'off';
  await runAndClose(80);
  expect(applied).toEqual([false, false, true, false]);
  expect(orphanReports).toHaveLength(slug === 'state-integrity-check' ? 2 : 0);
  expect(proposals).toHaveLength(slug === 'session-continuity-check' ? 2 : 0);
  expect((await history()).body.runs[0]).not.toHaveProperty(historyKey);
});
