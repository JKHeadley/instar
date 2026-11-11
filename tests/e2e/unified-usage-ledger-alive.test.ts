/**
 * Feature-is-alive proof for the unified usage ledger's read side
 * (docs/specs/unified-usage-ledger.md, Slice 4): an AgentServer booted on its production
 * path as a development agent answers every /usage/* route and /mobile/usage with 200
 * (not 503) from its real wiring, a funnel one-shot recorded through the production sink
 * shows up in the totals, and the same server booted as a fleet agent answers 503
 * (dark by default).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
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
    projectName: 'usage-ledger-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
  servers.push(server);
  return { server, stateDir };
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

  it('is dark on a fleet agent: the routes answer 503 in plain words', async () => {
    const { server } = await boot(false);
    const r = await auth(request(server.getApp()).get('/usage/summary'));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('usage-ledger-off');
  });
});
