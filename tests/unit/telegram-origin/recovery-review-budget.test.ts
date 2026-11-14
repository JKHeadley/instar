import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { admission, compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
const interval = 15 * 60_000;
const ladder = [30_000, 60_000, 2 * 60_000, 5 * 60_000];
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
    const due = now + ladder[0];
    expect(await reopened.reserveRecoveryAttempt({ operationId: op.operationId, now: due - 1 })).toBe(false);
    expect(await reopened.takeRecoverableAdmissions({ now: due - 1 })).toEqual([]);
    expect((await reopened.takeRecoverableAdmissions({ now: due })).map(row => row.operationId)).toEqual([op.operationId]);
    expect(await reopened.reserveRecoveryAttempt({ operationId: op.operationId, now: due })).toBe(true);
    const audit = await reopened.getOperation(op.operationId);
    expect(audit?.recovery).toEqual({ attempts: 2, nextAttemptAt: due + ladder[1] });
    expect(audit?.operation).toMatchObject({ deadlineAt: op.deadlineAt, maxAttempts: 9, state: 'admitted' });
    expect(audit?.attempts).toEqual([]);
    expect(audit?.children[0]).toMatchObject({ state: 'queued', attempts: 0 });
    expect((await reopened.recoverableAdmissions({ now: due + ladder[1] }))[0]).toEqual(op);
  });

  it('answers "not reserved" (false), never a lock error, while another writer holds the store', async () => {
    // Two owners share one store file; the loser of a reservation race must read
    // "not reserved", the same answer an already-reserved operation gives. Under CI
    // load the 25 ms busy timeout expired first and the reservation threw
    // "database is locked" instead (recovery-review-budget flake, PR #2408).
    const stateDir = temporaryState(), store = await open(stateDir);
    const now = Date.now(), op = admission('locked', now);
    await store.admit(op);
    const blocker = new Database((await store.diagnostics()).path);
    blocker.pragma('busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      expect(await store.reserveRecoveryAttempt({ operationId: op.operationId, now })).toBe(false);
    } finally {
      blocker.exec('ROLLBACK'); blocker.close();
    }
    // Nothing was spent while locked out: the reservation is still available.
    expect(await store.reserveRecoveryAttempt({ operationId: op.operationId, now })).toBe(true);
  });

  it('leaves another operation eligible and bounds recovery over the original lifetime', async () => {
    const store = await open(), now = Date.now(), a = admission('a', now), b = admission('b', now);
    await store.admit(a); await store.admit(b);
    // Quick at first, then the long-standing 15-minute pace. Six hours holds at most 28 starts.
    let at = now, starts = 0;
    while (at < a.deadlineAt) {
      expect(await store.reserveRecoveryAttempt({ operationId: a.operationId, now: at })).toBe(true);
      expect(await store.reserveRecoveryAttempt({ operationId: a.operationId, now: at + 1 })).toBe(false);
      at += ladder[starts] ?? interval; starts++;
    }
    expect(starts).toBe(28);
    for (const extra of [0, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000]) {
      expect(await store.reserveRecoveryAttempt({ operationId: a.operationId, now: a.deadlineAt + extra })).toBe(false);
    }
    expect((await store.takeRecoverableAdmissions({ now })).map(row => row.operationId)).toEqual([b.operationId]);
    expect(await store.reserveRecoveryAttempt({ operationId: b.operationId, now })).toBe(true);
  });

  it('walks the ladder and stays at the 15-minute pace after it', async () => {
    const store = await open(), now = Date.now(), op = admission('walk', now);
    await store.admit(op);
    let at = now;
    for (const step of [...ladder, interval, interval]) {
      expect(await store.reserveRecoveryAttempt({ operationId: op.operationId, now: at })).toBe(true);
      expect((await store.getOperation(op.operationId))?.recovery?.nextAttemptAt).toBe(at + step);
      at += step;
    }
    // The ladder paces recovery starts and never spends the transport budget.
    expect((await store.getOperation(op.operationId))?.children[0]).toMatchObject({ state: 'queued', attempts: 0 });
  });

  it('never makes an uncertain send eligible, however far the ladder has advanced', async () => {
    const store = await open(), now = Date.now(), op = admission('uncertain-after-ladder', now);
    await store.admit(op);
    expect(await store.reserveRecoveryAttempt({ operationId: op.operationId, now })).toBe(true);
    const child = op.children[0];
    const claim = await store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId, ownerBootId: 'owner', leaseMs: 60_000 });
    if (claim.status !== 'claimed') throw new Error('fixture claim unavailable');
    await store.markDispatched(claim.child);
    await store.recordOutcome({ ...claim.child, outcome: 'outcome-unknown' });
    for (const later of [ladder[0], 60_000, 15 * 60_000, 60 * 60_000]) {
      expect(await store.reserveRecoveryAttempt({ operationId: op.operationId, now: now + later })).toBe(false);
      expect(await store.takeRecoverableAdmissions({ now: now + later })).toEqual([]);
    }
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
    await store.recordOperationState({ operationId: suppressed.operationId, state: 'suppressed', holdReason: 'recorded-by-caller' });
    expect(await store.reserveRecoveryAttempt({ operationId: suppressed.operationId, now })).toBe(false);
  });
});
