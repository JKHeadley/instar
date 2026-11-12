/**
 * standby-durable-forward-without-token — acceptance 2–3 over the REAL signed mesh, real
 * origin stores: a standby WITHOUT the bot token holds a reply while the holder is
 * unreachable (the 2026-11-11 loss), then delivers it ONCE when the holder answers.
 * (Fixture adapted from the ACT-058 forward-on-standby integration test.)
 *
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
import { forwardReplyToHolder, recoverForwardedHold, confirmedRecoveredForward, submitOriginToHolder, HOLD_REASON_LEASE_NOT_HELD, heldForwardNoticeText, UNRESOLVED_TOKENLESS_ACCOUNT, validHolderCapabilities, followSupersedeChain } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardDeps, ForwardLeaseView, HeldForwardDetail } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import { relayOriginBot } from '../../src/messaging/telegram-origin/OriginMeshRelay.js';
import { TelegramOriginHoldError } from '../../src/messaging/telegram-origin/types.js';
import type { BotParameters } from '../../src/messaging/telegram-origin/types.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import { classifyOperationOutcome } from '../../src/messaging/telegram-origin/OriginOperationOutcome.js';

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
    storage: { stateDir: temporaryState(), agentId: 'echo' }, bot: { accountId: UNRESOLVED_TOKENLESS_ACCOUNT, token: undefined },
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
    tokenless: true,
    probe: async holder => { try { return validHolderCapabilities(await sendToHolder(holder)({ type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'capabilities' })); } catch { return { ok: false, reason: 'origin-peer-unreachable' }; } },
    prepare: async (holder, input, operationId, sealAccountId) => {
      const params = applyTelegramFormatter('sendMessage', { chat_id: input.chatId, text: input.text, parse_mode: 'Markdown', message_thread_id: input.topicId }, undefined).outgoingParams as BotParameters;
      const prepare = () => standby.service.prepareBot({ method: 'sendMessage', accountId: sealAccountId ?? UNRESOLVED_TOKENLESS_ACCOUNT, params, executionOwnerMachineId: holder,
        ...(operationId === undefined ? {} : { operationId }), policyInput: standby.service.currentSendPolicyInput(input.text) });
      const operation = standby.service.runAsUnboundAutomation('telegram-server', prepare);
      standby.service.authorizeSendPolicyDispatch(operation.record);
      await standby.service.recordIntent(operation);
      return operation;
    },
    submit: (holder, operation, capabilities) => submitOriginToHolder({ operation, send: sendToHolder(holder), expectedOwner: holder, capabilities }),
    hold: async (operation, detail) => {
      await standby.service.admit(operation);
      await standby.store.recordOperationState({ operationId: operation.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> });
      await standby.refreshHeldForward({ force: true });
    },
    notify,
    sleep: async ms => { sleeps.push(ms); }, now: Date.now, settleTimeoutMs: 200,
  };
  standby.options.forwardRecovery = (operation, row) => recoverForwardedHold({ lease, prepare: deps.prepare, submit: deps.submit, now: Date.now, tokenless: true, probe: deps.probe,
    receipt: async (machineId, operationId) => {
      try {
        const reply = await sendToHolder(machineId)({ type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId });
        const result = reply.result as { ok?: boolean; state?: string; originReceiptConfirmed?: boolean; messageIds?: string[] } | undefined;
        if (reply.ok && result?.ok) {
          if (result.state === 'accepted' && result.originReceiptConfirmed && result.messageIds?.length === 1) return { state: 'accepted', receiptJson: JSON.stringify({ messageId: result.messageIds[0], confirmedVia: 'receipt' }) };
          if (['no-record', 'not-admitted', 'known-failed', 'expired', 'suppressed', 'superseded'].includes(String(result.state))) return { state: 'not-accepted' };
          if (['admitted', 'held', 'partial', 'accepted'].includes(String(result.state))) return { state: 'owned-by-holder' };
          if (result.state === 'outcome-unknown') return { state: 'outcome-unknown' };
        }
        return { state: 'unreachable' };
      } catch { return { state: 'unreachable' }; }
    },
    resolve: (operationId, deliveryMachineId, receiptJson) => standby.store.recordForwardedAcceptance({ operationId, deliveryMachineId, receiptJson }),
    settleUnknown: (operationId, deliveryMachineId) => standby.store.recordForwardedOutcomeUnknown({ operationId, deliveryMachineId }),
    rehold: async (operationId, detail) => standby.store.recordOperationState({ operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> }),
    supersede: (operationId, next, detail) => standby.store.supersedeWithAdmission({ operationId, admission: next.admission, holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> }),
    sendLocal: async () => { throw new Error('the standby never holds the lease in this fixture'); },
  }, row, operation);
  const status = async () => (await originalFetch(`${standbyUrl}/telegram/origins/status`, { headers: { Authorization: 'Bearer test', 'X-Instar-Operator-Session': 'operator' } })).json() as Promise<{ held: Array<Record<string, unknown>>; heldForward: { count: number; topics: string[] } }>;
  const health = async () => (await originalFetch(`${standbyUrl}/health`, { headers: { Authorization: 'Bearer test' } })).json() as Promise<{ telegramOrigin?: { heldForward?: { count: number; topics: string[] } } }>;
  return { owner, standby, deps, botNetwork, sleeps, notify, status, health, setOwnerLease: (v: boolean) => { ownerHoldsLease = v; }, setOwnerReachable: (v: boolean) => { ownerReachable = v; },
    setLeaseHolder: (v: string) => { leaseHolder = v; }, setStandbyLease: (v: boolean) => { standbyHoldsLease = v; }, sendToOwner: sendToHolder('owner') };
}

describe('token-less standby durable forward over the signed mesh (standby-durable-forward-without-token)', () => {
  it('holder unreachable: the reply is HELD with the placeholder seal (no submit); holder back: re-sealed and delivered ONCE, and the first id resolves delivered', async () => {
    const h = await boot();
    h.setOwnerReachable(false);
    const outcome = await forwardReplyToHolder(h.deps, { topicId: 141014, chatId: '-100123', text: 'The root cause, saved.' });
    expect(outcome).toMatchObject({ kind: 'held', holder: 'owner', lastAttempt: 'unreachable' });
    expect(h.botNetwork).not.toHaveBeenCalled();
    const firstId = (outcome as { operationId: string }).operationId;
    const held = await h.standby.store.getOperation(firstId);
    expect(held?.operation?.state).toBe('held');
    expect(JSON.parse(held!.record.envelopeJson).destination.accountId).toBe(UNRESOLVED_TOKENLESS_ACCOUNT);
    const nextAt = (held?.operation?.holdDetail as HeldForwardDetail).ladder.nextAt!;
    // Still down at the first ladder step: retained, nothing sent.
    await h.standby.runForwardLadder(nextAt);
    expect(h.botNetwork).not.toHaveBeenCalled();
    // The holder answers again.
    h.setOwnerReachable(true);
    const again = (await h.standby.store.getOperation(firstId))?.operation?.holdDetail as HeldForwardDetail;
    await h.standby.runForwardLadder(again.ladder.nextAt ?? Date.now() + 3_600_000);
    expect(h.botNetwork).toHaveBeenCalledOnce();
    const end = await followSupersedeChain(firstId, id => h.standby.store.getOperation(id));
    expect(end.kind).toBe('terminal');
    if (end.kind === 'terminal') {
      expect(end.operationId).toMatch(new RegExp(`^${firstId}~r1-[0-9a-f]{8}$`));
      expect(end.audit?.operation?.state).toBe('accepted');
      expect(JSON.parse(end.audit!.record.envelopeJson).destination.accountId).toBe('123');
    }
    // No second delivery on later ticks.
    await h.standby.runForwardLadder(Date.now() + 7_200_000);
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });
  it('§2 per-pass reachability: holder down ⇒ one check per pass, no per-row recovery, ladder NOT advanced; holder back ⇒ delivered once', async () => {
    const h = await boot();
    h.setOwnerReachable(false);
    const outcome = await forwardReplyToHolder(h.deps, { topicId: 141014, chatId: '-100123', text: 'Held across a pass.' });
    const firstId = (outcome as { operationId: string }).operationId;
    const before = (await h.standby.store.getOperation(firstId))?.operation?.holdDetail as HeldForwardDetail;
    const checks = vi.fn(async () => (await h.deps.probe!('owner')).ok);
    h.standby.options.forwardTickReachable = checks;
    const recovery = vi.spyOn(h.standby.options, 'forwardRecovery');
    await h.standby.runForwardLadder(before.ladder.nextAt! + 1);
    expect(checks).toHaveBeenCalledTimes(1);
    expect(recovery).not.toHaveBeenCalled();
    const after = (await h.standby.store.getOperation(firstId))?.operation?.holdDetail as HeldForwardDetail;
    expect(after.ladder).toEqual(before.ladder);
    expect(h.botNetwork).not.toHaveBeenCalled();
    h.setOwnerReachable(true);
    await h.standby.runForwardLadder(before.ladder.nextAt! + 1);
    expect(checks).toHaveBeenCalledTimes(2);
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });
  it('healthy pool: sealed with the live account and delivered once on the first attempt (no hold, no placeholder)', async () => {
    const h = await boot();
    const outcome = await forwardReplyToHolder(h.deps, { topicId: 141014, chatId: '-100123', text: 'Straight through.' });
    expect(outcome).toMatchObject({ kind: 'sent', holder: 'owner' });
    expect(h.botNetwork).toHaveBeenCalledOnce();
    expect(await h.standby.store.listHeldOperations()).toEqual([]);
  });
});
