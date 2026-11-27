// CMT-1541 — feature-alive: the production AgentServer serves /pool and the console module the
// unreachable notices are built from, and the approval reminder runs end to end against the REAL
// sign-in repair store (sqlite) the server wires it to: one reminder per wait, none after approval.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';
import { SubscriptionReloginApprovalReminder, waitingSinceMs } from '../../src/core/SubscriptionReloginApprovalReminder.js';
import type { InstarConfig } from '../../src/core/types.js';

const roots: string[] = [];
const servers: AgentServer[] = [];
const stores: SubscriptionReloginStore[] = [];

afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'cmt1541 e2e cleanup' });
});

function config(root: string): InstarConfig {
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  return {
    projectName: 'cmt1541-e2e', projectDir: root, stateDir, port: 0,
    authToken: 'cmt1541-token', dashboardPin: '123456', requestTimeoutMs: 10_000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

describe('CMT-1541 through the production paths', () => {
  it('serves /pool alive (reconnect absent when the re-dialer is not wired) and ships the console wording module', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt1541-e2e-')); roots.push(root);
    const cfg = config(root);
    fs.writeFileSync(path.join(cfg.stateDir, 'config.json'), JSON.stringify(cfg, null, 2));
    const server = new AgentServer({ config: cfg, sessionManager: { listRunningSessions: () => [], getSession: () => null, on: vi.fn() } as never,
      state: new StateManager(cfg.stateDir) });
    servers.push(server);
    await server.start();
    const app = server.getApp();
    const pool = await request(app).get('/pool').set('Authorization', 'Bearer cmt1541-token');
    expect(pool.status).toBe(200);
    for (const m of pool.body.machines ?? []) expect('reconnect' in m).toBe(false);
    const mod = await request(app).get('/dashboard/console/unreachable-model.js');
    expect([200, 401]).toContain(mod.status); // served (auth-gated or not), never 404
    const src = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'console', 'unreachable-model.js'), 'utf8');
    expect(src).toContain('export function unreachableSentence');
  });

  it('reminds once for a repair waiting past the threshold, and not after it is approved', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt1541-reminder-')); roots.push(root);
    let now = Date.parse('2026-11-09T09:00:00.000Z');
    const store = new SubscriptionReloginStore({ stateDir: root, now: () => now, idFactory: () => 'repair-1' }); stores.push(store);
    const ep = store.suggest({ sourceEpisodeId: 7, accountId: 'acct-1', machineId: 'studio', mode: 'approval',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    const sent: string[] = [];
    const reminder = new SubscriptionReloginApprovalReminder({
      // The exact reads server.ts wires.
      listSuggested: () => store.list({ state: 'suggested', limit: 200 }).filter((e) => e.machineId === 'studio'),
      waitingSince: (e) => waitingSinceMs(e, store.listEvents(e.id, 50)),
      remind: ({ episode }) => { sent.push(episode.id); },
      thresholdMs: 4 * 3_600_000, now: () => now,
    });
    now += 3 * 3_600_000;
    expect(await reminder.tick()).toEqual([]);
    now += 2 * 3_600_000;
    expect((await reminder.tick()).length).toBe(1);
    now += 3_600_000;
    expect(await reminder.tick()).toEqual([]);
    store.approve(ep.id, { inputDigest: ep.inputDigest });
    now += 10 * 3_600_000;
    expect(await reminder.tick()).toEqual([]);
    expect(sent).toEqual(['repair-1']);
  });
});
