/**
 * native-conversation-base §3a — store and service behaviour behind "a reply is
 * ended only for a cause", on the real origin-store worker.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import { TelegramOriginService } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { validOriginAdmission } from '../../../src/messaging/telegram-origin/OriginAdmissionSeal.js';
import { originContentDedup } from '../../../src/messaging/telegram-origin/OriginContentDedup.js';
import { OutboundContentDedup } from '../../../src/messaging/OutboundContentDedup.js';
import { SqliteOutboundDedupStore } from '../../../src/messaging/OutboundDedupStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { admission, compileOriginWorker, hash, temporaryState } from '../../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';
import type { OriginAdmission } from '../../../src/messaging/telegram-origin/StoreTypes.js';
import type { TelegramOriginRecord } from '../../../src/messaging/telegram-origin/types.js';

const MIN = 60_000;
let worker: URL;
const stores: OriginStore[] = [], stateDirs: string[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); }, 30_000);
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const state of stateDirs.splice(0)) SafeFsExecutor.safeRmSync(state, { recursive: true, force: true, operation: 'tests/unit/telegram-origin/held-reply-store.test.ts:cleanup' });
});
async function open() {
  const stateDir = temporaryState(); stateDirs.push(stateDir);
  const store = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker); stores.push(store);
  return { store, stateDir };
}
const forwardDetail = (nextAt: number | null, extra: Record<string, unknown> = {}) => ({ kind: 'forward-to-holder', lastAttempt: 'refused', machineId: 'holder',
  topicId: 12, chatId: '-100123', text: 'The authored answer.', reason: 'x', at: 1, noticeDelivered: false, ladder: { attempts: 0, nextAt }, ...extra });
/** The fixture admission with a real destination in its envelope (the destination index is read from it). */
function withDestination(input: OriginAdmission): OriginAdmission {
  const envelope = { ...JSON.parse(input.record.envelopeJson), destination: { transport: 'bot-api', accountId: 'bot-1', chatId: '-100123', topicId: '12', messageId: null } };
  const envelopeJson = JSON.stringify(envelope);
  return { ...input, record: { ...input.record, envelopeJson, envelopeDigest: hash(envelopeJson) } };
}
async function heldForward(store: OriginStore, input: OriginAdmission, nextAt: number | null, extra: Record<string, unknown> = {}) {
  await store.admit(input);
  expect(await store.recordOperationState({ operationId: input.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: forwardDetail(nextAt, extra) })).toBe(true);
  return input;
}

describe('a reason on every suppression (§3a item 9)', () => {
  it('refuses a suppression with no reason or a reason outside the closed set', async () => {
    const { store } = await open();
    const a = admission('no-reason'); await store.admit(a);
    await expect(store.recordOperationState({ operationId: a.operationId, state: 'suppressed' })).rejects.toThrow(/suppression-reason-required/);
    await expect(store.recordOperationState({ operationId: a.operationId, state: 'suppressed', holdReason: 'overtaken' })).rejects.toThrow(/suppression-reason-required/);
    expect((await store.getOperation(a.operationId))?.operation?.state).toBe('admitted');
  });
  it('records each closed reason, keeps ids whole and cuts long free text with a visible marker, never refusing', async () => {
    const { store } = await open();
    for (const reason of ['duplicate-content', 'historical-notice-retired', 'recorded-by-caller', 'suppressed-at-holder'] as const) {
      const a = admission(reason); await store.admit(a);
      expect(await store.recordOperationState({ operationId: a.operationId, state: 'suppressed', holdReason: reason })).toBe(true);
      const op = (await store.getOperation(a.operationId))?.operation;
      expect(op).toMatchObject({ state: 'suppressed', holdReason: reason });
    }
    const q = admission('quiet'); await store.admit(q);
    expect(await store.recordOperationState({ operationId: q.operationId, state: 'suppressed', holdReason: 'quiet-notification-recorded', holdDetail: { quietId: 'q'.repeat(256) } })).toBe(true);
    const long = admission('long'); await store.admit(long);
    expect(await store.recordOperationState({ operationId: long.operationId, state: 'suppressed', holdReason: 'suppressed-at-holder',
      holdDetail: { holderReason: 'duplicate-content', id: 'i'.repeat(256), note: 'n'.repeat(400), text: 't'.repeat(1000) } })).toBe(true);
    const detail = (await store.getOperation(long.operationId))?.operation?.holdDetail as Record<string, string>;
    expect(detail.id).toHaveLength(256);
    expect(detail.note).toBe(`${'n'.repeat(200)}…[cut]`);
    expect(detail.text).toHaveLength(1000);
  });
});

