// safe-fs-allow: temporary fixture cleanup uses SafeFsExecutor.
/** Production boot path: AgentServer, real scheduler journal and real quality ledger. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('scheduled grade-pass idle proof lifecycle', () => {
  let dir: string;
  let server: AgentServer;
  let scheduler: JobScheduler;
  const auth = 'e2e-idle-proof';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-idle-proof-e2e-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]');
    const state = new StateManager(stateDir);
    const sessions = { listRunningSessions: () => [], getSession: () => null };
    scheduler = new JobScheduler({ jobsFile, enabled: false, maxParallelJobs: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, sessions as any, state, stateDir);
    const config = { projectName: 'idle-proof-e2e', projectDir: dir, stateDir, port: 0,
      authToken: auth, requestTimeoutMs: 10000, version: '0.0.0', developmentAgent: true,
      provenance: { uniformSeam: { enabled: true, dryRun: false } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30,
        protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile, maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: sessions as any, state, scheduler });
    await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    scheduler?.stop();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true,
      operation: 'tests/e2e/job-grade-pass-idle-proof-alive.test.ts' });
  });

  it('mints a proof only through the authenticated scheduled run and keeps model rollout off', async () => {
    const token = 'a'.repeat(64);
    const store = scheduler.getJobSupervisionStore();
    store.register({ runId: 'e2e-idle-run', fireId: 'e2e-idle-fire', slug: 'llm-decision-grading',
      evidencePolicy: 'job-result-structured-v2',
      receiptTokenHash: crypto.createHash('sha256').update(token).digest('hex') });
    const app = server.getApp();
    expect((await request(app).post('/decision-quality/grade-pass').send({})).status).toBe(401);
    const result = await request(app).post('/decision-quality/grade-pass')
      .set('Authorization', `Bearer ${auth}`)
      .set('X-Instar-Job-Run-Id', 'e2e-idle-run')
      .set('X-Instar-Job-Receipt-Token', token).send({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.graded).toBe(0);
    expect(store.gradePassIdleProof('e2e-idle-run')?.ruleId).toBe('grade-pass-idle-effects-v1');
    const triage = await request(app).get('/jobs/triage').set('Authorization', `Bearer ${auth}`);
    expect(triage.body.supervision.rollout).toMatchObject({ auditReady: false, cohort: 'off', active: false });
  });
});
