/**
 * Feature-is-alive proof for native app conversations (docs/specs/mobile-native-conversations.md,
 * increment 1): an AgentServer booted on a development agent with NO Telegram and NO Slack
 * constructs the conversation service on its production path, a phone paired through the existing
 * redeem/confirm path creates a conversation, sends a signed message, the session manager
 * receives the `[app:…]`-tagged bootstrap with a bind token scoped to the conversation, the
 * session's reply through POST /app/session-reply is accepted, and history shows both.
 * Increment 2: the operator message reads `originVerified: "verified"` on a real boot (the
 * machine identity signer, the signing-key history and the device-key ledger are wired), and the
 * session tag carries "📱 signed".
 * Wiring integrity: the service, its store, the dispatch, the request store, the signer and the
 * ledger are real.
 */
import { createRemovalSyncCursorCodec } from '../../src/server/mobileAppRemovalSyncCursor.js';
import { SingleInstanceLock } from '../../src/core/SingleInstanceLock.js';
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
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-native-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

const writerLocks: SingleInstanceLock[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const lock of writerLocks) lock.release();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-conversations-alive.test.ts' });
});

async function boot(developmentAgent: boolean, appRemovalReadAcceptance?: (key: string) => boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'native-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  // Every agent gets a machine identity at `instar init`; the receipt signer reads it.
  const identity = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'native-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent, workBoard: { enabled: false },
    mobilePairing: { multiRoute: { enabled: false }, native: { messageLinks: { enabled: true }, quotedReplies: { enabled: true }, reactions: { enabled: true }, forwards: { enabled: true } } }, // the single-host path; multi-route has its own e2e
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: Array<{ message: string; options: { bootstrapConversationIds?: number[] } }> = [];
  sessionManager.spawnInteractiveSession = async (message: string, _name: string | undefined, options: { bootstrapConversationIds?: number[] }) => {
    spawned.push({ message, options });
    return 'app-session-1';
  };
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const singleInstanceLock = new SingleInstanceLock({ stateDir, env: {} });
  expect((await singleInstanceLock.acquire()).acquired).toBe(true);
  writerLocks.push(singleInstanceLock);
  const server = new AgentServer({ config, sessionManager, singleInstanceLock, appRemovalReadAcceptance, meshSelfId: identity.machineId, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, workBoard: () => null });
  servers.push(server);
  return { server, stateDir, spawned, singleInstanceLock };
}

