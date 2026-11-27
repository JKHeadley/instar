/**
 * Feature-is-alive proof for the unified usage ledger's read side
 * (docs/specs/unified-usage-ledger.md, Slice 4): an AgentServer booted on its production
 * path as a development agent answers every /usage/* route and /mobile/usage with 200
 * (not 503) from its real wiring, a funnel one-shot recorded through the production sink
 * shows up in the totals, and the same server booted as a fleet agent answers 503
 * (dark by default).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { CircuitBreakingIntelligenceProvider } from '../../src/core/CircuitBreakingIntelligenceProvider.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/unified-usage-ledger-alive.test.ts' });
});

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'usage-ledger-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'usage-ledger-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', dashboardPin: '246810', developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const pool = new SubscriptionPool({ stateDir, machineId: 'm_test' });
  const server = new AgentServer({ config, sessionManager, subscriptionPool: pool, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
  servers.push(server);
  return { server, stateDir, pool, dir };
}

const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'usage-ledger-e2e');

describe('unified usage ledger — production wiring', () => {
  it('is alive on a development agent: every read route answers and a funnel one-shot reaches the totals', async () => {
    const { server, stateDir } = await boot(true);
    const app = server.getApp();
    // A one-shot through the real funnel → the production sink → the ledger queue.
    const funnel = new CircuitBreakingIntelligenceProvider({
      frameworkId: 'claude-code',
      evaluate: async (_p: string, o?: any) => {
        o?.onModel?.({ model: 'claude-opus-5-5', framework: 'claude-code' });
        o?.onUsage?.({ inputTokens: 1000, outputTokens: 10, cachedTokens: 0, detail: { sessionId: null, input: 1000, cacheRead: 0, cacheWrite: 0, output: 10 } });
        return 'ok';
      },
    } as any);
    await funnel.evaluate('hi', { attribution: { component: 'E2EProbe' } } as any);
    (server as any).usageLedger.flushInvocations();

    for (const p of ['/usage/summary', '/usage/series?grain=day&split=model', '/usage/top?dim=feature', '/usage/tree', '/usage/coverage', '/usage/rollup?after=0', '/mobile/usage']) {
      const r = await auth(request(app).get(p));
      expect(r.status, p).toBe(200);
    }
    const s = await auth(request(app).get('/usage/summary'));
    expect(s.body.total.tokens.total).toBe(1010);
    expect(s.body.total.equivUsd).toBeGreaterThan(0);
    const top = await auth(request(app).get('/usage/top?dim=feature'));
    expect(top.body.items[0].key).toBe('E2EProbe');
    expect(fs.existsSync(path.join(stateDir, 'server-data', 'usage-ledger.db'))).toBe(true);
    // Unauthenticated reads are refused by the server's auth layer.
    expect((await request(app).get('/usage/summary')).status).toBe(401);
  });

  it('reads a running agent’s newly enrolled local pool home and reports coverage over HTTP', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-host-'));
    dirs.push(sandbox);
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(sandbox);
    vi.stubEnv('CODEX_HOME', path.join(sandbox, '.codex'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(sandbox, '.claude'));
    try {
      const { server, pool, dir } = await boot(true);
      const slot = path.join(sandbox, 'disabled-slot');
      pool.addFixture({ id: 'archived', nickname: 'archived', provider: 'openai', framework: 'codex-cli',
        configHome: slot, email: 'fixture@example.invalid', status: 'disabled' });
      const day = path.join(slot, 'sessions', '2026', '11', '17');
      fs.mkdirSync(day, { recursive: true });
      const file = path.join(day, 'rollout-pool-member.jsonl');
      // Write metadata first so the observed event is newer than its transcript.
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'pool-member', cwd: dir } }) + '\n');
      fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 138, output_tokens: 7 } } } }) + '\n');
      await (server as any).usageLedger.scanTickAsync();
      const coverage = await auth(request(server.getApp()).get('/usage/coverage'));
      expect(coverage.status).toBe(200);
      expect(coverage.body.poolRootDiscovery).toBe('available');
      expect(coverage.body.rootMachineId).toBe('local');
      expect(coverage.body.roots).toContainEqual(expect.objectContaining({ root: slot, origin: 'codex:subscription-pool', listing: 'listed', filesPending: 0 }));
      const summary = await auth(request(server.getApp()).get('/usage/summary'));
      expect(summary.status).toBe(200);
      expect(summary.body.total.tokens.total).toBe(145);
    } finally {
      homedir.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('keeps the cross-agent fleet view off on a development server by default', async () => {
    const { server } = await boot(true);
    const app = server.getApp();
    await auth(request(app).get('/usage/fleet/status')).expect(200, { enabled: false });
    await auth(request(app).get('/usage/fleet')).expect(503, { error: 'fleet-usage-off' });
  });

  it('reads an enabled fleet summary through the real dashboard unlock on AgentServer', async () => {
    const originalFetch = globalThis.fetch;
    vi.stubEnv('INSTAR_FLEET_USAGE_ENABLED', 'true');
    vi.stubEnv('INSTAR_FLEET_USAGE_SOURCES', JSON.stringify([
      { id: 'EXAMPLE', agentId: 'example-agent', label: 'Example agent', origin: 'https://fleet-usage.example.test' },
    ]));
    vi.stubEnv('INSTAR_FLEET_USAGE_TOKEN_EXAMPLE', 'fixture-agent-token');
    vi.stubGlobal('fetch', async (input: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      if (url.hostname !== 'fleet-usage.example.test') return originalFetch(input, init);
      expect(new Headers(init?.headers).get('X-Instar-AgentId')).toBe('example-agent');
      return Response.json({
        since: new Date(Number(url.searchParams.get('since'))).toISOString(),
        grain: 'day', scope: 'pool', clamped: false, notReached: [], warming: [],
        total: { tokens: { total: 47 }, partialCalls: 0 },
      });
    });
    try {
      const { server } = await boot(true);
      const app = server.getApp();
      await request(app).get('/usage/fleet').expect(401);
      await auth(request(app).get('/usage/fleet')).expect(403);
      const unlock = await request(app).post('/dashboard/unlock').send({ pin: '246810' }).expect(200);
      const result = await auth(request(app).get('/usage/fleet')).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).expect(200);
      expect(result.body).toMatchObject({
        tokens: 47, complete: true, agents: [{ label: 'Example agent', tokens: 47, coverage: 'complete' }],
      });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('is dark on a fleet agent: the routes answer 503 in plain words', async () => {
    const { server } = await boot(false);
    const r = await auth(request(server.getApp()).get('/usage/summary'));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('usage-ledger-off');
  });
});
