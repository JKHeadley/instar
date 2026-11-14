/**
 * Feature-is-alive proof for slack-conversations-stay-with-connection: on a production-path
 * AgentServer, POST /pool/transfer is mounted and refuses a Slack conversation in words (409), for
 * the raw routing key and the slack: forms, while a Telegram topic passes that check.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, Session } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { presenceEnrollMessage } from '../../src/server/mobileConsoleTicket.js';
import { permissionPresenceMessage, actionLine, buildAction } from '../../src/server/mobilePermissionsRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { DOOR } from '../../src/server/mobileSessionControlsRoutes.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';

const HOST = 'echo-slack-stays-e2e.example.dev';
const PIN = '424242';
const servers: AgentServer[] = [];
const listeners: Server[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const l of listeners) await new Promise((r) => l.close(r));
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/slack-conversations-stay-alive.test.ts' });
});

function sessionRow(name: string): Session {
  return { id: `${name}-id`, name, tmuxSession: name, status: 'running', startedAt: new Date().toISOString(), jobSlug: undefined } as unknown as Session;
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'slack-stays-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'slack-stays-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 4, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const state = new StateManager(stateDir);
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const keys: Array<[string, string]> = [];
  sessionManager.sendKey = (t: string, k: string) => { keys.push([t, k]); return true; };
  sessionManager.captureOutputAsync = async () => 'mock output';
  sessionManager.spawnInteractiveSession = async (_m: unknown, name: string) => {
    const s = sessionRow(`spawned-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    sessionManager._sessions.push(s);
    state.saveSession(s);
    return s.tmuxSession;
  };
  const terminated: string[] = [];
  const terminateSessionAuthority = async (id: string) => {
    terminated.push(id);
    const s = state.getSession(id);
    if (s) state.saveSession({ ...s, status: 'killed' });
    return { terminated: true };
  };
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state, initiativeTracker: new InitiativeTracker(stateDir), tunnel, terminateSessionAuthority } as never);
  servers.push(server);
  const row = sessionRow('throwaway-session');
  sessionManager._sessions.push(row);
  sessionManager._aliveSet.add(row.tmuxSession);
  state.saveSession(row);
  return { server, stateDir, config, keys, terminated };
}

describe('a Slack conversation stays with its connection — production wiring', () => {
  it('is alive: the transfer route refuses Slack in words; a Telegram topic passes the check', async () => {
    const { server } = await boot();
    const app = server.getApp();
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'slack-stays-e2e');
    for (const topic of ['C0ABC123', 'C0ABC123:1730000000.000100', 'slack:C0ABC123']) {
      const res = await bearer(request(app).post('/pool/transfer')).send({ topic, to: 'Laptop' });
      expect(res.status, topic).toBe(409);
      expect(res.body).toMatchObject({ code: 'slack-stays-with-connection', error: 'This Slack conversation stays on the machine that holds your Slack connection.' });
    }
    const tg = await bearer(request(app).post('/pool/transfer')).send({ topic: '13481', to: 'Laptop' });
    expect(tg.body.code).not.toBe('slack-stays-with-connection');
  });
});
