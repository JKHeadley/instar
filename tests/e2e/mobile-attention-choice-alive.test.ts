/**
 * Feature-is-alive proof for Done and Ignore on a Needs-you item (docs/specs/mobile-attention-choices.md):
 * a production boot with no Telegram (the local attention list), a phone paired through the real
 * redeem/confirm path, one real item, and the phone's signed Ignore running the dashboard's own PATCH
 * over real loopback. Wiring integrity: on the production allowlist (not 403), mounted (not 404),
 * live (not 503), and the item really changes; the raw PATCH stays refused to the phone.
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
import { LocalAttentionItems } from '../../src/core/LocalAttentionItems.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';

const HOST = 'echo-attention-choice-e2e.example.dev';
const PIN = '424242';
const servers: AgentServer[] = [];
const listeners: Server[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const l of listeners) await new Promise((r) => l.close(r));
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-attention-choice-alive.test.ts' });
});

function sessionRow(name: string): Session {
  return { id: `${name}-id`, name, tmuxSession: name, status: 'running', startedAt: new Date().toISOString(), jobSlug: undefined } as unknown as Session;
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'attention-choice-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  // A Needs-you item on the local list, as the lifeline guard raises one on an agent without Telegram.
  new LocalAttentionItems(stateDir).raise({ id: 'telegram-ingress:unauthenticated:2026-11-06', title: 'Something other than the lifeline called my Telegram intake', summary: 'A request without the lifeline secret reached the internal Telegram message route.', priority: 'HIGH', category: 'security', source: 'agent' });
  const config = {
    projectName: 'attention-choice-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
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

describe('Needs-you choices — production wiring', () => {
  it('is alive: the phone ignores a real item and it leaves the open list', async () => {
    const { server, config } = await boot();
    const app = server.getApp();
    const listener = app.listen(0);
    listeners.push(listener);
    (config as unknown as { port: number }).port = (listener.address() as { port: number }).port;
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'attention-choice-e2e');
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await bearer(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    const deviceId = redeemed.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const signed = (method: 'GET' | 'POST' | 'PATCH', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      let r = method === 'GET' ? request(app).get(p) : method === 'PATCH' ? request(app).patch(p).set('Content-Type', 'application/json') : request(app).post(p).set('Content-Type', 'application/json');
      r = r.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? r.send(raw.toString()) : r;
    };
    expect((await signed('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

    const id = 'telegram-ingress:unauthenticated:2026-11-06';
    const before = await signed('GET', '/attention?status=OPEN');
    expect(before.status).toBe(200);
    expect(before.body.items.map((i: { id: string }) => i.id)).toContain(id);
    // The raw route stays the dashboard's: a phone can't PATCH it directly.
    expect((await signed('PATCH', `/attention/${encodeURIComponent(id)}`, { status: 'DONE' })).status).toBe(403);
    const r = await signed('POST', `/mobile/attention/${id}/choice`, { choice: 'ignore' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Ignored. It won\'t ask again.' });
    const after = await signed('GET', '/attention?status=OPEN');
    expect(after.body.items.map((i: { id: string }) => i.id)).not.toContain(id);
    const all = await bearer(request(app).get('/attention'));
    const row = all.body.items.find((i: { id: string }) => i.id === id);
    expect(row).toMatchObject({ status: 'WONT_DO' });
    // Again: it is already settled, said plainly.
    const again = await signed('POST', `/mobile/attention/${id}/choice`, { choice: 'done' });
    expect([200, 404]).toContain(again.status);
  });
});
