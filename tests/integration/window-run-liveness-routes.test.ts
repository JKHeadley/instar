import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WindowRunLivenessAuthority, WindowRunLivenessStore } from '../../src/core/WindowRunLivenessAuthority.js';
import { WindowRunCadenceExecutor, WindowRunCadenceStore } from '../../src/core/WindowRunCadenceExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer, selectWindowWorkTask } from '../../src/server/AgentServer.js';
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
      verifyWorkArtifact: (state, input) => {
        const content = '---\nrun_id: "run-w32"\n---\n\n- [ ] Implement fix\n- [ ] Verify fix\n';
        const used = new Set(state.audit.entries.filter(entry => entry.kind === 'work-receipt' && entry.workReceipt).map(entry => entry.workReceipt!.taskRef));
        const taskRef = selectWindowWorkTask(content, state.autonomousRunId, used);
        if (!taskRef) throw new Error('window-run-liveness-no-open-unreceipted-task');
        return { artifact: input.artifactRef, digest: (input.artifactRef === 'src/a.ts' ? 'b' : input.artifactRef === 'src/b.ts' ? 'c' : 'd').repeat(64), taskRef };
      },
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

  it('refuses a misnamed or missing binding field by name and keeps the existing binding', async () => {
    // The 2026-11-01 shape: runId instead of autonomousRunId, no lifecycleRunId.
    const misnamed = await auth(request(server.getApp()).post('/window-run-liveness/register'))
      .send({ windowId: 'desktop-131439', runId: 'run-131439', topicId: '131439', executorId: 'echo-desktop' }).expect(400);
    expect(misnamed.body.error).toBe('window-run-liveness-unknown-field:runId (did you mean autonomousRunId?)');
    expect(misnamed.body.allowed).toEqual(['windowId', 'topicId', 'autonomousRunId', 'lifecycleRunId', 'executorId']);
    const missing = await auth(request(server.getApp()).post('/window-run-liveness/register'))
      .send({ windowId: 'desktop-131439', topicId: '131439', autonomousRunId: 'run-131439', executorId: 'echo-desktop' }).expect(400);
    expect(missing.body.error).toBe('window-run-liveness-missing-field:lifecycleRunId');
    await auth(request(server.getApp()).post('/window-run-liveness/register')).send({ ...binding, topicId: null }).expect(400);
    const work = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactPath: 'src/a.ts' }).expect(400);
    expect(work.body.error).toBe('window-run-liveness-unknown-field:artifactPath (did you mean artifactRef?)');
    const status = await auth(request(server.getApp()).get('/window-run-liveness')).expect(200);
    expect(status.body.state).toMatchObject({ windowId: 'w32', autonomousRunId: 'run-w32' });
  });

  it('mints a receipt, evaluates all five predicates, and exposes durable state', async () => {
    const minted = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'src/a.ts' }).expect(201);
    expect(minted.body.receipt).toMatchObject({ sequence: 1, observedAt: now, digest: 'b'.repeat(64), taskRef: 'autonomous:run-w32:1' });
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

  it('continues the HTTP work receipt chain on a still-open task after every task was receipted', async () => {
    const second = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'src/b.ts' }).expect(201);
    expect(second.body.receipt).toMatchObject({ sequence: 2, taskRef: 'autonomous:run-w32:2' });
    const repeated = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'src/c.ts' }).expect(201);
    expect(repeated.body.receipt).toMatchObject({ sequence: 3, taskRef: 'autonomous:run-w32:1' });
    const unchanged = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'src/c.ts' }).expect(409);
    expect(unchanged.body.error).toBe('window-run-liveness-artifact-unchanged');
    const replayed = await auth(request(server.getApp()).post('/window-run-liveness/work-advance')).send({ ...binding, artifactRef: 'src/b.ts' }).expect(409);
    expect(replayed.body.error).toBe('window-run-liveness-artifact-replayed');
  });
});
