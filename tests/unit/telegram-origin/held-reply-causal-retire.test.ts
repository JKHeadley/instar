/**
 * native-conversation-base §3a — a held reply is ended only for a cause.
 * Unit tier: the forwarder's pure decisions with injected dependencies.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyHolderReceipt, forwardExpiryArm, lateMarkDue, recoverForwardedHold, expiredForwardWording, handBackItem, HOLD_REASON_LEASE_NOT_HELD,
} from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardLeaseView, HeldForwardDetail, HolderReceiptAnswer, HolderSubmitResult } from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { OriginPreparedBotOperation } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import type { HeldOperationRow } from '../../../src/messaging/telegram-origin/StoreTypes.js';

const MIN = 60_000;
const NOW = 10_000_000;

function lease(overrides: Partial<ForwardLeaseView> = {}): ForwardLeaseView {
  return { selfMachineId: 'author', leaseHolder: () => 'holder', holdsLease: () => false, isHolderHealthy: () => true, ...overrides };
}
/** A session reply this machine (`author`) wrote, sealed for `owner`. */
function sessionOperation(owner: string, operationId = 'op-1', parts = 1): OriginPreparedBotOperation {
  return {
    record: { operationId, originId: `origin-${operationId}`, originMachineId: 'author', executionOwnerMachineId: owner, producerKind: 'session',
      operationKind: 'sendMessage', sessionId: 'session-1', harnessId: 'claude-code' } as never,
    admission: { operationId, children: Array.from({ length: parts }, () => ({ materializations: [{ requestJson: JSON.stringify({ method: 'sendMessage', policy: { text: 'The answer.' } }) }] })) } as never,
  };
}
function row(detail: Partial<HeldForwardDetail> | null, extra: Partial<HeldOperationRow> = {}): HeldOperationRow {
  return { operationId: 'op-1', originId: 'o', state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
    holdDetail: detail === null ? null : { kind: 'forward-to-holder', lastAttempt: 'refused', machineId: 'holder', topicId: 42, chatId: '-100123', text: 'The answer.',
      reason: 'x', at: 1, noticeDelivered: false, ladder: { attempts: 0, nextAt: 5 }, ...detail },
    preparedAt: NOW - 2 * MIN, deadlineAt: NOW + 6 * 60 * MIN, executionOwnerMachineId: 'holder', destination: { accountId: '1', chatId: '-100123', topicId: '42' },
    recovery: null, expiryReportedAt: null, producerKind: 'session', originMachineId: 'author', sessionId: 'session-1', harnessId: 'claude-code', ...extra };
}
function rdeps(overrides: Partial<Parameters<typeof recoverForwardedHold>[0]> = {}) {
  let n = 0;
  const prepare = vi.fn(async (holder: string, input: { text: string }) => ({ ...sessionOperation(holder, `op-new-${++n}`), text: input.text }) as unknown as OriginPreparedBotOperation);
  const submit = vi.fn<(holder: string, op: OriginPreparedBotOperation) => Promise<HolderSubmitResult>>(async holder => ({ ok: true, messageId: 9, deliveryMachineId: holder, receiptJson: '{"messageId":9}' }));
  const receipt = vi.fn<(machineId: string, operationId: string) => Promise<HolderReceiptAnswer>>(async () => ({ state: 'unreachable' }));
  const resolve = vi.fn(async () => true);
  const rehold = vi.fn(async () => true);
  const supersede = vi.fn(async () => true);
  const sendLocal = vi.fn(async () => ({ messageId: 3 }));
  const settleUnknown = vi.fn(async () => true);
  const mergeDetail = vi.fn(async () => true);
  const endAtHolder = vi.fn(async () => true);
  const onOwnerVerdict = vi.fn();
  const onOwnerUnstatedSettled = vi.fn();
  const onLateUnmarked = vi.fn();
  const d = { lease: lease(), prepare, submit, receipt, resolve, rehold, supersede, sendLocal, settleUnknown, mergeDetail, endAtHolder,
    onOwnerVerdict, onOwnerUnstatedSettled, onLateUnmarked, now: () => NOW, ...overrides };
  return { d, prepare, submit, receipt, resolve, rehold, supersede, sendLocal, settleUnknown, mergeDetail, endAtHolder, onOwnerVerdict, onOwnerUnstatedSettled, onLateUnmarked };
}

