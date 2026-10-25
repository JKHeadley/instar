import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WindowRunLivenessAuthority, WindowRunLivenessStore } from '../../src/core/WindowRunLivenessAuthority.js';
import { WindowRunCadenceExecutor, WindowRunCadenceStore } from '../../src/core/WindowRunCadenceExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';

describe('window run liveness HTTP integration', () => {
  const token = 'w32-liveness-integration';
  const now = '2026-09-05T20:00:00.000Z';
  let project: TempProject;
  let server: AgentServer;

  beforeAll(async () => {
    project = createTempProject();
    const store = new WindowRunLivenessStore(project.stateDir);
    const authority = new WindowRunLivenessAuthority(store, {
      now: () => now,
      sample: state => ({
        sampledAt: now,
        executor: { id: state.executorId, running: true, heartbeatAt: now },
        deliveryReachable: true,
        work: state.lastWorkReceipt ?? null,
        lifecycle: { lifecycleRunId: state.lifecycleRunId, state: 'active_start', admitted: true, expiresAt: '2026-09-06T20:00:00.000Z' },
      }),
      verifyWorkArtifact: (_state, input) => ({ artifact: input.artifactRef, digest: 'b'.repeat(64), taskRef: 'task-1' }),
    }, { enabled: true, dryRun: true });
    const config: InstarConfig = {
      projectName: 'w32-integration', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token,
      requestTimeoutMs: 5000, version: '1.3.1223',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    };
    const cadence = new WindowRunCadenceExecutor(new WindowRunCadenceStore(project.stateDir), {
      now: () => now, getLiveness: () => authority.status().state, resolveFirstUnreceiptedTask: () => 'task-1',
    }, { enabled: true, dryRun: true });
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: project.state, windowRunLivenessAuthority: authority, windowRunCadenceExecutor: cadence });
    await server.start();
  });

  afterAll(async () => { await server.stop(); project.cleanup(); });
  const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`).set('X-Instar-AgentId', 'w32-integration');
  const binding = { windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: 'lifecycle-w32', executorId: 'echo-topic-36966' };

  it('keeps predicate facts out of both mutation boundaries', async () => {
    const legacy = await auth(request(server.getApp()).post('/autonomous/register')).send({ topicId: 100, condition: 'legacy start', workDir: project.dir, sessionId: 'session-100' }).expect(200);
    expect(legacy.body).toMatchObject({ initialStatus: 'active', preparationRequired: false });
    await auth(request(server.getApp()).post('/window-run-liveness/register')).send({ ...binding, heartbeatAt: now }).expect(400);
    await auth(request(server.getApp()).post('/window-run-liveness/register')).send(binding).expect(201);
    await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, taskRef: 'task-1', artifactRef: 'src/a.ts', digest: 'b'.repeat(64) }).expect(400);
  });

  it('mints a receipt, evaluates all five predicates, and exposes durable state', async () => {
    const minted = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'src/a.ts' }).expect(201);
    expect(minted.body.receipt).toMatchObject({ sequence: 1, observedAt: now, digest: 'b'.repeat(64), taskRef: 'task-1' });
    const active = await auth(request(server.getApp()).post('/window-run-liveness/tick')).send({}).expect(200);
    expect(active.body.status).toBe('active');
    expect(Object.values(active.body.predicates).every((entry: any) => entry.ok)).toBe(true);
    const status = await auth(request(server.getApp()).get('/window-run-liveness')).expect(200);
    expect(status.body.state.lastWorkReceipt.receiptId).toBe(minted.body.receipt.receiptId);
    expect(fs.existsSync(path.join(project.stateDir, 'window-run-liveness', 'state.json'))).toBe(true);
    await auth(request(server.getApp()).post('/window-run-liveness/cadence/tick')).send({}).expect(200);
    const cadence = await auth(request(server.getApp()).get('/window-run-liveness/cadence')).expect(200);
    expect(cadence.body).toMatchObject({ enabled: true, dryRun: true, config: { receiptIntervalMs: 1_800_000, reportIntervalMs: 10_800_000 }, state: { windowId: 'w32', autonomousRunId: 'run-w32' } });
    expect(fs.existsSync(path.join(project.stateDir, 'window-run-cadence', 'state.json'))).toBe(true);
  });
});