describe('ownerVerdict merge (§3a item 7)', () => {
  it('keeps the text, nulls ladder.nextAt, and leaves the due query and the held count', async () => {
    const { store } = await open();
    const now = Date.now();
    const a = await heldForward(store, withDestination(admission('verdict', now)), now - 1);
    expect((await store.heldForwardAdmissions({ now })).map(r => r.row.operationId)).toEqual([a.operationId]);
    expect(await store.unresolvedHeldOperationCount('12')).toBe(1);
    expect(await store.mergeHoldDetail({ operationId: a.operationId, patch: { ownerVerdict: { outcome: 'not-delivered', failure: 'never-left', at: now, machineId: 'holder' } } })).toBe(true);
    const detail = (await store.getOperation(a.operationId))?.operation?.holdDetail as Record<string, unknown>;
    expect(detail).toMatchObject({ text: 'The authored answer.', ladder: { attempts: 0, nextAt: null }, ownerVerdict: { failure: 'never-left' } });
    expect(await store.heldForwardAdmissions({ now })).toHaveLength(0);
    expect(await store.unresolvedHeldOperationCount('12')).toBe(0);
  });
  it('a settled ownerUnstated also leaves the due query; the merge refuses a row that is not a held forward', async () => {
    const { store } = await open();
    const now = Date.now();
    const a = await heldForward(store, admission('unstated', now), now - 1);
    expect(await store.mergeHoldDetail({ operationId: a.operationId, patch: { ownerUnstated: { at: now, attempts: 2, settled: true, machineId: 'holder' } } })).toBe(true);
    expect(await store.heldForwardAdmissions({ now })).toHaveLength(0);
    const plain = admission('plain'); await store.admit(plain);
    expect(await store.mergeHoldDetail({ operationId: plain.operationId, patch: { ownerVerdict: { failure: 'refused' } } })).toBe(false);
  });
  it('more than 500 expired unreported rows ahead of a due forward do not delay it', async () => {
    const { store } = await open();
    const now = Date.now();
    for (let i = 0; i < 505; i++) {
      const old = admission(`expired-${i}`, now - 7 * 60 * MIN);
      old.deadlineAt = old.preparedAt + 60 * MIN;
      await heldForward(store, old, null);
      expect(await store.recordOperationState({ operationId: old.operationId, state: 'expired', now })).toBe(true);
    }
    const due = await heldForward(store, admission('due', now), now - 1);
    expect((await store.listHeldOperations({ holdReason: 'lease-not-held', limit: 500 })).some(r => r.operationId === due.operationId)).toBe(false);
    expect((await store.heldForwardAdmissions({ now })).map(r => r.row.operationId)).toEqual([due.operationId]);
  }, 120_000);
});

