import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import { createLedger, EchoWindowLedgerStore } from '../../src/core/WindowLifecycleObligationLedger.js';
import { WindowRunLivenessAuthority, WindowRunLivenessStore } from '../../src/core/WindowRunLivenessAuthority.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';

// Topic 10000001225: on Echo with liveness enforcing, every registered run used
// to start 'preparing' and never left it. A run now prepares only while an open
// W32 window can actually promote it.
describe('POST /autonomous/register start status (enforcing liveness on Echo)', () => {
  const token = 'register-start-status';
  let project: TempProject;
  let server: AgentServer;
  let authority: WindowRunLivenessAuthority;
  const nowMs = Math.floor(Date.now() / 1000) * 1000;

  beforeAll(async () => {
    project = createTempProject();
    authority = new WindowRunLivenessAuthority(new WindowRunLivenessStore(project.stateDir), {
      now: () => new Date(nowMs).toISOString(),
      sample: state => ({
        sampledAt: new Date(nowMs).toISOString(),
        executor: { id: state.executorId, running: false, heartbeatAt: null },
        deliveryReachable: true,
        work: null,
        lifecycle: { lifecycleRunId: null, state: null, admitted: false, expiresAt: null },
      }),
    }, { enabled: true, dryRun: false });
    const config: InstarConfig = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token,
      requestTimeoutMs: 5000, version: '1.3.1223',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: project.state, windowRunLivenessAuthority: authority, windowLifecycleNow: () => new Date(nowMs).toISOString() });
    await server.start();
  });

  afterAll(async () => { await server.stop(); project.cleanup(); });
  const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`).set('X-Instar-AgentId', 'echo');
  const register = (topicId: number) => auth(request(server.getApp()).post('/autonomous/register')).send({
    topicId, condition: 'ship it', workDir: project.dir, startedAt: new Date(nowMs).toISOString(), endAt: new Date(nowMs + 3_600_000).toISOString(), sessionId: `s-${topicId}`,
  }).expect(200);

  it('starts active when no window is open (was: preparing forever)', async () => {
    const res = await register(9210);
    expect(res.body).toMatchObject({ initialStatus: 'active', preparationRequired: false });
    expect(new AutonomousRunStore(project.stateDir).getByPair('9210', res.body.runId)?.status).toBe('active');
  });

  it('prepares while an open window has a free liveness slot', async () => {
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w-open', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [] } });
    ledger.state = 'active_start';
    new EchoWindowLedgerStore(project.stateDir).save(ledger);
    const res = await register(36966);
    expect(res.body).toMatchObject({ initialStatus: 'preparing', preparationRequired: true });
  });

  it('starts active when another topic holds the open window\'s liveness slot', async () => {
    authority.register({ windowId: 'w-open', topicId: 36966, autonomousRunId: 'run-held', lifecycleRunId: 'run-held', executorId: 'echo-topic-36966' });
    const res = await register(4242);
    expect(res.body).toMatchObject({ initialStatus: 'active', preparationRequired: false });
  });
});
