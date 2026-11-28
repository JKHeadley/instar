/**
 * The stand-in owner chat through the full HTTP pipeline (docs/specs/throwaway-owner-chat.md):
 * a pairing it carries is ended by the shut-off sweep when a real owner channel appears mid-run,
 * after which its routes answer 410 and the approval path stops naming Telegram; and its routes
 * refuse a request that reaches the server through a tunnel host even with the right token.
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
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { STAND_IN_STATE } from '../../src/server/throwawayOwnerChat.js';

const HOST = 'toc-int.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/throwaway-owner-chat.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toc-int-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  const now = Date.now();
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    messaging: [], liveTest: { throwawayOwnerChat: { enabled: true } },
    throwawayAgent: { createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() },
  }));
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'toc int machine' });
  const config = {
    projectName: 'toc-int', projectDir: dir, stateDir, port: 0, authToken: 'int-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  const app = server.getApp();
  const mp = server.mobilePairing!;
  mp.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { app, mp, stateDir, configFile };
}

const auth = (q: request.Test) => q.set('Authorization', 'Bearer int-token').set('X-Instar-AgentId', 'toc-int');
const local = (q: request.Test) => auth(q).set('Host', 'localhost:0');

describe('stand-in owner chat through the HTTP pipeline', () => {
  it('a real owner channel appearing mid-run ends the pairing it carried and turns it off for good', async () => {
    const { app, mp, stateDir, configFile } = await boot();
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'phone', devicePublicKey: dev.publicKey });
    expect(r.body).toMatchObject({ status: 'pending', approval: 'telegram' });
    const deviceId = r.body.deviceId as string;
    const entries = (await local(request(app).get('/throwaway/owner-chat/messages'))).body.entries as Array<{ kind: string; id: number }>;
    const msgId = entries.find((e) => e.kind === 'message')!.id;

    // A messaging adapter is configured while the server runs.
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    cfg.messaging = [{ type: 'telegram', config: {} }];
    fs.writeFileSync(configFile, JSON.stringify(cfg));

    expect((await local(request(app).get('/throwaway/owner-chat/messages'))).status).toBe(410);
    expect((await local(request(app).post('/throwaway/owner-chat/tap')).send({ messageId: msgId, button: 0 })).status).toBe(410);
    // The sweep pressed Decline through the production funnel: the phone never becomes active.
    expect(mp.devices.get(deviceId)?.status ?? 'removed').not.toBe('active');
    // Its decline nonce is consumed: a later tap of that Decline (on any surface) finds nothing.
    expect(mp.declineByNonce('0'.repeat(24))).toBe('unknown');
    expect([...mp.declineNonces.values()]).not.toContain(deviceId);
    expect(mp.approvalPath()).not.toBe('telegram');
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, STAND_IN_STATE), 'utf8')).off.condition).toBe('real-owner');
  });

  it('the right token through a tunnel host is refused', async () => {
    const { app } = await boot();
    expect((await auth(request(app).get('/throwaway/owner-chat/messages')).set('Host', HOST)).status).toBe(404);
    expect((await local(request(app).get('/throwaway/owner-chat/messages'))).status).toBe(200);
  });
});
