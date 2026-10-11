/**
 * a2a-single-agent-identity §4 (ACT-058) — AC6, Tier 2.
 *
 * Standby + holder pair over the REAL signed mesh HTTP pipeline, real origin
 * runtimes/stores and real routes: the standby's reply lands via the holder
 * (`forwardedFromMachine`); the holder refuses `not-lease-holder` after a lease
 * move and the ladder re-resolves; holder down → 409 `telegram-origin-held`
 * `{hold_reason: lease-not-held}`, listed in `/telegram/origins/status.held[]`
 * and on `/health`; holder back → delivered once (same operation id).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MeshRpcDispatcher } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { createRoutes } from '../../src/server/routes.js';
import { sendOriginHoldResponse } from '../../src/server/telegramOriginRoutes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { handleOriginMesh } from '../../src/messaging/telegram-origin/OriginMesh.js';
import type { OriginMeshCommand } from '../../src/messaging/telegram-origin/OriginMesh.js';
import { applyTelegramFormatter } from '../../src/messaging/TelegramAdapter.js';
import { forwardReplyToHolder, recoverForwardedHold, submitOriginToHolder, HOLD_REASON_LEASE_NOT_HELD, heldForwardNoticeText } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardDeps, ForwardLeaseView, HeldForwardDetail } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import { relayOriginBot } from '../../src/messaging/telegram-origin/OriginMeshRelay.js';
import { TelegramOriginHoldError } from '../../src/messaging/telegram-origin/types.js';
import type { BotParameters } from '../../src/messaging/telegram-origin/types.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllGlobals(); });

async function listen(app: express.Express): Promise<import('node:http').Server> {
  const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  return server;
}

async function boot() {
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let ownerHoldsLease = true;
  const token = `123:${randomUUID()}`;
  const owner = await TelegramOriginRuntime.open({ storage: { stateDir: temporaryState(), agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'owner', originMachineName: 'The Mini' },
    signingKey: { privateKey, keyId: 'owner:1', keyEpoch: 1 }, bot: { accountId: '123', token },
    display: () => ({ agent: { enabled: true } }), authorize: request => ownerHoldsLease && request.destination.chatId === '-100123',
    holdsLease: () => ownerHoldsLease, authorizeOrigin: () => true,
    diagnoseUnknown: async () => undefined, alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
  owner.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(owner.options.storage.stateDir) });
  // The standby ALSO holds the bot token (a pool standby serving a moved topic) but not the lease.
  // Same ACCOUNT, a distinct token string: the process-global egress registry is keyed on the
  // token, and production runs the two machines in two processes.
  let standbyHoldsLease = false;
  const standby = await TelegramOriginRuntime.open({ ...owner.options,
    storage: { stateDir: temporaryState(), agentId: 'echo' }, bot: { accountId: '123', token: `123:${randomUUID()}` },
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'standby', originMachineName: 'The Laptop' },
    signingKey: { privateKey, keyId: 'standby:1', keyEpoch: 1 }, authorize: request => standbyHoldsLease && request.destination.chatId === '-100123', holdsLease: () => standbyHoldsLease });
  standby.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(standby.options.storage.stateDir) });
  cleanups.push(async () => { await standby.close(); await owner.close(); });
  const seen = new Set<string>();
  const resolveKey = (machineId: string) => ['standby', 'owner'].includes(machineId) ? { machineId, agentId: 'echo', keyId: `${machineId}:1`, keyEpoch: 1,
    publicKey, validFrom: 0, validUntil: null, revokedAt: null } : null;
  const dispatcher = new MeshRpcDispatcher({ verify: { selfMachineId: 'owner',
    verify: (bytes, signature, sender) => sender === 'standby' && verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, 'base64url')),
    isRegisteredPeer: sender => sender === 'standby', seenNonce: (_, nonce) => seen.has(nonce), now: Date.now },
    rbac: { routerHolder: () => 'owner', ownerOf: () => null, placementTargetOf: () => null }, recordNonce: (_, nonce) => { seen.add(nonce); },
    handlers: { 'telegram-origin': (command, sender) => handleOriginMesh({ runtime: owner, command: command as OriginMeshCommand, authenticatedSender: sender, resolveKey }) } });
  // The minimum route context `/health` reads (mirrors the other route fixtures).
  const routeCtx = { startTime: new Date(), sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
    state: { getJobState: () => null, getSession: () => null }, scheduler: null, telegram: null };
  const ownerApp = express(); ownerApp.use(express.json({ limit: '2mb' }));
  ownerApp.use(createRoutes({ ...routeCtx, config: { authToken: 'test', stateDir: owner.options.storage.stateDir, port: 0 }, telegramOrigin: owner, meshRpcDispatcher: dispatcher } as never));
  const ownerServer = await listen(ownerApp);
  const standbyApp = express(); standbyApp.use(express.json({ limit: '2mb' }));
  standbyApp.use(createRoutes({ ...routeCtx, config: { authToken: 'test', stateDir: standby.options.storage.stateDir, port: 0 }, telegramOrigin: standby,
    verifyDashboardOperatorSession: (proof: string | undefined) => proof === 'operator' } as never));
  const standbyServer = await listen(standbyApp);
  const standbyUrl = `http://127.0.0.1:${(standbyServer.address() as AddressInfo).port}`;
  const originalFetch = globalThis.fetch;
  let nextMessageId = 300;
  const botNetwork = vi.fn(async (_url: string, init: RequestInit) => {
    const params = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++nextMessageId, chat: { id: params.chat_id }, message_thread_id: params.message_thread_id } }));
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => String(url).startsWith('https://api.telegram.org/') ? botNetwork(url, init) : originalFetch(url, init));
  const client = new MeshRpcClient({ selfMachineId: 'standby', nonce: randomUUID, sign: bytes => sign(null, Buffer.from(bytes), privateKey).toString('base64url') });
  let ownerReachable = true;
  const sendToHolder = (holder: string) => async (command: OriginMeshCommand) => {
    if (holder !== 'owner' || !ownerReachable) throw new Error('ECONNREFUSED');
    return client.send({ machineId: 'owner', url: `http://127.0.0.1:${(ownerServer.address() as AddressInfo).port}` }, command, 0, { timeoutMs: 5000 });
  };
  let leaseHolder = 'owner';
  const lease: ForwardLeaseView = { selfMachineId: 'standby', leaseHolder: () => leaseHolder, holdsLease: () => false, isHolderHealthy: () => true };
  const sleeps: number[] = [];
  const notify = vi.fn(async (holder: string, topicId: number) => {
    const r = await standby.service.runAsUnboundAutomation('telegram-server', () => relayOriginBot({ runtime: standby, topicId, chatId: '-100123',
      text: heldForwardNoticeText('The Mini'), send: sendToHolder(holder), executionOwnerMachineId: holder }));
    return Number.isSafeInteger(r.messageId);
  });
  const deps: ForwardDeps = {
    lease,
    prepare: async (holder, input, operationId) => {
      const params = applyTelegramFormatter('sendMessage', { chat_id: input.chatId, text: input.text, parse_mode: 'Markdown', message_thread_id: input.topicId }, undefined).outgoingParams as BotParameters;
      const prepare = () => standby.service.prepareBot({ method: 'sendMessage', accountId: '123', params, executionOwnerMachineId: holder,
        ...(operationId === undefined ? {} : { operationId }), policyInput: standby.service.currentSendPolicyInput(input.text) });
      const operation = standby.service.runAsUnboundAutomation('telegram-server', prepare);
      standby.service.authorizeSendPolicyDispatch(operation.record);
      await standby.service.recordIntent(operation);
      return operation;
    },
    submit: (holder, operation) => submitOriginToHolder({ operation, send: sendToHolder(holder), expectedOwner: holder }),
    hold: async (operation, detail) => {
      await standby.service.admit(operation);
      await standby.store.recordOperationState({ operationId: operation.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> });
      await standby.refreshHeldForward({ force: true });
    },
    notify,
    sleep: async ms => { sleeps.push(ms); }, now: Date.now, settleTimeoutMs: 200,
  };
  standby.options.forwardRecovery = (operation, row) => recoverForwardedHold({ lease, prepare: deps.prepare, submit: deps.submit, now: Date.now,
    receipt: async (machineId, operationId) => {
      try {
        const reply = await sendToHolder(machineId)({ type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId });
        const result = reply.result as { ok?: boolean; state?: string; originReceiptConfirmed?: boolean } | undefined;
        if (reply.ok && result?.ok) {
          if (result.state === 'accepted' && result.originReceiptConfirmed) return { state: 'accepted', receiptJson: JSON.stringify({ confirmedVia: 'receipt' }) };
          if (['no-record', 'not-admitted', 'known-failed', 'expired', 'suppressed', 'superseded'].includes(String(result.state))) return { state: 'not-accepted' };
          if (['admitted', 'held', 'partial', 'accepted'].includes(String(result.state))) return { state: 'owned-by-holder' };
        }
        return { state: 'unreachable' };
      } catch { return { state: 'unreachable' }; }
    },
    resolve: (operationId, deliveryMachineId, receiptJson) => standby.store.recordForwardedAcceptance({ operationId, deliveryMachineId, receiptJson }),
    rehold: async (operationId, detail) => { await standby.store.recordOperationState({ operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> }); },
    supersede: (operationId, next, detail) => standby.store.supersedeWithAdmission({ operationId, admission: next.admission, holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> }),
    sendLocal: async () => { throw new Error('the standby never holds the lease in this fixture'); },
  }, row, operation);
  const status = async () => (await originalFetch(`${standbyUrl}/telegram/origins/status`, { headers: { Authorization: 'Bearer test', 'X-Instar-Operator-Session': 'operator' } })).json() as Promise<{ held: Array<Record<string, unknown>>; heldForward: { count: number; topics: string[] } }>;
  const health = async () => (await originalFetch(`${standbyUrl}/health`, { headers: { Authorization: 'Bearer test' } })).json() as Promise<{ telegramOrigin?: { heldForward?: { count: number; topics: string[] } } }>;
  return { owner, standby, deps, botNetwork, sleeps, notify, status, health, setOwnerLease: (v: boolean) => { ownerHoldsLease = v; }, setOwnerReachable: (v: boolean) => { ownerReachable = v; },
    setLeaseHolder: (v: string) => { leaseHolder = v; }, setStandbyLease: (v: boolean) => { standbyHoldsLease = v; }, sendToOwner: sendToHolder('owner') };
}

describe('Telegram origin forward-to-holder over the signed mesh pipeline (ACT-058)', () => {
  it("a standby's reply lands via the holder, attested by the standby and delivered by the owner (forwardedFromMachine)", async () => {
    const h = await boot();
    const outcome = await forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'The requested report from the standby.' });
    expect(outcome).toMatchObject({ kind: 'sent', holder: 'owner', messageId: 301 });
    expect(h.botNetwork).toHaveBeenCalledOnce();
    const ownerRecord = (await h.owner.store.listOrigins()).records.find(r => r.operation?.operationId === (outcome as { operationId: string }).operationId)!;
    expect(ownerRecord.record.machineId).toBe('standby'); // forwardedFromMachine
    expect(ownerRecord.children[0].state).toBe('accepted');
    expect(ownerRecord.attempts.at(-1)).toMatchObject({ outcome: 'accepted', deliveryMachineId: 'owner' });
    expect(h.sleeps).toEqual([]);
    expect((await h.status()).heldForward.count).toBe(0);
  });

  it('the holder refuses `not-lease-holder` (a lease move): the request holds after ONE attempt; the +10 s ladder step from the tick re-resolves and delivers once', async () => {
    const h = await boot();
    h.setOwnerLease(false);
    const outcome = await forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'After the lease moved.' });
    expect(outcome).toMatchObject({ kind: 'held', holder: 'owner', lastAttempt: 'refused', reason: 'not-lease-holder' });
    expect(h.sleeps).toEqual([]); // no in-request retry
    expect(h.botNetwork).not.toHaveBeenCalled();
    const operationId = (outcome as { operationId: string }).operationId;
    const held = await h.standby.store.getOperation(operationId);
    expect((held?.operation?.holdDetail as HeldForwardDetail).ladder).toMatchObject({ attempts: 0 });
    const nextAt = (held?.operation?.holdDetail as HeldForwardDetail).ladder.nextAt!;
    // Not due yet: the tick does nothing.
    expect(await h.standby.runForwardLadder(nextAt - 1)).toEqual({ processed: 0, recovered: 0 });
    // The holder now holds the lease: the first ladder step lands the SAME operation id once.
    h.setOwnerLease(true);
    expect(await h.standby.runForwardLadder(nextAt)).toEqual({ processed: 1, recovered: 1 });
    expect(h.botNetwork).toHaveBeenCalledOnce();
    expect((await h.owner.store.getOperation(operationId))?.operation).toMatchObject({ operationId, state: 'accepted' });
    expect((await h.standby.store.getOperation(operationId))?.operation).toMatchObject({ state: 'accepted' });
    expect(h.notify).toHaveBeenCalledWith('owner', 42); // the notice went through the holder at hold time (refused there too, honestly)
    expect(await h.standby.runForwardLadder(nextAt + 60_000)).toEqual({ processed: 0, recovered: 0 });
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });

  it('a lease move while held: the old record (bound to the dark owner) is SUPERSEDED and the reply lands ONCE via the new holder', async () => {
    const h = await boot();
    h.setLeaseHolder('owner-old'); // an owner that cannot be reached at all
    const outcome = await forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'Bound to the old owner.' });
    expect(outcome).toMatchObject({ kind: 'held', holder: 'owner-old', lastAttempt: 'unreachable' });
    const oldId = (outcome as { operationId: string }).operationId;
    const nextAt = ((await h.standby.store.getOperation(oldId))?.operation?.holdDetail as HeldForwardDetail).ladder.nextAt!;
    // The lease moved to the reachable owner.
    h.setLeaseHolder('owner');
    expect(await h.standby.runForwardLadder(nextAt)).toEqual({ processed: 1, recovered: 1 });
    expect(h.botNetwork).toHaveBeenCalledOnce();
    const old = await h.standby.store.getOperation(oldId);
    expect(old?.operation).toMatchObject({ state: 'superseded' });
    const newId = (old?.operation?.holdDetail as { supersededBy: string }).supersededBy;
    expect(newId).not.toBe(oldId);
    expect((await h.standby.store.getOperation(newId))?.operation).toMatchObject({ state: 'accepted' });
    expect((await h.owner.store.getOperation(newId))?.operation).toMatchObject({ state: 'accepted' });
    expect(await h.owner.store.getOperation(oldId)).toBeNull(); // the old record never reached the new owner
    expect((await h.status()).heldForward.count).toBe(0);
    // Neither tick nor schedule re-sends anything.
    expect(await h.standby.runForwardLadder(nextAt + 60_000)).toEqual({ processed: 0, recovered: 0 });
    expect(await h.standby.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });

  it("the holder answers `no-record` for an id it never saw, and a DIRECT-path lease hold is re-admitted and delivered by the standby's own replay once its lease returns", async () => {
    const h = await boot();
    // Receipt for an unknown id is a DEFINITE non-admission, distinct from a store outage.
    const receiptReply = await h.sendToOwner({ type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId: randomUUID() });
    expect(receiptReply.ok).toBe(true);
    expect((receiptReply.result as { state?: string }).state).toBe('no-record');
    // Direct path: the standby's own `authorize` refuses while it is not the holder.
    const network = vi.fn();
    await expect(h.standby.service.runAsAutomation('telegram-server', () => h.standby.service.sendBot(
      { method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Direct-path reply.' } }, network)))
      .rejects.toMatchObject({ reason: 'lease-not-held' });
    const held = await h.standby.store.listHeldOperations({ holdReason: 'lease-not-held' });
    expect(held).toHaveLength(1); expect(held[0].executionOwnerMachineId).toBe('standby');
    // A direct-path hold is reported ONCE (the server wires the notice/item on this hook), never per tick.
    const observed = vi.fn(async () => undefined);
    h.standby.options.onLeaseHoldObserved = observed;
    await h.standby.refreshHeldForward({ force: true }); await h.standby.refreshHeldForward({ force: true });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ operationId: held[0].operationId, holdReason: 'lease-not-held' }));
    // The marker is on the row, so a RESTARTED runtime (fresh in-memory set) does not report it again.
    expect((await h.standby.store.getOperation(held[0].operationId))?.operation?.holdDetail).toMatchObject({ kind: 'direct-lease-hold', reportedAt: expect.any(Number) });
    (h.standby as unknown as { '#observedLeaseHolds'?: Set<string> })['#observedLeaseHolds']?.clear();
    await h.standby.refreshHeldForward({ force: true });
    expect(observed).toHaveBeenCalledTimes(1);
    expect((await h.status()).heldForward).toMatchObject({ count: 1, topics: ['42'] });
    // Not the holder yet: the replay waits (no send, no re-admit).
    expect(await h.standby.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.botNetwork).not.toHaveBeenCalled();
    expect((await h.standby.store.getOperation(held[0].operationId))?.operation).toMatchObject({ state: 'held', holdReason: 'lease-not-held' });
    // The lease returns here: re-admitted, replayed through the standby's OWN token, delivered once.
    h.setStandbyLease(true);
    expect(await h.standby.recoverHeld()).toEqual({ processed: 1, recovered: 1 });
    expect(h.botNetwork).toHaveBeenCalledOnce();
    expect((await h.standby.store.getOperation(held[0].operationId))?.operation).toMatchObject({ state: 'accepted' });
    expect(await h.standby.store.listHeldOperations({ holdReason: 'lease-not-held' })).toHaveLength(0);
    expect(await h.standby.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });

  it('the notice goes through the holder when the holder can be reached but refuses the reply', async () => {
    const h = await boot();
    h.setOwnerLease(false); // the one in-request submit → not-lease-holder (retryable), held for the ladder
    const outcome = await forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'Refused once.' });
    expect(outcome).toMatchObject({ kind: 'held', lastAttempt: 'refused', reason: 'not-lease-holder' });
    expect(h.notify).toHaveBeenCalledWith('owner', 42);
    // The notice itself was refused by the same lease check — honest: not delivered.
    expect(outcome).toMatchObject({ noticeDelivered: false });
    expect(h.botNetwork).not.toHaveBeenCalled();
    h.setOwnerLease(true);
    expect(await h.deps.notify!('owner', 42)).toBe(true);
    expect(h.botNetwork).toHaveBeenCalledOnce();
    expect(JSON.parse(h.botNetwork.mock.calls[0][1].body as string).text).toContain('my reply is delayed while it is routed through The Mini');
  });
});