describe('native app conversations — production wiring', () => {
  it('is alive on a development agent with no Telegram and no Slack: create, send, session tag, reply, history', async () => {
    const enrolled = new Set<string>();
    const { server, stateDir, spawned, singleInstanceLock } = await boot(true, (key) => enrolled.has(key));
    const app = server.getApp();
    // Wiring integrity: real, non-null components on the production path.
    expect(server.mobilePairing).not.toBeNull();
    expect(server.mobilePairing!.nativeOn).toBe(true);
    expect(server.appConversations).not.toBeNull();
    expect(server.appConversations!.store).toBeTruthy();
    expect(server.appConversations!.deps.dispatch()).toBeTypeOf('function');
    expect(server.appConversations!.deps.requests).toBe(server.mobilePairing!.chatRequests());
    expect(server.appConversations!.deps.onEmergencyStop).toBeTypeOf('function'); // the Telegram path's stop side effects
    expect(fs.existsSync(path.join(stateDir, 'scripts', 'app-reply.sh'))).toBe(true); // boot-time relay install
    // Signed records (increment 2): the signer, the key history and the ledger are wired, and the
    // pairing service writes activations to the same ledger.
    expect(server.appConversations!.deps.signer).toBeTruthy();
    expect(server.appConversations!.deps.keyLookup).toBeTypeOf('function');
    expect(server.appConversations!.deps.keyLedger).toBeTruthy();
    expect(server.mobilePairing!.keyLedger).toBe(server.appConversations!.deps.keyLedger);

    // Pair through the existing path (mint → redeem → owner code → confirm), owner DM stubbed.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'native-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerId = () => 91472; // Synthetic account, with no Telegram adapter.
    server.mobilePairing!.deps.telegramOwnerPresent = () => true; // the Telegram path (no owner ⇒ the dashboard path, §4.4)
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    const send = (method: 'GET' | 'POST' | 'PUT', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now());
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app)[method === 'PUT' ? 'put' : 'post'](p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

    // Create a native conversation and send a signed message.
    const created = await send('POST', '/mobile/conversations', { title: 'Plans', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    const ownerList = await send('GET', '/mobile/conversations');
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.conversations.some((c: { id: string }) => c.id === key)).toBe(true);
    const sent = await send('POST', `/mobile/chat/app/${key}`, { text: 'What is on for Saturday?', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, outcome: 'delivered' });

    // The session manager received the tagged bootstrap with a bind token scoped to the alias.
    expect(spawned).toHaveLength(1);
    const alias = spawned[0]!.options.bootstrapConversationIds![0]!;
    expect(alias).toBeLessThan(0);
    expect(spawned[0]!.message).toContain(`[app:${alias} "Plans" from Justin (📱 signed)] What is on for Saturday?`);
    // The confirm path wrote the activation to the ledger first.
    expect(server.mobilePairing!.keyLedger!.rows().map((r) => r.type)).toEqual(['activation']);

    // The session answers through app-reply.sh's route with its bind token.
    const token = createConversationBindAuth(stateDir).mint('app-session-1', [alias]);
    const reply = await auth(request(app).post('/app/session-reply')).set('X-Instar-Bind-Token', token)
      .send({ conversationId: alias, text: 'Saturday is the farmers market at nine.' });
    expect(reply.status).toBe(200);
    // The reply's notification preview is served on the production server (chat-media §4.11).
    const preview = await send('GET', `/mobile/chat/app/${key}/preview/${reply.body.messageId as string}`);
    expect(preview.status).toBe(200);
    expect(preview.body.body).toBe('Saturday is the farmers market at nine.');

    // History shows both, the operator message verified against the ledger and the machine receipt.
    const hist = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.status).toBe(200);
    expect(hist.body.messages.map((x: { role: string; text: string }) => [x.role, x.text])).toEqual([
      ['operator', 'What is on for Saturday?'],
      ['agent', 'Saturday is the farmers market at nine.'],
    ]);
    expect(hist.body.messages[0].originVerified).toBe('verified');
    expect(hist.body.messages[1].originVerified).toBe('none');
    const target = hist.body.messages[1].eventId as string;
    expect(singleInstanceLock.revalidateForExclusiveWrite()).toBe(true);
    const journalRevision = server.appConversations!.store.removalJournalRevision(key);
    expect(journalRevision).toEqual(expect.any(String));
    const darkDelete = await send('POST', `/mobile/chat/app/${key}/message-removals`, {
      custodianMachineId: server.appConversations!.deps.machineId(), eventId: target,
      requestId: `${Date.now()}-${crypto.randomUUID()}`,
    });
    expect(darkDelete.status).toBe(403);
    expect(server.appConversations!.store.messageRemoval(key, target, reply.body.messageId)).toEqual({ eventId: null });
    const afterDarkDelete = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(afterDarkDelete.status).toBe(200);
    expect(afterDarkDelete.body.messages.map((row: { eventId: string }) => row.eventId))
      .toEqual(hist.body.messages.map((row: { eventId: string }) => row.eventId));

    const exact = await send('GET', `/mobile/chat/app/${key}/message-context?target=${encodeURIComponent(target)}&targetKind=event`);
    expect(exact.status).toBe(200);
    expect(exact.body.anchorApplied).toEqual({ requestedTarget: target, eventId: target, messageId: reply.body.messageId });
    const link = await send('GET', `/mobile/conversations/message-link?ref=app%3A${key}&messageId=${encodeURIComponent(target)}&targetKind=event`);
    expect(link.status).toBe(200);
    expect(new URL(link.body.url).hostname).toBe(HOST);
    expect(link.body.position.eventId).toBe(target);
    server.appConversations!.store.append({
      kind: 'message-removed', conversationKey: key, eventId: 'dark-test-removal-fact',
      targetEventId: target, targetMessageId: reply.body.messageId,
      machineId: server.appConversations!.deps.machineId(), at: new Date().toISOString(),
    });
    expect(server.appConversations!.store.removalJournalRevision(key)).toBe(journalRevision);
    expect(await server.appConversations!.store.prepareRemovalHistory(key)).toBe(true);
    const protectedHistory = server.appConversations!.store.readPreparedRemovalHistory(key, null, 100);
    expect(protectedHistory?.messages.map((row) => row.text)).toEqual(['What is on for Saturday?']);
    expect(server.appConversations!.store.hasPreparedRemovalHistory(key, protectedHistory!.proof)).toBe(true);
    const darkEvents = await send('GET', `/mobile/chat/app/${key}/events`);
    expect(darkEvents.status).toBe(200);
    expect(darkEvents.body.events.map((event: { kind: string }) => event.kind)).not.toContain('message-removed');
    const privateCursor = createRemovalSyncCursorCodec().issue({
      custodianMachineId: server.appConversations!.deps.machineId(), conversationKey: key, deviceId,
      deviceKeyHash: 'unused-dark-fixture', readerId: 'unused-dark-fixture', visibilityRevision: 'fixture-1',
    }, 1000);
    const legacyWithPrivateCursor = await send('GET', `/mobile/chat/app/${key}/events?cursor=${encodeURIComponent(privateCursor)}`);
    expect(legacyWithPrivateCursor.status).toBe(200);
    expect(legacyWithPrivateCursor.body).toEqual(darkEvents.body);
    expect(legacyWithPrivateCursor.body).not.toHaveProperty('epoch');
    expect(legacyWithPrivateCursor.body).not.toHaveProperty('continuation');
    expect(legacyWithPrivateCursor.body).not.toHaveProperty('changes');
    expect(legacyWithPrivateCursor.body).not.toHaveProperty('blocked');
    expect(legacyWithPrivateCursor.body).not.toHaveProperty('highWater');
    expect(legacyWithPrivateCursor.body).not.toHaveProperty('displayForMs');
    const entry = await request(app).get('/dashboard/console/message-link-v1/');
    expect(entry.status).toBe(200);
    expect(entry.text).toContain('/dashboard/console/console.js?message-link-v1');

    // The approval method rides the verified row (spec §4.6 display).
    expect(hist.body.messages[0].originApprovedVia).toBe('telegram-dm');
    // Pool reads are wired on the production server: a single machine answers with an empty
    // pool.failed, the same rows, and one list cursor across every kind.
    const poolHist = await send('GET', `/mobile/chat/app/${key}/messages?scope=pool`);
    expect(poolHist.status).toBe(200);
    expect(poolHist.body.pool).toEqual({ failed: [] });
    expect(poolHist.body.messages.map((x: { text: string }) => x.text)).toEqual(hist.body.messages.map((x: { text: string }) => x.text));
    const poolList = await send('GET', '/mobile/conversations?scope=pool');
    expect(poolList.status).toBe(200);
    expect(poolList.body).toMatchObject({ conversations: [expect.objectContaining({ id: key, platform: 'app' })], nextCursor: null, pool: { failed: [] } });
    const health = await auth(request(app).get('/health'));
    expect(health.body.appConversations).toMatchObject({ count: 1 });

    const quoted = await send('POST', `/mobile/chat/app/${key}/reply`, {
      text: 'Thanks for the details.', requestId: `${Date.now()}-${crypto.randomUUID()}`, replyTo: { eventId: target },
    });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
    const quotedEvent = server.appConversations!.store.getEvent(key, quoted.body.eventId);
    expect(quotedEvent).toMatchObject({ replyTo: { eventId: target }, receipt: { v: 3 } });

    const capabilities = await send('GET', '/mobile/conversations');
    expect(capabilities.body.conversations[0].messageActions).toMatchObject({ reply: true });
    expect(capabilities.body.conversations[0].messageActions).not.toHaveProperty('delete');
    const previews = await send('GET', `/mobile/chat/app/${key}/reply-previews?eventId=${encodeURIComponent(quoted.body.eventId)}`);
    expect(previews.status).toBe(200);
    expect(previews.body.messages).toEqual([{ eventId: quoted.body.eventId, reply: {
      state: 'available', eventId: target, messageId: reply.body.messageId,
      preview: 'Saturday is the farmers market at nine.', senderName: null,
    } }]);

    expect(capabilities.body.conversations[0].messageActions.reactions.emoji).toContain('👍');
    const reaction = await send('PUT', `/mobile/chat/app/${key}/reactions`, {
      eventId: target, emoji: '👍', expectedRevision: 0, requestId: `${Date.now()}-${crypto.randomUUID()}`,
    });
    expect(reaction.status, JSON.stringify(reaction.body)).toBe(200);
    expect(reaction.body).toEqual({ eventId: target, own: { emoji: '👍', revision: 1 } });
    const exactReaction = await send('GET', `/mobile/chat/app/${key}/reactions?eventId=${encodeURIComponent(target)}`);
    expect(exactReaction.status).toBe(200);
    expect(exactReaction.body).toEqual(reaction.body);

    const reacted = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(reacted.body.messages.find((row: { eventId: string }) => row.eventId === target).reaction.own)
      .toEqual({ emoji: '👍', revision: 1 });

    const destination = await send('POST', '/mobile/conversations',
      { title: 'Forward destination', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(destination.status).toBe(200);
    const dest = destination.body.conversationKey;
    server.appConversations!.store.append({ kind: 'message', conversationKey: dest, eventId: 'earlier-context-event',
      messageId: 'earlier-context-message', role: 'agent', text: 'Earlier ordinary context',
      at: '2026-11-20T00:00:00.000Z', machineId: server.appConversations!.deps.machineId() });
    const forwardPath = `/mobile/chat/app/${dest}/forward`;
    const intent = { custodianMachineId: server.appConversations!.deps.machineId(), sourceConversationKey: key, sourceEventId: target, requestId: `${Date.now()}-${crypto.randomUUID()}` };
    const before = spawned.length;
    const copy = await send('POST', forwardPath, intent);
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    expect((await send('POST', forwardPath, intent)).body).toEqual(copy.body);
    const copies = await send('GET', `/mobile/chat/app/${dest}/messages`);
    expect(copies.body.messages).toEqual([
      expect.objectContaining({ text: 'Earlier ordinary context' }),
      expect.objectContaining({ ...copy.body, forwarded: true, text: 'Saturday is the farmers market at nine.' }),
    ]);
    const raw = await send('GET', `/mobile/chat/app/${dest}/events`);
    expect(raw.status).toBe(200);
    const copiedEvent = raw.body.events.find((event: { eventId: string }) => event.eventId === copy.body.eventId);
    expect(copiedEvent).toMatchObject({ forwarded: true });
    expect(copiedEvent).not.toHaveProperty('forwardBinding');
    expect(spawned).toHaveLength(before);
    const next = await send('POST', `/mobile/chat/app/${dest}/reply`,
      { text: 'An ordinary new message', requestId: `${Date.now()}-${crypto.randomUUID()}`, replyTo: { eventId: copy.body.eventId } });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(spawned).toHaveLength(before + 1);
    const contextPath = spawned.at(-1)!.message.match(/Read (.+?\.txt) for conversation history/)?.[1];
    expect(contextPath).toBeTruthy();
    expect(spawned.at(-1)!.message).toContain('An ordinary new message');
    expect(spawned.at(-1)!.message).not.toContain('Saturday is the farmers market at nine.');
    const context = fs.readFileSync(contextPath!, 'utf8');
    expect(context).toContain('Earlier ordinary context');
    expect(context).not.toContain('Saturday is the farmers market at nine.');

    expect(server.mobilePairing!.machineId()).toBe(server.appConversations!.deps.machineId());
    enrolled.add(key);
    const acceptedHistory = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(acceptedHistory.status, JSON.stringify(acceptedHistory.body)).toBe(200);
    expect(acceptedHistory.headers['cache-control']).toBe('no-store');
    expect(acceptedHistory.body.messages.map((row: { eventId: string }) => row.eventId)).not.toContain(target);
    expect(acceptedHistory.body).not.toHaveProperty('displayForMs');
    const acceptedSync = await send('GET', `/mobile/chat/app/${key}/events`);
    expect(acceptedSync.status, JSON.stringify(acceptedSync.body)).toBe(200);
    expect(acceptedSync.body.epoch).toBe(acceptedHistory.body.epoch);
    const protectedQuotes = await send('GET', `/mobile/chat/app/${key}/reply-previews?eventId=${encodeURIComponent(quoted.body.eventId)}&eventId=${encodeURIComponent(target)}`);
    expect(protectedQuotes.status).toBe(200);
    expect(protectedQuotes.body).toEqual({ conversationKey: key, epoch: acceptedHistory.body.epoch, messages: [
      { eventId: quoted.body.eventId, reply: { state: 'unavailable' } }, { eventId: target },
    ] });

    const removedContext = await send('GET', `/mobile/chat/app/${key}/message-context?target=${encodeURIComponent(target)}&targetKind=event`);
    expect(removedContext.status).toBe(404);
    const linkFor = (eventId: string) => send('GET', `/mobile/conversations/message-link?ref=app%3A${key}&messageId=${encodeURIComponent(eventId)}&targetKind=event`);
    const removedLink = await linkFor(target);
    const unknownLink = await linkFor('unknown-exact-event');
    expect(removedLink.status).toBe(409);
    expect(removedLink.body).toEqual(unknownLink.body);
    expect(removedLink.body).not.toHaveProperty('url');
    const survivingLink = await linkFor(quoted.body.eventId);
    expect(survivingLink.status).toBe(200);
    expect(survivingLink.body.position.eventId).toBe(quoted.body.eventId);
    expect(new URL(survivingLink.body.url).hostname).toBe(HOST);

    const liveContext = await send('GET', `/mobile/chat/app/${key}/message-context?target=${encodeURIComponent(quoted.body.eventId)}&targetKind=event&limit=1`);
    expect(liveContext.status, JSON.stringify(liveContext.body)).toBe(200);
    expect(liveContext.body).toMatchObject({ epoch: acceptedHistory.body.epoch, anchorApplied: { eventId: quoted.body.eventId } });
    const older = liveContext.body.nextContextBefore;
    const previousContext = await send('GET', `/mobile/chat/app/${key}/message-context?beforeAt=${encodeURIComponent(older.at)}&beforeEventId=${encodeURIComponent(older.eventId)}`);
    expect(previousContext.status).toBe(200);
    expect(previousContext.body.messages).toEqual([expect.objectContaining({ text: 'What is on for Saturday?' })]);

    expect(acceptedSync.body.changes).toContainEqual({
      kind: 'message-removed', conversationKey: key, eventId: 'dark-test-removal-fact', targetEventId: target,
    });
    expect((await send('GET', `/mobile/chat/app/${key}/messages?scope=pool`)).status).toBe(400);
    expect((await auth(request(app).get(`/mobile/chat/app/${key}/messages`))).status).toBe(403);
    expect((await send('GET', `/mobile/chat/app/${dest}/messages`)).body).not.toHaveProperty('epoch');
    enrolled.delete(key);
    expect((await send('GET', `/mobile/chat/app/${key}/messages`)).body.epoch).toBe(acceptedHistory.body.epoch);

    // A ledger revocation alone refuses the phone at once on the production auth path, even if
    // the registry write after it failed (the registry still says active here).
    server.mobilePairing!.keyLedger!.recordRevocation(server.mobilePairing!.devices.get(deviceId)!, new Date().toISOString());
    expect(server.mobilePairing!.devices.get(deviceId)!.status).toBe('active');
    const refused = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(refused.status).toBe(401);
  });

  it('is off on a fleet agent: the routes answer 503', async () => {
    const { server } = await boot(false);
    expect(server.appConversations).toBeNull();
    const res = await request(server.getApp()).get('/mobile/conversations').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'native-e2e');
    expect(res.status).toBe(503);
  });
});
