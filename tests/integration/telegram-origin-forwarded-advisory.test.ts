/**
 * native-conversation-forwarded-advisory (slice 3g) — Tier 2: a tone verdict on a
 * reply in custody, between two real origin runtimes (holder = the lease holder,
 * author = the machine that wrote the reply), each behind the REAL signed mesh
 * pipeline (MeshRpcClient → MeshRpcDispatcher → handleOriginMesh). Every test
 * asserts the Telegram dispatch count.
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
import { applyTelegramFormatter } from '../../src/messaging/TelegramAdapter.js';
import { AdvisoryAnswerClosedError, classifyHolderReceipt, forwardReplyToHolder, recoverForwardedHold, submitOriginToHolder, HOLD_REASON_LEASE_NOT_HELD } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardDeps, ForwardRecoveryDeps, ForwardLeaseView, HolderSubmitResult } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import { OriginSendPolicyRefusal } from '../../src/messaging/telegram-origin/OriginSendPolicy.js';
import type { OriginSendPolicyDecision } from '../../src/messaging/telegram-origin/OriginSendPolicy.js';
import type { BotParameters, TelegramOriginRecord } from '../../src/messaging/telegram-origin/types.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

const IDS = ['holder', 'author'] as const;
type Id = typeof IDS[number];
type Review = OriginSendPolicyDecision;
const PASS: Review = { ok: true };
const ADVISORY = (ref: string | null = 'dq-1'): Review => ({ ok: false, status: 422, reason: 'tone-gate-advisory', body: { error: 'tone-gate-advisory', notSent: true,
  rule: 'B11_STYLE_MISMATCH', issue: 'internal', suggestion: 'Say it in two sentences.', ...(ref ? { decisionRef: ref } : {}) } });
const CREDENTIAL: Review = { ok: false, status: 422, reason: 'credential-exposure-guard', body: { error: 'Message blocked', blockedBy: 'credential-exposure-guard', overridable: false } };
const CAPACITY: Review = { ok: false, status: 422, reason: 'tone-gate-blocked', body: { error: 'tone-gate-blocked', rule: 'CAPACITY_UNAVAILABLE', issue: 'x', suggestion: 'y' } };
const NO_RULE: Review = { ok: false, status: 422, reason: 'tone-gate-blocked', body: { error: 'tone-gate-blocked', rule: 'GATE_UNAVAILABLE', failedClosed: true } };
const FLOOR: Review = { ok: false, status: 422, reason: 'tone-gate-blocked', body: { error: 'tone-gate-blocked', rule: 'B1_CLI_COMMAND', failedClosed: true, degradedToDeterministic: true } };

async function boot() {
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const holder = await TelegramOriginRuntime.open({ storage: { stateDir: temporaryState(), agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'holder', originMachineName: 'The Studio' },
    signingKey: { privateKey, keyId: 'holder:1', keyEpoch: 1 }, bot: { accountId: '123', token: `123:${randomUUID()}` },
    display: () => ({ agent: { enabled: true } }), authorize: request => request.destination.chatId === '-100123',
    holdsLease: () => true, authorizeOrigin: () => true,
    diagnoseUnknown: async () => undefined, alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
  const author = await TelegramOriginRuntime.open({ ...holder.options, storage: { stateDir: temporaryState(), agentId: 'echo' },
    bot: { accountId: '123', token: `123:${randomUUID()}` }, identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'author', originMachineName: 'Mac M5' },
    signingKey: { privateKey, keyId: 'author:1', keyEpoch: 1 }, authorize: () => false, holdsLease: () => false });
  const runtimes: Record<Id, TelegramOriginRuntime> = { holder, author };
  const reviews: Review[] = [];
  let reviewCount = 0;
  cleanups.push(async () => { for (const id of IDS) await runtimes[id].close(); });
  const resolveKey = (machineId: string) => (IDS as readonly string[]).includes(machineId) ? { machineId, agentId: 'echo', keyId: `${machineId}:1`, keyEpoch: 1,
    publicKey, validFrom: 0, validUntil: null, revokedAt: null } : null;
  const urls = {} as Record<Id, string>;
  for (const id of IDS) {
    const seen = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({ verify: { selfMachineId: id,
      verify: (bytes, signature, sender) => sender !== id && (IDS as readonly string[]).includes(sender) && verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, 'base64url')),
      isRegisteredPeer: sender => sender !== id && (IDS as readonly string[]).includes(sender), seenNonce: (_, nonce) => seen.has(nonce), now: Date.now },
      rbac: { routerHolder: () => 'holder', ownerOf: () => null, placementTargetOf: () => null }, recordNonce: (_, nonce) => { seen.add(nonce); },
      handlers: { 'telegram-origin': (command, sender) => handleOriginMesh({ runtime: runtimes[id], command: command as OriginMeshCommand, authenticatedSender: sender, resolveKey }) } });
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use(createRoutes({ startTime: new Date(), sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
      state: { getJobState: () => null, getSession: () => null }, scheduler: null, telegram: null,
      config: { authToken: 'test', stateDir: runtimes[id].options.storage.stateDir, port: 0 }, telegramOrigin: runtimes[id], meshRpcDispatcher: dispatcher } as never));
    const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanups.push(async () => { server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); });
    urls[id] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  // After the routes: `createRoutes` attaches the real send policy, which these replace.
  holder.attachSendPolicy({ review: async () => { reviewCount++; return reviews.shift() ?? PASS; }, authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(holder.options.storage.stateDir) });
  author.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(author.options.storage.stateDir) });
  const clients = Object.fromEntries(IDS.map(id => [id, new MeshRpcClient({ selfMachineId: id, nonce: randomUUID,
    sign: bytes => sign(null, Buffer.from(bytes), privateKey).toString('base64url') })])) as Record<Id, MeshRpcClient>;
  const sendFrom = (from: Id) => (machineId: string, command: OriginMeshCommand) => clients[from].send({ machineId, url: urls[machineId as Id] }, command, 0, { timeoutMs: 5000 });
  const originalFetch = globalThis.fetch;
  const botNetwork = vi.fn(async (_url: string, init: RequestInit) => {
    const params = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 901, chat: { id: params.chat_id }, message_thread_id: params.message_thread_id } }));
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => String(url).startsWith('https://api.telegram.org/') ? botNetwork(url, init) : originalFetch(url, init));
  const sent = () => botNetwork.mock.calls.map(call => JSON.parse(call[1].body as string).text as string);

  // The author's session: replies are prepared under its recorded producer, so they are session replies.
  const seed = author.service.runAsAutomation('telegram-server', () => author.service.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'seed' } }));
  const session = { ...seed.record, producerKind: 'session', producerId: 'session', sessionId: 'session-1', sessionIncarnation: 'incarnation-1',
    harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
  const lines: string[] = [];
  author.options.isSessionLive = () => true;
  author.options.injectSessionLine = (_binding, text) => { lines.push(text); return true; };
  author.options.raiseHandBackItem = () => undefined;

  let dropNextSubmitAnswer = false, olderHolder = false, leaseHolder = 'holder', crashBeforeSubmit = false;
  const lease: ForwardLeaseView = { selfMachineId: 'author', leaseHolder: () => leaseHolder, holdsLease: () => false, isHolderHealthy: () => true };
  const submit = async (machine: string, operation: Parameters<ForwardDeps['submit']>[1]): Promise<HolderSubmitResult> => {
    if (crashBeforeSubmit) { crashBeforeSubmit = false; throw new Error('process stopped before the submit'); }
    const result = await submitOriginToHolder({ operation, send: async command => {
      const reply = await sendFrom('author')(machine, command);
      // An older holder answers a refusal with no `copyEnded` (it keeps its row).
      if (olderHolder && command.action === 'submit') { const r = reply.result as Record<string, unknown> | undefined; if (r) { delete r.copyEnded; delete r.policyVerdict; } }
      return reply;
    }, expectedOwner: machine });
    if (dropNextSubmitAnswer) { dropNextSubmitAnswer = false; return { ok: false, reason: 'origin-relay-acceptance-unknown', outcome: 'outcome-unknown', retryable: false }; }
    return result;
  };
  const deps: ForwardDeps = {
    lease,
    prepare: async (machine, input, operationId) => {
      const params = applyTelegramFormatter('sendMessage', { chat_id: input.chatId, text: input.text, parse_mode: 'Markdown', message_thread_id: input.topicId }, undefined).outgoingParams as BotParameters;
      const run = () => author.service.prepareBot({ method: 'sendMessage', accountId: '123', params, executionOwnerMachineId: machine,
        ...(operationId === undefined ? {} : { operationId }), policyInput: author.service.currentSendPolicyInput(input.text) });
      const operation = author.service.hasProducerContext() ? run() : author.service.runAsRecordedProducer(session, run);
      author.service.authorizeSendPolicyDispatch(operation.record);
      await author.service.recordIntent(operation);
      return operation;
    },
    submit,
    hold: async (operation, detail) => {
      await author.service.admit(operation);
      return author.store.recordOperationState({ operationId: operation.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> });
    },
    sleep: async () => undefined, now: Date.now, settleTimeoutMs: 200,
    advisory: {
      supersede: async (originalId, next, detail) => {
        const answer = author.service.currentAdvisoryAnswer();
        const ok = await author.store.supersedeWithAdmission({ operationId: originalId, admission: next.admission, holdReason: HOLD_REASON_LEASE_NOT_HELD,
          holdDetail: detail as unknown as Record<string, unknown>, ...(answer ? { firstPreparedAt: answer.firstPreparedAt } : {}) });
        author.service.settleAdvisoryAnswer(ok ? 'superseded' : 'closed');
        return ok;
      },
      resolve: (operationId, deliveryMachineId, receiptJson) => author.store.recordForwardedAcceptance({ operationId, deliveryMachineId, receiptJson }),
      rehold: (operationId, detail) => author.store.recordOperationState({ operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> }),
      markAdvisory: (operationId, v) => author.store.markForwardAdvisory({ operationId, verdict: v as unknown as Record<string, unknown> }),
      markRefused: (operationId, v) => author.store.mergeHoldDetail({ operationId, patch: { ownerVerdict: v } }),
      noteAnsweredInline: operationId => author.noteVerdictAnsweredInline(operationId),
    },
  };
  const recoveryDeps: ForwardRecoveryDeps = {
    lease, prepare: deps.prepare, submit, audit: row => { if (process.env.ADVISORY_DEBUG) console.log('AUDIT', JSON.stringify(row)); }, now: Date.now,
    receipt: async (machineId, operationId) => {
      try { return classifyHolderReceipt(await sendFrom('author')(machineId, { type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId }), operationId, machineId); }
      catch { return { state: 'unreachable' }; }
    },
    resolve: (operationId, deliveryMachineId, receiptJson) => author.store.recordForwardedAcceptance({ operationId, deliveryMachineId, receiptJson }),
    settleUnknown: (operationId, deliveryMachineId) => author.store.recordForwardedOutcomeUnknown({ operationId, deliveryMachineId }),
    rehold: (operationId, detail) => author.store.recordOperationState({ operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as unknown as Record<string, unknown> }),
    supersede: (operationId, next, detail, carrier) => author.store.supersedeWithAdmission({ operationId, admission: next.admission, holdReason: HOLD_REASON_LEASE_NOT_HELD,
      holdDetail: detail as unknown as Record<string, unknown>, ...(carrier ? { firstPreparedAt: carrier.firstPreparedAt, lateMarkedAt: carrier.lateMarkedAt } : {}) }),
    mergeDetail: (operationId, patch) => author.store.mergeHoldDetail({ operationId, patch: patch as Record<string, unknown> }),
    onOwnerVerdict: (row, v) => author.handOwnerVerdict(row, v),
    markAdvisory: (operationId, v) => author.store.markForwardAdvisory({ operationId, verdict: v as unknown as Record<string, unknown> }),
    onAdvisory: row => author.handAdvisory(row),
    sendLocal: async () => { throw new Error('no local send in these tests'); },
  };
  /** One recovery pass on the author for every held forward (the ladder and the 15-minute schedule both call this). */
  const authorRecovery = async () => {
    const out: string[] = [];
    // The sealed admissions, exactly as the recovery scheduler reads them (advisory rows are never among them).
    const sealed = new Map((await author.store.recoverableAdmissions({ limit: 100 })).map(a => [a.operationId, a]));
    for (const row of await author.store.listHeldOperations({ holdReason: HOLD_REASON_LEASE_NOT_HELD, limit: 500 })) {
      if (row.state !== 'held') continue;
      const admission = sealed.get(row.operationId);
      const record = JSON.parse((await author.store.getOperation(row.operationId))!.record.envelopeJson) as TelegramOriginRecord;
      // A row the scheduler no longer offers is still handed to the ladder, which must refuse to move it.
      out.push(await recoverForwardedHold(recoveryDeps, row, { record, admission: admission ?? ({} as never) }));
    }
    return out;
  };
  /** A session reply, forwarded once, whose submit answer is lost: custody at the holder. */
  const forwardInCustody = async (text: string, review: Review) => {
    reviews.push(review); dropNextSubmitAnswer = true;
    const outcome = await author.service.runAsRecordedProducer(session, () => forwardReplyToHolder(deps, { topicId: 42, chatId: '-100123', text }));
    expect(outcome).toMatchObject({ kind: 'held', lastAttempt: 'outcome-unknown', holder: 'holder' });
    return (outcome as { operationId: string }).operationId;
  };
  /** The session answers a handed-back reply (item 5): a reply carrying the reference. */
  const answer = (originalId: string, text: string, kind: 'complied' | 'acked' = 'complied') => author.service.runAsRecordedProducer(session, async () => {
    const match = await author.findAdvisoryAnswer({ sessionId: 'session-1', topicId: 42, ref: (await author.store.getOperation(originalId))!.operation!.policyVerdict!.decisionRef as string ?? `op:${originalId}` });
    if (match) author.service.setAdvisoryAnswer({ originalId: match.operationId, firstPreparedAt: match.firstPreparedAt, deadlineAt: match.deadlineAt, kind, handedBackAt: match.verdict.at });
    return forwardReplyToHolder(deps, { topicId: 42, chatId: '-100123', text, ...(match ? { advisoryReplacementOf: match.operationId } : {}) });
  });
  return { runtimes, holder, author, reviews, reviewCount: () => reviewCount, botNetwork, sent, lines, deps, session, authorRecovery, forwardInCustody, answer, sendFrom,
    setOlderHolder: (v: boolean) => { olderHolder = v; }, setLeaseHolder: (v: string) => { leaseHolder = v; }, crashBeforeNextSubmit: () => { crashBeforeSubmit = true; } };
}