describe('classifyHolderReceipt — the raw state is read with outcome, reason and failure', () => {
  const answer = (result: Record<string, unknown>) => classifyHolderReceipt({ ok: true, result: { ok: true, operationId: 'op-1', ...result } }, 'op-1', 'holder');
  it('an old holder answering `suppressed` with no outcome is reasonless, never "not accepted" (no second copy)', () => {
    expect(answer({ state: 'suppressed', originReceiptConfirmed: false, messageIds: [] })).toEqual({ state: 'owner-reasonless', olderOwner: true });
  });
  it('a new owner with a stated reason ends it; a new owner with no reason is reasonless but not older', () => {
    expect(answer({ state: 'suppressed', outcome: 'delivered', reason: 'duplicate-content' })).toEqual({ state: 'owner-ended', reason: 'duplicate-content' });
    expect(answer({ state: 'suppressed', outcome: 'unknown', reason: null })).toEqual({ state: 'owner-reasonless', olderOwner: false });
    expect(answer({ state: 'suppressed', outcome: 'not-delivered', reason: 'made-up-reason' })).toEqual({ state: 'owner-reasonless', olderOwner: false });
  });
  it('the owner verdict of non-delivery carries its cause; a value outside the closed sets is no outcome', () => {
    expect(answer({ state: 'known-failed', outcome: 'not-delivered', failure: 'refused' })).toEqual({ state: 'owner-verdict', failure: 'refused' });
    expect(answer({ state: 'expired', outcome: 'not-delivered', failure: 'deadline' })).toEqual({ state: 'owner-verdict', failure: 'deadline' });
    expect(answer({ state: 'expired', outcome: 'bogus', failure: 'deadline' })).toEqual({ state: 'not-accepted', kind: 'older-terminal' });
    expect(answer({ state: 'known-failed', outcome: 'unknown', failure: null })).toEqual({ state: 'unreachable' });
  });
  it('never-admitted answers and the ladder\'s other readings are unchanged', () => {
    expect(answer({ state: 'no-record' })).toEqual({ state: 'not-accepted', kind: 'no-record' });
    expect(answer({ state: 'not-admitted' })).toEqual({ state: 'not-accepted', kind: 'not-admitted' });
    expect(answer({ state: 'known-failed' })).toEqual({ state: 'not-accepted', kind: 'older-terminal' });
    expect(answer({ state: 'held' })).toEqual({ state: 'owned-by-holder' });
    expect(answer({ state: 'outcome-unknown' })).toEqual({ state: 'outcome-unknown' });
    expect(answer({ state: 'accepted', originReceiptConfirmed: true, messageIds: ['77'] }).state).toBe('accepted');
    expect(classifyHolderReceipt({ ok: false }, 'op-1', 'holder')).toEqual({ state: 'unreachable' });
    expect(classifyHolderReceipt({ ok: true, result: { ok: true, operationId: 'other', state: 'no-record' } }, 'op-1', 'holder')).toEqual({ state: 'unreachable' });
  });
});

