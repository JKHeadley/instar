/** Production-path proof (docs/specs/quota-pacing-forecast.md): AgentServer builds the quota-history
 * ledger on a development agent whose config has NO subscriptionPool.pacing key, attaches it to the
 * real QuotaPoller (wiring integrity: the sink is the ledger, not null, and a real poll writes a real
 * history row), and GET /quota-pacing answers 200 (not 503). A fleet agent answers 503. */
import { describe, it, expect, afterAll } from 'vitest';
import { buildQuotaForecast } from '../../dashboard/console/quota-forecast-model.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaPoller } from '../../src/core/QuotaPoller.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'qpacing-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config: InstarConfig = {
    projectName: 'qpacing-e2e', projectDir: dir, stateDir, port: 0,
    developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  };
  expect((config as { subscriptionPool?: { pacing?: unknown } }).subscriptionPool?.pacing).toBeUndefined();
  const subscriptionPool = new SubscriptionPool({ stateDir });
  subscriptionPool.addFixture({ id: 'codex-a', nickname: 'codex', email: 'codex@example.test', provider: 'openai', framework: 'codex-cli', configHome: path.join(dir, '.codex') });
  const quotaPoller = new QuotaPoller({
    pool: subscriptionPool,
    codexLiveUsageReaderDetailed: async () => ({ kind: 'ok', snapshot: {
      source: 'codex-app-server', rolloutPath: '', threadId: null, capturedAt: new Date().toISOString(), model: null, planType: 'pro', rateLimitReachedType: null,
      primary: { usedPercent: 21, remainingPercent: 79, windowMinutes: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86_400, resetsAtIso: new Date(Date.now() + 86_400_000).toISOString(), resetsInSeconds: 86_400 },
      secondary: null,
    } }) as never,
    codexUsageReader: async () => null,
  });
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), subscriptionPool, quotaPoller });
  servers.push(server);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { server, stateDir, quotaPoller };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/quota-pacing-alive.test.ts' });
});

describe('quota pacing — production wiring', () => {
  it('is alive on a development agent with no config key: ledger attached to the poller, a real poll writes history, 200', async () => {
    const { server, stateDir, quotaPoller } = await boot(true);
    const internals = server as unknown as { quotaPacingLedger: { flush(force?: boolean): Promise<void>; dir: string } | null };
    expect(internals.quotaPacingLedger).not.toBeNull();
    expect((quotaPoller as unknown as { history: unknown }).history).toBe(internals.quotaPacingLedger);
    expect(await quotaPoller.pollAll()).toEqual({ polled: 1, failed: 0 });
    await internals.quotaPacingLedger!.flush(true);
    const file = path.join(stateDir, 'state', 'quota-history', 'codex-a.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].windows.sevenDay.pct).toBe(21);
    const res = await request(server.getApp()).get('/quota-pacing');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'quota-pacing/1', scope: 'pool' });
    expect(res.body.providers[0].accounts[0].accountId).toBe('codex-a');
    const page = buildQuotaForecast({ ok: true, data: res.body }, [{ id: 'codex-a', name: 'Codex Test Account' }]);
    expect(page.state).toBe('ready');
    expect(page.providers[0].accounts[0].name).toBe('Codex Test Account');
    expect(page.providers[0].accounts[0].lines.join(' ')).toContain('Not enough history');
    expect(page.calibration).toContain('No forecasts have been checked');
    const local = await request(server.getApp()).get('/quota-pacing?scope=local');
    expect(local.status).toBe(200);
    expect(local.body.logins[0].newestPolledAt).not.toBeNull();
  });

  it('is off on a fleet agent: 503 quota-pacing-off and no ledger', async () => {
    const { server, quotaPoller } = await boot(false);
    expect((server as unknown as { quotaPacingLedger: unknown }).quotaPacingLedger).toBeNull();
    expect((quotaPoller as unknown as { history: unknown }).history).toBeNull();
    const res = await request(server.getApp()).get('/quota-pacing');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('quota-pacing-off');
  });
});
