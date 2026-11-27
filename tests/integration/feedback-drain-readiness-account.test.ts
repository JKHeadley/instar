// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The readiness serving account, through the production AgentServer wiring and the HTTP
 * tick/status routes. A pinned account that is not in the pool is refused by name (no model
 * call, no spend); pinning a verified account then runs readiness on exactly that account,
 * and GET /feedback-factory/drain/status names it with verified=true. The pin is read live.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SubscriptionAccount, SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import type { InstarConfig, IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';
import type { CodexUsageSnapshot } from '../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js';

const AUTH = 'feedback-readiness-account-auth';
const PIN = '141421';

describe('feedback readiness serving account (HTTP + production wiring)', () => {
  let root: string;
  let server: AgentServer;
  let config: InstarConfig;
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const auth = { Authorization: `Bearer ${AUTH}` };
  const evaluateOptions: Array<IntelligenceOptions | undefined> = [];
  const quotaReads: string[] = [];

  beforeAll(async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-readiness-account-'));
    const stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'readiness-acct', authToken: AUTH, dashboardPin: PIN }));
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), '');
    fs.writeFileSync(path.join(canonical, 'clusters.jsonl'), Array.from({ length: 3 }, (_, i) => `${JSON.stringify({
      clusterId: `cluster-acct-${i}`, title: `Scheduler regression ${i}`, type: 'bug', reportCount: 2,
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
    })}\n`).join(''));

    const home = path.join(root, 'codex-gmail');
    fs.mkdirSync(home);
    const email = 'gmail@example.test';
    const idToken = `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.x`;
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken, account_id: 'login-gmail' } }));
    const gmail = { id: 'codex-justin-gmail', nickname: 'gmail', email, provider: 'openai', framework: 'codex-cli',
      configHome: home, status: 'active', enrolledAt: new Date().toISOString(), version: 1 } as SubscriptionAccount;
    const subscriptionPool = { list: () => [gmail], get: (id: string) => (id === gmail.id ? gmail : undefined) } as unknown as SubscriptionPool;
    const codexLiveUsageReader = async (opts?: { codexHome?: string }): Promise<CodexUsageSnapshot | null> => {
      quotaReads.push(opts?.codexHome ?? '');
      const window = { usedPercent: 13, remainingPercent: 87, windowMinutes: 10080, resetsAt: 1795909829, resetsAtIso: null, resetsInSeconds: null };
      return { source: 'codex-app-server', rolloutPath: '', threadId: null, capturedAt: new Date(Date.now()).toISOString(), model: null,
        planType: 'pro', rateLimitReachedType: null, primary: window, secondary: null };
    };

    const intelligence: IntelligenceProvider = {
      evaluate: async (prompt, options) => {
        evaluateOptions.push(options);
        const packet = JSON.parse(prompt.slice(prompt.indexOf('Candidates: ') + 12)) as Array<{ clusterId: string }>;
        options?.onModel?.({ model: 'gpt-6-astra', framework: 'codex-cli' });
        return JSON.stringify({ decisions: packet.map(({ clusterId }) => ({
          clusterId, outcome: 'collecting', confidence: 0.5, reasonCodes: ['needs-more-reports'], evidenceIds: [`cluster:${clusterId}`],
        })) });
      },
    };
    config = {
      projectName: 'readiness-acct', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: { processing: {}, drain: {}, consumer: { dryRun: true }, readiness: { account: 'codex-not-in-pool' } },
    } as InstarConfig;
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), intelligence,
      subscriptionPool, codexLiveUsageReader,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    } as ConstructorParameters<typeof AgentServer>[0]);
    await server.start();
    expect((await request(server.getApp()).post('/feedback-factory/readiness-authorities').set({ ...auth, 'X-Instar-Request': '1' }).send({
      pin: PIN, action: 'create', operatorDecisionRef: 'operator-approved-readiness-account',
      authorityId: 'feedback-readiness-default', agentId: 'readiness-acct', ownerMachineId: 'readiness-acct', ownerEpoch: 1,
      provider: 'codex-cli', modelFamily: 'gpt-6-astra', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
    })).status).toBe(200);
  });

  afterAll(async () => {
    await server?.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-drain-readiness-account.test.ts' });
  });

  async function tick(nonce: number): Promise<{ state: string; reason: string }> {
    const app = server.getApp();
    const accepted = await request(app).post('/feedback-factory/drain/tick')
      .set({ ...auth, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'readiness-acct', 'X-Instar-Request-Nonce': `feedback-readiness-acct-${String(nonce).padStart(4, '0')}` });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    for (let attempt = 0; attempt < 500; attempt++) {
      const last = (await request(app).get('/feedback-factory/drain/status').set(auth)).body?.lastRun;
      if (last?.runId === accepted.body.runId && !['accepted', 'running'].includes(last.state)) return last;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('drain run did not finish');
  }

  it('refuses a pinned account that is not in the pool, by name, with no model call', async () => {
    const last = await tick(1);
    expect(last).toMatchObject({ state: 'degraded', reason: 'readiness-account-refused' });
    expect(evaluateOptions).toHaveLength(0);
    const status = (await request(server.getApp()).get('/feedback-factory/drain/status').set(auth)).body;
    expect(status.readinessAccount).toMatchObject({
      mode: 'off', pinnedAccountId: 'codex-not-in-pool',
      last: { state: 'refused', reason: 'pinned-account-missing', pinned: true },
    });
    expect(status.authority.mode).toBe('active');
    expect(status.lastReadinessFailure.diagnosis).toMatchObject({ check: 'readiness-account-refused', message: 'pinned-account-missing' });
  });

  it('a corrected pin (read live) runs readiness on exactly that verified account', async () => {
    config.feedbackFactory!.readiness = { account: 'codex-justin-gmail' };
    offset += 16 * 60_000; // past the 15-minute retry for the refused rows
    const last = await tick(2);
    expect(last.state).toBe('succeeded');
    expect(evaluateOptions.length).toBeGreaterThan(0);
    expect(evaluateOptions.every((opts) => opts?.accountOverride?.accountId === 'codex-justin-gmail')).toBe(true);
    expect(quotaReads.some((home) => home.endsWith('codex-gmail'))).toBe(true);
    const status = (await request(server.getApp()).get('/feedback-factory/drain/status').set(auth)).body;
    expect(status.readinessAccount).toMatchObject({
      pinnedAccountId: 'codex-justin-gmail',
      last: { state: 'served', accountId: 'codex-justin-gmail', pinned: true, verified: true, usedPercent: 13 },
    });
    expect(JSON.stringify(status.readinessAccount)).not.toContain('auth.json');
    expect(JSON.stringify(status.readinessAccount)).not.toContain('login-gmail');
  });
});