describe('forwardExpiryArm — which line an expired held forward gets', () => {
  it.each([
    [{ lastAttempt: 'outcome-unknown' }, { arm: 'uncertain' }],
    [{ lastAttempt: 'local-sent' }, { arm: 'uncertain' }],
    [{ lastAttempt: 'refused' }, { arm: 'definite', cause: 'deadline' }],
    [{ lastAttempt: 'unreachable' }, { arm: 'definite', cause: 'deadline' }],
    [{ lastAttempt: 'unsettled' }, { arm: 'definite', cause: 'deadline' }],
    [{ ownerUnstated: { at: 1, attempts: 1, machineId: 'holder' } }, { arm: 'uncertain' }],
    [{ ownerUnstated: { at: 1, attempts: 2, settled: true, machineId: 'holder' } }, { arm: 'uncertain' }],
    [{ ownerVerdict: { outcome: 'not-delivered', failure: 'never-left', at: 1, machineId: 'holder' } }, { arm: 'definite', cause: 'never-left' }],
    [{ ownerVerdict: { outcome: 'not-delivered', failure: 'refused', at: 1, machineId: 'holder' } }, { arm: 'definite', cause: 'refused' }],
  ] as const)('%j → %j', (detail, arm) => {
    expect(forwardExpiryArm(row(detail as Partial<HeldForwardDetail>))).toEqual(arm);
  });
  it('the hub item wording agrees with the arm', () => {
    expect(expiredForwardWording(row({ ownerUnstated: { at: 1, attempts: 1, machineId: 'holder' } }))).toContain('may or may not');
    expect(expiredForwardWording(row({ lastAttempt: 'refused' }))).toContain('could not deliver');
  });
});

describe('lateMarkDue — late is more than 300 s after the first draft, marked once', () => {
  it('session sendMessage only, from first_prepared_at, never twice', () => {
    const op = sessionOperation('holder');
    expect(lateMarkDue(row({}, { preparedAt: NOW - 5 * MIN }), op, NOW)).toBeNull();
    expect(lateMarkDue(row({}, { preparedAt: NOW - 5 * MIN - 1 }), op, NOW)).toBe(NOW - 5 * MIN - 1);
    expect(lateMarkDue(row({}, { preparedAt: NOW - MIN, firstPreparedAt: NOW - 20 * MIN }), op, NOW)).toBe(NOW - 20 * MIN);
    expect(lateMarkDue(row({}, { preparedAt: NOW - 20 * MIN, lateMarkedAt: NOW - 10 * MIN }), op, NOW)).toBeNull();
    const automation = { ...op, record: { ...op.record, producerKind: 'server-automation' } } as OriginPreparedBotOperation;
    expect(lateMarkDue(row({}, { preparedAt: NOW - 20 * MIN }), automation, NOW)).toBeNull();
  });
});

