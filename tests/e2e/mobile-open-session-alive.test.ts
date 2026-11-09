/**
 * Feature-is-alive proof for "Open session" (GET /mobile/conversations/session): an AgentServer
 * booted on its production path (development agent, native app conversations on), a phone paired
 * through the existing redeem/confirm path, a conversation created and messaged so the session
 * manager spawns its session. Before the session runs the route answers active:false with the
 * plain reason; once the session record is running it answers active:true with a dashboard link
 * on the pairing origin focused on that session (`/dashboard?session=<name>`), and the dashboard
 * page served by the same server reads that `session` parameter. Bearer is refused (403), not 503.
 * Wiring integrity: the route is mounted on the production server and reads the real conversation
 * store and the real channel binding the spawn wrote.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
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
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { findRemoteSession, NO_SESSION_REASON } from '../../src/server/mobileSessionRoutes.js';

const HOST = 'echo-open-session-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-open-session-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'open-session-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'open-session-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  sessionManager.spawnInteractiveSession = async () => 'app-session-1';
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server, sessionManager };
}

describe('open session — production wiring', () => {
  it('is alive: inactive before the session runs, active with a focused dashboard link after', async () => {
    const { server, sessionManager } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    expect(server.appConversations).not.toBeNull();

    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'open-session-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

    const created = await send('POST', '/mobile/conversations', { title: 'Plans', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    const sessionPath = `/mobile/conversations/session?ref=${encodeURIComponent(`app:${key}`)}`;

    // No session yet: the honest "your next message starts one".
    const before = await send('GET', sessionPath);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ active: false, reason: NO_SESSION_REASON });

    // A message spawns the session; the conversation is now bound to "app-session-1".
    const sent = await send('POST', `/mobile/chat/app/${key}`, { text: 'Hello', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(sent.status).toBe(200);
    expect(server.appConversations!.sessionFor(key)).toBe('app-session-1');
    // Bound but not yet a running record (what the dashboard lists): still inactive.
    expect((await send('GET', sessionPath)).body.active).toBe(false);
    sessionManager._sessions.push({ id: 's-1', name: 'app-session-1', status: 'running', tmuxSession: 'app-session-1', startedAt: '2026-11-03T20:00:00.000Z', framework: 'claude-code' });

    const after = await send('GET', sessionPath);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      active: true, sessionName: 'app-session-1', startedAt: '2026-11-03T20:00:00.000Z', framework: 'claude-code',
      dashboardUrl: `https://${HOST}/dashboard?session=app-session-1`,
    });
    expect(typeof after.body.machineNickname === 'string' || after.body.machineNickname === null).toBe(true);

    // The link opens the dashboard served by this server, which focuses `?session=`. A /dashboard
    // link with a query goes to the legacy page with the query kept (dashboard-console-default spec §3.1).
    const hop = await request(app).get('/dashboard?session=app-session-1');
    expect(hop.status).toBe(302);
    expect(hop.headers.location).toBe('/dashboard/legacy?session=app-session-1');
    const dash = await request(app).get(hop.headers.location);
    expect(dash.status).toBe(200);
    expect(dash.text).toContain("params.get('session')");
    expect(dash.text).toContain('selectSession(match.tmuxSession, match)');

    // Bearer is refused (the route is alive: 403, not 503); unknown and malformed refs answer 404/400.
    const bearer = await auth(request(app).get(sessionPath));
    expect(bearer.status).toBe(403);
    expect((await send('GET', `/mobile/conversations/session?ref=${encodeURIComponent('app:33333333-3333-4333-8333-333333333333')}`)).status).toBe(404);
    expect((await send('GET', '/mobile/conversations/session?ref=nope')).status).toBe(400);

    // Open session on any machine: the production pool listing this server serves is the source the
    // route reads for a session on another machine. It parses here, and a machine not in it is not found
    // (a missing peer is never guessed at). This server's own sessions are not "remote".
    const listing = await auth(request(app).get('/sessions?scope=pool'));
    expect(listing.status).toBe(200);
    const ref = { kind: 'app' as const, ref: `app:${key}`, key };
    expect(findRemoteSession(listing.body, ref, 'm_absent_peer').state).toBe('none');
  });
});
