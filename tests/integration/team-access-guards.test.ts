/**
 * Each team guard through the real routes, from both sides, on one signed log. Written after an
 * independent review found these paths untested, and several of them open
 * (docs/specs/team-roles-and-access.md §3.5, §3.7, §4.1).
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { createTeamRouter } from '../../src/server/teamRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { TeamConfinement, placeForEntry } from '../../src/users/TeamConfinement.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const GRANTED = 50;
const OTHER = 51;
const dirs: string[] = [];
const services: MobilePairingService[] = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/team-access-guards.test.ts' });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-guard-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'mo', name: 'Mo', channels: [], permissions: ['user'] }]));
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test' });
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Ann' }, tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    mobilePairing: { multiRoute: { enabled: false } },
  };
  const spies = { routed: [] as Array<{ content: string; metadata: Record<string, unknown> }>, pushed: [] as string[], stops: [] as string[], disposition: 'route-through' };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps = {
    config: config as never, stateDir: dir, holdsLease: () => true, selfMachineId: 'm1', teamGate: () => 'ok',
    tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), ownerDM: async () => 1, telegramOwnerId: () => 777,
  } as unknown as MobilePairingDeps;
  const pairing = new MobilePairingService(deps);
  services.push(pairing);
  pairing.nativeOn = true;
  const signer = loadMachineSigner(dir)!;
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup: identityKeyLookup(dir) });
  pairing.push = { onAppReply: (k: string) => { spies.pushed.push(k); } } as never;
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Ann',
    killSession: () => true, onEmergencyStop: (_alias: unknown, scope?: string) => { spies.stops.push(scope ?? 'all'); },
    dispatch: () => async (input) => { svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  pairing.useAppConversationStore(svc.store);
  const session = (id: string, extra: Record<string, unknown>) => ({ id, name: `secret-${id}`, status: 'running', tmuxSession: id, startedAt: new Date().toISOString(), ...extra });
  const running = [
    session('s-granted', { telegramTopicId: GRANTED }), session('s-other', { telegramTopicId: OTHER }),
    session('s-app', { memoryPlaceInput: { memoryPlaceKey: 'app:11111111-1111-4111-8111-111111111111' } }),
  ];
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1', mobilePairingService: pairing,
    sessionManager: { listRunningSessions: () => running, killSession: () => true, isSessionAlive: () => true, captureOutput: () => '' },
    sentinel: { decideInboundDisposition: async () => ({ disposition: 'route-through', category: 'normal' }) },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined, listSessions: () => running, get: () => undefined },
    topicOperatorStore: { setAuthenticatedOperator: () => undefined }, conversationRegistry: registry, appConversations: svc,
    telegram: {
      getOwnerUserId: () => 777, getTopicHistory: (id: number) => [{ text: `words in ${id}`, timestamp: new Date().toISOString() }],
      getAllTopicMappings: () => [GRANTED, OTHER].map((topicId) => ({ topicId, topicName: `Topic ${topicId}`, sessionName: null })),
      isAuthorizedSender: () => true, logInboundMessage: () => undefined, getSessionForTopic: () => 'sess-a',
      onTopicMessage: async (m: { content: string; metadata: Record<string, unknown> }) => { spies.routed.push(m); },
      sendToTopic: async () => ({ messageId: 1, topicId: GRANTED }),
    },
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createTeamRouter(pairing, {
    signer: () => signer, applyConversationChange: async (_r, c) => c(), isSystemTopic: () => false, isJobTopic: () => false,
    ownerProfile: () => ({ userId: 'owner-1', several: false, links: {} }), logsDir: path.join(dir, 'logs'),
    restoreRefs: () => ({ teamRefs: [], allRefs: () => [] }), requireMemoryPrivacy: () => true,
  }));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({
    config: config as never, pairing, service: svc, machineId: () => 'm1',
    sentinel: { decideInboundDisposition: async () => ({ disposition: spies.disposition, category: 'normal' }) } as never,
    telegramTopics: () => [GRANTED, OTHER].map((topicId) => ({ topicId, topicName: `Topic ${topicId}`, lastActivity: null, lastPreview: `words in ${topicId}` })),
  }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  return { app, pairing, svc, spies, dir };
}
type Env = Awaited<ReturnType<typeof setup>>;
type Phone = { dev: ReturnType<typeof makeDevice>; id: string };

function phone(e: Env, person?: { userId: string; role: 'msp' | 'team' }): Phone {
  const dev = makeDevice();
  const c = e.pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
  if (!c.ok) throw new Error('setup');
  e.pairing.devices.applyConfirm(c.device.id, { ok: true });
  e.pairing.keyLedger!.recordActivation(e.pairing.devices.get(c.device.id)!, 'telegram-dm', new Date(Date.now() - 60_000).toISOString());
  return { dev, id: c.device.id };
}
let tick = 0;
function send(e: Env, p: Phone, method: 'GET' | 'POST', url: string, body?: unknown) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = p.dev.sign(canonicalString(p.id, HOST, method, url, time, raw));
  const q = (method === 'GET' ? request(e.app).get(url) : request(e.app).post(url).set('Content-Type', 'application/json'))
    .set('X-Instar-Device', p.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? q.send(raw.toString()) : q;
}
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

/** Team access on, Mia a member holding one topic. */
async function withMember(access: 'read' | 'use' = 'use') {
  const e = await setup();
  const owner = phone(e);
  const r = await send(e, owner, 'POST', '/mobile/team/invites', { events: [
    { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' }, { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' },
    { type: 'grant', personKey: 'mia', ref: `telegram:${GRANTED}`, access },
  ] });
  expect(r.status).toBe(200);
  return { e, owner, mia: phone(e, { userId: 'mia', role: 'team' }), msp: phone(e, { userId: 'mo', role: 'msp' }) };
}

