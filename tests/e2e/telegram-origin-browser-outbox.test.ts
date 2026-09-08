import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { signMessage, verifyMessage } from '../../src/core/agentSignatureProvenance.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { OriginBrowserExecutor } from '../../src/messaging/telegram-origin/OriginBrowserExecutor.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import type { PreparedBrowserChild } from '../../src/messaging/telegram-origin/BrowserTypes.js';
import { browserOperationDigest } from '../../src/messaging/telegram-origin/BrowserTypes.js';
import { canonicalOrigin, wireDigest } from '../../src/messaging/telegram-origin/CanonicalOrigin.js';
import { OriginStore } from '../../src/messaging/telegram-origin/OriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function boot() {
  const asp = generateIdentityKeyPair();
  const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir: temporaryState(), agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey, keyId: 'studio', keyEpoch: 1 }, bot: { accountId: 'bot-1', token: `bot:${Math.random()}` },
    display: () => ({ agent: { enabled: false } }), authorize: () => true,
    isSessionLive: () => true, attachSessionLifecycle: () => undefined,
    diagnoseUnknown: vi.fn(async () => undefined), alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
  runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(runtime.options.storage.stateDir) });
  let owned = true, supported = true;
  const invoke = vi.fn(async (child: Readonly<PreparedBrowserChild>): Promise<unknown> => {
    const audit = await runtime.store.getOrigin(child.originId);
    expect(audit?.attempts.at(-1)?.phase).toBe('dispatched');
    expect(audit?.record.envelopeJson).toContain('Mac Studio');
    expect(verifyMessage({ raw: String(child.args.message), expectedTopicId: 42, resolvePublicKey: () => asp.publicKey }).classification).toBe('agent-verified');
    return { _: 'updateShortSentMessage', id: 123 };
  });
  const executor = new OriginBrowserExecutor({ service: runtime.service, store: () => runtime.store,
    accountId: '7812716706', transport: 'telegram-web', authorize: () => true,
    signBody: (body, topicId, timestamp) => signMessage({ agentId: 'echo', body, topicId, timestamp, privateKey: asp.privateKey }).text,
    driverFactory: async () => ({ canary: async () => ({ transport: 'web-k', accountId: '7812716706', buildId: 'tested', supported }),
      readSnapshot: async () => ({ text: 'page', accountId: '7812716706' }), invoke, close: async () => undefined }),
    resolveAgentPublicKey: () => asp.publicKey, clockSkewMs: () => 0, isProfileExclusivelyOwned: () => owned });
  cleanups.push(async () => { await executor.close(); await runtime.close(); });
  const input = { text: 'Browser answer', destination: { kind: 'channel' as const, id: '123', topicId: 42 },
    peer: { _: 'inputPeerChannel', channel_id: '123', access_hash: '456' } };
  return { runtime, executor, input, invoke, unown: () => { owned = false; }, drift: () => { supported = false; } };
}
describe('browser origin production outbox lifecycle', () => {
  it('commits an in-flight browser receipt to the same healthy worker during recovery', async () => {
    const h = await boot(), originalStore = h.runtime.store;
    let entered!: () => void, release!: () => void;
    const invoked = new Promise<void>(resolve => { entered = resolve; });
    const ready = new Promise<void>(resolve => { release = resolve; });
    h.invoke.mockImplementation(async () => { entered(); await ready; return { _: 'updateShortSentMessage', id: 456 }; });
    const operation = h.runtime.service.runAsAutomation('telegram-server', () => h.executor.prepare(h.input));
    await h.runtime.service.admit(operation);
    const sending = h.executor.execute(operation);
    try {
      await invoked;
      expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
      expect(h.runtime.store).toBe(originalStore);
    } finally { release(); }
    expect((await sending).receipts[0].messageId).toBe(456);
    expect((await originalStore.getOrigin(operation.record.originId))?.operation?.state).toBe('accepted');
    expect(h.invoke).toHaveBeenCalledOnce();
  });

  it('holds repeated requests across broker and worker restart after one fresh-process canary retry', async () => {
    const h = await boot(); h.drift();
    const factory = vi.fn(h.executor.options.driverFactory);
    const options = { ...h.executor.options, driverFactory: factory,
      recovery: (action: import('../../src/messaging/telegram-origin/OriginBrowserRecovery.js').BrowserRecoveryAction) =>
        h.runtime.store.browserRecovery({ profileId: 'managed', action }) };
    const first = new OriginBrowserExecutor(options); cleanups.push(() => first.close());
    const operation = h.runtime.service.runAsAutomation('telegram-server', () => first.prepare(h.input));
    await h.runtime.service.admit(operation);
    await expect(first.execute(operation)).rejects.toMatchObject({ reason: 'unsupported-browser-build' });
    expect(factory).toHaveBeenCalledTimes(2); expect(h.invoke).not.toHaveBeenCalled();
    const held = await h.runtime.store.getOrigin(operation.record.originId);
    expect(held?.children[0]).toMatchObject({ attempts: 1, state: 'queued' });
    expect(held!.attempts[0].nextAttemptAt).toBeGreaterThan(Date.now() + 899_000);
    await first.close(); await h.runtime.store.close();
    h.runtime.store = await OriginStore.open(h.runtime.options.storage, worker);
    h.runtime.service.options.store = h.runtime.store;
    const restarted = new OriginBrowserExecutor(options); cleanups.push(() => restarted.close());
    const next = h.runtime.service.runAsAutomation('telegram-server', () => restarted.prepare(h.input));
    await h.runtime.service.admit(next);
    await expect(restarted.execute(next)).rejects.toMatchObject({ reason: 'browser-recovery-cooldown' });
    expect(factory).toHaveBeenCalledTimes(2); expect(h.invoke).not.toHaveBeenCalled();
  });
  it('renews an expired ASP over the same body and random ID within the original six-hour operation', async () => {
    const h = await boot();
    h.executor.options.now = () => Date.now() - 15 * 60_000;
    const operation = h.runtime.service.runAsAutomation('telegram-server', () => h.executor.prepare(h.input));
    await h.runtime.service.admit(operation);
    const child = operation.admission.children[0], original = JSON.parse(child.materializations[0].requestJson);
    expect(operation.admission.deadlineAt - operation.admission.preparedAt).toBe(6 * 60 * 60_000);
    expect((await h.runtime.store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId,
      ownerBootId: h.runtime.service.options.ownerBootId, leaseMs: 60_000 })).status).toBe('unavailable');
    h.executor.options.now = Date.now;
    const result = await h.executor.execute(operation);
    expect(result.originId).toBe(operation.record.originId);
    const invoked = h.invoke.mock.calls[0][0];
    expect(invoked.args.random_id).toBe(original.args.random_id);
    expect(invoked.args.peer).toEqual(original.args.peer);
    expect(invoked.args.message).not.toBe(original.args.message);
    expect((await h.runtime.store.getChild(child.childId))?.generation).toBe(1);
    expect((await h.runtime.store.getOrigin(operation.record.originId))?.record.envelopeJson).toBe(operation.admission.record.envelopeJson);
  });
  it.each(['message', 'random_id', 'peer'])('rejects a stored renewal that changes immutable %s', async field => {
    const h = await boot();
    const operation = h.runtime.service.runAsAutomation('telegram-server', () => h.executor.prepare(h.input));
    await h.runtime.service.admit(operation);
    const child = operation.admission.children[0], forged = JSON.parse(child.materializations[0].requestJson);
    if (field === 'message') forged.args.message = h.executor.options.signBody('changed body', 42, Math.floor(Date.now() / 1000));
    if (field === 'random_id') forged.args.random_id = '2';
    if (field === 'peer') forged.args.peer.channel_id = '456';
    forged.digest = browserOperationDigest(forged.method, forged.args);
    const requestJson = canonicalOrigin(forged);
    expect(await h.runtime.store.addMaterialization({ childId: child.childId, expectedGeneration: 0, kind: 'signature-renewal',
      canonicalContentDigest: child.canonicalContentDigest, destinationJson: child.destinationJson, inputDigest: 'a'.repeat(64),
      materialization: { materializationId: `forged-${field}`, requestJson, requestDigest: wireDigest(requestJson), dispatchDeadline: forged.deadlineMs } })).toBe(true);
    await expect(h.executor.execute(operation)).rejects.toMatchObject({ reason: 'browser-renewal-mismatch' });
    expect(h.invoke).not.toHaveBeenCalled();
    expect((await h.runtime.store.getChild(child.childId))?.attempts).toBe(0);
  });
  it('holds an expired signature when the owning signer is unavailable without resetting its operation', async () => {
    const h = await boot(); h.executor.options.now = () => Date.now() - 15 * 60_000;
    const operation = h.runtime.service.runAsAutomation('telegram-server', () => h.executor.prepare(h.input));
    await h.runtime.service.admit(operation); h.executor.options.now = Date.now;
    h.executor.options.signBody = () => { throw new Error('key unavailable'); };
    await expect(h.executor.execute(operation)).rejects.toMatchObject({ reason: 'browser-signing-unavailable' });
    expect(h.invoke).not.toHaveBeenCalled();
    const stored = await h.runtime.store.getChild(operation.admission.children[0].childId);
    expect(stored).toMatchObject({ generation: 0, attempts: 0, operationId: operation.record.operationId });
  });
  it('runs the authenticated typed browser route with server-resolved peers and source-session evidence', async () => {
    const h = await boot();
    const token = await h.runtime.sessions.issue({ sessionId: 'browser-author', harnessId: 'codex-cli',
      projectDir: process.cwd(), configuredModel: 'browser-author-model' });
    h.runtime.observer.track(h.runtime.sessions.getBinding('browser-author')!);
    const resolvePeer = vi.fn(async () => h.input.peer);
    h.runtime.browsers.set('operator-profile', { executor: h.executor, resolvePeer });
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
    app.use(createRoutes({ config: { stateDir: h.runtime.options.storage.stateDir, port: 0, projectName: 'echo' },
      telegramOrigin: h.runtime, sessionManager: {}, } as never));
    const payload = { text: h.input.text, destination: h.input.destination };
    const send = (body = payload, credential = token) => request(app).post('/telegram/browser/operator-profile/send')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', credential).send(body);
    expect((await send(payload, 'forged')).status).toBe(409);
    expect((await send({ ...payload, peer: h.input.peer } as never)).status).toBe(400);
    expect(resolvePeer).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
    const response = await send();
    expect(response.status).toBe(200);
    expect(resolvePeer).toHaveBeenCalledWith(h.input.destination);
    expect(h.invoke).toHaveBeenCalledOnce();
    const audit = await h.runtime.store.getOrigin(response.body.originId);
    expect(JSON.parse(audit!.record.envelopeJson)).toMatchObject({ sessionId: 'browser-author',
      harnessId: 'codex-cli', model: { value: 'browser-author-model', status: 'configured' }, display: { enabled: false } });
    const snapshot = await request(app).get('/telegram/browser/operator-profile/snapshot')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', token);
    expect(snapshot.status).toBe(200); expect(snapshot.body.accountId).toBe('7812716706');
    expect(h.invoke).toHaveBeenCalledOnce();
  });
  it('records hidden attribution and ASP before the exact browser invocation, then persists its concrete receipt', async () => {
    const h = await boot();
    const result = await h.runtime.service.runAsAutomation('telegram-server', () => h.executor.send(h.input));
    expect(result.receipts[0].messageId).toBe(123);
    expect(h.invoke).toHaveBeenCalledOnce();
    expect(h.invoke.mock.calls[0][0].args.message).not.toContain('Mac Studio');
    const audit = await h.runtime.store.getOrigin(result.originId);
    expect(audit?.operation?.state).toBe('accepted');
    expect(JSON.parse(audit!.record.envelopeJson).display.enabled).toBe(false);
  });
  it.each(['ownership', 'build'])('holds an unsupported %s before invoking the browser', async kind => {
    const h = await boot();
    if (kind === 'ownership') h.unown(); else h.drift();
    await expect(h.runtime.service.runAsAutomation('telegram-server', () => h.executor.send(h.input))).rejects.toMatchObject({ outcome: 'known-failed' });
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it('holds optimistic or lost browser results and cannot replay the same child', async () => {
    const h = await boot(); h.invoke.mockResolvedValue({ id: -1, text: 'optimistic bubble' });
    const operation = h.runtime.service.runAsAutomation('telegram-server', () => h.executor.prepare(h.input));
    await h.runtime.service.admit(operation);
    await expect(h.executor.execute(operation)).rejects.toMatchObject({ outcome: 'outcome-unknown' });
    await expect(h.executor.execute(operation)).rejects.toMatchObject({ reason: 'outbox-not-ready' });
    expect(h.invoke).toHaveBeenCalledOnce();
  });
});
