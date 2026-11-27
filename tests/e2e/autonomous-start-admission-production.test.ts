import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import { createLedger, EchoWindowLedgerStore } from '../../src/core/WindowLifecycleObligationLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';

// Production wiring for topic 10000001225: Echo's own enforcing liveness
// authority (built by AgentServer, not injected), with the long-closed W32
// ledger on disk. A fresh run must start active, and a run left 'preparing'
// must reach the operator through the real Telegram send path.
describe('autonomous start admission — production wiring (Echo)', () => {
  const token = 'start-admission-e2e';
  let project: TempProject;
  let server: AgentServer;
  const sent: Array<{ topicId: number; text: string; provenance?: string }> = [];

  beforeAll(async () => {
    project = createTempProject();
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w32', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: [] } });
    ledger.state = 'closed_failed';
    ledger.windowCeilingAt = '2026-09-08T11:45:56.904Z';
    ledger.recurrenceFrozenAt = '2026-09-08T11:45:56.904Z';
    new EchoWindowLedgerStore(project.stateDir).save(ledger);
    const config: InstarConfig = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token, developmentAgent: true,
      requestTimeoutMs: 5000, version: '1.3.1223',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 2, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [{ type: 'telegram', enabled: true, config: { token: 'start-admission-bot' } }],
      monitoring: { windowRunLiveness: { enabled: true, dryRun: false } }, updates: {},
    };
    const telegram = {
      getSessionForTopic: () => null,
      getStatus: () => ({ started: true, fatalReason: null, lastError: null, consecutivePollErrors: 0 }),
      getTopicHistory: () => [],
      sendToTopic: async (topicId: number, text: string, options: { provenance?: string } = {}) => {
        sent.push({ topicId, text, provenance: options.provenance });
        return { messageId: sent.length };
      },
    };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: project.state, telegram: telegram as never });
    await server.start();
  });

  afterAll(async () => { await server.stop(); project.cleanup(); });
  const auth = (call: request.Test) => call.set('Authorization', `Bearer ${token}`).set('X-Instar-AgentId', 'echo');

  it('is alive: the enforcing authority is built and a fresh run starts active', async () => {
    const liveness = await auth(request(server.getApp()).get('/window-run-liveness')).expect(200);
    expect(liveness.body).toMatchObject({ enabled: true, dryRun: false });
    const now = Date.now();
    const res = await auth(request(server.getApp()).post('/autonomous/register')).send({
      topicId: 10000001225, condition: 'fix it', workDir: project.dir, startedAt: new Date(now).toISOString(), endAt: new Date(now + 86_400_000).toISOString(), sessionId: 'fresh',
    }).expect(200);
    expect(res.body).toMatchObject({ initialStatus: 'active', preparationRequired: false });
    expect(new AutonomousRunStore(project.stateDir).getByPair('10000001225', res.body.runId)?.status).toBe('active');
  });

  it('wires the preparing watchdog to the real Telegram send path', async () => {
    expect(server.preparingRunWatchdog).not.toBeNull();
    const store = new AutonomousRunStore(project.stateDir);
    const startedMs = Date.now() - 15 * 60_000;
    const stuck = store.register({
      topicId: '9210', condition: 'old run', workDir: project.dir, startedAt: new Date(startedMs).toISOString(), endAt: new Date(startedMs + 86_400_000).toISOString(),
      scopeAccretion: { enabled: true, breakerK: 3 }, baseRoots: [], maxDurationMs: 172_800_000, initialStatus: 'preparing',
    }, startedMs);
    if (!stuck.ok) throw new Error('fixture register failed');
    expect(await server.preparingRunWatchdog!.tick()).toEqual([stuck.runId]);
    expect(sent).toEqual([expect.objectContaining({ topicId: 9210, provenance: 'automation' })]);
    expect(sent[0].text).toContain('did not start');
    expect(await server.preparingRunWatchdog!.tick()).toEqual([]);
    expect(store.getByPair('9210', stuck.runId)?.preparingNoticeAt).toBeTruthy();
  });
});
