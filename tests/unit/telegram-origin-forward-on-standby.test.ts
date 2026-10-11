/**
 * a2a-single-agent-identity §4 (ACT-058) — AC6, Tier 1.
 *
 * A reply from a machine that does not hold the serving lease is forwarded to
 * the holder; a failed forward is held durably with `lease-not-held`, a notice
 * through the holder and one item; retries never double-post;
 * `destination-not-authorized` is never forwarded.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  classifyLeaseRoute, settleLeaseRoute, forwardReplyToHolder, recoverForwardedHold, submitOriginToHolder, nextLadderState, FORWARD_SETTLE_TIMEOUT_MS, expiredForwardWording,
  HeldForwardItemCollapser, expiredForwardWording, heldForwardNoticeText, HOLD_REASON_LEASE_NOT_HELD, UNRESOLVED_LEASE_HOLDER,
} from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardDeps, ForwardLeaseView, HolderSubmitResult, HeldForwardDetail } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { OriginPreparedBotOperation } from '../../src/messaging/telegram-origin/TelegramOriginService.js';
import type { HeldOperationRow } from '../../src/messaging/telegram-origin/StoreTypes.js';
import { OriginSendPolicyRefusal } from '../../src/messaging/telegram-origin/OriginSendPolicy.js';
import { OriginStore } from '../../src/messaging/telegram-origin/OriginStore.js';
import { OriginSessionRegistry } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import { TelegramOriginService } from '../../src/messaging/telegram-origin/TelegramOriginService.js';
import { compileOriginWorker, temporaryState, admission } from '../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { migrateTelegramOriginDisplay, originForwardToHolderEnabled } from '../../src/messaging/telegram-origin/OriginConfig.js';
import { OriginForwardSettledLocallyError } from '../../src/messaging/telegram-origin/types.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── fixtures ────────────────────────────────────────────────────────────────
function fakeOperation(holder: string, operationId = 'op-1'): OriginPreparedBotOperation {
  return { record: { operationId, originId: `origin-${operationId}-${holder}`, originMachineId: 'standby', executionOwnerMachineId: holder } as never,
    admission: { operationId } as never };
}
function clock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; }, sleeps, advance: (ms: number) => { now += ms; } };
}
function lease(overrides: Partial<ForwardLeaseView> = {}): ForwardLeaseView {
  return { selfMachineId: 'standby', leaseHolder: () => 'holder', holdsLease: () => false, isHolderHealthy: () => true, ...overrides };
}
function deps(c = clock(), overrides: Partial<ForwardDeps> = {}) {
  const prepare = vi.fn(async (holder: string, _input: unknown, operationId?: string) => fakeOperation(holder, operationId ?? `op-${prepare.mock.calls.length}`));
  const submit = vi.fn<(holder: string, op: OriginPreparedBotOperation) => Promise<HolderSubmitResult>>(async (holder) =>
    ({ ok: true, messageId: 77, deliveryMachineId: holder, receiptJson: '{"messageId":77}' }));
  const hold = vi.fn(async () => undefined);
  const notify = vi.fn(async () => true);
  const audit = vi.fn();
  const d: ForwardDeps = { lease: lease(), prepare, submit, hold, notify, audit, sleep: c.sleep, now: c.now, ...overrides };
  return { d, prepare, submit, hold, notify, audit, c };
}
const input = { topicId: 9210, chatId: '-100123', text: 'The answer.' };

describe('classifyLeaseRoute — the three settling states', () => {
  it('self when this machine holds the lease', () => expect(classifyLeaseRoute(lease({ holdsLease: () => true }))).toEqual({ kind: 'self' }));
  it('peer when a healthy other machine holds it', () => expect(classifyLeaseRoute(lease())).toEqual({ kind: 'peer', holder: 'holder' }));
  it('settling: no holder named', () => expect(classifyLeaseRoute(lease({ leaseHolder: () => null }))).toEqual({ kind: 'settling', reason: 'no-holder' }));
  it('settling: self named but not yet confirmed (the seconds after a respawn)', () =>
    expect(classifyLeaseRoute(lease({ leaseHolder: () => 'standby' }))).toEqual({ kind: 'settling', reason: 'self-unconfirmed' }));
  it('settling: an expired named holder counts as unsettled (currentHolder has no expiry check)', () =>
    expect(classifyLeaseRoute(lease({ isHolderHealthy: () => false }))).toEqual({ kind: 'settling', reason: 'holder-unhealthy' }));
  it('an unreadable lease reads as settling, never as a peer', () =>
    expect(classifyLeaseRoute(lease({ leaseHolder: () => { throw new Error('boom'); } }))).toEqual({ kind: 'settling', reason: 'no-holder' }));
});

describe('settleLeaseRoute — ≤15 s, backoff, no row', () => {
  it('settles to a peer once the holder becomes healthy', async () => {
    const c = clock(); let healthy = false;
    setTimeoutLike(c, 1200, () => { healthy = true; });
    const r = await settleLeaseRoute(lease({ isHolderHealthy: () => healthy }), { sleep: c.sleep, now: c.now });
    expect(r).toEqual({ kind: 'peer', holder: 'holder' });
    expect(c.sleeps.slice(0, 3)).toEqual([250, 500, 1000]);
  });
  it('settles to self when holdsLease flips true', async () => {
    const c = clock(); let held = false;
    setTimeoutLike(c, 300, () => { held = true; });
    expect(await settleLeaseRoute(lease({ leaseHolder: () => null, holdsLease: () => held }), { sleep: c.sleep, now: c.now })).toEqual({ kind: 'self' });
  });
  it('gives up as unsettled at the timeout', async () => {
    const c = clock();
    const r = await settleLeaseRoute(lease({ leaseHolder: () => null }), { sleep: c.sleep, now: c.now, timeoutMs: 15_000 });
    expect(r).toEqual({ kind: 'unsettled', reason: 'no-holder' });
    expect(c.now()).toBeGreaterThanOrEqual(1_000_000 + 15_000);
    expect(c.now()).toBeLessThan(1_000_000 + 15_000 + 2000);
  });
  function setTimeoutLike(c: ReturnType<typeof clock>, afterMs: number, fn: () => void) {
    const origSleep = c.sleep; const start = c.now();
    c.sleep = async (ms) => { await origSleep(ms); if (c.now() - start >= afterMs) fn(); };
  }
});

describe('forwardReplyToHolder — settle, ONE attempt, then the durable hold', () => {
  it('a settling window never holds: a holder that appears within 15 s gets the reply (one submit, no hold, no notice)', async () => {
    const c = clock(); let healthy = false;
    const sleep = c.sleep; c.sleep = async ms => { await sleep(ms); if (c.now() - 1_000_000 >= 800) healthy = true; };
    const h = deps(c, { lease: lease({ isHolderHealthy: () => healthy }) });
    const r = await forwardReplyToHolder(h.d, input);
    expect(r).toMatchObject({ kind: 'sent', messageId: 77, holder: 'holder' });
    expect(h.submit).toHaveBeenCalledTimes(1); expect(h.hold).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
    expect(h.prepare).toHaveBeenCalledWith('holder', input);
  });
  it('settles to self → local, nothing prepared or forwarded', async () => {
    const h = deps(clock(), { lease: lease({ holdsLease: () => true }) });
    expect(await forwardReplyToHolder(h.d, input)).toEqual({ kind: 'local' });
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
  });
  it('a window that never settles becomes a forward failure: no attempt, the durable hold with lastAttempt=unsettled and the ladder armed at +10 s', async () => {
    const h = deps(clock(), { lease: lease({ leaseHolder: () => null }) });
    const before = h.c.now();
    const r = await forwardReplyToHolder(h.d, input);
    expect(r).toMatchObject({ kind: 'held', holder: null, lastAttempt: 'unsettled', reason: 'lease-settling-no-holder', noticeDelivered: false });
    expect(h.c.now() - before).toBeLessThanOrEqual(FORWARD_SETTLE_TIMEOUT_MS + 2000); // the settle window, nothing more
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.hold).toHaveBeenCalledTimes(1);
    const [heldOp, detail] = h.hold.mock.calls[0] as unknown as [OriginPreparedBotOperation, HeldForwardDetail];
    expect(heldOp.record.executionOwnerMachineId).toBe(UNRESOLVED_LEASE_HOLDER);
    expect(detail).toMatchObject({ kind: 'forward-to-holder', lastAttempt: 'unsettled', machineId: null, topicId: 9210, text: 'The answer.', ladder: { attempts: 0, nextAt: h.c.now() + 10_000 } });
    expect(h.notify).not.toHaveBeenCalled(); // no holder to notify through
  });
  it('a typed retryable refusal (not-lease-holder) is NOT retried inside the request: one submit, then the hold with the ladder armed (the recovery tick re-resolves the holder)', async () => {
    const h = deps(clock());
    h.submit.mockResolvedValue({ ok: false, reason: 'not-lease-holder', outcome: 'held', retryable: true });
    const r = await forwardReplyToHolder(h.d, input);
    expect(r).toMatchObject({ kind: 'held', holder: 'holder', lastAttempt: 'refused', reason: 'not-lease-holder' });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.c.sleeps).toEqual([]); // the reply request never sleeps on a refusal
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect((h.hold.mock.calls[0] as unknown as [unknown, HeldForwardDetail])[1].ladder).toEqual({ attempts: 0, nextAt: h.c.now() + 10_000 });
  });
  it('an unreachable holder holds durably with lease-not-held, sends the notice through the holder and reports noticeDelivered', async () => {
    const h = deps(clock());
    h.submit.mockResolvedValue({ ok: false, reason: 'origin-peer-unreachable', outcome: 'held', retryable: true });
    const r = await forwardReplyToHolder(h.d, input);
    expect(r).toMatchObject({ kind: 'held', holder: 'holder', lastAttempt: 'unreachable', reason: 'origin-peer-unreachable', noticeDelivered: true });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.hold).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith('holder', 9210);
    expect(h.audit.mock.calls.map(c => (c[0] as { phase: string }).phase)).toContain('notice-sent');
  });
  it('an outcome-unknown submit is NEVER re-sent: hold with lastAttempt=outcome-unknown naming the machine, and no notice through that machine', async () => {
    const h = deps(clock());
    h.submit.mockResolvedValue({ ok: false, reason: 'origin-relay-acceptance-unknown', outcome: 'outcome-unknown', retryable: false });
    const r = await forwardReplyToHolder(h.d, input);
    expect(r).toMatchObject({ kind: 'held', lastAttempt: 'outcome-unknown', holder: 'holder', noticeDelivered: false });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
    expect((h.hold.mock.calls[0] as unknown as [unknown, HeldForwardDetail])[1]).toMatchObject({ lastAttempt: 'outcome-unknown', machineId: 'holder' });
  });
  it('a non-retryable refusal holds after one submit', async () => {
    const h = deps(clock());
    h.submit.mockResolvedValue({ ok: false, reason: 'origin-plan-invalid', outcome: 'held', retryable: false });
    expect(await forwardReplyToHolder(h.d, input)).toMatchObject({ kind: 'held', lastAttempt: 'refused', reason: 'origin-plan-invalid' });
    expect(h.submit).toHaveBeenCalledTimes(1);
  });
  it("the holder's send-policy refusal (its tone gate) propagates as the typed refusal, never a hold", async () => {
    const h = deps(clock());
    h.submit.mockResolvedValue({ ok: false, reason: 'tone-gate-blocked', outcome: 'held', retryable: false,
      policyRefusal: { ok: false, status: 422, reason: 'tone-gate-blocked', body: { error: 'tone-gate-blocked' } } });
    await expect(forwardReplyToHolder(h.d, input)).rejects.toBeInstanceOf(OriginSendPolicyRefusal);
    expect(h.hold).not.toHaveBeenCalled();
  });
  it('the ladder state advances +10 s, +20 s, then exhausts to the 15-min schedule', () => {
    const first = nextLadderState(undefined, 100);
    expect(first).toEqual({ attempts: 0, nextAt: 10_100 });
    const second = nextLadderState(first, 20_000);
    expect(second).toEqual({ attempts: 1, nextAt: 40_000 });
    expect(nextLadderState(second, 50_000)).toEqual({ attempts: 2, nextAt: null });
    expect(nextLadderState({ attempts: 2, nextAt: null }, 60_000)).toEqual({ attempts: 3, nextAt: null });
  });
});

describe('recoverForwardedHold — re-forward the SAME operation, supersede on a holder change, never a blind re-send', () => {
  const row = (detail: Partial<HeldForwardDetail> | null, owner = 'holder'): HeldOperationRow => ({ operationId: 'op-1', originId: 'o', state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
    holdDetail: detail === null ? null : { kind: 'forward-to-holder', lastAttempt: 'refused', machineId: owner, topicId: 9210, chatId: '-100123', text: 'The answer.', reason: 'x', at: 1, noticeDelivered: false, ladder: { attempts: 0, nextAt: 5 }, ...detail },
    preparedAt: 1, deadlineAt: 2, executionOwnerMachineId: owner, destination: { accountId: '1', chatId: '-100123', topicId: '9210' }, recovery: null, expiryReportedAt: null });
  function rdeps(overrides: Partial<Parameters<typeof recoverForwardedHold>[0]> = {}) {
    const prepare = vi.fn(async (holder: string, _i: unknown, operationId?: string) => fakeOperation(holder, operationId ?? 'op-new'));
    const submit = vi.fn<(holder: string, op: OriginPreparedBotOperation) => Promise<HolderSubmitResult>>(async (holder) => ({ ok: true, messageId: 9, deliveryMachineId: holder, receiptJson: '{"messageId":9}' }));
    const receipt = vi.fn(async () => ({ state: 'unreachable' as const }));
    const resolve = vi.fn(async () => true);
    const rehold = vi.fn(async () => undefined);
    const supersede = vi.fn(async (_old: string, _next: OriginPreparedBotOperation, _detail: HeldForwardDetail) => true);
    const sendLocal = vi.fn(async () => ({ messageId: 3 }));
    return { prepare, submit, receipt, resolve, rehold, supersede, sendLocal, d: { lease: lease(), prepare, submit, receipt, resolve, rehold, supersede, sendLocal, now: () => 5, ...overrides } };
  }
  it('holder unchanged → re-submits the stored operation as-is and resolves the local row', async () => {
    const h = rdeps();
    expect(await recoverForwardedHold(h.d, row({}), fakeOperation('holder', 'op-1'))).toBe('sent');
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.resolve).toHaveBeenCalledWith('op-1', 'holder', '{"messageId":9}');
    expect(h.supersede).not.toHaveBeenCalled();
  });
  it('holder changed → ONE atomic supersede (new row admitted+held, old row retired) BEFORE the forward; then forwarded and resolved', async () => {
    const calls: string[] = [];
    const h = rdeps({ lease: lease({ leaseHolder: () => 'holder-2' }) });
    h.supersede.mockImplementation(async () => { calls.push('supersede'); return true; });
    h.submit.mockImplementation(async (holder) => { calls.push(`submit:${holder}`); return { ok: true, messageId: 9, deliveryMachineId: holder, receiptJson: '{}' }; });
    expect(await recoverForwardedHold(h.d, row({}), fakeOperation('holder', 'op-1'))).toBe('sent');
    expect(h.prepare).toHaveBeenCalledWith('holder-2', expect.objectContaining({ text: 'The answer.' }));
    expect(h.prepare.mock.calls[0]).toHaveLength(2); // a NEW operation id, never the old one re-bound
    expect(calls).toEqual(['supersede', 'submit:holder-2']);
    expect(h.supersede.mock.calls[0][0]).toBe('op-1');
    expect(h.supersede.mock.calls[0][1].record.operationId).toBe('op-new');
    expect(h.supersede.mock.calls[0][2]).toMatchObject({ supersedes: 'op-1', machineId: 'holder-2', ladder: { attempts: 1, nextAt: 20_005 } });
    expect(h.resolve).toHaveBeenCalledWith('op-new', 'holder-2', '{}');
    expect(h.rehold).not.toHaveBeenCalled();
  });
  it('holder changed and the new holder refuses → the NEW row is re-held with the refusal; the old stays superseded', async () => {
    const h = rdeps({ lease: lease({ leaseHolder: () => 'holder-2' }) });
    h.submit.mockResolvedValue({ ok: false, reason: 'not-lease-holder', outcome: 'held', retryable: true });
    expect(await recoverForwardedHold(h.d, row({}), fakeOperation('holder', 'op-1'))).toBe('retained');
    expect(h.supersede.mock.calls[0][0]).toBe('op-1');
    expect(h.rehold).toHaveBeenCalledWith('op-new', expect.objectContaining({ lastAttempt: 'refused', reason: 'not-lease-holder', supersedes: 'op-1' }));
    expect(h.resolve).not.toHaveBeenCalled();
  });
  it('a REFUSED supersede (the old row is no longer plainly held — it may be delivering) forwards NOTHING and retains', async () => {
    const h = rdeps({ lease: lease({ leaseHolder: () => 'holder-2' }) });
    h.supersede.mockResolvedValue(false);
    expect(await recoverForwardedHold(h.d, row({}), fakeOperation('holder', 'op-1'))).toBe('retained');
    expect(h.submit).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled(); expect(h.rehold).not.toHaveBeenCalled();
  });
  it('an unresolved-holder hold (no holder could be named at request time) is bound to the first real holder by the same supersede path', async () => {
    const h = rdeps();
    expect(await recoverForwardedHold(h.d, row({ machineId: null, lastAttempt: 'unsettled' }, UNRESOLVED_LEASE_HOLDER), fakeOperation(UNRESOLVED_LEASE_HOLDER, 'op-1'))).toBe('sent');
    expect(h.prepare).toHaveBeenCalledWith('holder', expect.anything());
    expect(h.supersede.mock.calls[0][0]).toBe('op-1');
  });
  it('outcome-unknown: the holder has CUSTODY (admitted/held there) → retained, never re-forwarded (its own recovery delivers)', async () => {
    const h = rdeps(); h.receipt.mockResolvedValue({ state: 'owned-by-holder' } as never);
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'outcome-unknown' }), fakeOperation('holder', 'op-1'))).toBe('retained');
    expect(h.submit).not.toHaveBeenCalled(); expect(h.supersede).not.toHaveBeenCalled();
    expect(h.rehold).toHaveBeenCalledWith('op-1', expect.objectContaining({ lastAttempt: 'outcome-unknown', ladder: { attempts: 1, nextAt: 20_005 } }));
  });
  it('outcome-unknown: the old holder confirms acceptance → resolved WITHOUT any submit', async () => {
    const h = rdeps(); h.receipt.mockResolvedValue({ state: 'accepted', receiptJson: '{"confirmedVia":"receipt"}' } as never);
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'outcome-unknown' }), fakeOperation('holder', 'op-1'))).toBe('resolved');
    expect(h.submit).not.toHaveBeenCalled(); expect(h.resolve).toHaveBeenCalledWith('op-1', 'holder', '{"confirmedVia":"receipt"}');
  });
  it('outcome-unknown: the old holder is unreachable → retained (ladder advanced), nothing sent', async () => {
    const h = rdeps();
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'outcome-unknown' }), fakeOperation('holder', 'op-1'))).toBe('retained');
    expect(h.submit).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled();
    expect(h.rehold).toHaveBeenCalledWith('op-1', expect.objectContaining({ lastAttempt: 'outcome-unknown', ladder: { attempts: 1, nextAt: 20_005 } }));
  });
  it('outcome-unknown at the OLD holder after a lease move: the receipt is asked there first; not-accepted → supersede → lands once via the new holder', async () => {
    const h = rdeps({ lease: lease({ leaseHolder: () => 'holder-2' }) }); h.receipt.mockResolvedValue({ state: 'not-accepted' } as never);
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'outcome-unknown' }), fakeOperation('holder', 'op-1'))).toBe('sent');
    expect(h.receipt).toHaveBeenCalledWith('holder', 'op-1');
    expect(h.submit).toHaveBeenCalledTimes(1); expect(h.submit.mock.calls[0][0]).toBe('holder-2');
    expect(h.supersede.mock.calls[0][0]).toBe('op-1');
  });
  it('the lease now held HERE → marks local-sent BEFORE sending, delivers locally from the stored detail and resolves', async () => {
    const calls: string[] = [];
    const h = rdeps({ lease: lease({ holdsLease: () => true }) });
    h.rehold.mockImplementation(async () => { calls.push('rehold'); });
    h.sendLocal.mockImplementation(async () => { calls.push('send'); return { messageId: 3 }; });
    expect(await recoverForwardedHold(h.d, row({}), fakeOperation('holder', 'op-1'))).toBe('sent');
    expect(calls).toEqual(['rehold', 'send']);
    expect(h.rehold).toHaveBeenCalledWith('op-1', expect.objectContaining({ lastAttempt: 'local-sent', machineId: 'standby' }));
    expect(h.sendLocal).toHaveBeenCalledWith(expect.objectContaining({ topicId: 9210, text: 'The answer.' }));
    expect(h.resolve).toHaveBeenCalledWith('op-1', 'standby', expect.stringContaining('supersededLocally'));
  });
  it('a row already marked local-sent is NEVER sent again (a failed resolve or a crash after the send)', async () => {
    const h = rdeps({ lease: lease({ holdsLease: () => true }) });
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'local-sent', machineId: 'standby' }), fakeOperation('holder', 'op-1'))).toBe('retained');
    expect(h.sendLocal).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
    expect(expiredForwardWording({ ...row({ lastAttempt: 'local-sent' }), preparedAt: 0, deadlineAt: 6 * 3_600_000 })).toContain('may or may not');
  });
  it('a still-settling lease retains; a refused re-forward re-records the detail (outcome-unknown stays sticky)', async () => {
    const settling = rdeps({ lease: lease({ leaseHolder: () => null }) });
    expect(await recoverForwardedHold(settling.d, row({}), fakeOperation('holder', 'op-1'))).toBe('retained');
    expect(settling.rehold).toHaveBeenCalledWith('op-1', expect.objectContaining({ reason: 'lease-settling-no-holder' }));
    const unknown = rdeps(); unknown.submit.mockResolvedValue({ ok: false, reason: 'origin-relay-acceptance-unknown', outcome: 'outcome-unknown', retryable: false });
    expect(await recoverForwardedHold(unknown.d, row({}), fakeOperation('holder', 'op-1'))).toBe('retained');
    expect(unknown.rehold).toHaveBeenCalledWith('op-1', expect.objectContaining({ lastAttempt: 'outcome-unknown', machineId: 'holder' }));
  });
  it('a legacy row without ladder state is treated as exhausted (the 15-min schedule owns it)', async () => {
    const h = rdeps(); h.submit.mockResolvedValue({ ok: false, reason: 'not-lease-holder', outcome: 'held', retryable: true });
    expect(await recoverForwardedHold(h.d, row({ ladder: undefined }), fakeOperation('holder', 'op-1'))).toBe('retained');
    expect(h.rehold).toHaveBeenCalledWith('op-1', expect.objectContaining({ ladder: { attempts: 3, nextAt: null } }));
  });
});

describe('submitOriginToHolder — one transport, one meaning per refusal', () => {
  const op = fakeOperation('holder');
  const caps = { ok: true, result: { ok: true, protocol: 'instar-telegram-origin-v1', credentialOwner: true, accountId: '1', executionOwnerMachineId: 'holder' } };
  it('capabilities transport failure → origin-peer-unreachable, retryable', async () => {
    expect(await submitOriginToHolder({ operation: op, send: async () => { throw new Error('ECONNREFUSED'); } })).toMatchObject({ ok: false, reason: 'origin-peer-unreachable', retryable: true, outcome: 'held' });
  });
  it('submit transport failure → outcome-unknown, NOT retryable', async () => {
    expect(await submitOriginToHolder({ operation: op, send: async c => c.action === 'capabilities' ? caps : Promise.reject(new Error('timeout')) }))
      .toMatchObject({ ok: false, reason: 'origin-relay-acceptance-unknown', outcome: 'outcome-unknown', retryable: false });
  });
  it('typed not-lease-holder → retryable held', async () => {
    expect(await submitOriginToHolder({ operation: op, send: async c => c.action === 'capabilities' ? caps : { ok: true, result: { ok: false, reason: 'not-lease-holder', outcome: 'held', retryable: true } } }))
      .toMatchObject({ ok: false, reason: 'not-lease-holder', retryable: true });
  });
  it('a holder answering as a different execution owner is refused before submit', async () => {
    const send = vi.fn(async () => caps);
    expect(await submitOriginToHolder({ operation: op, send, expectedOwner: 'holder-2' })).toMatchObject({ ok: false, reason: 'execution-owner-mismatch', retryable: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('acceptance carries the delivering machine and the forwarding machine in the receipt', async () => {
    const r = await submitOriginToHolder({ operation: op, send: async c => c.action === 'capabilities' ? caps
      : { ok: true, result: { ok: true, originId: op.record.originId, messageId: 44, originReceiptConfirmed: true, deliveryMachineId: 'holder', forwardedFromMachine: 'standby' } } });
    expect(r).toMatchObject({ ok: true, messageId: 44, deliveryMachineId: 'holder' });
    expect(JSON.parse((r as { receiptJson: string }).receiptJson)).toMatchObject({ messageId: 44, forwardedFromMachine: 'standby' });
  });
  it('a refusal that names OUR operation id (the holder took custody before refusing) is outcome-unknown: receipt-first, never re-sent', async () => {
    const op = fakeOperation('holder', 'op-c');
    const send = vi.fn().mockResolvedValueOnce(caps).mockResolvedValueOnce({ ok: true, result: { ok: false, reason: 'credential-capacity-unavailable', outcome: 'held', retryable: true, operationId: 'op-c' } });
    const r = await submitOriginToHolder({ operation: op, send });
    expect(r).toMatchObject({ ok: false, reason: 'credential-capacity-unavailable', outcome: 'outcome-unknown', retryable: false, admittedAtHolder: true });
    // The typed pre-admit refusals carry NO operation id and stay retryable.
    const send2 = vi.fn().mockResolvedValueOnce(caps).mockResolvedValueOnce({ ok: true, result: { ok: false, reason: 'not-lease-holder', outcome: 'held', retryable: true } });
    expect(await submitOriginToHolder({ operation: op, send: send2 })).toMatchObject({ ok: false, reason: 'not-lease-holder', outcome: 'held', retryable: true });
  });
  it('a dispatcher-level refusal (peer booting) is a definite, retryable refusal', async () => {
    expect(await submitOriginToHolder({ operation: op, send: async c => c.action === 'capabilities' ? caps : { ok: false, reason: 'origin-runtime-unavailable' } }))
      .toMatchObject({ ok: false, outcome: 'held', retryable: true });
  });
});

describe('item collapse + wording + notice', () => {
  it('three topics held on one standby within 1 h collapse to one item', () => {
    let now = 0; const c = new HeldForwardItemCollapser({ now: () => now });
    expect(c.record(1)).toMatchObject({ itemId: 'telegram-origin-held:1', aggregate: false });
    now += 10 * 60_000; expect(c.record(2)).toMatchObject({ itemId: 'telegram-origin-held:2', aggregate: false });
    now += 10 * 60_000; expect(c.record(3)).toMatchObject({ itemId: 'telegram-origin-held:aggregate', aggregate: true, supersedes: ['telegram-origin-held:1', 'telegram-origin-held:2', 'telegram-origin-held:3'] });
    now += 61 * 60_000; expect(c.record(4)).toMatchObject({ aggregate: false }); // the window has passed
  });
  it('expiry wording is honest about what is known', () => {
    const base: HeldOperationRow = { operationId: 'o', originId: 'o', state: 'expired', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: null, preparedAt: 0, deadlineAt: 6 * 3_600_000,
      executionOwnerMachineId: 'h', destination: { accountId: '1', chatId: '-1', topicId: '42' }, recovery: null, expiryReportedAt: null };
    expect(expiredForwardWording(base)).toBe('I could not deliver my reply to topic 42 within 6 h.');
    expect(expiredForwardWording({ ...base, holdDetail: { lastAttempt: 'outcome-unknown' } })).toBe('My reply to topic 42 may or may not have been delivered; the sending machine did not confirm within 6 h.');
    expect(heldForwardNoticeText('the Mini')).toBe('I have your message; my reply is delayed while it is routed through the Mini.');
  });
});

describe('config switch + migration parity (array-aware)', () => {
  it('forwardToHolder defaults ON, rejects non-boolean, honours an explicit false', () => {
    expect(originForwardToHolderEnabled(undefined)).toBe(true);
    expect(originForwardToHolderEnabled({})).toBe(true);
    expect(originForwardToHolderEnabled({ forwardToHolder: { enabled: false } })).toBe(false);
    expect(() => originForwardToHolderEnabled({ forwardToHolder: { enabled: 'yes' } })).toThrow();
  });
  it('migrateTelegramOriginDisplay adds forwardToHolder {enabled:true} once and never flips an operator false', () => {
    const config = { messaging: [{ type: 'telegram', config: {} as Record<string, unknown> }, { type: 'telegram', config: { messageOrigin: { forwardToHolder: { enabled: false } } } }] };
    expect(migrateTelegramOriginDisplay(config)).toBe(true);
    expect((config.messaging[0].config.messageOrigin as { forwardToHolder: unknown }).forwardToHolder).toEqual({ enabled: true });
    expect((config.messaging[1].config.messageOrigin as { forwardToHolder: unknown }).forwardToHolder).toEqual({ enabled: false });
    expect(migrateTelegramOriginDisplay(config)).toBe(false);
  });
});

// ── durable store rows (real worker) ────────────────────────────────────────
let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); });

describe('durable hold rows (OriginStoreBackend)', () => {
  it('recordOperationState(held, lease-not-held) is listed with its reason, resolved by a forwarded acceptance, and expiry is reported once', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo' }, worker); stores.push(store);
    const a = admission('fwd', 1_000);
    await store.admit(a);
    expect(await store.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: { kind: 'forward-to-holder', lastAttempt: 'refused' } })).toBe(true);
    await expect(store.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'Not Valid!' })).rejects.toThrow();
    const held = await store.listHeldOperations({ holdReason: 'lease-not-held' });
    expect(held).toHaveLength(1);
    // The bare fixture envelope carries no destination row; the integration tier asserts the real topic id.
    expect(held[0]).toMatchObject({ operationId: a.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'refused' } });
    expect((await store.getOperation(a.operationId))?.operation).toMatchObject({ state: 'held', holdReason: 'lease-not-held' });
    // A re-hold without a reason keeps the recorded one.
    expect(await store.recordOperationState({ operationId: a.operationId, state: 'held' })).toBe(true);
    expect((await store.listHeldOperations())[0].holdReason).toBe('lease-not-held');
    // Resolution by the holder's acceptance: same operation id, delivery machine named.
    expect(await store.recordForwardedAcceptance({ operationId: a.operationId, deliveryMachineId: 'holder', receiptJson: JSON.stringify({ messageId: 321, forwardedFromMachine: 'studio' }) })).toBe(true);
    const audit = await store.getOperation(a.operationId);
    expect(audit?.operation).toMatchObject({ state: 'accepted' });
    expect(audit?.operation).not.toHaveProperty('holdReason');
    expect(audit?.children.every(c => c.state === 'accepted')).toBe(true);
    expect(audit?.attempts[0]).toMatchObject({ outcome: 'accepted', deliveryMachineId: 'holder', reason: 'forwarded-to-holder' });
    expect(await store.listHeldOperations()).toHaveLength(0);
    expect(await store.recordForwardedAcceptance({ operationId: a.operationId, deliveryMachineId: 'holder', receiptJson: '{}' })).toBe(false); // never twice
    // Expiry: a held row past its deadline is listed until reported once.
    const b = admission('exp', 2_000);
    await store.admit(b);
    await store.recordOperationState({ operationId: b.operationId, state: 'held', holdReason: 'lease-not-held' });
    await store.cleanupPayloads(b.deadlineAt + 1);
    const expired = await store.listHeldOperations();
    expect(expired).toHaveLength(1); expect(expired[0]).toMatchObject({ operationId: b.operationId, state: 'expired', holdReason: 'lease-not-held', expiryReportedAt: null });
    expect((await store.getOperation(b.operationId))?.children[0].state).toBe('expired-unresolved');
    expect(await store.markHoldExpiryReported({ operationId: b.operationId, now: 3 })).toBe(true);
    expect(await store.listHeldOperations()).toHaveLength(0);
    expect(await store.markHoldExpiryReported({ operationId: b.operationId })).toBe(false);
  });
  it('heldForwardAdmissions lists only due ladder steps; supersedeOperation is terminal, linked, and refused once a child left queued', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo' }, worker); stores.push(store);
    const a = admission('lad', 1_000); await store.admit(a);
    await store.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'lease-not-held', holdDetail: { kind: 'forward-to-holder', ladder: { attempts: 0, nextAt: 5_000 } } });
    expect(await store.heldForwardAdmissions({ now: 4_999 })).toHaveLength(0);
    const due = await store.heldForwardAdmissions({ now: 5_000 });
    expect(due).toHaveLength(1);
    expect(due[0].admission.operationId).toBe(a.operationId);
    expect(due[0].row).toMatchObject({ operationId: a.operationId, holdReason: 'lease-not-held' });
    // Exhausted ladder (nextAt null) is never a candidate.
    await store.recordOperationState({ operationId: a.operationId, state: 'held', holdDetail: { kind: 'forward-to-holder', ladder: { attempts: 2, nextAt: null } } });
    expect(await store.heldForwardAdmissions({ now: 9_000 })).toHaveLength(0);
    // Supersede: terminal, linked by id, leaves the held listing, and never twice.
    await expect(store.supersedeOperation({ operationId: a.operationId, supersededBy: a.operationId })).rejects.toThrow();
    expect(await store.supersedeOperation({ operationId: a.operationId, supersededBy: 'op-next' })).toBe(true);
    const audit = await store.getOperation(a.operationId);
    expect(audit?.operation).toMatchObject({ state: 'superseded' });
    expect(audit?.operation?.holdDetail).toMatchObject({ supersededBy: 'op-next' });
    expect(audit?.children.every(c => c.state === 'superseded')).toBe(true);
    expect(await store.listHeldOperations()).toHaveLength(0);
    expect(await store.supersedeOperation({ operationId: a.operationId, supersededBy: 'op-next' })).toBe(false);
    expect(await store.recordForwardedAcceptance({ operationId: a.operationId, deliveryMachineId: 'holder', receiptJson: '{}' })).toBe(false);
    // The atomic variant: refuses on a superseded/accepted old row and admits NOTHING; succeeds in one step.
    const c = admission('old', 3_000); await store.admit(c);
    await store.recordOperationState({ operationId: c.operationId, state: 'held', holdReason: 'lease-not-held' });
    const d = admission('new', 4_000);
    expect(await store.supersedeWithAdmission({ operationId: a.operationId, admission: d, holdReason: 'lease-not-held', holdDetail: { kind: 'forward-to-holder', supersedes: a.operationId } })).toBe(false);
    expect(await store.getOperation(d.operationId)).toBeNull(); // nothing admitted on refusal
    expect(await store.supersedeWithAdmission({ operationId: c.operationId, admission: d, holdReason: 'lease-not-held', holdDetail: { kind: 'forward-to-holder', supersedes: c.operationId } })).toBe(true);
    expect((await store.getOperation(c.operationId))?.operation).toMatchObject({ state: 'superseded', holdDetail: { supersededBy: d.operationId } });
    expect((await store.getOperation(d.operationId))?.operation).toMatchObject({ state: 'held', holdReason: 'lease-not-held', holdDetail: { supersedes: c.operationId } });
    expect((await store.listHeldOperations({ holdReason: 'lease-not-held' })).map(r => r.operationId)).toEqual([d.operationId]);
    // An accepted row is never superseded.
    const b = admission('acc', 2_000); await store.admit(b);
    await store.recordForwardedAcceptance({ operationId: b.operationId, deliveryMachineId: 'holder', receiptJson: '{"messageId":1}' });
    expect(await store.supersedeOperation({ operationId: b.operationId, supersededBy: 'op-x' })).toBe(false);
  });
});

describe('service — lease-not-held vs destination-not-authorized', () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  async function harness(holdsLease: boolean) {
    const stateDir = temporaryState();
    const store = await OriginStore.open({ stateDir, agentId: 'echo' }, worker); stores.push(store);
    const sessions = new OriginSessionRegistry({ stateDir, agentId: 'echo', machineId: 'studio', isSessionLive: () => true });
    await sessions.initialize();
    const onHold = vi.fn();
    const service = new TelegramOriginService({ store, sessions, observer: new RuntimeOriginObserver(),
      sendPolicy: { review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) },
      identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
      signingKey: { privateKey: key, keyEpoch: 1, keyId: 'studio-1' }, ownerBootId: 'boot-1',
      display: () => ({ agent: { enabled: true } }), authorize: async () => false, holdsLease: () => holdsLease, onHold,
      spoolEvidence: async () => { throw new Error('spool unavailable'); }, reviewLegacyRecovery: async () => true });
    const send = () => service.runAsAutomation('telegram-server', () => service.sendBot(
      { method: 'sendMessage', accountId: 'bot-1', params: { chat_id: '-100123', message_thread_id: 42, text: 'Original answer' } }, vi.fn()));
    return { store, service, send, onHold };
  }
  it('a refused destination while NOT holding the lease is held as lease-not-held — durably, with the reason on the row', async () => {
    const h = await harness(false);
    await expect(h.send()).rejects.toMatchObject({ reason: 'lease-not-held' });
    expect(h.onHold).toHaveBeenCalledWith(expect.objectContaining({ reason: 'lease-not-held' }));
    const rows = await h.store.listHeldOperations({ holdReason: 'lease-not-held' });
    expect(rows).toHaveLength(1);
    expect(h.service.heldStatus()[0]).toMatchObject({ reason: 'lease-not-held' });
    expect(h.service.heldOperations()).toHaveLength(1); // a recovery candidate
  });
  it('a refused destination while HOLDING the lease stays destination-not-authorized and is never listed as a lease hold', async () => {
    const h = await harness(true);
    await expect(h.send()).rejects.toMatchObject({ reason: 'destination-not-authorized' });
    expect(await h.store.listHeldOperations({ holdReason: 'lease-not-held' })).toHaveLength(0);
  });
});

describe('TelegramAdapter — the send decision with a lease policy', () => {
  let adapter: TelegramAdapter | undefined; let tmpDir: string;
  afterEach(async () => { if (adapter) await adapter.stop(); adapter = undefined; SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/telegram-origin-forward-on-standby.test.ts' }); vi.unstubAllGlobals(); });
  function make(decide: () => 'forward' | 'local' | 'settling') {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fwd-'));
    adapter = new TelegramAdapter({ token: '123456:realbottoken', chatId: '-1001' }, tmpDir);
    adapter.holderForwardPolicy = { decide };
    return adapter;
  }
  it('willRelay is true only for a DEFINITE forward (a settling lease keeps the local tone gate)', () => {
    const relay = vi.fn();
    expect(Object.assign(make(() => 'forward'), { outboundRelay: relay }).willRelay()).toBe(true);
    expect(Object.assign(make(() => 'settling'), { outboundRelay: relay }).willRelay()).toBe(false);
    expect(Object.assign(make(() => 'local'), { outboundRelay: relay }).willRelay()).toBe(false);
    adapter!.holderForwardPolicy = null; expect(adapter!.willRelay()).toBe(false); // a token holder with no policy sends directly
  });
  it('a token-holding standby forwards through the relay and never calls the API itself', async () => {
    const a = make(() => 'forward');
    const relay = vi.fn().mockResolvedValue({ messageId: 99, topicId: 42 }); a.outboundRelay = relay;
    const mockFetch = vi.fn(); vi.stubGlobal('fetch', mockFetch);
    expect((await a.sendToTopic(42, 'hello from the standby')).messageId).toBe(99);
    expect(relay).toHaveBeenCalledTimes(1); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('a settling lease goes down the relay path; when it settles HERE the send proceeds locally', async () => {
    const a = make(() => 'settling');
    a.outboundRelay = vi.fn().mockRejectedValue(new OriginForwardSettledLocallyError());
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) });
    vi.stubGlobal('fetch', mockFetch);
    expect((await a.sendToTopic(42, 'direct after settling')).messageId).toBe(7);
    expect(mockFetch).toHaveBeenCalled();
  });
  it('gateSkippedForRelay: a send that would proceed LOCALLY after the caller skipped its gate is refused with the typed error, never sent ungated', async () => {
    const settled = make(() => 'settling');
    settled.outboundRelay = vi.fn().mockRejectedValue(new OriginForwardSettledLocallyError());
    const mockFetch = vi.fn(); vi.stubGlobal('fetch', mockFetch);
    await expect(settled.sendToTopic(42, 'ungated?', { gateSkippedForRelay: true })).rejects.toBeInstanceOf(OriginForwardSettledLocallyError);
    expect(mockFetch).not.toHaveBeenCalled();
    // The decision flipped to local between the route's willRelay() read and the send: same refusal.
    await settled.stop(); adapter = undefined;
    const flipped = make(() => 'local'); flipped.outboundRelay = vi.fn();
    await expect(flipped.sendToTopic(42, 'ungated?', { gateSkippedForRelay: true })).rejects.toBeInstanceOf(OriginForwardSettledLocallyError);
    expect(mockFetch).not.toHaveBeenCalled();
    // A definite forward still relays as before.
    await flipped.stop(); adapter = undefined;
    const fwd = make(() => 'forward'); fwd.outboundRelay = vi.fn().mockResolvedValue({ messageId: 5, topicId: 42 });
    expect((await fwd.sendToTopic(42, 'relayed', { gateSkippedForRelay: true })).messageId).toBe(5);
  });
  it('with the policy answering local, a real token sends directly (today\'s behaviour)', async () => {
    const a = make(() => 'local');
    const relay = vi.fn(); a.outboundRelay = relay;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }));
    await a.sendToTopic(42, 'direct'); expect(relay).not.toHaveBeenCalled();
  });
});
