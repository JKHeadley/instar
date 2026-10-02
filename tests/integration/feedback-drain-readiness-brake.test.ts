// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The readiness brake through the production AgentServer wiring and the HTTP routes. Live
 * 2026-10-02 (drain run 2e06aa3b): one real answer that cross-cited a sibling's evidence voided
 * the operator's approval, and nothing said which check failed. Replayed with the real
 * candidates and a real recorded gpt-6-astra reply.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'feedback-brake-auth';
const PIN = '271828';
const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-readiness-cross-cite-shapes.json'), 'utf8')) as {
  candidates: Array<Record<string, unknown>>; replies: Array<{ oldVerdict: string; raw: string }>;
};
const crossCite = fixture.replies.find((reply) => reply.oldVerdict.includes('cited evidence outside'))!;

describe('feedback drain readiness brake — HTTP + production wiring', () => {
  let root: string;
  let server: AgentServer;
  let reply = { raw: '', model: 'gpt-6-astra' };
  const auth = { Authorization: `Bearer ${AUTH}` };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-brake-'));
    const stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'brake', authToken: AUTH, dashboardPin: PIN }));
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), '');
    fs.writeFileSync(path.join(canonical, 'clusters.jsonl'), fixture.candidates.map((c) => `${JSON.stringify(c)}\n`).join(''));
    const intelligence: IntelligenceProvider = {
      evaluate: async (_prompt, options) => {
        options?.onModel?.({ model: reply.model, framework: 'codex-cli' });
        return reply.raw;
      },
    };
    const config = {
      projectName: 'brake', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: { processing: {}, drain: {}, consumer: { dryRun: true } },
    } as InstarConfig;
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), intelligence,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    });
    await server.start();
    expect((await request(server.getApp()).post('/feedback-factory/readiness-authorities').set({ ...auth, 'X-Instar-Request': '1' }).send({
      pin: PIN, action: 'create', operatorDecisionRef: 'operator-approved-brake',
      authorityId: 'feedback-readiness-default', agentId: 'brake', ownerMachineId: 'brake', ownerEpoch: 1,
      provider: 'codex-cli', modelFamily: 'gpt-6-astra', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
    })).status).toBe(200);
  });

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-drain-readiness-brake.test.ts' });
  });

  const db = () => (server as unknown as { feedbackDrain: { store: { db: import('better-sqlite3').Database } } }).feedbackDrain.store.db;
  const makeAllDue = () => db().prepare(`UPDATE readiness SET next_review_at=0 WHERE state='collecting'`).run();
  const status = async () => (await request(server.getApp()).get('/feedback-factory/drain/status').set(auth)).body;
  const postTick = (nonce: number) => request(server.getApp()).post('/feedback-factory/drain/tick')
    .set({ ...auth, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'brake', 'X-Instar-Request-Nonce': `feedback-brake-${String(nonce).padStart(6, '0')}` });

  async function tick(nonce: number): Promise<{ runId: string; state: string; reason: string }> {
    const accepted = await postTick(nonce);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    for (let attempt = 0; attempt < 500; attempt++) {
      const last = (await status()).lastRun;
      if (last?.runId === accepted.body.runId && !['accepted', 'running'].includes(last.state)) return last;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('drain run did not finish');
  }

  it('a rejected answer keeps the approval, and the status route names the check', async () => {
    reply = { raw: 'These clusters look mostly ready to me.', model: 'gpt-6-astra' };
    const run = await tick(1);
    expect(run).toMatchObject({ state: 'degraded', reason: 'readiness-output-rejected' });
    const body = await status();
    expect(body.authority).toMatchObject({ mode: 'active', pausedReason: null, pausedBecause: null });
    expect(body.lastReadinessFailure).toMatchObject({ runId: run.runId, outcome: 'output-rejected', diagnosis: {
      check: 'invalid-json', candidateCount: 9, resolvedModel: 'gpt-6-astra', excerpt: 'These clusters look mostly ready to me.',
    } });
  });

  it('the recorded live cross-cite answer is accepted with the two cross-citing rows held back', async () => {
    makeAllDue();
    reply = { raw: crossCite.raw, model: 'gpt-6-astra' };
    expect(await tick(2)).toMatchObject({ state: 'succeeded' });
    expect((await status()).authority.mode).toBe('active');
    expect((db().prepare(`SELECT COUNT(*) n FROM readiness WHERE reason_code='evidence-not-own'`).get() as { n: number }).n).toBe(2);
  });

  it('a different model answering still pauses at once, says why in plain words, and the next tick is refused', async () => {
    makeAllDue();
    reply = { raw: crossCite.raw, model: 'gpt-5.5' };
    const run = await tick(3);
    expect(run).toMatchObject({ state: 'degraded', reason: 'readiness-authority-failed' });
    const body = await status();
    expect(body.authority).toMatchObject({ mode: 'proposal-only', pausedReason: 'readiness-schema-provenance-or-routing-failure' });
    expect(body.authority.pausedBecause).toMatch(/did not come from the approved model/);
    expect(body.lastReadinessFailure).toMatchObject({ runId: run.runId, outcome: 'contract-violation', diagnosis: { check: 'resolved-model-mismatch', resolvedModel: 'gpt-5.5' } });
    const proposal = (await request(server.getApp()).get('/feedback-factory/readiness-authorities/proposal').set(auth)).body;
    expect(proposal).toMatchObject({ status: 'proposal-only', pausedBecause: body.authority.pausedBecause });
    expect((await postTick(4)).status).toBe(403);
  });
});
