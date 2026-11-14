/**
 * Feature-is-alive proof for a New session with its own native app conversation
 * (docs/specs/session-conversation-for-every-session.md §6): a production-path AgentServer with native
 * conversations on, a phone paired through the real redeem/confirm path with its presence key enrolled,
 * and the topic-profile bundle carrying the REAL message-free starter over the server's REAL app
 * conversation service (only the tmux spawn is a stand-in). The phone's signed `session-new` with
 * `platform: 'app'` runs the dashboard's create route over real loopback: the conversation is created
 * in the real store, the session is started and registered on its channel, the conversation is listed,
 * and the session list names it as the session's conversation.
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

import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { createAppSessionStarter } from '../../src/core/appInboundDispatch.js';
const HOST = 'echo-app-new-e2e.example.dev';
const PIN = '424242';
const servers: AgentServer[] = [];
const listeners: Server[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const l of listeners) await new Promise((r) => l.close(r));
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/session-app-new-alive.test.ts' });
});

function sessionRow(name: string): Session {
  return { id: `${name}-id`, name, tmuxSession: name, status: 'running', startedAt: new Date().toISOString(), jobSlug: undefined } as unknown as Session;
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'app-new-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  allowTestIdentities(stateDir);
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'app-new-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
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
  let spawnCount = 0;
  sessionManager.spawnInteractiveSession = async (_m: unknown, name: string | undefined) => {
    // The production session manager names an unnamed session itself; this stand-in does the same.
    const s = sessionRow(`spawned-${(name ?? `session-${++spawnCount}`).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
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
  // The topic-profile bundle with the REAL starter, bound lazily to the server's own app conversation service.
  const tpStore = new TopicProfileStore({ stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'), isDryRun: () => true });
  const tpResolver = new TopicProfileResolver({
    store: tpStore, defaultFramework: () => 'claude-code', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
    frameworkDefaultModels: () => ({}), tierEscalationConfig: () => undefined, localModelBinding: () => null, frameworkBinaryPath: () => null,
  });
  const surface = new TopicProfileWriteSurface({
    store: tpStore, resolver: tpResolver, regime: () => ({ enabled: false, dryRun: true }), boundOperator: () => null,
    localModelBinding: () => null, legacyFrameworkRespawn: async () => ({ respawned: false }), disclose: async () => undefined, audit: () => 'seq',
  });
  let starter: ReturnType<typeof createAppSessionStarter> | null = null;
  const topicProfile = {
    store: tpStore, resolver: tpResolver, surface, confirmSlots: new ProfileConfirmSlots({ ttlMs: () => 300_000 }),
    appSessionReady: () => ({ ready: true }),
    startAppSession: async (key: string) => {
      const svc = server.appConversations!;
      starter ??= createAppSessionStarter(
        { sessions: sessionManager, channels: svc.channels, store: svc.store, stateDir },
        { serves: (k) => svc.serves(k), aliasFor: (k) => svc.deps.registry.appAliasFor(k), titleFor: (k) => (svc.liveConversation(k) as { title?: string } | null)?.title ?? null, ownerName: () => 'Justin' },
      );
      const landed = await starter(key, { framework: null, model: null }, { reason: 'new' });
      return landed ? { session: svc.sessionFor(key), refusal: null } : { session: null, refusal: 'spawn-failed' };
    },
  };
  const server = new AgentServer({ config, sessionManager, state, initiativeTracker: new InitiativeTracker(stateDir), tunnel, terminateSessionAuthority, topicProfile } as never);
  servers.push(server);
  const row = sessionRow('throwaway-session');
  sessionManager._sessions.push(row);
  sessionManager._aliveSet.add(row.tmuxSession);
  state.saveSession(row);
  return { server, stateDir, config, keys, terminated };
}

describe('a New session with its own app conversation — production wiring', () => {
  it('is alive: a Face ID New session gets its own app conversation, started and named as its conversation', async () => {
    const { server, config } = await boot();
    const app = server.getApp();
    const listener = app.listen(0);
    listeners.push(listener);
    (config as unknown as { port: number }).port = (listener.address() as { port: number }).port;
    expect(server.mobilePairing).not.toBeNull();
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'app-new-e2e');

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

    const act = async (issue: Record<string, unknown>, route: string, body: Record<string, unknown>) => {
      const built = buildAction(issue.action, issue.target, issue);
      if (!built.ok) throw new Error(built.error);
      const ch = await signed('POST', '/mobile/permissions/challenge', issue);
      expect(ch.status, JSON.stringify(ch.body)).toBe(200);
      return signed('POST', route, { ...body, challenge: ch.body.challenge, presenceSig: presence.sign(permissionPresenceMessage(deviceId, HOST, ch.body.challenge, actionLine(built.action))) });
    };


    // The phone starts a session with its own app conversation, through the production allowlist and Face ID.
    const made = await act({ action: 'session-new', target: 'new', name: 'Plans', platform: 'app' }, '/mobile/sessions/new', { name: 'Plans', platform: 'app' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body, JSON.stringify(made.body)).toMatchObject({ ok: true, message: 'Started "Plans". Open it in Conversations to talk to it.' });

    // The conversation is real: listed for the phone, under its name.
    const convs = await signed('GET', '/mobile/conversations');
    expect(convs.status, JSON.stringify(convs.body)).toBe(200);
    const row = (convs.body.conversations as Array<{ id: string; platform: string; title: string }>).find((c) => c.platform === 'app' && c.title === 'Plans');
    expect(row, JSON.stringify(convs.body)).toBeTruthy();

    // The session is real and registered on it: the session list names this conversation as its own.
    const list = await bearer(request(app).get('/sessions'));
    const s = (list.body as Array<{ tmuxSession: string; conversationRef?: string; triggeredBy?: string }>).find((x) => x.conversationRef === `app:${row!.id}`);
    expect(s, JSON.stringify(list.body)).toBeTruthy();
    expect(server.appConversations!.sessionFor(row!.id)).toBe(s!.tmuxSession);

    // An over-long name for an app conversation is refused before Face ID.
    const long = 'Plans for the week ahead '.repeat(4).trim();
    expect((await signed('POST', '/mobile/permissions/challenge', { action: 'session-new', target: 'new', name: long, platform: 'app' })).status).toBe(400);
  });
});
