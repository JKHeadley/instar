/**
 * native-conversation-base §3b — Tier 2: the outcome route gives the execution
 * owner's verdict (F2).
 *
 * Three real origin runtimes (owner = lease holder, author = a standby that
 * forwards, third = a machine with no row), each behind the REAL signed mesh
 * HTTP pipeline (MeshRpcClient → MeshRpcDispatcher → handleOriginMesh) and the
 * real routes. The route on any machine asks the owner over the existing
 * `receipt` verb with `reader: true`, and the author when it is not the author.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MeshRpcDispatcher } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { handleOriginMesh } from '../../src/messaging/telegram-origin/OriginMesh.js';
import type { OriginMeshCommand } from '../../src/messaging/telegram-origin/OriginMesh.js';
import { OriginOwnerReader } from '../../src/messaging/telegram-origin/OriginOwnerRead.js';
import { applyTelegramFormatter } from '../../src/messaging/TelegramAdapter.js';
import { forwardReplyToHolder, submitOriginToHolder, HOLD_REASON_LEASE_NOT_HELD } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardDeps, ForwardLeaseView } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { BotParameters } from '../../src/messaging/telegram-origin/types.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

const IDS = ['owner', 'author', 'third'] as const;
type Id = typeof IDS[number];

async function boot() {
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const base = await TelegramOriginRuntime.open({ storage: { stateDir: temporaryState(), agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'owner', originMachineName: 'The Studio' },
    signingKey: { privateKey, keyId: 'owner:1', keyEpoch: 1 }, bot: { accountId: '123', token: `123:${randomUUID()}` },
    display: () => ({ agent: { enabled: true } }), authorize: request => request.destination.chatId === '-100123',
    holdsLease: () => true, authorizeOrigin: () => true,
    diagnoseUnknown: async () => undefined, alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
  const runtimes: Record<Id, TelegramOriginRuntime> = { owner: base } as never;
  for (const id of ['author', 'third'] as const) {
    runtimes[id] = await TelegramOriginRuntime.open({ ...base.options, storage: { stateDir: temporaryState(), agentId: 'echo' },
      bot: id === 'author' ? { accountId: '123', token: `123:${randomUUID()}` } : { accountId: 'unresolved' },
      identity: { agentId: 'echo', agentName: 'Echo', originMachineId: id, originMachineName: id },
      signingKey: { privateKey, keyId: `${id}:1`, keyEpoch: 1 }, authorize: () => false, holdsLease: () => false });
  }
  for (const id of IDS) runtimes[id].attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(runtimes[id].options.storage.stateDir) });
  cleanups.push(async () => { for (const id of IDS) await runtimes[id].close(); });
  const resolveKey = (machineId: string) => (IDS as readonly string[]).includes(machineId) ? { machineId, agentId: 'echo', keyId: `${machineId}:1`, keyEpoch: 1,
    publicKey, validFrom: 0, validUntil: null, revokedAt: null } : null;
  const urls = {} as Record<Id, string>;
  const down = new Set<Id>();
  const routeCtx = { startTime: new Date(), sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
    state: { getJobState: () => null, getSession: () => null }, scheduler: null, telegram: null };
  for (const id of IDS) {
    const seen = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({ verify: { selfMachineId: id,
      verify: (bytes, signature, sender) => sender !== id && (IDS as readonly string[]).includes(sender) && verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, 'base64url')),
      isRegisteredPeer: sender => sender !== id && (IDS as readonly string[]).includes(sender), seenNonce: (_, nonce) => seen.has(nonce), now: Date.now },
      rbac: { routerHolder: () => 'owner', ownerOf: () => null, placementTargetOf: () => null }, recordNonce: (_, nonce) => { seen.add(nonce); },
      handlers: { 'telegram-origin': (command, sender) => handleOriginMesh({ runtime: runtimes[id], command: command as OriginMeshCommand, authenticatedSender: sender, resolveKey }) } });
    const app = express(); app.use(express.json({ limit: '2mb' }));
    // A stopped machine accepts the connection and never answers.
    app.use((req, _res, next) => { if (down.has(id) && req.path.startsWith('/mesh')) return; next(); });
    app.use(createRoutes({ ...routeCtx, config: { authToken: 'test', stateDir: runtimes[id].options.storage.stateDir, port: 0 }, telegramOrigin: runtimes[id], meshRpcDispatcher: dispatcher } as never));
    const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanups.push(async () => { server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); });
    urls[id] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const clients = Object.fromEntries(IDS.map(id => [id, new MeshRpcClient({ selfMachineId: id, nonce: randomUUID,
    sign: bytes => sign(null, Buffer.from(bytes), privateKey).toString('base64url') })])) as Record<Id, MeshRpcClient>;
  const meshCalls: Array<{ from: Id; to: string; command: OriginMeshCommand }> = [];
  const sendFrom = (from: Id) => async (machineId: string, command: OriginMeshCommand, timeoutMs: number) => {
    meshCalls.push({ from, to: machineId, command });
    const url = urls[machineId as Id];
    if (!url) return { ok: false };
    return clients[from].send({ machineId, url }, command, 0, { timeoutMs });
  };
  let ownerRead = true;
  for (const id of IDS) runtimes[id].ownerReader = new OriginOwnerReader({ selfMachineId: id, transport: { send: sendFrom(id) },
    leaseHolder: () => 'owner', enabled: () => ownerRead });
  const originalFetch = globalThis.fetch;
  const botNetwork = vi.fn(async (_url: string, init: RequestInit) => {
    const params = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 901, chat: { id: params.chat_id }, message_thread_id: params.message_thread_id } }));
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => String(url).startsWith('https://api.telegram.org/') ? botNetwork(url, init) : originalFetch(url, init));
  const author = runtimes.author;
  const lease: ForwardLeaseView = { selfMachineId: 'author', leaseHolder: () => 'owner', holdsLease: () => false, isHolderHealthy: () => true };
  const deps: ForwardDeps = {
    lease,
    prepare: async (holder, input, operationId) => {
      const params = applyTelegramFormatter('sendMessage', { chat_id: input.chatId, text: input.text, parse_mode: 'Markdown', message_thread_id: input.topicId }, undefined).outgoingParams as BotParameters;
      const operation = author.service.runAsUnboundAutomation('telegram-server', () => author.service.prepareBot({ method: 'sendMessage', accountId: '123', params,
        executionOwnerMachineId: holder, ...(operationId === undefined ? {} : { operationId }), policyInput: author.service.currentSendPolicyInput(input.text) }));
      author.service.authorizeSendPolicyDispatch(operation.record);
      await author.service.recordIntent(operation);
      return operation;
    },
    submit: (holder, operation) => submitOriginToHolder({ operation, send: command => sendFrom('author')(holder, command, 5000), expectedOwner: holder }),
    hold: async (operation, detail) => {
      await author.service.admit(operation);
      await author.store.recordOperationState({ operationId: operation.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> });
    },
    sleep: async () => undefined, now: Date.now, settleTimeoutMs: 200,
  };
  const outcome = async (on: Id, operationId: string) => {
    const response = await originalFetch(`${urls[on]}/telegram/origins/operations/${operationId}/outcome`, { headers: { Authorization: 'Bearer test' } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { runtimes, deps, botNetwork, outcome, meshCalls, stop: (id: Id) => down.add(id), setOwnerRead: (v: boolean) => { ownerRead = v; } };
}

describe('outcome route asks the execution owner (native-conversation-base §3b)', () => {
  it('author holding plus owner failure: pending on the third machine (found via originMachineId), then not-delivered once the author ends its row', async () => {
    const h = await boot();
    h.botNetwork.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }), { status: 400 }));
    const forwarded = await forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'A reply Telegram refuses at the holder.' });
    expect(forwarded).toMatchObject({ kind: 'held', holder: 'owner' });
    const operationId = (forwarded as { operationId: string }).operationId;
    expect((await h.runtimes.owner.store.getOperation(operationId))?.operation?.state).toBe('known-failed');
    expect(await h.runtimes.third.store.getOperation(operationId)).toBeNull();

    // F2: the third machine has no row. It asks the lease holder, which names the author.
    const first = await h.outcome('third', operationId);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: 'pending', safeToResend: false, source: 'execution-owner', answeredBy: 'owner', resolution: 7, executionOwnerMachineId: 'owner' });
    const thirdCalls = h.meshCalls.filter(call => call.from === 'third');
    expect(thirdCalls.map(call => call.to)).toEqual(['owner', 'author']);
    expect(thirdCalls.every(call => (call.command as { reader?: boolean }).reader === true)).toBe(true);
    // On the author itself the same reply reads pending (it holds it).
    expect((await h.outcome('author', operationId)).body).toMatchObject({ outcome: 'pending', safeToResend: false });

    // The author ends its row (deadline passed): nobody holds it any more.
    const held = await h.runtimes.author.store.getOperation(operationId);
    expect(await h.runtimes.author.store.recordOperationState({ operationId, state: 'expired', now: held!.operation!.deadlineAt + 1 })).toBe(true);
    const after = await h.outcome('third', operationId);
    expect(after.body).toMatchObject({ outcome: 'not-delivered', safeToResend: true, source: 'execution-owner', answeredBy: 'owner', failure: 'refused', resolution: 6 });
    // The owner's own route agrees.
    expect((await h.outcome('owner', operationId)).body).toMatchObject({ outcome: 'not-delivered', safeToResend: true, failure: 'refused' });
    // Nothing was ever sent twice.
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });

  it('the owner failed, then the author delivered it itself after the lease came back: delivered everywhere, never safe to resend', async () => {
    const h = await boot();
    h.botNetwork.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }), { status: 400 }));
    const forwarded = await forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'Refused at the holder, later sent by its author.' });
    const operationId = (forwarded as { operationId: string }).operationId;
    expect((await h.runtimes.owner.store.getOperation(operationId))?.operation?.state).toBe('known-failed');
    // The ladder's local send after the lease returns records the author's own receipt on the same id.
    expect(await h.runtimes.author.store.recordForwardedAcceptance({ operationId, deliveryMachineId: 'author', receiptJson: JSON.stringify({ messageId: '777', deliveryMachineId: 'author', supersededLocally: true }) })).toBe(true);
    for (const on of ['third', 'owner', 'author'] as const) {
      expect((await h.outcome(on, operationId)).body).toMatchObject({ outcome: 'delivered', safeToResend: false, messageIds: ['777'] });
    }
  });

  it('owner stopped, 20 distinct ids: every answer returns inside 4 s with why, and none says resend', async () => {
    const h = await boot();
    h.stop('owner');
    // 20 forwarded replies whose last forward was refused (so the author must ask the owner).
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const operation = await h.deps.prepare('owner', { topicId: 42, chatId: '-100123', text: `Reply number ${i} while the owner is down.` });
      await h.deps.hold(operation, { kind: 'forward-to-holder', lastAttempt: 'refused', machineId: 'owner', topicId: 42, chatId: '-100123', text: `Reply number ${i}`,
        reason: 'not-lease-holder', at: Date.now(), noticeDelivered: false, ladder: { attempts: 0, nextAt: Date.now() + 60_000 } } as never);
      ids.push(operation.record.operationId);
    }
    const started = Date.now();
    const answers = await Promise.all(ids.map(async id => { const t = Date.now(); const a = await h.outcome('author', id); return { ...a, ms: Date.now() - t }; }));
    expect(Date.now() - started).toBeLessThan(4500);
    for (const a of answers) {
      expect(a.ms).toBeLessThan(4500);
      expect(a.body).toMatchObject({ outcome: 'pending', safeToResend: false, ownerAnswered: false, why: 'timeout' });
    }
  }, 30_000);

  it('a held, not-yet-forwarded reply makes no mesh call', async () => {
    const h = await boot();
    const operation = await h.deps.prepare('owner', { topicId: 42, chatId: '-100123', text: 'Held before any forward.' });
    await h.deps.hold(operation, { kind: 'forward-to-holder', lastAttempt: 'unsettled', machineId: null, topicId: 42, chatId: '-100123', text: 'Held before any forward.',
      reason: 'lease-settling-no-holder', at: Date.now(), noticeDelivered: false, ladder: { attempts: 0, nextAt: Date.now() + 60_000 } } as never);
    const before = h.meshCalls.length;
    expect((await h.outcome('author', operation.record.operationId)).body).toMatchObject({ outcome: 'pending', safeToResend: false });
    expect(h.meshCalls.length).toBe(before);
  });

  it('a delivered forward reads delivered from the owner on every machine; switched off, the third machine makes no ask', async () => {
    const h = await boot();
    const forwarded = await forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'A reply the holder delivers.' });
    expect(forwarded).toMatchObject({ kind: 'sent', holder: 'owner', messageId: 901 });
    const operationId = (forwarded as { operationId: string }).operationId;
    expect((await h.outcome('third', operationId)).body).toMatchObject({ outcome: 'delivered', source: 'execution-owner', messageIds: ['901'], answeredBy: 'owner' });
    h.setOwnerRead(false);
    const before = h.meshCalls.filter(call => call.from === 'third').length;
    expect(await h.outcome('third', `${operationId.slice(0, -4)}ffff`)).toMatchObject({ status: 404, body: { outcome: 'unknown', safeToResend: false, why: 'owner-read-off' } });
    expect(h.meshCalls.filter(call => call.from === 'third').length).toBe(before);
  });
});