describe('a tone verdict on a forwarded reply in custody (native-conversation-forwarded-advisory)', () => {
  it('advisory in custody: the holder ends its copy, the author holds the only copy with the verdict, one line; comply sends only the revised text', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('A long first answer.', ADVISORY());
    expect((await h.holder.store.getOperation(id))?.operation).toMatchObject({ state: 'suppressed', holdReason: 'tone-advisory' });
    expect(await h.authorRecovery()).toEqual(['settled']);
    const row = (await h.author.store.getOperation(id))!.operation!;
    expect(row).toMatchObject({ state: 'held', policyVerdict: { class: 'advisory', rule: 'B11_STYLE_MISMATCH', decisionRef: 'dq-1' } });
    expect(h.lines).toEqual([expect.stringContaining(`Your reply \`${id}\` was not sent. The outbound check has a suggestion (\`B11_STYLE_MISMATCH\`): Say it in two sentences.`)]);
    expect(h.lines[0]).toContain('--tone-decision-ref dq-1');
    // Never reviewed again, never re-forwarded, the line never repeated.
    expect(await h.authorRecovery()).toEqual(['skipped']);
    await h.author.refreshHeldForward({ force: true });
    expect(h.lines).toHaveLength(1);
    expect(h.botNetwork).not.toHaveBeenCalled();
    // The holder's own recovery has nothing to send.
    await h.holder.recoverHeld();
    expect(h.botNetwork).not.toHaveBeenCalled();
    // The author's outcome reads "not sent", never "safe to resend".
    const reviewsBefore = h.reviewCount();
    const sent = await h.answer(id, 'A short answer.');
    expect(sent).toMatchObject({ kind: 'sent', holder: 'holder' });
    expect(h.reviewCount()).toBe(reviewsBefore + 1);
    expect(h.sent()).toEqual([expect.stringContaining('A short answer.')]);
    expect((await h.author.store.getOperation(id))?.operation).toMatchObject({ state: 'superseded', holdDetail: { supersededBy: (sent as { operationId: string }).operationId } });
    expect(await h.author.heldReplyCounters()).toMatchObject({ advisoryHandedBack: 1, advisoryLineSent: 1, advisoryComplied: 1, advisoryAnswerDelayCount: 1 });
    // A second answer with the same reference finds the row closed: nothing sent.
    await expect(h.answer(id, 'Another try.')).rejects.toBeInstanceOf(AdvisoryAnswerClosedError);
    expect(h.botNetwork).toHaveBeenCalledOnce();
    expect(await h.author.heldReplyCounters()).toMatchObject({ advisoryAnswerRefused: 1 });
  });

  it('ack: the original text is sent once, by its replacement', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('Exactly as written.', ADVISORY(null));
    await h.authorRecovery();
    expect(h.lines[0]).toContain(`--tone-decision-ref op:${id}`);
    await h.answer(id, 'Exactly as written.', 'acked');
    expect(h.sent()).toEqual([expect.stringContaining('Exactly as written.')]);
    await h.authorRecovery(); await h.holder.recoverHeld();
    expect(h.botNetwork).toHaveBeenCalledOnce();
    expect(await h.author.heldReplyCounters()).toMatchObject({ advisoryAcked: 1 });
  });

  it('silence to the deadline: one advisory line, then one definite deadline line that says what to do if revised; nothing delivered', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('Never answered.', ADVISORY());
    await h.authorRecovery();
    const row = (await h.author.store.getOperation(id))!.operation!;
    expect(await h.author.store.recordOperationState({ operationId: id, state: 'expired', now: row.deadlineAt + 1 })).toBe(true);
    await h.author.refreshHeldForward({ force: true });
    await h.author.refreshHeldForward({ force: true });
    expect(h.lines).toHaveLength(2);
    expect(h.lines[1]).toMatch(/was not delivered \(it passed its delivery deadline\) and will not be retried\..*If you already sent a revised version, do nothing\.$/);
    expect(await h.author.store.listHeldOperations({ advisory: 'only' })).toEqual([]);
    expect(h.botNetwork).not.toHaveBeenCalled();
    expect(await h.author.heldReplyCounters()).toMatchObject({ advisoryExpiredUnanswered: 1 });
  });

  it('an unflagged reply while one is held is a separate message; the held one stays held and is never sent', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('The held one.', ADVISORY());
    await h.authorRecovery();
    const other = await h.author.service.runAsRecordedProducer(h.session, () => forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'A new message.' }));
    expect(other).toMatchObject({ kind: 'sent' });
    expect(h.sent()).toEqual([expect.stringContaining('A new message.')]);
    expect((await h.author.store.getOperation(id))?.operation?.state).toBe('held');
  });

  it('a synchronous advisory: the session is told now, the holder copy is ended, and a recovery tick sends nothing', async () => {
    const h = await boot();
    h.reviews.push(ADVISORY());
    await expect(h.author.service.runAsRecordedProducer(h.session, () => forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'First draft.' })))
      .rejects.toBeInstanceOf(OriginSendPolicyRefusal);
    const holderRows = (await h.holder.store.listOrigins()).records.filter(r => r.operation);
    expect(holderRows.map(r => [r.operation!.state, r.operation!.holdReason])).toEqual([['suppressed', 'tone-advisory']]);
    await h.holder.recoverHeld();
    expect(h.botNetwork).not.toHaveBeenCalled();
    expect(await h.author.store.listHeldOperations({})).toEqual([]);
  });

  it('a synchronous advisory against an older holder (no copyEnded) is custody, never "not sent"', async () => {
    const h = await boot();
    h.setOlderHolder(true);
    h.reviews.push(ADVISORY());
    const outcome = await h.author.service.runAsRecordedProducer(h.session, () => forwardReplyToHolder(h.deps, { topicId: 42, chatId: '-100123', text: 'Older holder.' }));
    expect(outcome).toMatchObject({ kind: 'held', lastAttempt: 'outcome-unknown' });
  });

  it('refused in custody (a credential): one definite line naming the outbound check, zero dispatches, never retried', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('Contains a secret.', CREDENTIAL);
    expect((await h.holder.store.getOperation(id))?.operation).toMatchObject({ state: 'suppressed', holdReason: 'policy-refused' });
    expect(await h.authorRecovery()).toEqual(['settled']);
    expect(h.lines).toEqual([expect.stringMatching(/was not delivered \(the outbound check refused it \(`credential-exposure-guard`\)\) and will not be retried\..*Rewrite it before sending again\.$/)]);
    expect(await h.authorRecovery()).toEqual(['skipped']);
    expect(h.botNetwork).not.toHaveBeenCalled();
    expect(await h.author.heldReplyCounters()).toMatchObject({ policyRefusedHandedBack: 1 });
  });

  it('a capacity shed in custody is retained and delivered on the next pass', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('Under load.', CAPACITY);
    expect((await h.holder.store.getOperation(id))?.operation?.state).toBe('admitted');
    expect((await h.holder.store.getOperation(id))?.operation?.policyVerdict).toBeUndefined();
    await h.holder.recoverHeld();
    expect(h.sent()).toEqual([expect.stringContaining('Under load.')]);
  });

  it('a fail-closed review with no rule is retained; one where the floor catches a rule ends it', async () => {
    const h = await boot();
    const retained = await h.forwardInCustody('No verdict.', NO_RULE);
    expect((await h.holder.store.getOperation(retained))?.operation?.state).toBe('admitted');
    const floor = await h.forwardInCustody('Floor catch.', FLOOR);
    expect((await h.holder.store.getOperation(floor))?.operation).toMatchObject({ state: 'suppressed', holdReason: 'policy-refused' });
    await h.authorRecovery();
    expect(h.lines.filter(line => line.includes(floor))).toHaveLength(1);
  });

  it('a submit and a recovery of one operation with divergent results: the first verdict wins, the loser answers custody', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('Raced.', ADVISORY('first'));
    const decision = { ok: false as const, status: 422, reason: 'credential-exposure-guard', body: { blockedBy: 'credential-exposure-guard' } };
    expect(await h.holder.endForPolicy({ operationId: id, originMachineId: 'author', producerKind: 'session' }, decision)).toMatchObject({ ended: false });
    expect((await h.holder.store.getOperation(id))?.operation).toMatchObject({ holdReason: 'tone-advisory', policyVerdict: { class: 'advisory', decisionRef: 'first' } });
  });

  it('the receipt carries the verdict to the author, never on a reader answer', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('Private suggestion.', ADVISORY());
    const plain = await h.sendFrom('author')('holder', { type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId: id });
    expect((plain.result as Record<string, unknown>).policyVerdict).toMatchObject({ class: 'advisory' });
    const reader = await h.sendFrom('author')('holder', { type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId: id, reader: true });
    expect((reader.result as Record<string, unknown>).policyVerdict).toBeUndefined();
  });

  it('a reply written on the holder and refused on recovery: one definite line, zero dispatches', async () => {
    const h = await boot();
    const svc = h.holder.service;
    const seed = svc.runAsAutomation('telegram-server', () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'seed' } }));
    const local = { ...seed.record, producerKind: 'session', producerId: 'session', sessionId: 'session-h', sessionIncarnation: 'i', harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
    const op = svc.runAsRecordedProducer(local, () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Run rm -rf now.' } }));
    await svc.admit(op);
    const lines: string[] = [];
    h.holder.options.isSessionLive = () => true;
    h.holder.options.injectSessionLine = (_b, text) => { lines.push(text); return true; };
    h.holder.options.onSessionDeliveryHeld = async () => undefined;
    h.reviews.push(FLOOR);
    await h.holder.recoverHeld();
    expect((await h.holder.store.getOperation(op.record.operationId))?.operation).toMatchObject({ state: 'suppressed', holdReason: 'policy-refused' });
    // The recovery tick starts the session-exception scan itself (fire and forget); wait for its line.
    await vi.waitFor(() => expect(lines).toEqual([expect.stringContaining('the outbound check refused it (`B1_CLI_COMMAND`)')]), { timeout: 5000 });
    await h.holder.recoverHeld();
    expect(h.botNetwork).not.toHaveBeenCalled();
  });

  it('a reply written on the holder and handed back on recovery: held for its author; the local answer supersedes and sends once', async () => {
    const h = await boot();
    const svc = h.holder.service;
    const seed = svc.runAsAutomation('telegram-server', () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'seed' } }));
    const local = { ...seed.record, producerKind: 'session', producerId: 'session', sessionId: 'session-h', sessionIncarnation: 'i', harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
    const op = svc.runAsRecordedProducer(local, () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Wordy local reply.' } }));
    await svc.admit(op);
    const lines: string[] = [];
    h.holder.options.isSessionLive = () => true;
    h.holder.options.injectSessionLine = (_b, text) => { lines.push(text); return true; };
    h.holder.options.onSessionDeliveryHeld = async () => undefined;
    h.reviews.push(ADVISORY('local-ref'));
    await h.holder.recoverHeld();
    expect((await h.holder.store.getOperation(op.record.operationId))?.operation).toMatchObject({ state: 'held', holdReason: 'tone-advisory' });
    await vi.waitFor(() => expect(lines).toEqual([expect.stringContaining('--tone-decision-ref local-ref')]), { timeout: 5000 });
    await h.holder.recoverHeld();
    expect(h.botNetwork).not.toHaveBeenCalled();
    const match = await h.holder.findAdvisoryAnswer({ sessionId: 'session-h', topicId: 42, ref: 'local-ref' });
    expect(match).toMatchObject({ operationId: op.record.operationId, state: 'held' });
    const transport = (async (req: { body: string }) => fetch('https://api.telegram.org/bot123/sendMessage', { method: 'POST', body: req.body })) as never;
    await svc.runAsRecordedProducer(local, async () => {
      svc.setAdvisoryAnswer({ originalId: match!.operationId, firstPreparedAt: match!.firstPreparedAt, deadlineAt: match!.deadlineAt, kind: 'complied', handedBackAt: match!.verdict.at });
      return svc.sendBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Short local reply.' } }, transport);
    });
    expect(h.sent()).toEqual([expect.stringContaining('Short local reply.')]);
    expect((await h.holder.store.getOperation(op.record.operationId))?.operation?.state).toBe('superseded');
    await h.holder.recoverHeld();
    expect(h.botNetwork).toHaveBeenCalledOnce();
  });

  it('an answer that arrives after the deadline finds the row closed; one before it wins (both orders)', async () => {
    const h = await boot();
    const late = await h.forwardInCustody('Answered too late.', ADVISORY('late'));
    await h.authorRecovery();
    const row = (await h.author.store.getOperation(late))!.operation!;
    expect(await h.author.store.recordOperationState({ operationId: late, state: 'expired', now: row.deadlineAt + 1 })).toBe(true);
    await expect(h.answer(late, 'Revised, too late.')).rejects.toBeInstanceOf(AdvisoryAnswerClosedError);
    const early = await h.forwardInCustody('Answered in time.', ADVISORY('early'));
    await h.authorRecovery();
    await h.answer(early, 'Revised in time.');
    const earlyRow = (await h.author.store.getOperation(early))!.operation!;
    expect(earlyRow.state).toBe('superseded');
    // Expiry after the answer cannot touch the superseded original.
    expect(await h.author.store.recordOperationState({ operationId: early, state: 'expired', now: earlyRow.deadlineAt + 1 })).toBe(false);
    expect(h.sent()).toEqual([expect.stringContaining('Revised in time.')]);
  });

  it('a lease change while held moves nothing: no supersede to the new holder, no local send', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('Held across a lease change.', ADVISORY());
    await h.authorRecovery();
    h.setLeaseHolder('another-machine');
    expect(await h.authorRecovery()).toEqual(['skipped']);
    expect((await h.author.store.getOperation(id))?.operation?.state).toBe('held');
    expect(h.botNetwork).not.toHaveBeenCalled();
  });

  it('a restart between the supersede and the submit: the replacement is asked about at the holder, then sent once', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('Before the crash.', ADVISORY());
    await h.authorRecovery();
    h.crashBeforeNextSubmit();
    await expect(h.answer(id, 'After the crash.')).rejects.toThrow(/process stopped/);
    // The original is retired; the replacement is the one held row, marked outcome-unknown at the holder.
    expect((await h.author.store.getOperation(id))?.operation?.state).toBe('superseded');
    const [replacement] = (await h.author.store.listHeldOperations({ holdReason: HOLD_REASON_LEASE_NOT_HELD })).filter(r => r.state === 'held');
    expect(replacement.holdDetail).toMatchObject({ lastAttempt: 'outcome-unknown', machineId: 'holder', supersedes: id });
    expect(await h.authorRecovery()).toEqual(['retained']); // the holder never saw it: cleared for a re-forward
    expect(await h.authorRecovery()).toEqual(['sent']);
    expect(h.sent()).toEqual([expect.stringContaining('After the crash.')]);
    expect(await h.authorRecovery()).toEqual([]);
  });

  it('a replacement that gets its own advisory: the session reads it at send time, and silence still ends in one deadline line', async () => {
    const h = await boot();
    const id = await h.forwardInCustody('First version.', ADVISORY('one'));
    await h.authorRecovery();
    h.reviews.push(ADVISORY('two'));
    await expect(h.answer(id, 'Second version.')).rejects.toBeInstanceOf(OriginSendPolicyRefusal);
    const [replacement] = await h.author.store.listHeldOperations({ advisory: 'only' });
    expect(replacement.policyVerdict).toMatchObject({ decisionRef: 'two' });
    await h.author.refreshHeldForward({ force: true });
    expect(h.lines).toHaveLength(1); // the first line only; the second verdict was read at send time
    expect(await h.author.store.recordOperationState({ operationId: replacement.operationId, state: 'expired', now: replacement.deadlineAt + 1 })).toBe(true);
    await h.author.refreshHeldForward({ force: true });
    expect(h.lines).toHaveLength(2);
    expect(h.lines[1]).toContain('If you already sent a revised version, do nothing.');
    expect(h.botNetwork).not.toHaveBeenCalled();
  });

  it('a local answer whose supersede fails is not parked for a later replay: nothing is sent, and the retried answer sends once', async () => {
    const h = await boot();
    const svc = h.holder.service;
    const seed = svc.runAsAutomation('telegram-server', () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'seed' } }));
    const local = { ...seed.record, producerKind: 'session', producerId: 'session', sessionId: 'session-h', sessionIncarnation: 'i', harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
    const op = svc.runAsRecordedProducer(local, () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Wordy.' } }));
    await svc.admit(op);
    h.holder.options.onSessionDeliveryHeld = async () => undefined;
    h.reviews.push(ADVISORY('slow-ref'));
    await h.holder.recoverHeld();
    const transport = (async (req: { body: string }) => fetch('https://api.telegram.org/bot123/sendMessage', { method: 'POST', body: req.body })) as never;
    const answerOnce = async () => {
      const match = (await h.holder.findAdvisoryAnswer({ sessionId: 'session-h', topicId: 42, ref: 'slow-ref' }))!;
      return svc.runAsRecordedProducer(local, async () => {
        svc.setAdvisoryAnswer({ originalId: match.operationId, firstPreparedAt: match.firstPreparedAt, deadlineAt: match.deadlineAt, kind: 'complied', handedBackAt: match.verdict.at });
        return svc.sendBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'Short.' } }, transport);
      });
    };
    const supersede = vi.spyOn(h.holder.store, 'supersedeWithAdmission').mockRejectedValueOnce(new Error('origin-store:request-timeout'));
    await expect(answerOnce()).rejects.toMatchObject({ reason: 'advisory-answer-unrecorded' });
    expect(svc.heldStatus()).toEqual([]);
    await h.holder.recoverHeld();
    expect(h.botNetwork).not.toHaveBeenCalled();
    expect((await h.holder.store.getOperation(op.record.operationId))?.operation?.state).toBe('held');
    supersede.mockRestore();
    await answerOnce();
    await h.holder.recoverHeld();
    expect(h.sent()).toEqual([expect.stringContaining('Short.')]);
  });
});
