/**
 * E2E: job-mode instructions (docs/specs/job-mode-instructions.md) on the production path — real
 * AgentServer, real scheduler, real SessionManager in tmux, a mock claude binary that logs argv.
 * A job opted in by override launches with the job-mode flags; the API reports it; after the run
 * the transcript check records unknown (the mock writes no transcript) and never suppresses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import { createMockClaude, waitFor } from '../helpers/setup.js';
import type { InstarConfig, JobDefinition } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

describeMaybe('E2E: job-mode instructions lifecycle', () => {
  let projectDir: string;
  let stateDir: string;
  let sessionManager: SessionManager;
  let scheduler: JobScheduler;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'e2e-job-mode-token';
  const auth = { Authorization: `Bearer ${AUTH}` };

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-jobmode-'));
    stateDir = path.join(projectDir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs', 'ledger']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'e2e-jobmode', port: 0, authToken: AUTH, developmentAgent: true,
      scheduler: { enabled: true, maxParallelJobs: 2, instructionsOverrides: { 'user:jm-job': 'job-mode' } },
    }, null, 2));
    const jobs: JobDefinition[] = [
      { slug: 'jm-job', name: 'JM', description: 'JM', schedule: '0 0 1 1 *', priority: 'high', expectedDurationMinutes: 1, model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'Quick test' } },
      { slug: 'full-job', name: 'F', description: 'F', schedule: '0 0 1 1 *', priority: 'high', expectedDurationMinutes: 1, model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'Quick test' } },
    ];
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
    const mockClaudePath = createMockClaude(projectDir);
    // Like the real binary, answer --version (an unreadable version launches full, by design).
    const mockBody = fs.readFileSync(mockClaudePath, 'utf8');
    fs.writeFileSync(mockClaudePath, mockBody.replace('#!/bin/bash\n', '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "2.1.330 (Claude Code)"; exit 0; fi\n'));
    const state = new StateManager(stateDir);
    for (const slug of ['jm-job', 'full-job']) state.saveJobState({ slug, lastRun: new Date().toISOString(), lastResult: 'success', runCount: 1, consecutiveFailures: 0 });
    sessionManager = new SessionManager({
      tmuxPath: tmuxPath!, claudePath: mockClaudePath, projectDir, maxSessions: 5, protectedSessions: [], completionPatterns: ['Session ended'],
    }, state);
    scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } }, sessionManager, state, stateDir);
    scheduler.start();
    sessionManager.startMonitoring(500);
    sessionManager.on('sessionComplete', (session) => { scheduler.notifyJobComplete(session.id, session.tmuxSession); });
    const config: InstarConfig = { projectName: 'e2e-jobmode', projectDir, stateDir, port: 0, authToken: AUTH };
    server = new AgentServer({ config, sessionManager, state, scheduler });
    app = server.getApp();
  }, 30_000);

  afterAll(async () => {
    scheduler?.stop();
    sessionManager?.stopMonitoring?.();
    await server?.stop();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/job-mode-instructions-lifecycle.test.ts' });
  });

  it('the feature is alive: the status route answers 200 with the configured mode', async () => {
    const res = await request(app).get('/jobs/jm-job/job-mode').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: 'job-mode', source: 'override' });
    expect((await request(app).get('/jobs/full-job/job-mode').set(auth)).body).toMatchObject({ configured: 'full' });
  });

  it('an opted-in job launches with the job-mode flags; the run is checked and an unreadable transcript stays unknown', async () => {
    const argvLog = path.join(projectDir, 'mock-claude-argv.log');
    await request(app).post('/jobs/jm-job/trigger').set(auth).send({});
    await waitFor(() => fs.existsSync(argvLog) && fs.readFileSync(argvLog, 'utf8').includes('JOB-MODE-MARKER instar '), 20_000);
    const argv = fs.readFileSync(argvLog, 'utf8');
    expect(argv).toContain('--append-system-prompt');
    expect(argv).toContain('"autoMemoryEnabled":false');
    const checkFile = path.join(stateDir, 'state', 'job-mode-checks', 'user_jm-job.json');
    await waitFor(() => fs.existsSync(checkFile) && JSON.parse(fs.readFileSync(checkFile, 'utf8')).unknownAttempts >= 1, 30_000);
    const check = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
    expect(check.suppressed).toBe(false);
  }, 60_000);
});