describe('replacementState and the late-mark carrier (§3a item 2)', () => {
  it('`admitted` replaces an admitted reply in one transaction, sets the carrier, and keeps it across a re-admit', async () => {
    const { store } = await open();
    const now = Date.now();
    const original = admission('orig', now - 20 * MIN); await store.admit(original);
    const replacement = admission('repl', now);
    replacement.deadlineAt = original.deadlineAt;
    expect(await store.supersedeWithAdmission({ operationId: original.operationId, admission: replacement, holdDetail: null,
      replacementState: 'admitted', firstPreparedAt: original.preparedAt, lateMarkedAt: now })).toBe(true);
    expect((await store.getOperation(original.operationId))?.operation).toMatchObject({ state: 'superseded', holdDetail: { supersededBy: replacement.operationId } });
    const op = (await store.getOperation(replacement.operationId))?.operation;
    expect(op).toMatchObject({ state: 'admitted', firstPreparedAt: original.preparedAt, lateMarkedAt: now, deadlineAt: original.deadlineAt });
    // A later hold and re-admit clear the hold detail, never the carrier: a marked reply is not marked twice.
    expect(await store.recordOperationState({ operationId: replacement.operationId, state: 'held', holdReason: 'lease-not-held' })).toBe(true);
    expect(await store.recordOperationState({ operationId: replacement.operationId, state: 'admitted' })).toBe(true);
    expect((await store.getOperation(replacement.operationId))?.operation).toMatchObject({ state: 'admitted', firstPreparedAt: original.preparedAt, lateMarkedAt: now });
  });
  it('a successor without its own carrier copies it from the row it replaces', async () => {
    const { store } = await open();
    const now = Date.now();
    const first = admission('first', now - 30 * MIN); await store.admit(first);
    const second = admission('second', now - 10 * MIN);
    expect(await store.supersedeWithAdmission({ operationId: first.operationId, admission: second, holdReason: 'lease-not-held', holdDetail: forwardDetail(null),
      firstPreparedAt: first.preparedAt, lateMarkedAt: now - 10 * MIN })).toBe(true);
    const third = admission('third', now);
    expect(await store.supersedeWithAdmission({ operationId: second.operationId, admission: third, holdReason: 'lease-not-held', holdDetail: forwardDetail(null) })).toBe(true);
    expect((await store.getOperation(third.operationId))?.operation).toMatchObject({ state: 'held', firstPreparedAt: first.preparedAt, lateMarkedAt: now - 10 * MIN });
    const rows = await store.listHeldOperations({ holdReason: 'lease-not-held' });
    expect(rows.find(r => r.operationId === third.operationId)).toMatchObject({ firstPreparedAt: first.preparedAt, lateMarkedAt: now - 10 * MIN });
  });
  it('the two columns are added idempotently: a second open of the same database keeps working', async () => {
    const { store, stateDir } = await open();
    const again = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker); stores.push(again);
    const a = admission('twice'); await store.admit(a);
    expect((await again.getOperation(a.operationId))?.operation).toMatchObject({ firstPreparedAt: null, lateMarkedAt: null });
  });
});

