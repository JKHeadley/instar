/** Real AgentServer initialization: personal archive and mute through signed HTTP and the production push hook. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { FOLD_MS } from '../../src/core/MobilePush.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { makeDevice } from '../helpers/mobileDevice.js';
const HOST = 'preferences-e2e.example.dev';
const servers: AgentServer[] = []; const dirs: string[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop();
  for (const dir of dirs) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/conversation-preferences-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preferences-alive-')); dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const sub of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'users.json'), '[]');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Preference lifecycle machine' });
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const vault = new SecretStore({ stateDir, forceFileKey: true }); vault.set('apns_key_p8', key); vault.set('apns_key_id', 'TEST_KEY');
  const config = { projectName: 'preferences-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: '482915',
    secrets: { forceFileKey: true }, mobilePairing: { multiRoute: { enabled: false }, push: { teamId: 'TEST_TEAM' } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any; sessionManager.on = () => undefined;
  sessionManager.memoryPrivacyStatus = () => ({ enabled: true, sandboxReady: true, multiPerson: false, ownerUserId: null, blocker: null, fix: null });
  sessionManager.applyConversationChange = async (_ref: string, change: () => unknown) => change();
  const spawned: string[] = []; sessionManager.spawnInteractiveSession = async (message: string) => { spawned.push(message); return 'preferences-session'; }; sessionManager.injectMessage = () => true;
  const clock = { now: Date.now() }; const sent: any[] = [];
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel,
    mobilePushNow: () => clock.now, mobilePushTransport: async (_environment, _token, _headers, body) => { sent.push(JSON.parse(body)); return { status: 200 }; },
  }); servers.push(server); server.mobilePairing!.push!.stop();
  return { server, stateDir, spawned, clock, sent };
}

describe('conversation preferences — production wiring', () => {
  it('archives reversibly without losing history, suppresses a queued muted reply, and still delivers an independent item', async () => {
    const { server, stateDir, spawned, clock, sent } = await boot(); const app = server.getApp(); const mp = server.mobilePairing!;
    expect(server.conversationPreferences).not.toBeNull(); expect(mp.push!.supportsTypedPreferences).toBe(true);
    const phone = makeDevice(); const pending = mp.devices.createPending({ deviceName: 'Owner phone', label: null, publicKey: phone.publicKey, host: HOST });
    if (!pending.ok) throw new Error('fixture phone'); const id = pending.device.id;
    mp.keyLedger!.recordActivation(pending.device, 'dashboard-pin', new Date().toISOString()); mp.devices.applyConfirm(id, { ok: true, approvedVia: 'dashboard-pin' });
    let lastTime = Date.now();
    const signed = (method: 'GET' | 'POST', route: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body)); const time = String(++lastTime);
      const q = method === 'GET' ? request(app).get(route) : request(app).post(route).set('Content-Type', 'application/json');
      q.set('Host', HOST).set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', phone.sign(canonicalString(id, HOST, method, route, time, raw)));
      return raw ? q.send(raw.toString()) : q;
    };
    const registered = await signed('POST', '/mobile/device/push', { token: 'a'.repeat(64), environment: 'sandbox', notifyTokenHash: 'b'.repeat(64), revision: 1 });
    expect(registered.status).toBe(200); expect(registered.body.ready).toBe(true);
    const create = await signed('POST', '/mobile/conversations', { title: '📚 Preference Lifecycle', requestId: `${Date.now()}-${crypto.randomUUID()}` }); expect(create.status, JSON.stringify(create.body)).toBe(200);
    const key = create.body.conversationKey as string; const ref = `app:${key}`;
    expect((await signed('POST', `/mobile/chat/app/${key}`, { text: 'Keep this conversation.', requestId: `${Date.now()}-${crypto.randomUUID()}` })).status).toBe(200);
    const alias = Number(/\[app:(-\d+) /.exec(spawned[0]!)![1]); const bindToken = createConversationBindAuth(stateDir).mint('preferences-session', [alias]);
    const reply = (text: string) => request(app).post('/app/session-reply').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'preferences-e2e').set('X-Instar-Bind-Token', bindToken).send({ conversationId: alias, text });
    expect((await reply('First saved reply.')).status).toBe(200); await vi.waitFor(() => expect(sent).toHaveLength(1));
    const history = await signed('GET', `/mobile/chat/app/${key}/messages`); expect(history.status).toBe(200); expect(history.body.messages).toHaveLength(2);
    const preference = (change: { muted?: boolean; archived?: boolean }) => signed('POST', '/mobile/conversations/preferences', { requestId: `${Date.now()}-${crypto.randomUUID()}`, ref, ...change });
    const archived = await preference({ archived: true }); expect(archived.status, JSON.stringify(archived.body)).toBe(200); expect(archived.body.preferences.archived).toBe(true);
    const list = await signed('GET', '/mobile/conversations'); expect(list.status).toBe(200); expect(list.body.conversations.some((row: { id: string }) => row.id === key)).toBe(false);
    const direct = await signed('GET', `/mobile/chat/app/${key}/messages`); expect(direct.status).toBe(200); expect(direct.body.messages).toEqual(history.body.messages);
    expect((await signed('GET', '/mobile/conversations?archive=only')).body.conversations).toMatchObject([{ id: key, archived: true }]);
    expect((await preference({ archived: false })).status).toBe(200);
    expect((await signed('GET', '/mobile/conversations')).body.conversations).toMatchObject([{ id: key, archived: false }]);
    expect((await reply('Queued before the mute.')).status).toBe(200);
    await vi.waitFor(() => expect((mp.push!.status().devices as any[])[0].pending).toBe(1));
    const muted = await preference({ muted: true }); expect(muted.status, JSON.stringify(muted.body)).toBe(200); expect(muted.body.preferences.muted).toBe(true);
    clock.now += FOLD_MS; await mp.push!.tick(); expect(sent).toHaveLength(1);
    const notice = await request(app).post('/mobile/push/notify').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'preferences-e2e').send({ kind: 'item', itemId: 'ATT-4242', dedupeKey: 'independent-item', sourceMachine: mp.machineId() });
    expect(notice.status).toBe(202); await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].instar).toMatchObject({ kind: 'item', itemId: 'ATT-4242', count: 1 });
    const finalHistory = await signed('GET', `/mobile/chat/app/${key}/messages`); expect(finalHistory.body.messages.map((row: { text: string }) => row.text)).toEqual(['Keep this conversation.', 'First saved reply.', 'Queued before the mute.']);
    expect(server.appConversations!.liveConversation(key)).toBeTruthy();
  });
  it('holds missing and unreplicated reply witnesses, then keeps a private replicated witness held under the real team ACL', async () => {
    const { server, clock, sent, stateDir } = await boot(); const app = server.getApp(); const mp = server.mobilePairing!;
    const ownerKey = makeDevice(); const ownerPending = mp.devices.createPending({ deviceName: 'Owner phone', label: null, publicKey: ownerKey.publicKey, host: HOST });
    if (!ownerPending.ok) throw new Error('owner fixture');
    mp.keyLedger!.recordActivation(ownerPending.device, 'dashboard-pin', new Date().toISOString());
    mp.devices.applyConfirm(ownerPending.device.id, { ok: true, approvedVia: 'dashboard-pin' });
    mp.devices.setPresenceKey(ownerPending.device.id, makeDevice().publicKey);
    let signedTime = Date.now();
    const owner = (route: string, body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body)); const time = String(++signedTime);
      return request(app).post(route).set('Host', HOST).set('Content-Type', 'application/json').set('X-Instar-Device', ownerPending.device.id).set('X-Instar-Device-Time', time)
        .set('X-Instar-Device-Sig', ownerKey.sign(canonicalString(ownerPending.device.id, HOST, 'POST', route, time, raw))).send(raw.toString());
    };
    const create = await owner('/mobile/conversations', { title: '🔒 Shared Conversation', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(create.status).toBe(200); const key = create.body.conversationKey as string;
    const invited = await owner('/mobile/team/invites', { events: [
      { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' },
      { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' }, { type: 'grant', personKey: 'mia', ref: key, access: 'use' },
    ] });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    const member = mp.devices.createPending({ deviceName: 'Mia phone', label: null, publicKey: makeDevice().publicKey, host: HOST, role: 'team', userId: 'mia' });
    if (!member.ok) throw new Error('member fixture');
    mp.keyLedger!.recordActivation(member.device, 'dashboard-pin', new Date().toISOString()); mp.devices.applyConfirm(member.device.id, { ok: true }); mp.bindTeamPhones();
    mp.devices.setPush(member.device.id, { token: 'c'.repeat(64), environment: 'sandbox', notifyTokenHash: 'd'.repeat(64), revision: 1 });
    expect(mp.personOfDevice(mp.devices.get(member.device.id)!).ok).toBe(true); expect(mp.deviceMayUseConversation(member.device.id, key)).toBe(true);
    const trigger = (dedupeKey: string, messageId?: string) => request(app).post('/mobile/push/notify').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'preferences-e2e')
      .send({ kind: 'reply', conversationKey: key, dedupeKey, sourceMachine: 'laptop', ...(messageId === undefined ? {} : { messageId }) });
    expect((await trigger('missing-id')).status).toBe(202);
    await vi.waitFor(() => expect((mp.push!.status().devices as any[])[0].pending).toBe(1));
    clock.now += FOLD_MS; await mp.push!.tick(); expect(sent).toHaveLength(0);
    expect((await trigger('private-before-replication', 'held-private')).status).toBe(202);
    expect(mp.deviceMayNotifyMessage(member.device.id, key, 'held-private')).toBe(false);
    clock.now += FOLD_MS; await mp.push!.tick(); expect(sent).toHaveLength(0);
    server.appConversations!.store.ingestReplicated({ eventId: 'private-replicated-event', kind: 'message', conversationKey: key, at: new Date().toISOString(), machineId: 'laptop',
      messageId: 'held-private', role: 'agent', text: 'Private before the grant reached the other machine.', accessStamp: { origin: 'laptop', incarnation: 'i1', seq: 1, access: {} },
    });
    expect(mp.deviceMayReadMessage(member.device.id, key, 'held-private')).toBe(false);
    expect(mp.deviceMayNotifyMessage(member.device.id, key, 'held-private')).toBe(false);
    clock.now += FOLD_MS; await mp.push!.tick(); expect(sent).toHaveLength(0);
    expect((mp.push!.status().devices as any[])[0]).toMatchObject({ pending: 1, admission: { lastReason: 'witness-unreadable' } });
    // The same real team reader can receive a public witness. A later reply stays queued
    // while the actual signed access log is unreadable, rather than being treated as revoked.
    const publicRow = (messageId: string) => server.appConversations!.store.ingestReplicated({ eventId: `event-${messageId}`, kind: 'message', conversationKey: key, at: new Date().toISOString(), machineId: 'laptop', messageId, role: 'agent', text: 'A public represented reply.' });
    publicRow('public-first'); expect((await trigger('public-first', 'public-first')).status).toBe(202);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    publicRow('public-queued'); expect((await trigger('public-queued', 'public-queued')).status).toBe(202);
    await vi.waitFor(() => expect((mp.push!.status().devices as any[])[0].pending).toBe(1));
    const log = mp.teamLog()!; const logFile = path.join(stateDir, 'state', 'team-access', 'log.jsonl'); const savedLog = fs.readFileSync(logFile);
    try {
      fs.writeFileSync(logFile, '{invalid signed access log}\n'); log.load(); expect(log.healthState()).toBe('unreadable');
      expect(mp.personOfDevice(mp.devices.get(member.device.id)!).ok).toBe(false);
      clock.now += FOLD_MS; await mp.push!.tick(); expect(sent).toHaveLength(1);
      expect((mp.push!.status().devices as any[])[0]).toMatchObject({ pending: 1, admission: { lastReason: 'device-standing-unavailable', lastEvidence: { active: true, standingKnown: false, disposition: 'hold' } } });
    } finally { fs.writeFileSync(logFile, savedLog); log.load(); }
    expect(log.healthState()).toBe('ok'); expect(mp.personOfDevice(mp.devices.get(member.device.id)!).ok).toBe(true);
    await mp.push!.tick(); expect(sent).toHaveLength(2); expect(sent[1].instar).toMatchObject({ messageId: 'public-queued', kind: 'reply' });

  });

  it('releases an early reply trigger after its conversation and actual public witness replicate, without another trigger', async () => {
    const { server, clock, sent } = await boot(); const app = server.getApp(); const mp = server.mobilePairing!;
    const phone = mp.devices.createPending({ deviceName: 'Owner phone', label: null, publicKey: makeDevice().publicKey, host: HOST });
    if (!phone.ok) throw new Error('phone fixture');
    mp.keyLedger!.recordActivation(phone.device, 'dashboard-pin', new Date().toISOString()); mp.devices.applyConfirm(phone.device.id, { ok: true });
    mp.devices.setPush(phone.device.id, { token: 'e'.repeat(64), environment: 'sandbox', notifyTokenHash: 'f'.repeat(64), revision: 1 });
    const key = crypto.randomUUID(); expect(server.appConversations!.liveConversation(key)).toBeNull();
    const received = await request(app).post('/mobile/push/notify').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'preferences-e2e')
      .send({ kind: 'reply', conversationKey: key, messageId: 'early-public', dedupeKey: 'early-conversation', sourceMachine: 'laptop' });
    expect(received.status).toBe(202);
    clock.now += FOLD_MS; await mp.push!.tick(); expect(sent).toHaveLength(0);
    expect((mp.push!.status().devices as any[])[0].pending).toBe(1);
    const store = server.appConversations!.store;
    store.ingestReplicated({ eventId: 'early-created', kind: 'created', conversationKey: key, at: new Date().toISOString(), machineId: 'laptop', title: '📨 Replicated Conversation' });
    store.ingestReplicated({ eventId: 'early-message', kind: 'message', conversationKey: key, at: new Date().toISOString(), machineId: 'laptop', messageId: 'early-public', role: 'agent', text: 'The represented public reply has arrived.' });
    expect(mp.deviceMayNotifyMessage(phone.device.id, key, 'early-public')).toBe(true);
    clock.now += FOLD_MS; await mp.push!.tick(); expect(sent).toHaveLength(1);
    expect(sent[0].instar).toMatchObject({ kind: 'reply', conversationKey: key, messageId: 'early-public', count: 1 });
    expect((mp.push!.status().devices as any[])[0].pending).toBe(0);
  });

});
