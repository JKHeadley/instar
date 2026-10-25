// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Readiness authority survives what the live Mac Studio does, on the production path.
 *
 * Live 2026-10-01: the operator approved the authority at lease epoch 22677. The next run
 * hit CodexExecJsonTimeoutError (20s budget, 50 candidates) and that one timeout demoted
 * the authority for good. Routine same-machine restarts then moved the lease epoch to
 * 22679, which alone would have refused the authority as a stale owner. This proves both
 * on a real AgentServer: one timeout is retried, not a demotion; a same-machine epoch
 * advance keeps the approval; another machine owning the drain still requires a new one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import { resolveCliModelFlag } from '../../src/providers/adapters/openai-codex/models.js';
import { CodexExecJsonTimeoutError } from '../../src/providers/adapters/openai-codex/transport/codexSpawn.js';
import type { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import type { InstarConfig, IntelligenceOptions } from '../../src/core/types.js';

const AUTH = 'feedback-readiness-continuity-auth';
const PIN = '161803';
const H = { Authorization: `Bearer ${AUTH}` };
const MACHINE = 'm_studio';

describe('readiness authority continuity — production path', () => {
  let root: string;
  let server: AgentServer;
  let leaseEpoch = 22677;
  let timeouts = 1;
  let calls = 0;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-readiness-continuity-'));
    const stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', authToken: AUTH, dashboardPin: PIN }));
    fs.writeFileSync(path.join(canonical, 'clusters.jsonl'), `${JSON.stringify({
      clusterId: 'cluster-a', title: 'Scheduler crash on resume', type: 'bug', reportCount: 3,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    })}\n`);
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), '');
    // Reports its model exactly as CodexCliIntelligenceProvider does, and fails the way the
    // live call did: onModel fires, then the exec times out.
    const codex = {
      evaluate: async (prompt: string, options?: IntelligenceOptions) => {
        calls++;
        options?.onModel?.({ model: resolveCliModelFlag(options?.model), framework: 'codex-cli' });
        if (timeouts-- > 0) throw new CodexExecJsonTimeoutError(options?.timeoutMs ?? 0, '');
        const clusterId = [...prompt.matchAll(/"clusterId"\s*:\s*"([^"]+)"/g)].at(-1)?.[1];
        return JSON.stringify({ decisions: [{ clusterId, outcome: 'collecting', confidence: 0.6, reasonCodes: ['single-report'], evidenceIds: [`cluster:${clusterId}`] }] });
      },
    };
    const intelligence = new IntelligenceRouter({
      defaultProvider: codex, defaultFramework: 'codex-cli', resolveConfig: () => undefined, buildProvider: () => null,
    });
    const config = {
      projectName: 'echo', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: { operatedHostMachineId: MACHINE, processing: {}, drain: {}, consumer: { dryRun: true } },
    } as unknown as InstarConfig;
    // The multi-machine lease the Studio runs under; its epoch advances on every restart.
    const coordinator = {
      enabled: true, getLeaseEpoch: () => leaseEpoch, holdsLease: () => true, isAwake: () => true,
      getSyncStatus: () => ({ holdsLease: true, leaseHolder: MACHINE }), identity: { machineId: MACHINE },
      // Machine-to-machine routes mount under an enabled coordinator; they are not exercised here.
      managers: { identityManager: { baseDir: stateDir, hasIdentity: () => false } },
    };
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), intelligence,
      coordinator: coordinator as never, meshSelfId: MACHINE,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    } as never);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-readiness-authority-continuity.test.ts' });
  });

  const tick = (nonce: string) => request(server.getApp()).post('/feedback-factory/drain/tick')
    .set({ ...H, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'echo', 'X-Instar-Request-Nonce': nonce });
  const proposal = async () => (await request(server.getApp()).get('/feedback-factory/readiness-authorities/proposal').set(H)).body;
  async function settle() {
    let status = await request(server.getApp()).get('/feedback-factory/drain/status').set(H);
    for (let i = 0; i < 200 && ['accepted', 'running'].includes(status.body?.lastRun?.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await request(server.getApp()).get('/feedback-factory/drain/status').set(H);
    }
    return status;
  }

  it('retries a timeout, keeps the approval across a same-machine epoch advance, and refuses a new owner machine', async () => {
    const app = server.getApp();
    expect(await proposal()).toMatchObject({ status: 'none', approveAction: 'create', proposal: { ownerMachineId: MACHINE, ownerEpoch: 22677 } });
    const approved = await request(app).post('/feedback-factory/readiness-authorities')
      .set({ ...H, 'X-Instar-Request': '1' })
      .send({ action: 'create', useProposal: true, pin: PIN, operatorDecisionRef: 'dashboard:20260930T235142Z:e2e' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    // 1. The live timeout: the run degrades, the rows wait for the next review, the authority stays active.
    expect((await tick('continuity-nonce-0001')).status).toBe(202);
    const status = await settle();
    expect(status.body.lastRun).toMatchObject({ state: 'degraded', reason: 'readiness-authority-failed' });
    expect(calls).toBe(1);
    expect(status.body.authority).toMatchObject({ generation: 1, mode: 'active' });
    expect(await proposal()).toMatchObject({ status: 'active', approveAction: null });

    // 2. Two same-machine restarts later the approval still holds: no 403, no re-approval card.
    leaseEpoch = 22679;
    expect((await tick('continuity-nonce-0002')).status).toBe(202);
    await settle();
    expect(await proposal()).toMatchObject({ status: 'active', approveAction: null, current: { ownerEpoch: 22677, matchesProposal: true } });

    // 3. Another machine ran the drain since the approval: the record is a stale owner.
    const store = (server as unknown as { feedbackDrain: { store: FeedbackDrainStore } }).feedbackDrain.store;
    const foreign = store.startRun({ ownerHost: 'm_laptop', ownerEpoch: 22680, leaseMs: 1_000 });
    store.transitionRun(foreign.runId, 'accepted', 'running', '', { ownerHost: 'm_laptop', ownerEpoch: 22680 });
    store.transitionRun(foreign.runId, 'running', 'succeeded', '', { ownerHost: 'm_laptop', ownerEpoch: 22680 });
    leaseEpoch = 22681;
    const refused = await tick('continuity-nonce-0003');
    expect(refused.status).toBe(403);
    expect(await proposal()).toMatchObject({ status: 'active', approveAction: 'replace', current: { matchesProposal: false } });
  });
});
