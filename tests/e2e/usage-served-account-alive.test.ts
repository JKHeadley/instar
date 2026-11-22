/**
 * Feature-is-alive proof for spend by served account (docs/specs/quota-pacing-spend-by-account.md):
 * an AgentServer booted on its production path as a development agent with no config key wires
 * the slot resolver into the usage ledger, a Codex rollout under an enrolled home is attributed to
 * that account, and GET /usage/accounts, /usage/account-mismatches and /usage/accounts/size answer
 * 200 (not 503). The switch turned off explicitly makes them answer 503 served-account-off.
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

const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/usage-served-account-alive.test.ts' });
});

async function boot(servedAccount?: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'usage-served-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'usage-served-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    ...(servedAccount === undefined ? {} : { usage: { ledger: { servedAccount } } }),
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

const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'usage-served-e2e');

describe('spend by served account — production wiring', () => {
  it('is alive on a development agent with no config key and attributes a rollout to its enrolled account', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-served-host-'));
    dirs.push(sandbox);
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(sandbox);
    vi.stubEnv('CODEX_HOME', path.join(sandbox, '.codex'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(sandbox, '.claude'));
    try {
      const { server, pool, dir, stateDir } = await boot();
      const slot = path.join(sandbox, 'codex-slot');
      pool.addFixture({ id: 'codex-x', nickname: 'x', provider: 'openai', framework: 'codex-cli', configHome: slot, email: 'x@example.invalid', status: 'disabled' });
      const day = path.join(slot, 'sessions', '2026', '11', '18');
      fs.mkdirSync(day, { recursive: true });
      const file = path.join(day, 'rollout-served.jsonl');
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'served-1', cwd: dir } }) + '\n');
      fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date(Date.now() + 1000).toISOString(),
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, output_tokens: 4 } } } }) + '\n');
      await (server as any).usageLedger.scanTickAsync();
      const app = server.getApp();
      const accounts = await auth(request(app).get('/usage/accounts?scope=local'));
      expect(accounts.status).toBe(200);
      // Codex sign-ins are never identity-checked: the account is recorded, unconfirmed, apart from any login.
      expect(accounts.body.unidentified).toContainEqual(expect.objectContaining({ account: 'codex-x', basis: 'identity-unconfirmed' }));
      for (const p of ['/usage/accounts', '/usage/account-mismatches', '/usage/accounts/size?account=codex-x']) {
        expect((await auth(request(app).get(p))).status, p).toBe(200);
      }
      // The switch history and the identity-check folder are the production state locations.
      expect(fs.existsSync(path.join(stateDir, 'state', 'served-account-switch.jsonl'))).toBe(true);
      expect((await request(app).get('/usage/accounts')).status).toBe(401);
    } finally {
      homedir.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('answers 503 served-account-off when the switch is set off', async () => {
    const { server } = await boot(false);
    const r = await auth(request(server.getApp()).get('/usage/accounts'));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('served-account-off');
  });
});
