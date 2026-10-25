import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { admission, compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
const interval = 15 * 60_000;
async function open(stateDir = temporaryState()) {
  const store = await OriginStore.open({ stateDir, agentId: 'echo' }, worker); stores.push(store); return store;
}

describe('durable recovery review pacing', () => {
  it('reserves once across owners and restart, with an exact due boundary and unchanged transport budget', async () => {
    const stateDir = temporaryState(), first = await open(stateDir), second = await open(stateDir);
    const now = Date.now(), op = admission('paced', now);
    await first.admit(op);
    const results = await Promise.all([first, second].map(store => store.reserveRecoveryAttempt({ operationId: op.operationId, now })));
    expect(results.sort()).toEqual([false, true]);
    await first.close(); await second.close();
    const reopened = await open(stateDir);
    await reopened.admit(op); // Repeated admission must not reset the spending clock.
    expect(await reopened.reserveRecoveryAttempt({ operationId: op.operationId, now: now + interval - 1 })).toBe(false);
    expect(await reopened.takeRecoverableAdmissions({ now: now + interval - 1 })).toEqual([]);
    expect((await reopened.takeRecoverableAdmissions({ now: now + interval })).map(row => row.operationId)).toEqual([op.operationId]);
    expect(await reopened.reserveRecoveryAttempt({ operationId: op.operationId, now: now + interval })).toBe(true);
    const audit = await reopened.getOperation(op.operationId);
    expect(audit?.recovery).toEqual({ attempts: 2, nextAttemptAt: now + 2 * interval });
    expect(audit?.operation).toMatchObject({ deadlineAt: op.deadlineAt, maxAttempts: 9, state: 'admitted' });
    expect(audit?.attempts).toEqual([]);
    expect(audit?.children[0]).toMatchObject({ state: 'queued', attempts: 0 });
    expect((await reopened.recoverableAdmissions({ now: now + 2 * interval }))[0]).toEqual(op);
  });

  it('leaves another operation eligible and bounds recovery over the original lifetime', async () => {
    const store = await open(), now = Date.now(), a = admission('a', now), b = admission('b', now);
    await store.admit(a); await store.admit(b);
    for (let n = 0; n < 24; n++) {
      expect(await store.reserveRecoveryAttempt({ operationId: a.operationId, now: now + n * interval })).toBe(true);
      expect(await store.reserveRecoveryAttempt({ operationId: a.operationId, now: now + n * interval + 1 })).toBe(false);
    }
    for (const extra of [0, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000]) {
      expect(await store.reserveRecoveryAttempt({ operationId: a.operationId, now: a.deadlineAt + extra })).toBe(false);
    }
    expect((await store.takeRecoverableAdmissions({ now })).map(row => row.operationId)).toEqual([b.operationId]);
    expect(await store.reserveRecoveryAttempt({ operationId: b.operationId, now })).toBe(true);
  });

  it('cannot reserve missing, suppressed, uncertain or not-yet-due work', async () => {
    const store = await open(), now = Date.now();
    expect(await store.reserveRecoveryAttempt({ operationId: 'missing', now })).toBe(false);
    for (const outcome of ['outcome-unknown', 'known-failed'] as const) {
      const op = admission(outcome, now); await store.admit(op);
      const child = op.children[0];
      const claim = await store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId, ownerBootId: 'owner', leaseMs: 60_000 });
      if (claim.status !== 'claimed') throw new Error('fixture claim unavailable');
      await store.markDispatched(claim.child);
      await store.recordOutcome({ ...claim.child, outcome, ...(outcome === 'known-failed' ? { nextAttemptAt: now + 60_000 } : {}) });
      expect(await store.reserveRecoveryAttempt({ operationId: op.operationId, now })).toBe(false);
      if (outcome === 'known-failed') expect(await store.reserveRecoveryAttempt({ operationId: op.operationId, now: now + 60_000 })).toBe(true);
    }
    const suppressed = admission('suppressed', now); await store.admit(suppressed);
    await store.recordOperationState({ operationId: suppressed.operationId, state: 'suppressed' });
    expect(await store.reserveRecoveryAttempt({ operationId: suppressed.operationId, now })).toBe(false);
  });
});
