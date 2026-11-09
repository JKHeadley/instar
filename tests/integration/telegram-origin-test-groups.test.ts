// docs/specs/telegram-test-groups.md — the three routes through the full HTTP pipeline,
// and reply claim renewal against the real origin store.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import { OriginBrowserExecutor } from '../../src/messaging/telegram-origin/OriginBrowserExecutor.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { signMessage } from '../../src/core/agentSignatureProvenance.js';
import { TelegramTestGroups, readTestGroupGrant } from '../../src/messaging/telegram-origin/TelegramTestGroups.js';
import type { TelegramBrowserDriver } from '../../src/messaging/telegram-origin/BrowserTypes.js';

let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ACCOUNT = '7812716706';
const BOT = { username: 'instar_pr2760_livetest_bot', userId: '8000000001' };
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.unstubAllGlobals(); });

async function appHarness() {
  const stateDir = temporaryState(), botToken = `123:${randomUUID()}`;
  let lifecycle: OriginSessionLifecycle | undefined;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 27 } }))));
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 }, bot: { token: botToken, accountId: 'bot-1', chatId: '-100123' },
    isSessionLive: () => true, attachSessionLifecycle: l => { lifecycle = l; }, display: () => ({}),
    authorize: () => true, diagnoseUnknown: async () => undefined, alertDestinations: () => [],
    getAlertPolicy: () => null, onNoticeState: () => undefined,
  });
  runtimes.push(runtime);
  const sessionToken = await lifecycle!.issue({ sessionId: 'source-session', harnessId: 'codex-cli', projectDir: process.cwd(), configuredModel: 'gpt-6-astra' });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ state: { getSession: () => undefined }, config: { authToken: 'agent-test', stateDir, port: 0, projectName: 'echo',
    messaging: [{ type: 'telegram', enabled: true, config: { token: botToken, chatId: '-100123', lifelineTopicId: 7848 } }] },
  telegramOrigin: runtime, verifyDashboardOperatorSession: () => false,
  telegram: { sendToTopic: async () => ({ messageId: 1, timestamp: new Date().toISOString() }) },
  sessionManager: { clearInjectionTracker: () => undefined } } as never));
  return { app, runtime, sessionToken, stateDir };
}

function account() {
  const chats = new Map<string, { title: string; date: number }>();
  let next = 9100;
  const driver: Partial<TelegramBrowserDriver> = {
    listTestGroups: async input => ({ ok: true, complete: true,
      groups: [...chats].filter(([, c]) => /\[itg-[a-z2-7]{10}\]$/.test(c.title)).map(([id, c]) => ({ channelId: id, title: c.title, date: c.date })),
      ...(input.channelId ? { requested: { present: chats.has(input.channelId) } } : {}) }),
    createTestGroup: async input => { const id = String(next++); chats.set(id, { title: input.title, date: Math.floor(Date.now() / 1000) }); return { ok: true, channelId: id }; },
    deleteTestGroup: async input => { if (!chats.has(input.channelId)) return { ok: true, outcome: 'gone' }; chats.delete(input.channelId); return { ok: true, outcome: 'deleted' }; },
  };
  return { chats, driver };
}
function executorFor(h: Awaited<ReturnType<typeof appHarness>>, driver: Partial<TelegramBrowserDriver>, extra: Partial<ConstructorParameters<typeof OriginBrowserExecutor>[0]> = {}) {
  const asp = generateIdentityKeyPair();
  const invoke = vi.fn(async () => ({ _: 'updateShortSentMessage', id: 83 }));
  const executor = new OriginBrowserExecutor({ service: h.runtime.service, store: () => h.runtime.store,
    accountId: ACCOUNT, transport: 'telegram-web', authorize: () => true,
    signBody: (body, topicId, timestamp) => signMessage({ agentId: 'echo', body, topicId, timestamp, privateKey: asp.privateKey }).text,
    driverFactory: async () => ({ canary: async () => ({ transport: 'web-k', accountId: ACCOUNT, buildId: 'fixture', supported: true }),
      readSnapshot: async () => ({ text: 'fixture', accountId: ACCOUNT }), invoke, close: async () => undefined, ...driver }),
    resolveAgentPublicKey: () => asp.publicKey, clockSkewMs: () => 0, isProfileExclusivelyOwned: () => true, ...extra });
  return { executor, invoke };
}
const grant = () => readTestGroupGrant({ testGroups: { profileId: 'operator', accountId: ACCOUNT, bots: [BOT],
  decisionRef: '[source: telegram 134088/123456 2026-11-08]', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }, Date.now());

describe('test-group routes through the HTTP pipeline', () => {
  it('create, list and delete with the session credential; no response carries a hash', async () => {
    const h = await appHarness(), a = account();
    const { executor } = executorFor(h, a.driver);
    let now = Date.now();
    const groups = new TelegramTestGroups({ profileId: 'operator', stateDir: h.stateDir, accountId: ACCOUNT, broker: executor.broker,
      executorBusy: () => executor.busy, authority: () => ({ healthy: true, enabled: true, holdsLease: true, grant: grant() }), now: () => now });
    h.runtime.browsers.set('operator', { executor, resolvePeer: async () => ({}), testGroups: groups });
    const call = (method: 'get' | 'post', url: string) => request(h.app)[method](url).set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken);
    const created = await call('post', '/telegram/browser/operator/test-groups').send({ title: 'Instar test - route proof', bot: BOT.username });
    expect(created.status).toBe(200);
    expect(created.body.chatId).toBe(`-100${created.body.channelId}`);
    now += 6000;
    const listed = await call('get', '/telegram/browser/operator/test-groups');
    expect(listed.status).toBe(200);
    expect(listed.body.groups).toEqual([expect.objectContaining({ channelId: created.body.channelId, verification: 'verified' })]);
    now += 6000;
    const deleted = await call('post', `/telegram/browser/operator/test-groups/${created.body.channelId}/delete`).send({});
    expect(deleted.body).toEqual({ channelId: created.body.channelId, state: 'deleted' });
    for (const body of [created.body, listed.body, deleted.body]) expect(JSON.stringify(body)).not.toMatch(/hash/i);
  });
  it('refuses an unenrolled profile, a missing session credential, and unknown body keys', async () => {
    const h = await appHarness(), a = account();
    const { executor } = executorFor(h, a.driver);
    h.runtime.browsers.set('no-groups', { executor, resolvePeer: async () => ({}) });
    const auth = (r: request.Test) => r.set('Authorization', 'Bearer agent-test');
    expect((await auth(request(h.app).get('/telegram/browser/no-groups/test-groups'))).status).toBe(503);
    h.runtime.browsers.set('operator', { executor, resolvePeer: async () => ({}), testGroups: new TelegramTestGroups({ profileId: 'operator',
      stateDir: h.stateDir, accountId: ACCOUNT, broker: executor.broker, executorBusy: () => false,
      authority: () => ({ healthy: true, enabled: true, holdsLease: true, grant: grant() }) }) });
    const noSession = await auth(request(h.app).get('/telegram/browser/operator/test-groups'));
    expect(noSession.status).toBe(409);
    expect(noSession.body.error).toBe('telegram-origin-held');
    const extra = await auth(request(h.app).post('/telegram/browser/operator/test-groups')).set('X-Instar-Origin-Session', h.sessionToken)
      .send({ title: 'Instar test - a', bot: BOT.username, accessHash: '1' });
    expect(extra.status).toBe(400);
    const badDelete = await auth(request(h.app).post('/telegram/browser/operator/test-groups/1/delete')).set('X-Instar-Origin-Session', h.sessionToken).send({ force: true });
    expect(badDelete.status).toBe(400);
    expect(a.chats.size).toBe(0);
  });
});