describe('recoverForwardedHold — native-conversation-base §3a item 7', () => {
  it('a row with ownerVerdict returns at once on every route: no receipt, no submit, no supersede, no local send', async () => {
    for (const leaseView of [lease(), lease({ leaseHolder: () => 'holder-2' }), lease({ holdsLease: () => true, leaseHolder: () => 'author' })]) {
      const h = rdeps({ lease: leaseView });
      const verdictRow = row({ lastAttempt: 'outcome-unknown', ownerVerdict: { outcome: 'not-delivered', failure: 'never-left', at: 1, machineId: 'holder' } });
      expect(await recoverForwardedHold(h.d, verdictRow, sessionOperation('holder'))).toBe('skipped');
      for (const fn of [h.receipt, h.submit, h.supersede, h.sendLocal, h.rehold, h.prepare]) expect(fn).not.toHaveBeenCalled();
    }
  });
  it('the owner answers not-delivered with a cause: the verdict is merged, the definite line goes out, nothing is submitted', async () => {
    const h = rdeps();
    h.receipt.mockResolvedValue({ state: 'owner-verdict', failure: 'never-left' });
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'outcome-unknown' }), sessionOperation('holder'))).toBe('settled');
    expect(h.mergeDetail).toHaveBeenCalledWith('op-1', { ownerVerdict: { outcome: 'not-delivered', failure: 'never-left', at: NOW, machineId: 'holder' } });
    expect(h.onOwnerVerdict).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });
  it('the owner ended it with a stated reason: recorded suppressed-at-holder and stopped', async () => {
    const h = rdeps();
    h.receipt.mockResolvedValue({ state: 'owner-ended', reason: 'duplicate-content' });
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'outcome-unknown' }), sessionOperation('holder'))).toBe('settled');
    expect(h.endAtHolder).toHaveBeenCalledWith('op-1', 'duplicate-content', 'holder', expect.objectContaining({ text: 'The answer.' }));
    expect(h.submit).not.toHaveBeenCalled();
  });
  it('new author, old holder: one reasonless suppression leads to ONE fresh-time replacement, the old id never re-submitted', async () => {
    const h = rdeps();
    h.receipt.mockResolvedValue({ state: 'owner-reasonless', olderOwner: true });
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'outcome-unknown' }, { preparedAt: NOW - 2 * MIN }), sessionOperation('holder'))).toBe('sent');
    expect(h.mergeDetail).toHaveBeenCalledWith('op-1', { ownerUnstated: { at: NOW, attempts: 1, machineId: 'holder' } });
    expect(h.supersede).toHaveBeenCalledTimes(1);
    expect(h.supersede.mock.calls[0][2]).toMatchObject({ unstatedReplacementOf: 'op-1', supersedes: 'op-1' });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0][1].record.operationId).toBe('op-new-1');
    // The replacement keeps the original's deadline and policy input (content-check key).
    expect(h.prepare.mock.calls[0][1]).toMatchObject({ replacement: { deadlineAt: NOW + 6 * 60 * MIN, policyInput: { text: 'The answer.' } } });
  });
  it('a second reasonless suppression settles the row: one session line, no third submit', async () => {
    const h = rdeps();
    h.receipt.mockResolvedValue({ state: 'owner-reasonless', olderOwner: true });
    expect(await recoverForwardedHold(h.d, row({ lastAttempt: 'outcome-unknown', unstatedReplacementOf: 'op-0' }), sessionOperation('holder'))).toBe('retained');
    expect(h.mergeDetail).toHaveBeenCalledWith('op-1', { ownerUnstated: { at: NOW, attempts: 2, settled: true, machineId: 'holder' } });
    expect(h.onOwnerUnstatedSettled).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.supersede).not.toHaveBeenCalled();
  });
  it('a settled row submits nothing on later ticks while the owner stays reasonless', async () => {
    const h = rdeps();
    h.receipt.mockResolvedValue({ state: 'owner-reasonless', olderOwner: true });
    const settled = row({ ownerUnstated: { at: 1, attempts: 2, settled: true, machineId: 'holder' } });
    expect(await recoverForwardedHold(h.d, settled, sessionOperation('holder'))).toBe('retained');
    expect(h.submit).not.toHaveBeenCalled(); expect(h.onOwnerUnstatedSettled).not.toHaveBeenCalled();
  });
  it('the old holder accepted the text and suppressed with no reason, then the lease moves to the author: it asks the old holder, and unreachable or still reasonless sends nothing', async () => {
    for (const answer of [{ state: 'unreachable' } as const, { state: 'owner-reasonless', olderOwner: true } as const]) {
      const h = rdeps({ lease: lease({ holdsLease: () => true, leaseHolder: () => 'author' }) });
      h.receipt.mockResolvedValue(answer);
      const unstated = row({ ownerUnstated: { at: 1, attempts: 2, settled: true, machineId: 'holder' } });
      expect(await recoverForwardedHold(h.d, unstated, sessionOperation('holder'))).toBe('retained');
      expect(h.receipt).toHaveBeenCalledWith('holder', 'op-1');
      expect(h.sendLocal).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled(); expect(h.supersede).not.toHaveBeenCalled();
    }
  });
  it('the same, lease moved to a third machine: no holder-change supersede without the old owner\'s record', async () => {
    const h = rdeps({ lease: lease({ leaseHolder: () => 'holder-2' }) });
    const unstated = row({ ownerUnstated: { at: 1, attempts: 1, machineId: 'holder' } });
    expect(await recoverForwardedHold(h.d, unstated, sessionOperation('holder'))).toBe('retained');
    expect(h.supersede).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
  });
  it('only the old owner\'s own record moves an ownerUnstated row', async () => {
    const accepted = rdeps();
    accepted.receipt.mockResolvedValue({ state: 'accepted', receiptJson: '{"messageId":5}' });
    expect(await recoverForwardedHold(accepted.d, row({ ownerUnstated: { at: 1, attempts: 2, settled: true, machineId: 'holder' } }), sessionOperation('holder'))).toBe('resolved');
    const never = rdeps();
    never.receipt.mockResolvedValue({ state: 'not-accepted', kind: 'no-record' });
    expect(await recoverForwardedHold(never.d, row({ ownerUnstated: { at: 1, attempts: 2, settled: true, machineId: 'holder' } }), sessionOperation('holder'))).toBe('retained');
    const cleared = never.rehold.mock.calls[0][1] as HeldForwardDetail;
    expect(cleared.ownerUnstated).toBeUndefined();
    expect(never.submit).not.toHaveBeenCalled();
    const older = rdeps();
    older.receipt.mockResolvedValue({ state: 'not-accepted', kind: 'older-terminal' });
    expect(await recoverForwardedHold(older.d, row({ ownerUnstated: { at: 1, attempts: 2, settled: true, machineId: 'holder' } }), sessionOperation('holder'))).toBe('retained');
    expect(older.rehold).not.toHaveBeenCalled(); expect(older.submit).not.toHaveBeenCalled();
  });
});