describe('replacements prepared in a recovery pass (§3a item 2)', () => {
  async function service() {
    const { store, stateDir } = await open();
    const sessions = new OriginSessionRegistry({ stateDir, agentId: 'echo', machineId: 'studio', isSessionLive: () => true });
    await sessions.initialize();
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const svc = new TelegramOriginService({ store, sessions, observer: new RuntimeOriginObserver(),
      sendPolicy: { review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) },
      identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
      signingKey: { privateKey: key, keyEpoch: 1, keyId: 'studio-1' }, ownerBootId: 'boot-1',
      display: () => ({ agent: { enabled: false } }), authorize: async () => true, onHold: () => undefined,
      spoolEvidence: async () => { throw new Error('spool unavailable'); }, reviewLegacyRecovery: async () => true });
    // The stored record of a session reply this machine wrote (the session itself has since ended).
    const automation = svc.runAsAutomation('telegram-server', () => svc.prepareBot({ method: 'sendMessage', accountId: 'bot-1',
      params: { chat_id: '-100123', message_thread_id: 12, text: 'seed' } }));
    const sessionRecord = { ...automation.record, producerKind: 'session', producerId: 'session', sessionId: 'session-1', sessionIncarnation: 'incarnation-1',
      harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
    const original = svc.runAsRecordedProducer(sessionRecord, () => svc.prepareBot({ method: 'sendMessage', accountId: 'bot-1',
      params: { chat_id: '-100123', message_thread_id: 12, text: 'The authored answer.' } }));
    expect(original.record).toMatchObject({ producerKind: 'session', sessionId: 'session-1' });
    return { svc, original };
  }
  it('is sealed as the original session reply, passes validOriginAdmission, and carries firstPreparedAt in its envelope', async () => {
    const { svc, original } = await service();
    const first = original.admission.preparedAt;
    const policy = JSON.parse(original.admission.children[0].materializations[0].requestJson).policy;
    // No producer context, as in a recovery pass: re-entered from the stored record.
    expect(() => svc.currentProducer()).toThrow();
    const replacement = svc.runAsRecordedProducer(original.record, () => svc.prepareBot({ method: 'sendMessage', accountId: 'bot-1',
      params: { chat_id: '-100123', message_thread_id: 12, text: 'Late reply, written more than 6 minutes ago and held up in delivery. It answers an earlier message:\n\nThe authored answer.' },
      policyInput: policy, replacement: { firstPreparedAt: first, deadlineAt: original.admission.deadlineAt } }));
    expect(replacement.record).toMatchObject({ producerKind: 'session', sessionId: 'session-1', originMachineId: 'studio', firstPreparedAt: first });
    expect(validOriginAdmission(replacement)).toBe(true);
    expect(replacement.record.createdAt).toBe(replacement.admission.preparedAt);
    expect(replacement.admission.deadlineAt).toBe(original.admission.deadlineAt);
    expect(JSON.parse(replacement.admission.record.envelopeJson).firstPreparedAt).toBe(first);
    expect(JSON.parse(replacement.admission.children[0].materializations[0].requestJson).policy).toEqual(policy);
  });
  it('refuses to re-enter anything but this machine\'s own session reply', async () => {
    const { svc, original } = await service();
    expect(() => svc.runAsRecordedProducer({ ...original.record, producerKind: 'server-automation' } as TelegramOriginRecord, () => 1)).toThrow(/recorded-producer-unavailable/);
    expect(() => svc.runAsRecordedProducer({ ...original.record, originMachineId: 'other' } as TelegramOriginRecord, () => 1)).toThrow(/recorded-producer-unavailable/);
  });
});

describe('the content check reads firstPreparedAt (§3a item 2)', () => {
  it('a replacement whose text was accepted 20 minutes earlier is a duplicate; without the field the 15-minute look-back misses it', async () => {
    const stateDir = temporaryState(); stateDirs.push(stateDir);
    let now = Date.now();
    const dedup = originContentDedup(new OutboundContentDedup({}, () => now, new SqliteOutboundDedupStore(SqliteOutboundDedupStore.defaultPath(stateDir))), '-100123');
    const text = 'The authored answer, long enough for the content check to apply to it.';
    const record = (operationId: string, createdAt: number, firstPreparedAt?: number) => ({ operationId, originId: `o-${operationId}`, createdAt,
      ...(firstPreparedAt === undefined ? {} : { firstPreparedAt }), destination: { transport: 'bot-api', accountId: 'bot-1', chatId: '-100123', topicId: '12', messageId: null } }) as unknown as TelegramOriginRecord;
    const drafted = now;
    expect((await dedup.reserveContent!(record('original', drafted), { text }, now + 60 * MIN, 'claim-1')).ok).toBe(true);
    await dedup.completeContent!(record('original', drafted), { text });
    now += 20 * MIN;
    const marked = await dedup.reserveContent!(record('replacement', now, drafted - MIN), { text }, now + 60 * MIN, 'claim-2');
    expect(marked).toMatchObject({ ok: false, reason: 'duplicate-content' });
    const unmarked = await dedup.reserveContent!(record('older-owner', now), { text }, now + 60 * MIN, 'claim-3');
    expect(unmarked.ok).toBe(true);
  });
});
