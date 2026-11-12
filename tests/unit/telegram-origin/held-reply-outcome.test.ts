/**
 * Held-reply outcome lookup (Echo Bugs topic 10000000967): Telegram accepted a
 * reply, the origin store could not save the receipt, and the caller was told
 * "outcome unknown" while the message id was in hand — so it resent and the
 * user got a duplicate. Covers the capture, the lookup verdicts on both sides
 * of every boundary, and the fold-back into the store, against the REAL store
 * worker.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import { TelegramOriginService } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { TelegramOriginRuntime } from '../../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { OriginUnrecordedReceipts } from '../../../src/messaging/telegram-origin/OriginUnrecordedReceipts.js';
import { classifyOperationOutcome, receiptMessageIds } from '../../../src/messaging/telegram-origin/OriginOperationOutcome.js';
import { TelegramOriginHoldError } from '../../../src/messaging/telegram-origin/types.js';
import { compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';

const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); });

async function harness(response?: () => Response) {
  const stateDir = temporaryState();
  const store = await OriginStore.open({ stateDir, agentId: 'echo' }, worker); stores.push(store);
  const sessions = new OriginSessionRegistry({ stateDir, agentId: 'echo', machineId: 'studio', isSessionLive: () => true });
  await sessions.initialize();
  const ledger = new OriginUnrecordedReceipts(stateDir);
  const authorize = vi.fn(async () => true);
  const service = new TelegramOriginService({ store, sessions, observer: new RuntimeOriginObserver(), unrecordedReceipts: ledger,
    sendPolicy: { review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) },
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey: key, keyEpoch: 1, keyId: 'studio-1' }, ownerBootId: 'boot-1',
    display: () => ({ agent: { enabled: true } }), authorize, onHold: vi.fn(), spoolEvidence: vi.fn(async () => { throw new Error('spool unavailable'); }) });
  const input = { method: 'sendMessage', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, text: 'Original answer' } };
  const network = vi.fn(async () => response ? response() : new Response(JSON.stringify({ ok: true, result: { message_id: 8812, chat: { id: -100123 }, message_thread_id: 42 } }), { status: 200 }));
  const send = () => service.runAsAutomation('telegram-server', () => service.sendBot(input, network));
  return { stateDir, store, ledger, service, network, send, authorize };
}

async function heldError(promise: Promise<unknown>): Promise<TelegramOriginHoldError> {
  try { await promise; } catch (error) { if (error instanceof TelegramOriginHoldError) return error; throw error; }
  throw new Error('expected a hold');
}

describe('accepted-unrecorded capture', () => {
  it('keeps Telegram\'s message id in the fallback record and tells the caller it was delivered', async () => {
    const h = await harness();
    vi.spyOn(h.store, 'recordOutcome').mockRejectedValue(new Error('worker restarting'));
    const error = await heldError(h.send());
    expect(error).toMatchObject({ reason: 'receipt-persistence-unavailable', outcome: 'accepted-unrecorded',
      delivered: { messageId: '8812', fallbackRecorded: true } });
    const captured = h.ledger.forOperation(error.operationId!);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ messageId: '8812', chatId: '-100123', topicId: '42' });
    expect(h.network).toHaveBeenCalledOnce();
  });

  it('a store that answers recorded:false is treated the same as one that throws', async () => {
    const h = await harness();
    vi.spyOn(h.store, 'recordOutcome').mockResolvedValue({ recorded: false, reason: 'stale-fence' });
    const error = await heldError(h.send());
    expect(error.outcome).toBe('accepted-unrecorded');
    expect(h.ledger.pending()).toHaveLength(1);
  });

  it('a genuinely uncertain send (no correlated receipt) stays outcome-unknown and writes no fallback', async () => {
    const h = await harness(() => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    const error = await heldError(h.send());
    expect(error.outcome).toBe('outcome-unknown');
    expect(h.ledger.pending()).toHaveLength(0);
  });
});

describe('Telegram receipt ID validity', () => {
  it('accepts a positive safe integer ID and refuses an unsafe numeric string', () => {
    expect(receiptMessageIds('{"messageId":"1508"}')).toEqual(['1508']);
    expect(receiptMessageIds('{"messageId":"9007199254740993"}')).toEqual([]);
    expect(receiptMessageIds('{"messages":[{"messageId":321},{}]}')).toEqual([]);
  });
});

describe('operation outcome verdicts', () => {
  it('delivered from the fallback record; unknown without it — never not-delivered after a dispatch', async () => {
    const h = await harness();
    vi.spyOn(h.store, 'recordOutcome').mockRejectedValue(new Error('worker restarting'));
    const error = await heldError(h.send());
    const audit = await h.store.getOperation(error.operationId!);
    const withFallback = classifyOperationOutcome(error.operationId!, audit, h.ledger.forOperation(error.operationId!));
    expect(withFallback).toMatchObject({ outcome: 'delivered', safeToResend: false, source: 'unrecorded-receipt', messageIds: ['8812'] });
    const without = classifyOperationOutcome(error.operationId!, audit, []);
    expect(without).toMatchObject({ outcome: 'unknown', safeToResend: false });
  });

  it('delivered from the store on an ordinary send', async () => {
    const h = await harness();
    const response = await h.send();
    const origin = await h.store.getOrigin(response.headers.get('X-Instar-Origin-Id')!);
    const verdict = classifyOperationOutcome(origin!.operation!.operationId, origin, []);
    expect(verdict).toMatchObject({ outcome: 'delivered', source: 'origin-store', messageIds: ['8812'] });
  });

  it('never calls an accepted row delivered without a Telegram message id', async () => {
    const h = await harness();
    const response = await h.send();
    const origin = await h.store.getOrigin(response.headers.get('X-Instar-Origin-Id')!);
    const audit = { ...origin!, attempts: origin!.attempts.map(attempt => ({ ...attempt,
      receiptJson: '{"confirmedVia":"receipt","deliveryMachineId":"holder"}' })) };
    expect(classifyOperationOutcome(audit.operation!.operationId, audit, [])).toMatchObject({
      outcome: 'unknown', safeToResend: false, messageIds: [],
    });
  });

  it('not-delivered (safe to resend) only when Telegram definitely refused it', async () => {
    const h = await harness(() => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 }));
    const error = await heldError(h.send());
    const verdict = classifyOperationOutcome(error.operationId!, await h.store.getOperation(error.operationId!), []);
    expect(verdict).toMatchObject({ outcome: 'not-delivered', safeToResend: true });
  });

  it('pending when the server holds the message before any request went out', async () => {
    const h = await harness();
    h.authorize.mockResolvedValueOnce(false);
    const error = await heldError(h.send());
    expect(h.network).not.toHaveBeenCalled();
    const verdict = classifyOperationOutcome(error.operationId!, await h.store.getOperation(error.operationId!), []);
    expect(verdict).toMatchObject({ outcome: 'pending', safeToResend: false });
  });

  it('unknown for an id this machine never saw', () => {
    expect(classifyOperationOutcome('00000000-0000-0000-0000-000000000000', null, [])).toMatchObject({ outcome: 'unknown', source: 'none' });
  });
});

describe('fold-back into the store (runtime recovery tick)', () => {
  it('reconciles the captured receipt once the abandoned claim is reaped, then marks it done', async () => {
    const h = await harness();
    const record = h.store.recordOutcome.bind(h.store);
    vi.spyOn(h.store, 'recordOutcome').mockRejectedValueOnce(new Error('worker restarting')).mockImplementation(record);
    const error = await heldError(h.send());
    const reconcile = TelegramOriginRuntime.prototype.reconcileUnrecordedReceipts;
    const host = { unrecordedReceipts: h.ledger, store: h.store };
    // Still claimed under a live lease: not yet reconcilable, stays pending.
    expect(await reconcile.call(host as never)).toBe(0);
    expect(h.ledger.pending()).toHaveLength(1);
    await h.store.reapAbandoned(Date.now() + 120_000);
    expect(await reconcile.call(host as never)).toBe(1);
    expect(h.ledger.pending()).toHaveLength(0);
    const audit = await h.store.getOperation(error.operationId!);
    expect(audit?.operation?.state).toBe('accepted');
    expect(classifyOperationOutcome(error.operationId!, audit, [])).toMatchObject({ outcome: 'delivered', source: 'origin-store', messageIds: ['8812'] });
  });
});

describe('fallback record file', () => {
  it('skips a torn final line and survives a fresh reader', () => {
    const dir = temporaryState();
    const ledger = new OriginUnrecordedReceipts(dir);
    ledger.append({ operationId: 'op-1', originId: 'o-1', childId: 'c-1', attemptId: 'a-1', receiptJson: '{}', messageId: '5', chatId: null, topicId: null, at: 1 });
    fs.appendFileSync(ledger.file, '{"kind":"receipt","operationId":');
    const reread = new OriginUnrecordedReceipts(dir);
    expect(reread.pending().map(entry => entry.messageId)).toEqual(['5']);
    reread.markReconciled('op-1', 'c-1');
    expect(new OriginUnrecordedReceipts(dir).pending()).toHaveLength(0);
    expect(fs.statSync(ledger.file).mode & 0o777).toBe(0o600);
  });
});

// ── native-conversation-base §3b: reasons, and the resolution table ──────────
import { resolveOutcome } from '../../../src/messaging/telegram-origin/OriginOperationOutcome.js';
import type { AuthorEvidence, LocalEvidence, OperationOutcomeVerdict, OwnerEvidence } from '../../../src/messaging/telegram-origin/OriginOperationOutcome.js';
import type { OriginAuditRecord } from '../../../src/messaging/telegram-origin/StoreTypes.js';

function row(state: string, extra: { holdReason?: string; holdDetail?: Record<string, unknown> | null; attempts?: OriginAuditRecord['attempts']; childState?: string } = {}): OriginAuditRecord {
  return { sequence: 1, record: { originId: 'origin-1', machineId: 'author', createdAt: 1, envelopeJson: '{}', envelopeDigest: 'd' } as never,
    operation: { operationId: 'op-11111111', preparedAt: 1, deadlineAt: 2, maxAttempts: 3, state,
      ...(extra.holdReason !== undefined || extra.holdDetail !== undefined ? { holdReason: extra.holdReason, holdDetail: extra.holdDetail ?? null } : {}) },
    children: [{ childId: 'c-1', deliveryId: 'd-1', destinationJson: '{}', generation: 0, state: extra.childState ?? 'queued', attempts: 0 }],
    attempts: extra.attempts ?? [] };
}
const attempt = (outcome: string, reason: string | null, phase = 'resolved') => ({ attemptId: `a-${Math.random()}`, childId: 'c-1', materializationId: 'm', ownerBootId: 'b',
  deliveryMachineId: null, phase, outcome, receiptJson: null, createdAt: 1, resolvedAt: 2, reason });

describe('classifier reads suppression reasons (§3b item 2)', () => {
  it('a suppressed row with a null reason is unknown, never safe to resend', () => {
    expect(classifyOperationOutcome('op-11111111', row('suppressed'), [])).toMatchObject({ outcome: 'unknown', safeToResend: false });
    // A stale hold reason left on the row is not a suppression reason.
    expect(classifyOperationOutcome('op-11111111', row('suppressed', { holdReason: 'lease-not-held', holdDetail: {} }), [])).toMatchObject({ outcome: 'unknown', safeToResend: false });
  });
  it('duplicate-content (own or at the holder) is delivered: the user already has this text', () => {
    expect(classifyOperationOutcome('op-11111111', row('suppressed', { holdReason: 'duplicate-content', holdDetail: { duplicateOfMessageId: '77' } }), []))
      .toMatchObject({ outcome: 'delivered', safeToResend: false, reason: 'duplicate-content', duplicateOfMessageId: '77' });
    expect(classifyOperationOutcome('op-11111111', row('suppressed', { holdReason: 'suppressed-at-holder', holdDetail: { holderReason: 'duplicate-content' } }), []))
      .toMatchObject({ outcome: 'delivered', safeToResend: false });
  });
  it('quiet, historical and caller endings are ended on purpose: not-delivered, not safe to resend', () => {
    for (const reason of ['quiet-notification-recorded', 'historical-notice-retired', 'recorded-by-caller']) {
      expect(classifyOperationOutcome('op-11111111', row('suppressed', { holdReason: reason, holdDetail: {} }), [])).toMatchObject({ outcome: 'not-delivered', safeToResend: false, reason });
    }
  });
  it('known-failed names refused or never-left; expired names deadline', () => {
    expect(classifyOperationOutcome('op-11111111', row('known-failed', { attempts: [attempt('known-failed', 'telegram-400')] }), [])).toMatchObject({ outcome: 'not-delivered', safeToResend: true, failure: 'refused' });
    expect(classifyOperationOutcome('op-11111111', row('known-failed', { attempts: [attempt('known-failed', 'telegram-429')] }), [])).toMatchObject({ failure: 'never-left' });
    expect(classifyOperationOutcome('op-11111111', row('known-failed', { attempts: [attempt('known-failed', 'telegram-connect-failed')] }), [])).toMatchObject({ failure: 'never-left' });
    expect(classifyOperationOutcome('op-11111111', row('expired'), [])).toMatchObject({ outcome: 'not-delivered', failure: 'deadline' });
  });
  it('superseded names its successor; a held row with ownerUnstated is unknown', () => {
    expect(classifyOperationOutcome('op-11111111', row('superseded', { holdDetail: { supersededBy: 'op-22222222' } }), [])).toMatchObject({ outcome: 'pending', supersededBy: 'op-22222222' });
    expect(classifyOperationOutcome('op-11111111', row('held', { holdReason: 'lease-not-held', holdDetail: { ownerUnstated: { at: 1, attempts: 1 } } }), [])).toMatchObject({ outcome: 'unknown', safeToResend: false });
  });
});

const V = (outcome: OperationOutcomeVerdict['outcome'], extra: Partial<OperationOutcomeVerdict> = {}): OperationOutcomeVerdict =>
  ({ operationId: 'op-11111111', outcome, safeToResend: outcome === 'not-delivered', source: 'origin-store', messageIds: [], state: null, detail: 'local', ...extra });
const L = (verdict: OperationOutcomeVerdict | null, extra: Partial<LocalEvidence> = {}): LocalEvidence => ({ verdict, isAuthor: false, ownerUnstated: false, terminalNoDispatch: false, ...extra });
const O = (outcome: OperationOutcomeVerdict['outcome'], extra: Partial<Extract<OwnerEvidence, { kind: 'verdict' }>> = {}): OwnerEvidence =>
  ({ kind: 'verdict', machineId: 'owner', outcome, safeToResend: outcome === 'not-delivered', messageIds: [], reason: null, failure: outcome === 'not-delivered' ? 'refused' : null, supersededBy: null, duplicateOfMessageId: null, ...extra });
const A = (holding: boolean, supersededBy: string | null = null): AuthorEvidence => ({ kind: 'answer', holding, supersededBy, machineId: 'author' });
const SILENT: AuthorEvidence = { kind: 'missing' };
const answer = (step: ReturnType<typeof resolveOutcome>) => { if (step.kind !== 'answer') throw new Error(`expected an answer, got follow ${step.successor}`); return step.answer; };

describe('resolveOutcome, one case per table row (§3b item 4)', () => {
  it('row 1: a local or owner delivery stands, with message ids', () => {
    expect(answer(resolveOutcome(L(V('delivered', { messageIds: ['5'] })), { kind: 'missing', why: 'timeout' }, SILENT, 'third'))).toMatchObject({ outcome: 'delivered', row: 1, messageIds: ['5'] });
    expect(answer(resolveOutcome(L(V('pending')), O('partially-delivered', { messageIds: ['6'] }), SILENT, 'third'))).toMatchObject({ outcome: 'partially-delivered', source: 'execution-owner', answeredBy: 'owner', row: 1 });
  });
  it('row 1, author half: an author that delivered it itself outranks the owner\'s own failure', () => {
    expect(answer(resolveOutcome(L(null), O('not-delivered'), { kind: 'answer', holding: false, supersededBy: null, machineId: 'author', delivered: { messageIds: ['9'] } }, 'third')))
      .toMatchObject({ outcome: 'delivered', safeToResend: false, messageIds: ['9'], answeredBy: 'author', row: 1 });
  });
  it('row 2: a duplicate-content ending is delivered', () => {
    expect(answer(resolveOutcome(L(V('pending')), O('not-delivered', { reason: 'duplicate-content', safeToResend: false }), A(false), 'third')))
      .toMatchObject({ outcome: 'delivered', safeToResend: false, row: 2, detail: 'The user already has this text.' });
  });
  it('row 3: superseded locally, at the owner or at the author follows the successor', () => {
    expect(resolveOutcome(L(V('pending', { supersededBy: 'op-2' })), O('pending'), A(true), 'third')).toEqual({ kind: 'follow', successor: 'op-2', via: 'local' });
    expect(resolveOutcome(L(null), O('pending', { supersededBy: 'op-3' }), SILENT, 'third')).toEqual({ kind: 'follow', successor: 'op-3', via: 'owner' });
    expect(resolveOutcome(L(V('pending')), O('not-delivered'), A(false, 'op-4'), 'third')).toEqual({ kind: 'follow', successor: 'op-4', via: 'author' });
  });
  it('row 4: the owner still has it', () => {
    expect(answer(resolveOutcome(L(V('pending')), O('pending'), SILENT, 'third'))).toMatchObject({ outcome: 'pending', row: 4 });
  });
  it('row 5: owner unresolved, a local unresolved dispatch, or a local ownerUnstated row', () => {
    expect(answer(resolveOutcome(L(V('pending')), O('unknown'), A(false), 'third'))).toMatchObject({ outcome: 'unknown', why: 'owner-unresolved', row: 5, safeToResend: false });
    expect(answer(resolveOutcome(L(V('unknown', { unresolvedDispatch: true })), O('not-delivered'), A(false), 'third'))).toMatchObject({ why: 'owner-unresolved', row: 5, safeToResend: false });
    expect(answer(resolveOutcome(L(V('unknown'), { ownerUnstated: true }), O('not-delivered'), A(false), 'third'))).toMatchObject({ why: 'owner-unresolved', row: 5, safeToResend: false });
  });
  it('row 6: owner not-delivered and the author no longer holds it', () => {
    expect(answer(resolveOutcome(L(V('pending')), O('not-delivered'), A(false), 'third'))).toMatchObject({ outcome: 'not-delivered', safeToResend: true, source: 'execution-owner', failure: 'refused', row: 6 });
    expect(answer(resolveOutcome(L(V('pending')), O('not-delivered', { safeToResend: false, reason: 'quiet-notification-recorded', failure: null }), A(false), 'third'))).toMatchObject({ outcome: 'not-delivered', safeToResend: false, row: 6 });
  });
  it('row 7: owner not-delivered while the author still holds it is pending', () => {
    expect(answer(resolveOutcome(L(V('pending')), O('not-delivered'), A(true), 'third'))).toMatchObject({ outcome: 'pending', safeToResend: false, row: 7 });
  });
  it('row 8: owner not-delivered and the author silent is unknown, never safe to resend', () => {
    expect(answer(resolveOutcome(L(V('pending')), O('not-delivered'), SILENT, 'third'))).toMatchObject({ outcome: 'unknown', why: 'author-unanswered', safeToResend: false, row: 8 });
  });
  it('row 9 each way, on the author\'s machine', () => {
    const refusedExpired = V('not-delivered', { failure: 'deadline' });
    expect(answer(resolveOutcome(L(refusedExpired, { isAuthor: true, terminalNoDispatch: true }), { kind: 'no-record', machineId: 'owner' }, A(false), 'author')))
      .toMatchObject({ outcome: 'not-delivered', safeToResend: true, source: 'author+execution-owner', failure: 'deadline', row: 9 });
    // A local-sent attempt (terminalNoDispatch false): unknown.
    expect(answer(resolveOutcome(L(refusedExpired, { isAuthor: true, terminalNoDispatch: false }), { kind: 'no-record', machineId: 'owner' }, A(false), 'author')))
      .toMatchObject({ outcome: 'unknown', safeToResend: false, why: 'owner-no-record', row: 10 });
    // The owner silent: unknown (row 11).
    expect(answer(resolveOutcome(L(refusedExpired, { isAuthor: true, terminalNoDispatch: true }), { kind: 'missing', why: 'timeout' }, A(false), 'author')))
      .toMatchObject({ outcome: 'unknown', safeToResend: false, why: 'timeout', row: 11 });
    // On a third machine: owner no-record and an author that delivered it itself (holding false) never says resend.
    expect(answer(resolveOutcome(L(null), { kind: 'no-record', machineId: 'owner' }, A(false), 'third')))
      .toMatchObject({ outcome: 'unknown', safeToResend: false, why: 'owner-no-record', row: 10 });
  });
  it('row 10: owner no-record while the author holds it is pending', () => {
    expect(answer(resolveOutcome(L(V('pending')), { kind: 'not-admitted', machineId: 'owner' }, A(true), 'third'))).toMatchObject({ outcome: 'pending', row: 10 });
  });
  it('row 11: a stale local not-delivered with the owner unavailable, old, or the read off is unknown', () => {
    for (const why of ['timeout', 'refused', 'old-version', 'owner-read-off'] as const) {
      expect(answer(resolveOutcome(L(V('not-delivered')), { kind: 'missing', why }, A(false), 'third')))
        .toMatchObject({ outcome: 'unknown', safeToResend: false, ownerAnswered: false, why, row: 11 });
    }
    expect(answer(resolveOutcome(L(V('pending')), { kind: 'missing', why: 'timeout' }, SILENT, 'third'))).toMatchObject({ outcome: 'pending', why: 'timeout', row: 11 });
  });
  it('an author row held with ownerVerdict reads not holding: owner not-delivered answers at once', () => {
    expect(answer(resolveOutcome(L(V('pending')), O('not-delivered'), A(false), 'author'))).toMatchObject({ outcome: 'not-delivered', row: 6 });
  });
});
