/**
 * Feature-is-alive proof for the session screen's controls (docs/specs/mobile-native-session-controls.md):
 * an AgentServer booted on its production path (development agent, mobile pairing on, a dashboard PIN), a
 * phone paired through the real redeem/confirm path, its presence key enrolled through the real route, and
 * a throwaway mock session. Reads, a key, a real attachment on disk, then a new session, a default and a
 * close with real P-256 presence signatures, each running the dashboard's own route over this server's real
 * loopback. Wiring integrity: the routes are on the production allowlist (not 403 device-not-allowed),
 * mounted (not 404) and live (not 503); an unsigned or token write is refused.
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
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { allowTestIdentities } from '../helpers/allow-test-identities.js';

const HOST = 'echo-session-controls-e2e.example.dev';
const PIN = '424242';
const servers: AgentServer[] = [];
const listeners: Server[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const l of listeners) await new Promise((r) => l.close(r));
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-session-controls-alive.test.ts' });
});

function sessionRow(name: string): Session {
  return { id: `${name}-id`, name, tmuxSession: name, status: 'running', startedAt: new Date().toISOString(), jobSlug: undefined } as unknown as Session;
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'session-controls-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'session-controls-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
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

describe('session controls — production wiring', () => {
  it('is alive: the menu, a key, a file, and Face ID-confirmed new, default and close', async () => {
    const { server, stateDir, config, keys, terminated } = await boot();
    const app = server.getApp();
    const listener = app.listen(0);
    listeners.push(listener);
    (config as unknown as { port: number }).port = (listener.address() as { port: number }).port;
    expect(server.mobilePairing).not.toBeNull();
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'session-controls-e2e');

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
    const presence = makeDevice();
    const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(redeemed.status).toBe(200);
    const deviceId = redeemed.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const signed = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      let r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      r = r.set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? r.send(raw.toString()) : r;
    };
    expect((await signed('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    expect((await signed('POST', '/mobile/device/presence-key', { publicKey: presence.publicKey, proof: presence.sign(presenceEnrollMessage(deviceId, HOST, presence.publicKey)) })).status).toBe(200);

    // The menu, over real loopback to the dashboard's own routes.
    const controls = await signed('GET', '/mobile/sessions/controls?name=throwaway-session');
    expect(controls.status, JSON.stringify(controls.body)).toBe(200);
    expect(controls.body.actions).toEqual({ state: 'available', reason: null, presenceKey: true });
    expect(controls.body.session).toMatchObject({ tmuxSession: 'throwaway-session', id: 'throwaway-session-id', kind: 'a conversation', chat: 'none (terminal only)' });
    expect(controls.body.door.state).toBe('not-this-chat');
    expect(controls.body.typing).toEqual({ can: true, reason: null });
    expect((await signed('GET', '/mobile/sessions/controls?name=not-there')).status).toBe(404);
    expect((await signed('GET', '/mobile/sessions/new-options')).status).toBe(200);

    // A key, through the production allowlist and router.
    const key = await signed('POST', '/sessions/throwaway-session/key', { key: 'Escape' });
    expect(key.status, JSON.stringify(key.body)).toBe(200);
    expect(keys).toEqual([['throwaway-session', 'Escape']]);

    // A file: the dashboard's own handler, on this machine's disk.
    const att = await signed('POST', '/sessions/throwaway-session/attachments', { filename: 'note.txt', dataBase64: Buffer.from('hi there').toString('base64') });
    expect(att.status, JSON.stringify(att.body)).toBe(201);
    expect(att.body.path).toContain(path.join('state', 'dashboard-uploads'));
    expect(fs.readFileSync(att.body.path, 'utf8')).toBe('hi there');

    const act = async (issue: Record<string, unknown>, route: string, body: Record<string, unknown>) => {
      const built = buildAction(issue.action, issue.target, issue);
      if (!built.ok) throw new Error(built.error);
      const ch = await signed('POST', '/mobile/permissions/challenge', issue);
      expect(ch.status, JSON.stringify(ch.body)).toBe(200);
      return signed('POST', route, { ...body, challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(deviceId, HOST, ch.body.challenge, actionLine(built.action))) });
    };

    // A new session: the dashboard's create route ran for real.
    const made = await act({ action: 'session-new', target: 'new', name: 'Throwaway two', platform: 'headless' }, '/mobile/sessions/new', { name: 'Throwaway two', platform: 'headless' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ ok: true, message: 'Started "Throwaway two".' });
    const list = await bearer(request(app).get('/sessions'));
    expect(list.body.some((s: { tmuxSession: string }) => s.tmuxSession === 'spawned-throwaway-two')).toBe(true);

    // A proof for one action does not run another.
    const ch = await signed('POST', '/mobile/permissions/challenge', { action: 'session-new', target: 'new', name: 'Throwaway two', platform: 'headless' });
    const wrong = await signed('POST', '/mobile/sessions/new', { name: 'Something else', platform: 'headless', challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(deviceId, HOST, ch.body.challenge, 'session-new new x headless none none auto')) });
    expect(wrong.status).toBe(401);

    // A close: the dashboard's route, on the exact session.
    const closed = await act({ action: 'session-close', target: 'throwaway-session-id', tmux: 'throwaway-session' }, '/mobile/sessions/close/throwaway-session-id', { tmux: 'throwaway-session' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ ok: true, message: 'Closed.' });
    expect(terminated).toEqual(['throwaway-session-id']);

    // The audit file names the phone's actions, and no name a person typed.
    const rows = fs.readFileSync(path.join(stateDir, 'state', 'mobile-permission-actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.filter((x) => x.event === 'session-action').map((x) => x.action)).toEqual(expect.arrayContaining(['session-new', 'session-close']));
    expect(JSON.stringify(rows)).not.toContain('Throwaway two');

    // The token can't make these writes; an unsigned request can't reach anything.
    expect((await bearer(request(app).post('/mobile/sessions/new')).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).post('/sessions/throwaway-session/key').send({ key: 'y' })).status).toBe(401);
  });
});
