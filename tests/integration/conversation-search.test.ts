// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Keyword search over conversations (docs/specs/conversation-search.md) through the production
 * auth middleware, the real device allowlist and team log, the real conversation store and the
 * real TopicMemory index: the owner finds hits in all three channels, a team member never sees a
 * hit from a conversation they were not given, `ref=` restricts, the errors, the off switch, and a
 * pool read that names a machine that did not answer.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { createConversationSearchRouter } from '../../src/server/mobileConversationSearchRoutes.js';
import { createTeamRouter } from '../../src/server/teamRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const GRANTED = 50;
const OTHER = 51;
const dirs: string[] = [];
const services: MobilePairingService[] = [];
const memories: TopicMemory[] = [];
const servers: Server[] = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const s of services) s.stop();
  for (const m of memories) m.close();
  for (const s of servers) s.close();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/conversation-search.test.ts' });
});

type Peer = { machineId: string; url: string; kind: 'lan' };
async function setup(opts: { machine?: string; peers?: () => Peer[]; searchOff?: boolean } = {}) {
  const machine = opts.machine ?? 'm1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-search-int-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'mo', name: 'Mo', channels: [], permissions: ['user'] }]));
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test' });
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Ann' }, tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    mobilePairing: { enabled: true, multiRoute: { enabled: false }, native: { enabled: true, ...(opts.searchOff ? { search: { enabled: false } } : {}) } },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => machine, isRecordingEnabled: () => true });
  const deps = {
    config: config as never, stateDir: dir, holdsLease: () => true, selfMachineId: machine, teamGate: () => 'ok',
    tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), ownerDM: async () => 1, telegramOwnerId: () => 777,
  } as unknown as MobilePairingDeps;
  const pairing = new MobilePairingService(deps);
  services.push(pairing);
  pairing.nativeOn = true;
  const signer = loadMachineSigner(dir)!;
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup: identityKeyLookup(dir) });
  pairing.push = { onAppReply: () => undefined } as never;
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => machine, registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Ann',
    killSession: () => true, dispatch: () => async (input) => { svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  pairing.useAppConversationStore(svc.store);
  const tm = new TopicMemory(dir); memories.push(tm);
  await tm.open();
  tm.insertMessages([
    { messageId: 11, topicId: GRANTED, text: `the rocket launch for topic ${GRANTED}`, fromUser: true, timestamp: '2026-11-09T10:00:00.000Z', sessionName: null },
    { messageId: 12, topicId: OTHER, text: `secret rocket plans in topic ${OTHER}`, fromUser: false, timestamp: '2026-11-09T10:01:00.000Z', sessionName: null },
  ]);
  const topics = () => [GRANTED, OTHER].map((topicId) => ({ topicId, topicName: `Topic ${topicId}`, sessionName: null }));
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: machine, mobilePairingService: pairing,
    sessionManager: { listRunningSessions: () => [], killSession: () => true, isSessionAlive: () => true, captureOutput: () => '' },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined, listSessions: () => [], get: () => undefined },
    topicOperatorStore: { setAuthenticatedOperator: () => undefined }, conversationRegistry: registry, appConversations: svc,
    telegram: { getOwnerUserId: () => 777, getTopicHistory: () => [], getAllTopicMappings: topics, isAuthorizedSender: () => true },
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createTeamRouter(pairing, {
    signer: () => signer, applyConversationChange: async (_r, c) => c(), isSystemTopic: () => false, isJobTopic: () => false,
    ownerProfile: () => ({ userId: 'owner-1', several: false, links: {} }), logsDir: path.join(dir, 'logs'), stateDir: dir, conversationTitle: () => null,
    restoreRefs: () => ({ teamRefs: [], allRefs: () => [] }), requireMemoryPrivacy: () => true,
  }));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => machine }));
  app.use(createConversationSearchRouter({
    config: config as never, pairing, service: svc, machineId: () => machine, topicMemory: () => tm,
    telegramTopics: () => topics().map((t) => ({ topicId: t.topicId, topicName: t.topicName })),
    slack: () => ({
      conversations: () => [{ id: -7, title: '#general' }],
      history: () => [{ ts: '1700000000.000100', text: 'rocket talk in slack', fromUser: true, at: '2026-11-09T11:00:00.000Z' }],
    }),
    pool: { config: config as never, resolvePeerUrls: opts.peers ?? (() => []), recordRopeResult: null },
  }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  return { app, pairing, svc, machine };
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
const bearer = (e: Env, url: string) => request(e.app).get(url).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'echo');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

/** An app conversation with two messages, created by `by`. */
async function appConversation(e: Env, by: Phone, title: string, words: string): Promise<string> {
  const r = await send(e, by, 'POST', '/mobile/conversations', { title, requestId: rid() });
  expect(r.status).toBe(200);
  const key = r.body.conversationKey as string;
  e.svc.store.append({ eventId: `${title}-1`, kind: 'message', conversationKey: key, at: '2026-11-09T12:00:00.000Z', machineId: e.machine, messageId: `${title}-m1`, role: 'agent', text: words } as never);
  return key;
}

/** Team access on, Mia a member holding topic GRANTED. */
async function withMember(e: Env) {
  const owner = phone(e);
  const r = await send(e, owner, 'POST', '/mobile/team/invites', { events: [
    { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' }, { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' },
    { type: 'grant', personKey: 'mia', ref: `telegram:${GRANTED}`, access: 'use' },
  ] });
  expect(r.status).toBe(200);
  return { owner, mia: phone(e, { userId: 'mia', role: 'team' }) };
}

describe('the owner', () => {
  it('finds hits in app conversations, Telegram topics and Slack, each with the id the history uses', async () => {
    const e = await setup();
    const owner = phone(e);
    const key = await appConversation(e, owner, 'Trip', 'pack the rocket fuel');
    const r = await send(e, owner, 'GET', '/mobile/conversations/search?q=rocket');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ query: 'rocket', mode: 'keyword', ref: null, partial: false, failedMachines: [] });
    const refs = (r.body.results as Array<{ ref: string; messageId: string; platform: string; snippet: string; marks: Array<{ start: number; length: number }> }>);
    expect(refs.map((h) => `${h.ref} ${h.messageId}`).sort()).toEqual([
      `app:${key} Trip-1`, 'slack:m1:-7 slack:1700000000.000100', `telegram:${GRANTED} in:11`, `telegram:${OTHER} out:12`,
    ].sort());
    for (const h of refs) expect(h.snippet.slice(h.marks[0].start, h.marks[0].start + h.marks[0].length).toLowerCase()).toBe('rocket');
    // The agent's own token reads as the owner.
    expect((await bearer(e, '/mobile/conversations/search?q=rocket')).body.results).toHaveLength(4);
  });

  it('ref= searches inside one conversation', async () => {
    const e = await setup();
    const owner = phone(e);
    await appConversation(e, owner, 'Trip', 'pack the rocket fuel');
    const r = await send(e, owner, 'GET', `/mobile/conversations/search?q=rocket&ref=telegram:${GRANTED}`);
    expect(r.status).toBe(200);
    expect(r.body.ref).toBe(`telegram:${GRANTED}`);
    expect(r.body.results.map((h: { ref: string }) => h.ref)).toEqual([`telegram:${GRANTED}`]);
  });
});

