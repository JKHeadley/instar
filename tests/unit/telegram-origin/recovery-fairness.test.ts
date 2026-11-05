import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { admission, compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

describe('durable fair origin recovery selection', () => {
  it('surfaces a session reply with unknown delivery after a restart', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo' }, worker); stores.push(store);
    const row = admission('lost-reply');
    row.record.envelopeJson = JSON.stringify({ ...JSON.parse(row.record.envelopeJson), producerKind: 'session', operationKind: 'sendMessage',
      destination: { transport: 'bot-api', accountId: 'bot-1', chatId: '-100123', topicId: '12' } });
    row.record.envelopeDigest = createHash('sha256').update(row.record.envelopeJson).digest('hex');
    await store.admit(row);
    const child = row.children[0];
    const claim = await store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId,
      ownerBootId: 'before-restart', leaseMs: 60_000 });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('claim unavailable');
    await store.markDispatched(claim.child);
    await store.recordOutcome({ ...claim.child, outcome: 'outcome-unknown', reason: 'transport-acceptance-unknown' });
    const delayed = admission('delayed-reply', Date.now() - 90_000);
    delayed.record.envelopeJson = JSON.stringify({ ...JSON.parse(delayed.record.envelopeJson), producerKind: 'session', operationKind: 'sendMessage',
      destination: { transport: 'bot-api', accountId: 'bot-1', chatId: '-100123', topicId: '12' } });
    delayed.record.envelopeDigest = createHash('sha256').update(delayed.record.envelopeJson).digest('hex');
    await store.admit(delayed);
    const edit = admission('edited-message', Date.now() - 90_000);
    edit.record.envelopeJson = JSON.stringify({ ...JSON.parse(edit.record.envelopeJson), producerKind: 'session',
      operationKind: 'editMessageText', destination: { transport: 'bot-api', accountId: 'bot-1', chatId: '-100123', topicId: '12' } });
    edit.record.envelopeDigest = createHash('sha256').update(edit.record.envelopeJson).digest('hex');
    await store.admit(edit);
    const exceptions = await store.listSessionDeliveryExceptions();
    expect(exceptions.some(item => item.operationId === edit.operationId)).toBe(false);
    expect(exceptions).toContainEqual(expect.objectContaining({ operationId: row.operationId,
      state: 'outcome-unknown', uncertain: true, threadId: 12 }));
    expect(exceptions).toContainEqual(expect.objectContaining({ operationId: delayed.operationId,
      state: 'admitted', uncertain: false, threadId: 12 }));
  });

  it('pages past older exceptions and revisits accepted replies to close stale alerts', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo' }, worker); stores.push(store);
    const admitted = [];
    const preparedBase = Date.now() - 90_000;
    for (let i = 0; i < 5; i++) {
      const row = admission(`notice-page-${i}`, preparedBase + i);
      row.record.envelopeJson = JSON.stringify({ ...JSON.parse(row.record.envelopeJson), producerKind: 'session', operationKind: 'sendMessage',
        destination: { transport: 'bot-api', accountId: 'bot-1', chatId: '-100123', topicId: '12' } });
      row.record.envelopeDigest = createHash('sha256').update(row.record.envelopeJson).digest('hex');
      await store.admit(row);
      admitted.push(row);
    }
    const accept = async (row: (typeof admitted)[number], messageId: number) => {
      const child = row.children[0];
      const claim = await store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId,
        ownerBootId: 'replay', leaseMs: 60_000 });
      expect(claim.status).toBe('claimed');
      if (claim.status !== 'claimed') throw new Error('claim unavailable');
      await store.markDispatched(claim.child);
      await store.recordOutcome({ ...claim.child, outcome: 'accepted', receiptJson: JSON.stringify({ messageId }) });
    };
    // A newer reply lands first, then the older one is accepted later.
    await accept(admitted[2], 123);
    await new Promise(resolve => setTimeout(resolve, 5));
    await accept(admitted[1], 124);
    // Receipt ids prove the opposite order for this pair despite reversed recording order.
    await accept(admitted[4], 126);
    await accept(admitted[3], 125);
    const accepted = admitted[1];
    const first = await store.listSessionDeliveryExceptions({ limit: 1 });
    expect(first).toHaveLength(1);
    const next = await store.listSessionDeliveryExceptions({ afterPreparedAt: first[0].preparedAt,
      afterOperationId: first[0].operationId, limit: 4 });
    expect(next.map(row => row.operationId)).toEqual(admitted.slice(1).map(row => row.operationId));
    expect(next[0]).toMatchObject({ state: 'accepted', acceptedAt: expect.any(Number), outOfOrder: true });
    expect(next[1]).toMatchObject({ state: 'accepted', outOfOrder: false });
    expect(next[2]).toMatchObject({ state: 'accepted', outOfOrder: false });
  });

  it('advances beyond an unchanged blocked head and preserves progress across worker restart', async () => {
    const options = { stateDir: temporaryState(), agentId: 'echo' };
    let store = await OriginStore.open(options, worker); stores.push(store);
    for (let i = 0; i < 12; i++) await store.admit(admission(`fair-${i}`));
    const first = await store.takeRecoverableAdmissions();
    expect(first.map(row => row.operationId)).toEqual(Array.from({ length: 10 }, (_, i) => `operation-fair-${i}`));
    // A read-only inspection must not move the recovery scheduler's cursor.
    expect((await store.recoverableAdmissions())[0].operationId).toBe('operation-fair-0');
    await store.close();
    store = await OriginStore.open(options, worker); stores.push(store);
    const resumed = await store.takeRecoverableAdmissions();
    expect(resumed).toHaveLength(10);
    expect(resumed.slice(0, 2).map(row => row.operationId)).toEqual(['operation-fair-10', 'operation-fair-11']);
    expect(new Set(resumed.map(row => row.operationId)).size).toBe(10);
    const audit = await store.getOperation('operation-fair-0');
    expect(audit?.attempts).toEqual([]);
    expect(audit?.children[0]).toMatchObject({ state: 'queued', attempts: 0 });
  });

  it('never adds an uncertain child to the fair traversal', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo' }, worker); stores.push(store);
    const uncertain = admission('uncertain'), queued = admission('queued');
    await store.admit(uncertain); await store.admit(queued);
    const child = uncertain.children[0];
    const claim = await store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId, ownerBootId: 'test-owner', leaseMs: 60_000 });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('claim unavailable');
    await store.markDispatched(claim.child);
    await store.recordOutcome({ ...claim.child, outcome: 'outcome-unknown' });
    for (let i = 0; i < 3; i++) expect((await store.takeRecoverableAdmissions()).map(row => row.operationId)).toEqual([queued.operationId]);
  });
});
