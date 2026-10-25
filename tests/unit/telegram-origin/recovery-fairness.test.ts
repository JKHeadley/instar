import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { admission, compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

describe('durable fair origin recovery selection', () => {
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