describe('a team member', () => {
  it('gets hits only from what they were given', async () => {
    const e = await setup();
    const { owner, mia } = await withMember(e);
    const ownerKey = await appConversation(e, owner, 'Private', 'rocket budget numbers');
    const miaKey = await appConversation(e, mia, 'Mine', 'my rocket notes');
    const r = await send(e, mia, 'GET', '/mobile/conversations/search?q=rocket');
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(r.body.results.map((h: { ref: string }) => h.ref).sort()).toEqual([`app:${miaKey}`, `telegram:${GRANTED}`].sort());
    expect(text).not.toContain(`topic ${OTHER}`);
    expect(text).not.toContain('budget');
    expect(text).not.toContain('slack');
    // Naming a conversation they were not given is the same 404 a missing one gets.
    expect((await send(e, mia, 'GET', `/mobile/conversations/search?q=rocket&ref=telegram:${OTHER}`)).status).toBe(404);
    expect((await send(e, mia, 'GET', `/mobile/conversations/search?q=rocket&ref=app:${ownerKey}`)).body.error).toBe('unknown-conversation');
  });
});

describe('the answers that refuse', () => {
  it('validates the query, the ref, the mode and the scope', async () => {
    const e = await setup();
    const owner = phone(e);
    expect((await send(e, owner, 'GET', '/mobile/conversations/search?q=%20%20')).body.error).toBe('bad-query');
    expect((await send(e, owner, 'GET', `/mobile/conversations/search?q=${'a'.repeat(201)}`)).body.error).toBe('bad-query');
    expect((await send(e, owner, 'GET', '/mobile/conversations/search?q=x&ref=nope')).body.error).toBe('bad-ref');
    const meaning = await send(e, owner, 'GET', '/mobile/conversations/search?q=x&mode=meaning');
    expect([meaning.status, meaning.body.error]).toEqual([400, 'mode-unsupported']);
    expect((await send(e, owner, 'GET', '/mobile/conversations/search?q=x&scope=all')).body.error).toBe('invalid-scope');
    expect((await send(e, owner, 'GET', '/mobile/conversations/search?q=x&ref=telegram:999')).status).toBe(404);
    expect((await send(e, owner, 'GET', '/mobile/conversations/search?q=%3F%21')).body.results).toEqual([]);
  });

  it('the off switch answers 503 search-off', async () => {
    const e = await setup({ searchOff: true });
    const r = await send(e, phone(e), 'GET', '/mobile/conversations/search?q=rocket');
    expect([r.status, r.body.error]).toEqual([503, 'search-off']);
  });
});

describe('a pool read', () => {
  it('merges an answering machine and names the one that did not answer', async () => {
    const peer = await setup({ machine: 'm2' });
    const peerOwner = phone(peer);
    const peerKey = await appConversation(peer, peerOwner, 'Remote', 'rocket on the other machine');
    const server = peer.app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    const e = await setup({ peers: () => [
      { machineId: 'm2', url: `http://127.0.0.1:${port}`, kind: 'lan' },
      { machineId: 'm3', url: 'http://127.0.0.1:9', kind: 'lan' },
    ] });
    const r = await bearer(e, '/mobile/conversations/search?q=rocket&scope=pool');
    expect(r.status).toBe(200);
    expect(r.body.partial).toBe(true);
    expect(r.body.failedMachines).toEqual(['m3']);
    const refs = r.body.results.map((h: { ref: string; machine?: string }) => h.ref);
    expect(refs).toContain(`app:${peerKey}`);
    expect(refs).toContain('slack:m2:-7');
    // The same Telegram message held on both machines is listed once.
    expect(refs.filter((x: string) => x === `telegram:${GRANTED}`)).toHaveLength(1);
    // Without scope=pool only this machine is searched.
    const local = await bearer(e, '/mobile/conversations/search?q=rocket');
    expect(local.body.results.map((h: { ref: string }) => h.ref)).not.toContain(`app:${peerKey}`);
    expect(local.body.partial).toBe(false);
  });
});