describe('recoverForwardedHold — the late first line (native-conversation-base §3a item 2)', () => {
  it('a reply forwarded after 300 s is replaced once with the late line, keeping the authored text as its policy input', async () => {
    const h = rdeps();
    const late = row({}, { preparedAt: NOW - 20 * MIN });
    expect(await recoverForwardedHold(h.d, late, sessionOperation('holder'))).toBe('sent');
    const input = h.prepare.mock.calls[0][1] as unknown as { text: string; replacement: { firstPreparedAt: number; policyInput: { text: string }; maxParts: number } };
    expect(input.text).toBe('Late reply, written more than 20 minutes ago and held up in delivery. It answers an earlier message:\n\nThe answer.');
    expect(input.replacement).toMatchObject({ firstPreparedAt: NOW - 20 * MIN, policyInput: { text: 'The answer.' }, maxParts: 1 });
    expect(h.supersede.mock.calls[0][3]).toEqual({ firstPreparedAt: NOW - 20 * MIN, lateMarkedAt: NOW });
    expect(h.submit.mock.calls[0][1].record.operationId).toBe('op-new-1');
  });
  it('a marked reply that stalls again is not marked twice', async () => {
    const h = rdeps();
    expect(await recoverForwardedHold(h.d, row({}, { preparedAt: NOW - MIN, firstPreparedAt: NOW - 20 * MIN, lateMarkedAt: NOW - 10 * MIN }), sessionOperation('holder'))).toBe('sent');
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.supersede).not.toHaveBeenCalled();
    expect(h.submit.mock.calls[0][1].record.operationId).toBe('op-1');
  });
  it('when the line cannot be added the reply goes out as it is, counted lateUnmarked, and is never tried again', async () => {
    const h = rdeps();
    h.prepare.mockRejectedValue(new Error('replacement-part-limit'));
    expect(await recoverForwardedHold(h.d, row({}, { preparedAt: NOW - 20 * MIN }), sessionOperation('holder'))).toBe('sent');
    expect(h.onLateUnmarked).toHaveBeenCalledWith('op-1');
    expect(h.rehold).toHaveBeenCalledWith('op-1', expect.objectContaining({ lateMarkUnavailable: true }));
    expect(h.submit.mock.calls[0][1].record.operationId).toBe('op-1');
    const again = rdeps();
    await recoverForwardedHold(again.d, row({ lateMarkUnavailable: true }, { preparedAt: NOW - 20 * MIN }), sessionOperation('holder'));
    expect(again.prepare).not.toHaveBeenCalled();
  });
  it('a holder change on a late reply carries the line in the one replacement it already makes', async () => {
    const h = rdeps({ lease: lease({ leaseHolder: () => 'holder-2' }) });
    expect(await recoverForwardedHold(h.d, row({}, { preparedAt: NOW - 20 * MIN }), sessionOperation('holder'))).toBe('sent');
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect((h.prepare.mock.calls[0][1] as { text: string }).text).toMatch(/^Late reply, written more than 20 minutes ago/);
    expect(h.submit.mock.calls[0][0]).toBe('holder-2');
  });
  it('a reply under 300 s is forwarded exactly as written', async () => {
    const h = rdeps();
    await recoverForwardedHold(h.d, row({}, { preparedAt: NOW - 4 * MIN }), sessionOperation('holder'));
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.submit.mock.calls[0][1].record.operationId).toBe('op-1');
  });
});

