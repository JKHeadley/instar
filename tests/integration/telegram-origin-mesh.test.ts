import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MeshRpcDispatcher } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { handleOriginMesh, originAuditAudience, ORIGIN_MESH_PROTOCOL, ORIGIN_METRICS_AUDIENCE } from '../../src/messaging/telegram-origin/OriginMesh.js';
import { mintPoolLinkAssertion } from '../../src/core/PoolLinkAssertion.js';
import { OriginStore } from '../../src/messaging/telegram-origin/OriginStore.js';
import type { OriginMeshCommand } from '../../src/messaging/telegram-origin/OriginMesh.js';
import { relayOriginBot } from '../../src/messaging/telegram-origin/OriginMeshRelay.js';
import { originDeliveryConfirmed } from '../../src/messaging/telegram-origin/OriginDeliveryResolution.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllGlobals(); });
async function boot(extra: { source?: Record<string, unknown>; owner?: Record<string, unknown> } = {}) {
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const owner = await TelegramOriginRuntime.open({ storage: { stateDir: temporaryState(), agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'owner', originMachineName: 'Delivery machine' },
    signingKey: { privateKey, keyId: 'owner:1', keyEpoch: 1 }, bot: { accountId: '123', token: `123:${randomUUID()}` },
    display: () => ({ agent: { enabled: true } }), authorize: request => request.destination.chatId === '-100123',
    authorizeOrigin: () => true,
    diagnoseUnknown: async () => undefined, alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
  let lifecycle: any;
  const source = await TelegramOriginRuntime.open({ ...owner.options,
    storage: { stateDir: temporaryState(), agentId: 'echo' }, bot: { accountId: 'unresolved' },
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'source', originMachineName: 'Origin machine' },
    signingKey: { privateKey, keyId: 'source:1', keyEpoch: 1 }, display: () => ({ agent: { enabled: false } }),
    attachSessionLifecycle: value => { lifecycle = value; }, isSessionLive: () => true });
  const credential = await lifecycle.issue({ sessionId: 'origin-session', harnessId: 'codex-cli', projectDir: process.cwd(), configuredModel: 'gpt-6-astra' });
  createRoutes({ config: { authToken: 'test', stateDir: source.options.storage.stateDir, port: 0 },
    telegramOrigin: source, ...extra.source } as any);
  const seen = new Set<string>();
  let attestationRevoked = false;
  const resolveKey = (machineId: string) => ['source', 'other'].includes(machineId) ? { machineId, agentId: 'echo', keyId: `${machineId}:1`, keyEpoch: 1,
    publicKey, validFrom: 0, validUntil: null, revokedAt: attestationRevoked ? Date.now() - 1 : null } : null;
  const dispatcher = new MeshRpcDispatcher({ verify: { selfMachineId: 'owner',
    verify: (bytes, signature, sender) => ['source', 'other'].includes(sender) && verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, 'base64url')),
    isRegisteredPeer: sender => ['source', 'other'].includes(sender), seenNonce: (_, nonce) => seen.has(nonce), now: Date.now },
    rbac: { routerHolder: () => 'owner', ownerOf: () => null, placementTargetOf: () => null }, recordNonce: (_, nonce) => { seen.add(nonce); },
    handlers: { 'telegram-origin': (command, sender) => handleOriginMesh({ runtime: owner,
      command: command as OriginMeshCommand, authenticatedSender: sender, resolveKey }) } });
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use(createRoutes({ config: { authToken: 'test', stateDir: owner.options.storage.stateDir, port: 0 },
    telegramOrigin: owner, meshRpcDispatcher: dispatcher, ...extra.owner } as any));
  const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await source.close(); await owner.close(); });
  const originalFetch = globalThis.fetch;
  const botNetwork = vi.fn(async (_url: string, init: RequestInit) => {
    const params = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 321, chat: { id: params.chat_id }, message_thread_id: params.message_thread_id } }));
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => String(url).startsWith('https://api.telegram.org/') ? botNetwork(url, init) : originalFetch(url, init));
  const client = new MeshRpcClient({ selfMachineId: 'source', nonce: randomUUID,
    sign: bytes => sign(null, Buffer.from(bytes), privateKey).toString('base64url') });
  const send = (command: OriginMeshCommand) => client.send({ machineId: 'owner', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, command, 0);
  const otherClient = new MeshRpcClient({ selfMachineId: 'other', nonce: randomUUID,
    sign: bytes => sign(null, Buffer.from(bytes), privateKey).toString('base64url') });
  const sendOther = (command: OriginMeshCommand) => otherClient.send({ machineId: 'owner', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, command, 0);
  const auditAssertion = (query: import('../../src/messaging/telegram-origin/StoreTypes.js').OriginListQuery | string) =>
    mintPoolLinkAssertion({ holderFingerprint: 'owner', viewId: typeof query === 'string' ? query : originAuditAudience(query), method: 'GET' }, 'pin-session', {
      selfFingerprint: 'source', sign: canonical => sign(null, Buffer.from(canonical), privateKey).toString('base64'), mintJti: randomUUID, now: Date.now, ttlMs: 10_000 });
  return { owner, source, credential, send, sendOther, botNetwork, auditAssertion, revoke: () => { attestationRevoked = true; } };
}
describe('Telegram origin signed mesh HTTP pipeline', () => {
  it('resolves a lost holder response from durable source evidence after a worker restart without resending', async () => {
    const h = await boot();
    let heldOperation = '';
    try {
      await h.source.service.runWithSessionToken(h.credential, () => relayOriginBot({ runtime: h.source,
        topicId: 42, chatId: '-100123', text: 'Accepted despite lost response', send: async command => {
          const reply = await h.send(command);
          if (command.action === 'submit') throw new Error('reply connection lost after committed receipt');
          return reply;
        } }));
    } catch (error) {
      expect(error).toMatchObject({ reason: 'origin-relay-acceptance-unknown' });
      heldOperation = (error as { operationId: string }).operationId;
    }
    expect(heldOperation).not.toBe(''); expect(h.botNetwork).toHaveBeenCalledOnce();
    await h.source.store.close();
    h.source.store = await OriginStore.open(h.source.options.storage, worker);
    h.source.service.options.store = h.source.store;
    const source = await h.source.store.getOperation(heldOperation);
    expect(source?.operation).toBeNull();
    const query = vi.fn(async (machineId: string, command: OriginMeshCommand, timeoutMs: number) => {
      expect(machineId).toBe('owner'); expect(timeoutMs).toBeGreaterThan(0); expect(timeoutMs).toBeLessThanOrEqual(2000);
      expect(command).toEqual({ type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL, action: 'receipt', operationId: heldOperation });
      return h.send(command);
    });
    expect(await originDeliveryConfirmed(h.source.store, heldOperation, { selfMachineId: 'source', agentId: 'echo', send: query })).toBe(true);
    expect(query).toHaveBeenCalledOnce(); expect(h.botNetwork).toHaveBeenCalledOnce();
    const receipt = await h.send({ type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL, action: 'receipt', operationId: heldOperation });
    expect(receipt.result).toEqual({ ok: true, operationId: heldOperation, originId: source!.record.originId,
      envelopeDigest: source!.record.envelopeDigest, executionOwnerMachineId: 'owner', state: 'accepted', originReceiptConfirmed: true });
    const intruder = await h.sendOther({ type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL, action: 'receipt', operationId: heldOperation });
    expect(intruder.result).toEqual({ ok: false, reason: 'origin-receipt-unavailable' });
    const lookup = h.owner.store.getOperation.bind(h.owner.store);
    vi.spyOn(h.owner.store, 'getOperation').mockImplementationOnce(async operationId => {
      const audit = await lookup(operationId); h.revoke(); return audit;
    });
    expect((await h.send({ type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL, action: 'receipt', operationId: heldOperation })).result)
      .toEqual({ ok: false, reason: 'origin-peer-unavailable' });
    expect(await originDeliveryConfirmed(h.source.store, heldOperation, { selfMachineId: 'source', agentId: 'echo', send: query })).toBe(false);
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });

  it('does not treat an owner evidence mirror as a receipt or follow a replacement owner', async () => {
    const h = await boot();
    const operation = h.source.service.runAsAutomation('telegram-server', () => h.source.service.prepareBot({
      method: 'sendMessage', accountId: '123', executionOwnerMachineId: 'owner', params: { chat_id: '-100123', text: 'Prepared only' } }));
    await h.source.service.recordIntent(operation);
    await h.send({ type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL, action: 'evidence', record: operation.admission.record });
    const send = vi.fn(async (_machineId: string, command: OriginMeshCommand) => h.send(command));
    expect(await originDeliveryConfirmed(h.source.store, operation.record.operationId, { selfMachineId: 'source', agentId: 'echo', send })).toBe(false);
    expect(send.mock.calls[0][0]).toBe('owner');
    expect(h.botNetwork).not.toHaveBeenCalled();
    const wrongOwner = vi.fn(async () => ({ ok: true, result: { ok: true, operationId: operation.record.operationId,
      originId: operation.record.originId, envelopeDigest: operation.admission.record.envelopeDigest,
      executionOwnerMachineId: 'successor', state: 'accepted', originReceiptConfirmed: true } }));
    expect(await originDeliveryConfirmed(h.source.store, operation.record.operationId, { selfMachineId: 'source', agentId: 'echo', send: wrongOwner })).toBe(false);
    expect(wrongOwner).toHaveBeenCalledOnce();
  });
  it('runs the holder content gate and returns its actionable refusal without a network send', async () => {
    const h = await boot();
    await expect(h.source.service.runWithSessionToken(h.credential, () => relayOriginBot({ runtime: h.source,
      topicId: 42, chatId: '-100123', text: 'Open http://localhost:4042/private', send: h.send })))
      .rejects.toMatchObject({ decision: { status: 422, reason: 'localhost-link-guard' } });
    expect(h.botNetwork).not.toHaveBeenCalled();
  });
  it('keeps the original pre-format text and typed advisory reaction across the relay', async () => {
    const review = vi.fn(async (_text: string) => ({ pass: false, advisory: true, rule: 'B21_USER_TASK_SUBSTITUTION',
      issue: 'Fixture advisory', suggestion: 'Review', decisionRef: 'd-fixture', latencyMs: 1 }));
    const h = await boot({ owner: { messagingToneGate: { review } } });
    const send = (kindMetadata?: Record<string, unknown>) => h.source.service.runWithSessionToken(h.credential, () =>
      relayOriginBot({ runtime: h.source, topicId: 42, chatId: '-100123', text: '**I will handle this.**', kindMetadata, send: h.send }));
    await expect(send()).rejects.toMatchObject({ decision: { reason: 'tone-gate-advisory' } });
    expect(h.botNetwork).not.toHaveBeenCalled();
    await expect(send({ toneAdvisoryAck: 'B21_USER_TASK_SUBSTITUTION', toneAdvisoryAckReason: 'The operator explicitly authorized this.',
      isProxy: true, allowDebugText: true })).resolves.toMatchObject({ messageId: 321 });
    expect(review.mock.calls.map(call => call[0])).toEqual(['**I will handle this.**', '**I will handle this.**']);
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });
  it('refuses a standing-down source before handing its prepared work to the holder', async () => {
    const h = await boot({ source: { meshSelfId: 'source', sessionOwnershipRegistry: { ownerOf: () => 'other' },
      standDownRegistry: { getByTopic: () => ({ sessionName: 'source-session', dryRun: false, ownerMachineId: 'other' }),
        isEnforcing: () => true, countRefusedSend: vi.fn() } } });
    await expect(h.source.service.runWithSessionToken(h.credential, () => relayOriginBot({ runtime: h.source,
      topicId: 42, chatId: '-100123', text: 'A duplicate source reply.', send: h.send })))
      .rejects.toMatchObject({ reason: 'standing-down' });
    expect(h.botNetwork).not.toHaveBeenCalled(); expect((await h.owner.store.listOrigins()).records).toEqual([]);
  });
  it('requires a separate one-use operator metrics audience and excludes remote evidence copies', async () => {
    const h = await boot();
    const operation = await h.source.service.runWithSessionToken(h.credential, async () => h.source.service.prepareBot({
      method: 'sendMessage', accountId: '123', executionOwnerMachineId: 'owner',
      params: { chat_id: '-100123', message_thread_id: 42, text: 'Prepared source' } }));
    await h.source.service.recordIntent(operation); await h.owner.service.admit(operation);
    const command = { type: 'telegram-origin' as const, protocol: ORIGIN_MESH_PROTOCOL, action: 'metrics' as const };
    expect((await h.send(command)).result).toMatchObject({ ok: false, reason: 'operator-audit-scope-required' });
    expect((await h.send({ ...command, operatorAssertion: h.auditAssertion({}) })).result).toMatchObject({ ok: false });
    const operatorAssertion = h.auditAssertion(ORIGIN_METRICS_AUDIENCE);
    const result = (await h.send({ ...command, operatorAssertion })).result as any;
    expect(result).toMatchObject({ ok: true, metrics: { counts: { 'operation:admitted': 1 } } });
    expect(result.metrics.counts['operation:prepared']).toBeUndefined();
    expect((await h.send({ ...command, operatorAssertion })).result).toMatchObject({ ok: false });
    expect(h.botNetwork).not.toHaveBeenCalled();
  });
  it('requires a query-bound operator assertion and rejects reuse across an origin-worker restart', async () => {
    const h = await boot(), query = { limit: 10 };
    const base = { type: 'telegram-origin' as const, protocol: ORIGIN_MESH_PROTOCOL, action: 'audit' as const, query };
    expect((await h.send(base)).result).toMatchObject({ ok: false, reason: 'operator-audit-scope-required' });
    const operatorAssertion = h.auditAssertion(query);
    expect((await h.send({ ...base, operatorAssertion, query: { limit: 9 } })).result).toMatchObject({ ok: false, reason: 'operator-audit-assertion-invalid' });
    expect((await h.send({ ...base, operatorAssertion })).result).toMatchObject({ ok: true, page: { coverage: 'complete', records: [] } });
    await h.owner.store.close();
    h.owner.store = await OriginStore.open(h.owner.options.storage, worker); h.owner.service.options.store = h.owner.store;
    expect((await h.send({ ...base, operatorAssertion })).result).toMatchObject({ ok: false, reason: 'operator-audit-assertion-invalid' });
    expect((await h.send({ ...base, operatorAssertion: h.auditAssertion(query) })).result).toMatchObject({ ok: true });
    h.revoke();
    expect((await h.send({ ...base, operatorAssertion: h.auditAssertion(query) })).result).toMatchObject({ ok: false });
    expect(h.botNetwork).not.toHaveBeenCalled();
  });
  it.each(['deadline', 'prepared-at', 'attempts', 'derivations'])('refuses unsigned %s changes before admission or send', async changed => {
    const h = await boot();
    const operation = await h.source.service.runWithSessionToken(h.credential, () => h.source.service.prepareBot({
      method: 'sendMessage', accountId: '123', executionOwnerMachineId: 'owner',
      params: { chat_id: '-100123', message_thread_id: 42, text: 'Original bounded intent' },
    }));
    if (changed === 'deadline') operation.admission.deadlineAt += 1000;
    if (changed === 'prepared-at') { operation.admission.preparedAt += 1000; operation.admission.deadlineAt += 1000; }
    if (changed === 'attempts') operation.admission.maxAttempts--;
    if (changed === 'derivations') operation.admission.children[0].allowedDerivations = ['signature-renewal'];
    const response = await h.send({ type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL, action: 'submit', operation });
    expect(response.result).toMatchObject({ ok: false, reason: 'origin-plan-invalid' });
    expect(h.botNetwork).not.toHaveBeenCalled();
    expect((await h.owner.store.listOrigins()).records).toHaveLength(0);
  });
  it('refuses execution on a successor owner instead of minting another queue claim for the old plan', async () => {
    const h = await boot();
    const operation = await h.source.service.runWithSessionToken(h.credential, async () =>
      h.source.service.prepareBot({ method: 'sendMessage', accountId: '123', executionOwnerMachineId: 'previous-owner',
        params: { chat_id: '-100123', message_thread_id: 42, text: 'Uncertain old-owner operation.' } }));
    await h.source.service.recordIntent(operation);
    const response = await h.send({ type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL, action: 'submit', operation });
    expect(response.result).toMatchObject({ ok: false, reason: 'execution-owner-mismatch', outcome: 'held' });
    expect(h.botNetwork).not.toHaveBeenCalled();
    expect((await h.owner.store.listOrigins()).records).toEqual([]);
    expect((await h.source.store.listOrigins()).records).toHaveLength(1);
  });
  it('keeps source session/model and hidden presentation across a tokenless relay, with owner receipt persistence', async () => {
    const h = await boot();
    const result = await h.source.service.runWithSessionToken(h.credential, () => relayOriginBot({ runtime: h.source,
      topicId: 42, chatId: '-100123', text: 'Cross-machine answer', send: h.send }));
    expect(result.messageId).toBe(321); expect(h.botNetwork).toHaveBeenCalledOnce();
    expect(JSON.parse(h.botNetwork.mock.calls[0][1].body as string).text).toBe('Cross-machine answer');
    const records = await h.owner.store.listOrigins();
    expect(records.records).toHaveLength(1);
    expect(records.records[0].operation?.state).toBe('accepted');
    expect(records.records[0].attempts[0].deliveryMachineId).toBe('owner');
    expect(records.records[0].acceptanceVerification).toMatchObject({ verifierMachineId: 'owner', keyId: 'source:1',
      keyEpoch: 1, envelopeDigest: records.records[0].record.envelopeDigest, keyStatusAtAcceptance: 'active' });
    expect(records.records[0].acceptanceVerification!.verifiedAt).toBeLessThanOrEqual(records.records[0].attempts[0].createdAt);
    expect(JSON.parse(records.records[0].record.envelopeJson)).toMatchObject({ originMachineId: 'source', sessionId: 'origin-session',
      model: { value: 'gpt-6-astra', status: 'configured' }, display: { enabled: false } });
    expect((await h.source.store.listOrigins()).records[0].operation).toBeNull();
  });
  it('refuses a revoked source attestation before owner admission or network dispatch', async () => {
    const h = await boot(); h.revoke();
    await expect(h.source.service.runWithSessionToken(h.credential, () => relayOriginBot({ runtime: h.source,
      topicId: 42, chatId: '-100123', text: 'Held', send: h.send }))).rejects.toMatchObject({ reason: 'key-revoked' });
    expect(h.botNetwork).not.toHaveBeenCalled();
    expect((await h.owner.store.listOrigins()).records).toEqual([]);
  });
  it('rejects an incompatible peer without falling back to an unattributed send', async () => {
    const h = await boot();
    const result = await h.send({ type: 'telegram-origin', protocol: 'old-version' as typeof ORIGIN_MESH_PROTOCOL, action: 'capabilities' });
    expect(result.result).toMatchObject({ ok: false, reason: 'origin-protocol-unsupported' });
    expect(h.botNetwork).not.toHaveBeenCalled();
  });
});
