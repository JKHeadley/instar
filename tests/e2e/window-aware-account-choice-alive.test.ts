/** Production-path proof (docs/specs/quota-pacing-account-choice.md): on a development agent whose
 * config has NO subscriptionPool.pacing.windowAwareChoice key, the real AgentServer answers
 * GET /quota-pacing/account-choice with 200 (not 503) and serves the rows the shadow log wrote at
 * the production path; a fleet agent answers 503. The composition in src/commands/server.ts wires the
 * shared window-aware inputs into every picker (pinned resolver, default resolver, scheduler,
 * anti-thrash, Codex referee) and passes the spawn's model to the resolver. */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AccountChoiceShadowLog, shadowLogPath } from '../../src/monitoring/AccountChoiceShadowLog.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'wa-choice-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config: InstarConfig = {
    projectName: 'wa-choice-e2e', projectDir: dir, stateDir, port: 0,
    developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  };
  expect((config as { subscriptionPool?: { pacing?: unknown } }).subscriptionPool?.pacing).toBeUndefined();
  const subscriptionPool = new SubscriptionPool({ stateDir });
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), subscriptionPool });
  servers.push(server);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { server, stateDir };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/window-aware-account-choice-alive.test.ts' });
});

describe('window-aware account choice — production wiring', () => {
  it('is alive on a development agent with no config key: 200 with the rows the shadow log wrote', async () => {
    const { server, stateDir } = await boot(true);
    const log = new AccountChoiceShadowLog({ file: shadowLogPath(stateDir), machineId: 'local', flushMs: 0 });
    log.record({
      sessionName: 'wa-e2e-1', caller: 'spawn-default', framework: 'claude-code', model: 'claude-opus-5-5', modelSource: 'explicit',
      executed: 'b', oldPick: 'a', newPick: 'b', reasons: ['window-pairing'], accounts: [],
    });
    await log.stop();
    const pool = await request(server.getApp()).get('/quota-pacing/account-choice');
    expect(pool.status).toBe(200);
    expect(pool.body).toMatchObject({ schema: 'account-choice-shadow/1', scope: 'pool' });
    expect(pool.body.machines[0].days[0]).toMatchObject({ placements: 1, differing: 1 });
    const local = await request(server.getApp()).get('/quota-pacing/account-choice?scope=local&limit=10');
    expect(local.status).toBe(200);
    expect(local.body.rows[0]).toMatchObject({ sessionName: 'wa-e2e-1', newPick: 'b', oldPick: 'a' });
  });

  it('is off on a fleet agent: 503 window-aware-choice-off', async () => {
    const { server } = await boot(false);
    const res = await request(server.getApp()).get('/quota-pacing/account-choice');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('window-aware-choice-off');
  });

  it('server.ts composes the shared window-aware inputs into every picker', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
    expect(src).toContain("liveConfig.get<boolean | undefined>('subscriptionPool.pacing.windowAwareChoice'");
    expect(src).toContain('requestRead: (id) => quotaPoller.requestRead(id)');
    expect(src).toContain("caller: 'spawn-pinned'");
    expect(src).toContain('sessionManager.setSpawnAccountResolver((ctx) => wallRescue.spawnAccount(ctx));');
    expect(src).toContain('windowAware: windowAwareDeps,');
    expect(src).toContain('windowAware: windowAwareEnabled,');
    expect(src).toContain('windowAwareSelection,');
    expect(src).toContain("readingValidity(acct, nowMs, antiThrashKnobsGetter().quotaFreshnessMs, { windowAware: windowAwareEnabled() })");
  });
});