describe('a marked reply keeps its line on every successor (second-pass review finding)', () => {
  it('marked on H1, refused, lease moves to H2: the new copy carries the same line and stays marked', async () => {
    const h = rdeps({ lease: lease({ leaseHolder: () => 'holder-2' }) });
    const marked = row({}, { preparedAt: NOW - MIN, firstPreparedAt: NOW - 20 * MIN, lateMarkedAt: NOW - 14 * MIN });
    expect(await recoverForwardedHold(h.d, marked, sessionOperation('holder'))).toBe('sent');
    // Rebuilt at the time it was sealed: 6 minutes old then, so "more than 6 minutes".
    expect((h.prepare.mock.calls[0][1] as { text: string }).text).toBe('Late reply, written more than 6 minutes ago and held up in delivery. It answers an earlier message:\n\nThe answer.');
    expect(h.supersede.mock.calls[0][3]).toEqual({ firstPreparedAt: NOW - 20 * MIN, lateMarkedAt: NOW - 14 * MIN });
    expect(h.onLateUnmarked).not.toHaveBeenCalled();
  });
  it('when the line cannot be carried over, the new copy is recorded unmarked and counted', async () => {
    const h = rdeps({ lease: lease({ leaseHolder: () => 'holder-2' }) });
    h.prepare.mockImplementationOnce(async () => { throw new Error('replacement-part-limit'); });
    const marked = row({}, { preparedAt: NOW - MIN, firstPreparedAt: NOW - 20 * MIN, lateMarkedAt: NOW - 14 * MIN });
    expect(await recoverForwardedHold(h.d, marked, sessionOperation('holder'))).toBe('sent');
    expect(h.supersede.mock.calls[0][3]).toEqual({ firstPreparedAt: NOW - 20 * MIN, lateMarkedAt: null });
    expect(h.supersede.mock.calls[0][2]).toMatchObject({ lateMarkUnavailable: true });
    expect(h.onLateUnmarked).toHaveBeenCalledWith('op-1');
  });
  it('the one replacement after a reasonless ending of a marked reply keeps the line too', async () => {
    const h = rdeps();
    h.receipt.mockResolvedValue({ state: 'owner-reasonless', olderOwner: true });
    const marked = row({ lastAttempt: 'outcome-unknown' }, { preparedAt: NOW - MIN, firstPreparedAt: NOW - 20 * MIN, lateMarkedAt: NOW - 14 * MIN });
    expect(await recoverForwardedHold(h.d, marked, sessionOperation('holder'))).toBe('sent');
    expect((h.prepare.mock.calls[0][1] as { text: string }).text).toMatch(/^Late reply, written more than 6 minutes ago/);
    expect(h.supersede.mock.calls[0][3]).toMatchObject({ lateMarkedAt: NOW - 14 * MIN });
  });
});

describe('handBackItem — the hub item names the owner verdict\'s cause', () => {
  it('a verdict row says what happened; any other row keeps the expiry wording and id', () => {
    const verdict = row({ ownerVerdict: { outcome: 'not-delivered', failure: 'refused', at: 1, machineId: 'holder' } });
    const item = handBackItem(verdict);
    expect(item.summary).toContain('was not delivered (Telegram refused it)');
    expect(item.summary).not.toContain('within');
    expect(handBackItem(row({ lastAttempt: 'refused' })).summary).toContain('could not deliver');
    expect(item.id).toBe(handBackItem(row({})).id);
  });
});
