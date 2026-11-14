/**
 * CMT-1610 production-shaped lifecycle: the shipped health-check script job,
 * a server that died mid-run (pending history + attempt, plus the hold the
 * pre-fix census wrote), then a fresh scheduler + AgentServer. GET /jobs must
 * report health-check on its script runner (not session-rollback), the
 * interrupted run is settled as failed, and the hold release is on record.
 * The release route is alive (not 503) and audited through the real server.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const token = 'e2e-interrupted-run';
const devCfg = () => ({ developmentAgent: true, jobs: { scriptRunners: { enabled: true, disabledSlugs: [] } } });

function boot(projectDir: string) {
  const stateDir = path.join(projectDir, '.instar');
  const jobsFile = path.join(stateDir, 'jobs.json');
  const state = new StateManager(stateDir);
  const sessions = createMockSessionManager();
  const scheduler = new JobScheduler({
    jobsFile, enabled: true, maxParallelJobs: 2, authToken: token, projectName: 'interrupted-e2e', port: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  }, sessions as any, state, stateDir);
  scheduler.setScriptStartOffsetEnabled(false);
  scheduler.setConfigReader(devCfg);
  scheduler.start();
  const config: InstarConfig = { projectName: 'interrupted-e2e', projectDir, stateDir, port: 0, authToken: token };
  const server = new AgentServer({ config, sessionManager: sessions as any, state, scheduler });
  return { scheduler, server, sessions };
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe('interrupted script run lifecycle (CMT-1610)', () => {
  it('a restart after an interrupted health-check run keeps it on the script runner', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-interrupted-e2e-'));
    cleanup.push(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/job-supervision-interrupted-run-lifecycle.test.ts' }));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), '[]');
    const installed = installBuiltinJobs({ agentStateDir: stateDir, packageRoot: process.cwd(), port: 1 });
    expect(installed.errors).toEqual([]);

    // The process that dies mid-run.
    const first = boot(projectDir);
    const store0 = first.scheduler.getJobSupervisionStore();
    const runId = first.scheduler.getRunHistory().recordStart({
      slug: 'health-check', sessionId: 'script-health-check-x', trigger: 'retry:error', origin: 'instar', runner: 'script', tokens: 0,
    });
    const attemptId = store0.register({ runId, fireId: `local:${runId}`, slug: 'health-check', evidencePolicy: 'job-result-structured-v2' });
    store0.markUnchecked(attemptId, 'outcome-unknown');
    store0.holdSlug('health-check', 'independent-history-mismatch');
    await first.server.stop();
    store0.close();
    first.scheduler.stop();

    // The restarted server, well after the interrupted run's longest lifetime.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    const next = boot(projectDir);
    cleanup.push(async () => { await next.server.stop(); next.scheduler.stop(); });
    const app = next.server.getApp();
    const jobs = await request(app).get('/jobs').set('Authorization', `Bearer ${token}`);
    expect(jobs.status).toBe(200);
    const list = (Array.isArray(jobs.body) ? jobs.body : jobs.body.jobs) as Array<{ slug: string; runner: string }>;
    expect(list.find(j => j.slug === 'health-check')?.runner).toBe('script');

    expect(next.scheduler.getRunHistory().findRun(runId)).toMatchObject({ result: 'failure', error: expect.stringMatching(/^interrupted/) });
    const hold = await request(app).get('/jobs/health-check/supervision-hold').set('Authorization', `Bearer ${token}`);
    expect(hold.status).toBe(200);
    expect(hold.body.hold).toBeNull();
    expect(hold.body.releases[0]).toMatchObject({ holdReason: 'independent-history-mismatch', releasedBy: 'census' });

    // The release route is alive and audited on the real server.
    next.scheduler.getJobSupervisionStore().holdSlug('health-check', 'write-failed:disk-full');
    const released = await request(app).post('/jobs/health-check/supervision-hold/release')
      .set('Authorization', `Bearer ${token}`).send({ reason: 'ledger writable again' });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ released: true, hold: { reason: 'write-failed:disk-full' }, releasedBy: 'agent' });
    expect(next.sessions._spawnCount).toBe(0);
  });
});
