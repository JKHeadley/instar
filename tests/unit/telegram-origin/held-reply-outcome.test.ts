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
import { classifyOperationOutcome } from '../../../src/messaging/telegram-origin/OriginOperationOutcome.js';
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