describe('reply claim renewal while queued (the one send-path change)', () => {
  const send = (h: Awaited<ReturnType<typeof appHarness>>) => request(h.app).post('/telegram/browser/operator/send')
    .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', h.sessionToken)
    .send({ text: 'A reply that waits behind slow browser work.', destination: { kind: 'channel', id: '123', topicId: 42 } });
  it('a reply that waits longer than its lease still dispatches because the claim is renewed', async () => {
    const h = await appHarness();
    let first = true;
    const { executor, invoke } = executorFor(h, {
      canary: async () => { if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 3000)); }
        return { transport: 'web-k', accountId: ACCOUNT, buildId: 'fixture', supported: true }; },
    }, { claimLeaseMs: 1500, claimRenewMs: 400 });
    h.runtime.browsers.set('operator', { executor, resolvePeer: async () => ({ _: 'inputPeerChannel', channel_id: '123', access_hash: '456' }) });
    const response = await send(h);
    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledOnce();
  }, 30_000);
  it('one transient renewal error with lease headroom left does not drop the reply', async () => {
    const h = await appHarness();
    const renew = h.runtime.store.renewClaim.bind(h.runtime.store);
    vi.spyOn(h.runtime.store, 'renewClaim').mockRejectedValueOnce(new Error('worker restarting')).mockImplementation(renew);
    let first = true;
    const { executor, invoke } = executorFor(h, {
      canary: async () => { if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 2500)); }
        return { transport: 'web-k', accountId: ACCOUNT, buildId: 'fixture', supported: true }; },
    }, { claimLeaseMs: 3000, claimRenewMs: 400 });
    h.runtime.browsers.set('operator', { executor, resolvePeer: async () => ({ _: 'inputPeerChannel', channel_id: '123', access_hash: '456' }) });
    expect((await send(h)).status).toBe(200);
    expect(invoke).toHaveBeenCalledOnce();
  }, 30_000);
  it('without renewal the same wait would expire the claim, so a failed renewal is never dispatched', async () => {
    const h = await appHarness();
    vi.spyOn(h.runtime.store, 'renewClaim').mockResolvedValue(false);
    let first = true;
    const { executor, invoke } = executorFor(h, {
      canary: async () => { if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 1200)); }
        return { transport: 'web-k', accountId: ACCOUNT, buildId: 'fixture', supported: true }; },
    }, { claimLeaseMs: 60_000, claimRenewMs: 300 });
    h.runtime.browsers.set('operator', { executor, resolvePeer: async () => ({ _: 'inputPeerChannel', channel_id: '123', access_hash: '456' }) });
    const response = await send(h);
    expect(response.status).toBe(409);
    expect(invoke).not.toHaveBeenCalled();
  }, 30_000);
});