describe('reading a Telegram topic', () => {
  it('a member reads the topic given to them and no other', async () => {
    const { e, mia } = await withMember();
    expect((await send(e, mia, 'GET', `/telegram/topics/${GRANTED}/messages`)).status).toBe(200);
    expect((await send(e, mia, 'GET', `/telegram/topics/${OTHER}/messages`)).status).toBe(404);
  });

  it.each([`${OTHER}x`, `%35%31`, `${OTHER}.0`, `0${OTHER}`, ` ${OTHER}`.replace(' ', '%20')])('an altered address %s does not reach another topic', async (id) => {
    const { e, mia } = await withMember();
    const r = await send(e, mia, 'GET', `/telegram/topics/${id}/messages`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain(`words in ${OTHER}`);
  });

  it('the owner and an MSP phone read every topic, as before', async () => {
    const { e, owner, msp } = await withMember();
    expect((await send(e, owner, 'GET', `/telegram/topics/${OTHER}/messages`)).status).toBe(200);
    expect((await send(e, msp, 'GET', `/telegram/topics/${OTHER}/messages`)).status).toBe(200);
  });
});

describe('the conversation list', () => {
  it('shows a member only what they hold, with no name or preview of the rest', async () => {
    const { e, mia } = await withMember();
    const text = JSON.stringify((await send(e, mia, 'GET', '/mobile/conversations')).body);
    expect(text).toContain(`Topic ${GRANTED}`);
    expect(text).not.toContain(`Topic ${OTHER}`);
    expect(text).not.toContain(`words in ${OTHER}`);
  });

  it('shows the owner and an MSP phone every topic', async () => {
    const { e, owner, msp } = await withMember();
    expect(JSON.stringify((await send(e, owner, 'GET', '/mobile/conversations')).body)).toContain(`Topic ${OTHER}`);
    expect(JSON.stringify((await send(e, msp, 'GET', '/mobile/conversations')).body)).toContain(`Topic ${OTHER}`);
  });
});

describe('a member\'s own conversation', () => {
  it('is confined to that person from its first moment, and a grant cannot share it', async () => {
    const { e, owner, mia } = await withMember();
    const created = await send(e, mia, 'POST', '/mobile/conversations', { title: 'My notes', requestId: rid() });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    const log = e.pairing.teamLog()!;
    expect(log.isConfined(key)).toBe(true);
    expect(log.ownerOf(key)).toBe('mia');
    // The owner sending in later changes nothing: its audience is the person, for good.
    const entry = new TeamConfinement(e.dir).entries()!.get(key)!;
    expect(placeForEntry(entry)).toMatchObject({ kind: 'private', personId: 'mia', alwaysPerson: true });
    const shared = await send(e, owner, 'POST', '/mobile/team/grants', { events: [{ type: 'grant', personKey: 'mia', ref: key, access: 'use' }] });
    expect(shared.body.error).toBe('own-conversation');
  });

  it('an owner\'s new conversation is not confined', async () => {
    const { e, owner } = await withMember();
    const created = await send(e, owner, 'POST', '/mobile/conversations', { title: 'Mine', requestId: rid() });
    expect(e.pairing.teamLog()!.isConfined(created.body.conversationKey)).toBe(false);
  });

  it('keeps a second machine out even with no people left', async () => {
    const { e, mia } = await withMember();
    await send(e, mia, 'POST', '/mobile/conversations', { title: 'My notes', requestId: rid() });
    await request(e.app).post('/team/people/mia/lower').set('Authorization', 'Bearer tok-1').send({ remove: true });
    expect(e.pairing.teamJoinBlocked()).toBe(true);
  });
});

describe('sessions', () => {
  it.each(['/sessions', '/sessions?scope=pool'])('%s hides a session an MSP phone may not read, while team access is on', async (url) => {
    const { e, msp, owner } = await withMember();
    expect(JSON.stringify((await send(e, owner, 'GET', url)).body)).toContain('secret-s-app');
    const r = await send(e, msp, 'GET', url);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('secret-s-app');
    expect(text).toContain('Private session');
    expect(text).toContain('secret-s-other'); // an MSP phone still reads Telegram topics
  });
});

describe('sending while team access is on', () => {
  it('an MSP phone is read-only into a conversation with owner reach, and a member sends in a confined one', async () => {
    const { e, msp, mia } = await withMember();
    const refused = await send(e, msp, 'POST', `/mobile/chat/${OTHER}`, { text: 'hi', requestId: rid() });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('read-only-owner-reach');
    const allowed = await send(e, mia, 'POST', `/mobile/chat/${GRANTED}`, { text: '/new restart', requestId: rid() });
    expect(allowed.status).toBe(200);
  });

  it('a read-only grant reads and does not send', async () => {
    const { e, mia } = await withMember('read');
    expect((await send(e, mia, 'GET', `/telegram/topics/${GRANTED}/messages`)).status).toBe(200);
    expect((await send(e, mia, 'POST', `/mobile/chat/${GRANTED}`, { text: 'hi', requestId: rid() })).status).toBe(404);
  });

  it('a team phone\'s words are marked, so no command runs; the owner\'s are not', async () => {
    const { e, mia, owner } = await withMember();
    await send(e, mia, 'POST', `/mobile/chat/${GRANTED}`, { text: '/new', requestId: rid() });
    await send(e, owner, 'POST', `/mobile/chat/${GRANTED}`, { text: 'hello', requestId: rid() });
    await vi.waitFor(() => expect(e.spies.routed).toHaveLength(2));
    expect(e.spies.routed[0].metadata.teamPhone).toBe(true);
    expect(e.spies.routed[1].metadata.teamPhone).toBeUndefined();
  });
});

describe('a stop word from a phone', () => {
  it('from a team phone stops only that conversation; from the owner it stops everything, as before', async () => {
    const { e, mia, owner } = await withMember();
    e.spies.disposition = 'kill';
    const key = (await send(e, mia, 'POST', '/mobile/conversations', { title: 'Mine', requestId: rid() })).body.conversationKey as string;
    await send(e, mia, 'POST', `/mobile/chat/app/${key}`, { text: 'please stop all of it', requestId: rid() });
    expect(e.spies.stops).toEqual(['conversation']);
    const own = (await send(e, owner, 'POST', '/mobile/conversations', { title: 'Own', requestId: rid() })).body.conversationKey as string;
    await send(e, owner, 'POST', `/mobile/chat/app/${own}`, { text: 'please stop all of it', requestId: rid() });
    expect(e.spies.stops).toEqual(['conversation', 'all']);
  });
});

describe('hook events from a scoped session', () => {
  it('speak for that session alone, whatever the address names; an unscoped caller is unchanged', async () => {
    const set: Array<[string, string]> = [];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { if (req.headers['x-scoped']) res.locals.memorySession = { sessionId: 'mine' }; next(); });
    app.use(createRoutes({
      config: { projectName: 'x', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-hook-')), sessions: {}, scheduler: {} },
      startTime: new Date(), scheduler: null,
      hookEventReceiver: { receive: () => true, storeEvent: () => true },
      sessionManager: {
        listRunningSessions: () => [], getSessionById: (id: string) => ({ id, claudeSessionId: 'old' }),
        setClaudeSessionId: (a: string, b: string) => { set.push([a, b]); },
      },
      state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined, get: () => undefined },
    } as unknown as RouteContext));
    const body = { event: 'PostToolUse', session_id: 'new-id' };
    await request(app).post('/hooks/events?instar_sid=someone-else').set('x-scoped', '1').send(body);
    await request(app).post('/hooks/events?instar_sid=someone-else').send(body);
    expect(set).toEqual([['mine', 'new-id'], ['someone-else', 'new-id']]);
  });
});

describe('a second machine', () => {
  it('is free to join an agent that never had a team, and refused once it has', async () => {
    const e = await setup();
    expect(e.pairing.teamJoinBlocked()).toBe(false);
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' }, { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' }] });
    expect(e.pairing.teamJoinBlocked()).toBe(true);
  });

  it('is refused while the confined list cannot be read', async () => {
    const e = await setup();
    const owner = phone(e);
    await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' }, { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' }] });
    fs.writeFileSync(path.join(e.dir, 'state', 'team-access', 'confined.json'), 'not json');
    expect(e.pairing.teamJoinBlocked()).toBe(true);
  });
});

describe('a reply in a shared topic', () => {
  it('tells phones when someone holds the topic, and stays quiet when no one does', async () => {
    const { e } = await withMember();
    e.pairing.teamTopicReply(OTHER);
    expect(e.spies.pushed).toEqual([]);
    e.pairing.teamTopicReply(GRANTED);
    expect(e.spies.pushed).toEqual([`telegram:${GRANTED}`]);
  });
});
