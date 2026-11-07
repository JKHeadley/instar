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
import { actOnUrgent, createAppDrainDeliver, createAppOwnerReceiver, forwardSpeakerName, parseAppForward, type AppPoolHandle } from '../../src/core/appConversationPool.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import type { InboundMessage } from '../../src/core/SessionRouter.js';
import type { AppDispatchInput } from '../../src/core/appInboundDispatch.js';
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

async function setup(opts: { machine?: string; pool?: AppPoolHandle } = {}) {
  const machine = opts.machine ?? 'm1';
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
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => machine, isRecordingEnabled: () => true });
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
  const dispatched: AppDispatchInput[] = [];
  const svc = new AppConversationService({
    ...(opts.pool ? { pool: () => opts.pool! } : {}),
    stateDir: dir, machineId: () => machine, registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Ann',
    killSession: () => true, onEmergencyStop: (_alias: unknown, scope?: string) => { spies.stops.push(scope ?? 'all'); },
    dispatch: () => async (input) => { dispatched.push(input); svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
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
  return { app, pairing, svc, spies, dir, registry, dispatched };
}
type Env = Awaited<ReturnType<typeof setup>>;
type Phone = { dev: ReturnType<typeof makeDevice>; id: string };

function phone(e: Env, person?: { userId: string; role: 'msp' | 'team' }): Phone {
  const dev = makeDevice();
  const c = e.pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST, ...(person ?? {}) });
  if (!c.ok) throw new Error('setup');
  e.pairing.devices.applyConfirm(c.device.id, { ok: true });
  e.pairing.keyLedger!.recordActivation(e.pairing.devices.get(c.device.id)!, 'telegram-dm', new Date(Date.now() - 60_000).toISOString());
  e.pairing.devices.setPresenceKey(c.device.id, makeDevice().publicKey);
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
async function withMember(access: 'read' | 'use' = 'use', opts: Parameters<typeof setup>[0] = {}) {
  const e = await setup(opts);
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

describe('the same rules through a conversation on another machine (app-conversations-in-the-pool §2.4)', () => {
  /** The machine that serves the phone, with every conversation owned by `m_owner`, and the owner beside it. */
  async function moved() {
    const routed: InboundMessage[] = [];
    const record = (k: string): SessionOwnershipRecord => ({ sessionKey: k, ownerMachineId: 'm_owner', ownershipEpoch: 5, status: 'active', nonce: 'n', timestamp: Date.now(), updatedBy: 'm_owner' }) as SessionOwnershipRecord;
    const pool: AppPoolHandle = {
      active: () => true, read: record, gateOpenFor: () => true, drainRunning: () => false, sessionRunning: () => false,
      closeLostSession: async () => ({ closed: true }), leaseHeldElsewhere: () => true, dropHeld: () => undefined, hasHeld: () => false,
      route: async (m) => { routed.push(m); return { action: 'forwarded', owner: 'm_owner', acked: true }; },
    };
    const holder = await withMember('use', { pool });
    const owner = await setup({ machine: 'm_owner' });
    const verdict = { now: 'deliver' as 'kill' | 'pause' | 'deliver' };
    const receiver = createAppOwnerReceiver({
      service: () => owner.svc, storedEpoch: () => 5, markInjected: () => undefined,
      classify: async () => verdict.now,
    });
    /** The forward the route really sent, as a queue row or mesh command carries it, on the owner. */
    const onOwner = (key: string) => {
      if (!owner.svc.liveConversation(key)) owner.svc.applyCreate('d', rid(), key, 'Moved');
      owner.svc.channels.register(String(owner.registry.appAliasFor(key)), 'sess-owner');
      const m = routed[routed.length - 1];
      const row = JSON.stringify(m.payload);
      receiver.accepted(m.sessionKey, m.messageId, row);
      return parseAppForward(row)!;
    };
    return { holder, owner, routed, onOwner, verdict, receiver };
  }
  const talk = async (m: Awaited<ReturnType<typeof moved>>, who: 'mia' | 'owner', text: string) => {
    const p = who === 'mia' ? m.holder.mia : m.holder.owner;
    const key = (await send(m.holder.e, p, 'POST', '/mobile/conversations', { title: 'Mine', requestId: rid() })).body.conversationKey as string;
    const r = await send(m.holder.e, p, 'POST', `/mobile/chat/app/${key}`, { text, requestId: rid() });
    return { key, r };
  };

  it('an exact stop from a team phone ends only that conversation on the owner; the owner\'s own still stops everything', async () => {
    const m = await moved();
    const a = await talk(m, 'mia', 'stop');
    expect(a.r.body).toMatchObject({ deliveryState: 'intercepted', forwarded: true });
    expect(m.routed[0].appUrgent).toBe('stop');
    expect(m.onOwner(a.key)).toMatchObject({ urgent: 'stop', stopScope: 'conversation' });
    expect(m.owner.spies.stops).toEqual(['conversation']);
    const b = await talk(m, 'owner', 'stop');
    expect(m.onOwner(b.key).stopScope).toBeUndefined();
    expect(m.owner.spies.stops).toEqual(['conversation', 'all']);
    expect(m.holder.e.spies.stops).toEqual([]); // nothing ran on the machine that doesn't own it
  });

  it('a stop the classifier finds on the serving machine keeps the same rule', async () => {
    const m = await moved();
    m.holder.e.spies.disposition = 'kill';
    const a = await talk(m, 'mia', 'please stop all of it');
    expect(m.onOwner(a.key)).toMatchObject({ urgent: 'stop', stopScope: 'conversation' });
    expect(m.owner.spies.stops).toEqual(['conversation']);
  });

  it('a plain send the owner itself turns into a stop keeps the rule: its classifier, and an exact stop in a held row', async () => {
    const m = await moved();
    m.verdict.now = 'kill';
    const a = await talk(m, 'mia', 'an ordinary sentence');
    const f = m.onOwner(a.key);
    expect(f.urgent).toBeUndefined();
    expect(f.stopScope).toBe('conversation');
    await vi.waitFor(() => expect(m.owner.spies.stops).toEqual(['conversation']));
    m.verdict.now = 'deliver';
    const b = await talk(m, 'owner', 'an ordinary sentence');
    expect(m.onOwner(b.key).stopScope).toBeUndefined();
    await vi.waitFor(() => expect(m.owner.dispatched).toHaveLength(1));
    expect(m.owner.spies.stops).toEqual(['conversation']);
  });

  it('a held stop acted on by a drain keeps the rule', async () => {
    const m = await moved();
    const a = await talk(m, 'mia', 'stop');
    const f = parseAppForward(JSON.stringify(m.routed[0].payload))!;
    m.owner.svc.applyCreate('d', rid(), a.key, 'Moved');
    m.owner.svc.ingestReplicated([f.event as never]);
    actOnUrgent(m.owner.svc, a.key, f, f.event.messageId);
    expect(m.owner.spies.stops).toEqual(['conversation']);
    expect(m.owner.svc.store.deliveryState(f.event.messageId)).toBe('intercepted');
  });

  it('a team member\'s send reaches the owner as theirs, never as the owner, in the session and in the store', async () => {
    const m = await moved();
    const a = await talk(m, 'mia', 'hello from Mia');
    const f = m.onOwner(a.key);
    await vi.waitFor(() => expect(m.owner.dispatched).toHaveLength(1));
    expect(f.memoryPersonId).toBe('mia');
    expect(m.owner.dispatched[0].memoryPersonId).toBe('mia');
    expect(m.owner.dispatched[0].ownerName).toBe('Mia');
    expect(f.event).toMatchObject({ senderName: 'Mia', senderRole: 'team' });
    expect(m.owner.spies.stops).toEqual([]);
    const b = await talk(m, 'owner', 'hello from the owner');
    expect(m.onOwner(b.key).memoryPersonId).toBeNull();
    await vi.waitFor(() => expect(m.owner.dispatched).toHaveLength(2));
    expect(m.owner.dispatched[1].memoryPersonId).toBeNull();
  });

  /** The route's real forward, as a row with its fields changed: an older holder, or a damaged one. */
  const rowOf = (m: Awaited<ReturnType<typeof moved>>, change: (p: Record<string, unknown>) => void = () => undefined) => {
    const last = m.routed[m.routed.length - 1];
    const p = JSON.parse(JSON.stringify(last.payload)) as Record<string, unknown>;
    change(p);
    return { sessionKey: last.sessionKey, messageId: last.messageId, payload: JSON.stringify(p), senderEnvelope: last.senderEnvelope };
  };
  const ready = (m: Awaited<ReturnType<typeof moved>>, key: string) => {
    if (!m.owner.svc.liveConversation(key)) m.owner.svc.applyCreate('d', rid(), key, 'Moved');
    m.owner.svc.channels.register(String(m.owner.registry.appAliasFor(key)), 'sess-owner');
  };
  const handover = { commitReceipt: () => true, stopRecheck: () => false };
  const landsHere = (m: Awaited<ReturnType<typeof moved>>, h: Partial<typeof handover> = {}) => {
    const deliver = createAppDrainDeliver({ service: () => m.owner.svc, routerReady: () => true, route: async () => ({ action: 'handled-locally', acked: true }) });
    return (row: ReturnType<typeof rowOf>) => deliver(row, { ...handover, ...h });
  };

  it('a row with no scope, from an older holder or the queue, still stops only that conversation', async () => {
    const m = await moved();
    const a = await talk(m, 'mia', 'stop');
    ready(m, a.key);
    const row = rowOf(m, (p) => { delete p.stopScope; });
    expect(parseAppForward(row.payload)!.stopScope).toBe('conversation');
    m.receiver.accepted(row.sessionKey, row.messageId, row.payload);
    expect(m.owner.spies.stops).toEqual(['conversation']);
    await landsHere(m)({ ...row, messageId: 'another-attempt' });
    expect(m.owner.spies.stops).toEqual(['conversation', 'conversation']);
    // The owner's own stop stays whole: the field is forced only for a team sender.
    const b = await talk(m, 'owner', 'stop');
    expect(parseAppForward(rowOf(m).payload)!.stopScope).toBeUndefined();
    expect(b.r.body.deliveryState).toBe('intercepted');
  });

  it('a team send with no person is refused on the owner and in a drain, never run as the owner\'s', async () => {
    const m = await moved();
    const a = await talk(m, 'mia', 'hello');
    ready(m, a.key);
    const row = rowOf(m, (p) => { p.memoryPersonId = null; });
    m.receiver.ingest(row.sessionKey, row.payload);
    m.receiver.accepted(row.sessionKey, row.messageId, row.payload);
    await vi.waitFor(() => expect(m.owner.svc.store.deliveryState(row.messageId)).toBe('refused'));
    const held = await talk(m, 'mia', 'hello again');
    ready(m, held.key);
    const heldRow = rowOf(m, (p) => { p.memoryPersonId = null; });
    m.receiver.ingest(heldRow.sessionKey, heldRow.payload);
    expect(await landsHere(m)(heldRow)).toEqual({ kind: 'local-delivered' });
    expect(m.owner.svc.store.deliveryState(heldRow.messageId)).toBe('refused');
    expect(m.owner.dispatched).toEqual([]);
  });

  it('only the owner\'s own message may fall back to the owner\'s name', async () => {
    const m = await moved();
    const a = await talk(m, 'mia', 'hello');
    const noName = parseAppForward(rowOf(m, (p) => { p.ownerName = null; }).payload)!;
    expect(forwardSpeakerName(m.owner.svc, noName)).toBe('Mia');
    const blank = parseAppForward(rowOf(m, (p) => { p.ownerName = null; delete (p.event as Record<string, unknown>).senderName; }).payload)!;
    expect(forwardSpeakerName(m.owner.svc, blank)).toBe('Another person');
    for (const role of ['msp', 'team']) {
      const other = parseAppForward(rowOf(m, (p) => { p.ownerName = null; const e = p.event as Record<string, unknown>; e.senderRole = role; delete e.senderName; }).payload)!;
      expect(forwardSpeakerName(m.owner.svc, other)).not.toBe('Ann');
    }
    const owners = parseAppForward(rowOf(m, (p) => { p.ownerName = null; const e = p.event as Record<string, unknown>; e.senderRole = 'owner'; }).payload)!;
    expect(forwardSpeakerName(m.owner.svc, owners)).toBe('Ann');
    ready(m, a.key);
    const row = rowOf(m, (p) => { p.ownerName = null; });
    m.receiver.ingest(row.sessionKey, row.payload);
    m.receiver.accepted(row.sessionKey, row.messageId, row.payload);
    await vi.waitFor(() => expect(m.owner.dispatched).toHaveLength(1));
    expect(m.owner.dispatched[0].ownerName).toBe('Mia');
  });

  it('a team event whose signature failed does nothing: no stop, no send. One not yet checkable still runs', async () => {
    const m = await moved();
    const a = await talk(m, 'mia', 'stop');
    ready(m, a.key);
    const verify = vi.spyOn(m.owner.svc, 'verify').mockReturnValue('failed');
    const stop = rowOf(m);
    m.receiver.ingest(stop.sessionKey, stop.payload);
    m.receiver.accepted(stop.sessionKey, stop.messageId, stop.payload);
    expect(m.owner.spies.stops).toEqual([]);
    expect(m.owner.svc.store.deliveryState(stop.messageId)).toBe('refused');
    const b = await talk(m, 'mia', 'hello');
    ready(m, b.key);
    const send = rowOf(m);
    m.receiver.ingest(send.sessionKey, send.payload);
    m.receiver.accepted(send.sessionKey, send.messageId, send.payload);
    await vi.waitFor(() => expect(m.owner.svc.store.deliveryState(send.messageId)).toBe('refused'));
    expect(m.owner.dispatched).toEqual([]);
    const c = await talk(m, 'mia', 'hello there');
    ready(m, c.key);
    const held = rowOf(m);
    m.receiver.ingest(held.sessionKey, held.payload);
    expect(await landsHere(m)(held)).toEqual({ kind: 'local-delivered' });
    expect(m.owner.svc.store.deliveryState(held.messageId)).toBe('refused');
    verify.mockReturnValue('unknown');
    const d = await talk(m, 'mia', 'once more');
    ready(m, d.key);
    const later = rowOf(m);
    m.receiver.ingest(later.sessionKey, later.payload);
    m.receiver.accepted(later.sessionKey, later.messageId, later.payload);
    await vi.waitFor(() => expect(m.owner.dispatched).toHaveLength(1));
    // The owner's own failed verdict keeps today's policy: delivered, and flagged by the verdict.
    verify.mockReturnValue('failed');
    const e = await talk(m, 'owner', 'from the owner');
    ready(m, e.key);
    const own = rowOf(m);
    m.receiver.ingest(own.sessionKey, own.payload);
    m.receiver.accepted(own.sessionKey, own.messageId, own.payload);
    await vi.waitFor(() => expect(m.owner.dispatched).toHaveLength(2));
  });

  describe('the drain', () => {
    it('delivers a team send as theirs once, and acts on a held stop in its scope', async () => {
      const m = await moved();
      const a = await talk(m, 'mia', 'hello');
      ready(m, a.key);
      const row = rowOf(m);
      m.receiver.ingest(row.sessionKey, row.payload);
      const deliver = landsHere(m);
      expect(await deliver(row)).toEqual({ kind: 'local-delivered' });
      expect(m.owner.dispatched).toHaveLength(1);
      expect(m.owner.dispatched[0].memoryPersonId).toBe('mia');
      expect(m.owner.svc.store.deliveryState(row.messageId)).toBe('delivered');
      await deliver(row); // already handled: never a second dispatch
      expect(m.owner.dispatched).toHaveLength(1);
      const b = await talk(m, 'mia', 'stop');
      ready(m, b.key);
      const stop = rowOf(m, (p) => { delete p.stopScope; });
      m.receiver.ingest(stop.sessionKey, stop.payload);
      expect(await deliver(stop)).toEqual({ kind: 'local-delivered' });
      expect(m.owner.spies.stops).toEqual(['conversation']);
      expect(m.owner.svc.store.deliveryState(stop.messageId)).toBe('intercepted');
    });

    it('answers for every way a row does not land here', async () => {
      const m = await moved();
      const a = await talk(m, 'mia', 'hello');
      ready(m, a.key);
      const row = rowOf(m);
      m.receiver.ingest(row.sessionKey, row.payload);
      const via = (out: Record<string, unknown>) => createAppDrainDeliver({ service: () => m.owner.svc, routerReady: () => true, route: async () => out as never });
      expect(await via({ action: 'queued', detail: 'mid-move' })(row, handover)).toEqual({ kind: 'un-routable', reason: 'mid-move' });
      expect(await via({ action: 'forwarded' })(row, handover)).toEqual({ kind: 'remote-delivered' });
      expect(await landsHere(m, { commitReceipt: () => false })(row)).toEqual({ kind: 'handover-refused' });
      expect(await landsHere(m, { stopRecheck: () => true })(row)).toEqual({ kind: 'stopped-before-inject' });
      expect(m.owner.dispatched).toEqual([]);
      expect(await via({ action: 'rejected' })(row, handover)).toEqual({ kind: 'sender-rejected' });
      expect(m.owner.svc.store.deliveryState(row.messageId)).toBe('refused');
      expect((await createAppDrainDeliver({ service: () => m.owner.svc, routerReady: () => true, route: async () => ({ action: 'forwarded' }) as never })({ ...row, payload: 'not a forward' }, handover)).kind).toBe('failed');
    });
  });

  it('only the one known scope survives parsing', () => {
    const event = { kind: 'message', conversationKey: 'k', messageId: 'm', eventId: 'e' };
    expect(parseAppForward({ kind: 'app-forward', event, seed: 's', stopScope: 'conversation' })!.stopScope).toBe('conversation');
    expect(parseAppForward({ kind: 'app-forward', event, seed: 's', stopScope: 'everything' })!.stopScope).toBeUndefined();
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

  it('carry no file paths from a scoped session; other callers keep theirs', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { if (req.headers['x-scoped']) res.locals.memorySession = { sessionId: 'mine' }; next(); });
    app.use(createRoutes({
      config: { projectName: 'x', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-hook-')), sessions: {}, scheduler: {} },
      startTime: new Date(), scheduler: null,
      hookEventReceiver: { receive: (e: Record<string, unknown>) => { seen.push(e); return true; }, storeEvent: (e: Record<string, unknown>) => { seen.push(e); return true; } },
      sessionManager: { listRunningSessions: () => [], getSessionById: () => null, setClaudeSessionId: () => undefined },
      state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined, get: () => undefined },
    } as unknown as RouteContext));
    const body = { event: 'PostToolUse', session_id: 'x', transcript_path: '/etc/passwd', agent_transcript_path: '/etc/hosts', cwd: '/scope' };
    await request(app).post('/hooks/events').set('x-scoped', '1').send(body);
    expect(JSON.stringify(seen)).not.toContain('/etc/passwd');
    expect(JSON.stringify(seen)).not.toContain('/scope');
    seen.length = 0;
    await request(app).post('/hooks/events').send(body);
    expect(JSON.stringify(seen)).toContain('/etc/passwd');
  });
});

describe('with no access log able to open', () => {
  it('team access counts as on once there are signs of a team, and stays off on an agent that never had one', async () => {
    const e = await setup();
    const owner = phone(e);
    expect(e.pairing.teamOn()).toBe(false);
    await send(e, owner, 'POST', '/mobile/team/invites', { events: [{ type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' }, { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' }] });
    e.pairing.teamLogInstance = null;
    e.pairing.keyLedger = null;
    expect(e.pairing.teamLog()).toBeNull();
    expect(e.pairing.teamOn()).toBe(true);
  });
});

describe('phones across machines', () => {
  it('an active team phone is bound in the log, once', async () => {
    const { e, mia } = await withMember();
    e.pairing.bindTeamPhones();
    e.pairing.bindTeamPhones();
    const binds = e.pairing.teamLog()!.allRows().flatMap((r) => (r.kind === 'machine' ? r.events.filter((x) => x.type === 'phone-bind' && x.deviceId === mia.id) : []));
    expect(binds).toHaveLength(1);
  });

  it('a removal that arrives here revokes this machine\'s phones for that person, and nobody else\'s', async () => {
    const { e, mia, owner } = await withMember();
    const stranger = phone(e, { userId: 'not-in-the-log-yet', role: 'team' });
    e.pairing.reconcileTeamPhones();
    expect(e.pairing.devices.get(mia.id)!.status).toBe('active');
    e.pairing.teamLog()!.appendMachineEvents([{ type: 'lower', personKey: 'mia', remove: true }]); // as a peer's row would fold
    e.pairing.reconcileTeamPhones();
    expect(e.pairing.devices.get(mia.id)!.status).toBe('revoked');
    expect(e.pairing.devices.get(owner.id)!.status).toBe('active');
    // A phone can pair before its person's row reaches this machine.
    expect(e.pairing.devices.get(stranger.id)!.status).toBe('active');
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
