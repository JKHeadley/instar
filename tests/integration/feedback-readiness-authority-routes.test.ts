// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Readiness authority from the dashboard, over the real HTTP pipeline.
 *
 * The live failure: the drain had 1,001 reports and every tick answered 403
 * "current registered readiness agent required", because the only way to register was a
 * PIN route with no screen and a dozen technical fields. This proves the new path end to
 * end: the server proposes the exact binding, the agent still cannot register itself,
 * the operator approves with the PIN and only the envelope, and the next tick drains
 * instead of 403ing — with the arbiter's provider/model check passing (the authority is
 * not demoted), because the proposal was computed from the same router the call uses.
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
import type { InstarConfig, IntelligenceOptions } from '../../src/core/types.js';

const AUTH = 'feedback-readiness-authority-auth';
const PIN = '271828';
const H = { Authorization: `Bearer ${AUTH}` };

describe('readiness authority dashboard path — proposal → PIN approve → tick drains', () => {
  let root: string;
  let server: AgentServer;
  let tracker: InitiativeTracker;
  const arbiterCalls: string[] = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-readiness-authority-'));
    const stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'studio', authToken: AUTH, dashboardPin: PIN }));
    fs.writeFileSync(path.join(canonical, 'clusters.jsonl'), `${JSON.stringify({
      clusterId: 'cluster-a', title: 'Scheduler crash on resume', type: 'bug', reportCount: 3,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    })}\n`);
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), '');
    tracker = new InitiativeTracker(stateDir);
    // A codex-cli door that reports its model exactly as CodexCliIntelligenceProvider does
    // (resolveCliModelFlag(options.model)); stubbed only at the network edge.
    const codex = {
      evaluate: async (prompt: string, options?: IntelligenceOptions) => {
        options?.onModel?.({ model: resolveCliModelFlag(options?.model), framework: 'codex-cli' });
        arbiterCalls.push(String(options?.model));
        const clusterId = [...prompt.matchAll(/"clusterId"\s*:\s*"([^"]+)"/g)].at(-1)?.[1];
        return JSON.stringify({ decisions: [{ clusterId, outcome: 'ready', confidence: 0.96, reasonCodes: ['coherent-recurrence'], evidenceIds: [`cluster:${clusterId}`] }] });
      },
    };
    const intelligence = new IntelligenceRouter({
      defaultProvider: codex, defaultFramework: 'codex-cli', resolveConfig: () => undefined, buildProvider: () => null,
    });
    const config = {
      projectName: 'studio', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: { processing: {}, drain: {}, consumer: { dryRun: true } },
    } as unknown as InstarConfig;
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: tracker, intelligence,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-readiness-authority-routes.test.ts' });
  });

  const tick = (nonce: string) => request(server.getApp()).post('/feedback-factory/drain/tick')
    .set({ ...H, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'studio', 'X-Instar-Request-Nonce': nonce });

  async function settle() {
    let status = await request(server.getApp()).get('/feedback-factory/drain/status').set(H);
    for (let i = 0; i < 200 && ['accepted', 'running'].includes(status.body?.lastRun?.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await request(server.getApp()).get('/feedback-factory/drain/status').set(H);
    }
    return status;
  }

  it('drives the whole path; the agent can never register itself', async () => {
    const app = server.getApp();

    // 1. The server proposes the exact binding for this machine.
    const proposal = await request(app).get('/feedback-factory/readiness-authorities/proposal').set(H);
    expect(proposal.status).toBe(200);
    expect(proposal.body).toMatchObject({
      status: 'none', approveAction: 'create', blockers: [],
      proposal: {
        authorityId: 'feedback-readiness-default', agentId: 'studio', ownerMachineId: 'studio', ownerEpoch: 1,
        provider: 'codex-cli', modelFamily: resolveCliModelFlag('capable'),
        promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness',
        maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
      },
    });
    expect(proposal.body.summary).toContain('up to 50 reports per batch, at most $5 per day');

    // 2. Before registration the tick 403s — the live symptom.
    const refused = await tick('readiness-ui-nonce-0001');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('current registered readiness agent required');

    // 3. The agent cannot self-register through the new path: Bearer + useProposal without PIN.
    const self = await request(app).post('/feedback-factory/readiness-authorities')
      .set({ ...H, 'X-Instar-Request': '1' }).send({ action: 'create', useProposal: true, operatorDecisionRef: 'self-attempt' });
    expect(self.status).toBe(403);
    const wrongPin = await request(app).post('/feedback-factory/readiness-authorities')
      .set({ ...H, 'X-Instar-Request': '1' }).send({ action: 'create', useProposal: true, pin: '000000', operatorDecisionRef: 'self-attempt' });
    expect(wrongPin.status).toBe(403);
    expect((await request(app).get('/feedback-factory/readiness-authorities/proposal').set(H)).body.status).toBe('none');

    // 4. Operator approves with the PIN; the body carries only the envelope.
    const approved = await request(app).post('/feedback-factory/readiness-authorities')
      .set({ ...H, 'X-Instar-Request': '1' })
      .send({ action: 'create', useProposal: true, pin: PIN, operatorDecisionRef: 'dashboard:20260930T173000Z:0001', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
        agentId: 'attacker-supplied', provider: 'attacker' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ authorityId: 'feedback-readiness-default', generation: 1, revoked: false });

    const after = await request(app).get('/feedback-factory/readiness-authorities/proposal').set(H);
    expect(after.body).toMatchObject({ status: 'active', approveAction: null, current: { agentId: 'studio', provider: 'codex-cli', matchesProposal: true } });

    // 5. The tick no longer 403s, the arbiter's model check passes, the cluster is approved.
    const accepted = await tick('readiness-ui-nonce-0002');
    expect(accepted.status).toBe(202);
    const status = await settle();
    expect(status.body.lastRun.state, JSON.stringify(status.body.lastRun)).toBe('succeeded');
    expect(arbiterCalls).toEqual(['capable']);
    expect(status.body.authority).toMatchObject({ generation: 1, revoked: false, mode: 'active' });
    expect(status.body.drain.readiness.collecting ?? 0).toBe(0);

    // 6. Revoke with the PIN → the card offers restore, and the tick 403s again.
    const revoked = await request(app).post('/feedback-factory/readiness-authorities')
      .set({ ...H, 'X-Instar-Request': '1' }).send({ action: 'revoke', pin: PIN, operatorDecisionRef: 'dashboard:revoke:0001' });
    expect(revoked.body).toMatchObject({ generation: 2, revoked: true });
    expect((await request(app).get('/feedback-factory/readiness-authorities/proposal').set(H)).body)
      .toMatchObject({ status: 'revoked', approveAction: 'restore' });
    expect((await tick('readiness-ui-nonce-0003')).status).toBe(403);
  });

  it('an out-of-range envelope is refused and records nothing', async () => {
    const res = await request(server.getApp()).post('/feedback-factory/readiness-authorities')
      .set({ ...H, 'X-Instar-Request': '1' })
      .send({ action: 'restore', pin: PIN, operatorDecisionRef: 'dashboard:restore:0001' });
    expect(res.status).toBe(200);
    const bad = await request(server.getApp()).post('/feedback-factory/readiness-authorities')
      .set({ ...H, 'X-Instar-Request': '1' })
      .send({ action: 'replace', useProposal: true, pin: PIN, operatorDecisionRef: 'dashboard:replace:0001', maxBatch: 500 });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/Batch size must be a whole number from 1 to 50/);
    const proposal = await request(server.getApp()).get('/feedback-factory/readiness-authorities/proposal').set(H);
    expect(proposal.body.current.generation).toBe(3);
  });
});
