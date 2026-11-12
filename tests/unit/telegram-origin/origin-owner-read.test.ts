/**
 * native-conversation-base §3b — the outcome route asks the execution owner.
 * Unit tier: the receipt-answer parser (closed sets; an older owner's raw
 * `suppressed` is never read as an ending), the bounded reader (coalescing,
 * terminal-verdict cache, timeout memo, per-ask budget inside the route
 * deadline) and the route orchestration over a fake store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireDigest } from '../../../src/messaging/telegram-origin/CanonicalOrigin.js';
import {
  authorHolding, authorStatement, OriginOwnerReader, parseReceiptAnswer, readOperationOutcome, OWNER_READ_ROUTE_DEADLINE_MS,
} from '../../../src/messaging/telegram-origin/OriginOwnerRead.js';
import { classifyOperationOutcome } from '../../../src/messaging/telegram-origin/OriginOperationOutcome.js';
import type { OriginAuditRecord } from '../../../src/messaging/telegram-origin/StoreTypes.js';
import type { OriginMeshCommand } from '../../../src/messaging/telegram-origin/OriginMesh.js';

afterEach(() => vi.useRealTimers());

const OP = 'op-aaaaaaaa';
function audit(input: { id?: string; owner: string; author: string; state: string | null; holdReason?: string; holdDetail?: Record<string, unknown> | null;
  attempts?: OriginAuditRecord['attempts']; childState?: string }): OriginAuditRecord {
  const id = input.id ?? OP;
  const envelopeJson = JSON.stringify({ originId: `origin-${id}`, operationId: id, agentId: 'echo', originMachineId: input.author, executionOwnerMachineId: input.owner });
  return { sequence: 1, record: { originId: `origin-${id}`, machineId: input.author, createdAt: 1, envelopeJson, envelopeDigest: wireDigest(envelopeJson) } as never,
    operation: input.state === null ? null : { operationId: id, preparedAt: 1, deadlineAt: 2, maxAttempts: 3, state: input.state,
      ...(input.holdReason !== undefined || input.holdDetail !== undefined ? { holdReason: input.holdReason, holdDetail: input.holdDetail ?? null } : {}) },
    children: input.state === null ? [] : [{ childId: 'c-1', deliveryId: 'd-1', destinationJson: '{}', generation: 0, state: input.childState ?? 'queued', attempts: 0 }],
    attempts: input.attempts ?? [] };
}
const digestOf = (id: string) => audit({ id, owner: 'owner', author: 'author', state: null }).record.envelopeDigest;
const ownerReply = (extra: Record<string, unknown>) => ({ ok: true, result: { ok: true, operationId: OP, originId: `origin-${OP}`, envelopeDigest: digestOf(typeof extra.operationId === 'string' ? extra.operationId : OP), role: 'execution-owner', state: 'known-failed',
  originReceiptConfirmed: false, messageIds: [], outcome: 'not-delivered', safeToResend: true, reason: null, failure: 'refused', supersededBy: null, duplicateOfMessageId: null,
  originMachineId: 'author', ...extra } });
const authorReply = (holding: boolean | null, extra: Record<string, unknown> = {}) => ({ ok: true, result: { ok: true, operationId: OP, originId: `origin-${OP}`,
  envelopeDigest: digestOf(typeof extra.operationId === 'string' ? extra.operationId : OP), role: 'author', holding, supersededBy: null, ...extra } });

function reader(send: (machineId: string, command: OriginMeshCommand, timeoutMs: number) => Promise<{ ok: boolean; result?: unknown }>, opts: { enabled?: boolean; holder?: string | null; self?: string; budgetMs?: number } = {}) {
  return new OriginOwnerReader({ selfMachineId: opts.self ?? 'third', transport: { send }, leaseHolder: () => opts.holder ?? 'owner',
    enabled: () => opts.enabled ?? true, budgetMs: () => opts.budgetMs ?? 2000, cacheEntries: () => 1024 });
}
function deps(self: string, rows: Record<string, OriginAuditRecord | null>, r: OriginOwnerReader | null) {
  return { selfMachineId: self, getOperation: async (id: string) => rows[id] ?? null, unrecorded: () => [], reader: r };
}

describe('parseReceiptAnswer', () => {
  it('an older holder answering a raw suppressed state with no outcome is old-version, never an ending', () => {
    expect(parseReceiptAnswer('owner', OP, { ok: true, result: { ok: true, operationId: OP, state: 'suppressed', originReceiptConfirmed: false, messageIds: [] } }))
      .toEqual({ kind: 'missing', machineId: 'owner', why: 'old-version' });
  });
  it('no-record and not-admitted are definite answers from any version', () => {
    expect(parseReceiptAnswer('owner', OP, { ok: true, result: { ok: true, operationId: OP, state: 'no-record', executionOwnerMachineId: 'liar' } })).toEqual({ kind: 'no-record', machineId: 'owner' });
    expect(parseReceiptAnswer('owner', OP, { ok: true, result: { ok: true, operationId: OP, state: 'not-admitted' } })).toEqual({ kind: 'not-admitted', machineId: 'owner' });
  });
  it('values outside the closed sets make an answer with no outcome; an unknown reason is dropped', () => {
    expect(parseReceiptAnswer('owner', OP, ownerReply({ outcome: 'probably-fine' }))).toMatchObject({ kind: 'missing', why: 'old-version' });
    expect(parseReceiptAnswer('owner', OP, ownerReply({ failure: 'cosmic-rays' }))).toMatchObject({ kind: 'missing', why: 'old-version' });
    expect(parseReceiptAnswer('owner', OP, ownerReply({ reason: 'made-up' }))).toMatchObject({ kind: 'owner', reason: null, failure: 'refused' });
  });
  it('a mismatched operation, origin or digest is refused; the body cannot name the answerer', () => {
    expect(parseReceiptAnswer('owner', OP, ownerReply({ operationId: 'op-other' }))).toMatchObject({ kind: 'missing', why: 'refused' });
    expect(parseReceiptAnswer('owner', OP, ownerReply({ originId: 'forged' }), { originId: `origin-${OP}`, envelopeDigest: 'x' })).toMatchObject({ kind: 'missing', why: 'refused' });
    const parsed = parseReceiptAnswer('owner', OP, ownerReply({ executionOwnerMachineId: 'someone-else', answeredBy: 'someone-else' }));
    expect(parsed).toMatchObject({ kind: 'owner', machineId: 'owner' });
  });
  it('safeToResend is only ever true on a not-delivered verdict', () => {
    expect(parseReceiptAnswer('owner', OP, ownerReply({ outcome: 'pending', safeToResend: true, failure: null }))).toMatchObject({ kind: 'owner', safeToResend: false });
  });
});

describe('OriginOwnerReader', () => {
  it('coalesces concurrent asks for one id into one mesh call', async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<{ ok: boolean; result?: unknown }>(resolve => { release = () => resolve(ownerReply({ outcome: 'pending', safeToResend: false, failure: null })); }));
    const r = reader(send);
    const deadline = Date.now() + 4000;
    const all = Promise.all([r.ask('owner', OP, deadline), r.ask('owner', OP, deadline), r.ask('owner', OP, deadline)]);
    await Promise.resolve(); release();
    const answers = await all;
    expect(send).toHaveBeenCalledOnce();
    expect(answers.every(a => a.kind === 'owner')).toBe(true);
    expect(r.stats()).toMatchObject({ asks: 1, coalesced: 2 });
  });
  it('keeps a terminal owner verdict and asks again for a non-terminal one', async () => {
    const send = vi.fn(async () => ownerReply({}));
    const r = reader(send);
    await r.ask('owner', OP, Date.now() + 4000); await r.ask('owner', OP, Date.now() + 4000);
    expect(send).toHaveBeenCalledOnce();
    const pending = vi.fn(async () => ownerReply({ outcome: 'pending', safeToResend: false, failure: null }));
    const r2 = reader(pending);
    await r2.ask('owner', OP, Date.now() + 4000); await r2.ask('owner', OP, Date.now() + 4000);
    expect(pending).toHaveBeenCalledTimes(2);
  });
  it('a machine that just timed out is answered timeout at once for the next 2 s; each ask gets min(budget, time left)', async () => {
    vi.useFakeTimers();
    const send = vi.fn((_m: string, _c: OriginMeshCommand, _t: number) => new Promise<{ ok: boolean }>(() => undefined));
    const r = reader(send);
    const first = r.ask('owner', OP, Date.now() + 1500);
    expect(send.mock.calls[0][2]).toBe(1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await first).toEqual({ kind: 'missing', machineId: 'owner', why: 'timeout' });
    expect(await r.ask('owner', 'op-bbbbbbbb', Date.now() + 4000)).toEqual({ kind: 'missing', machineId: 'owner', why: 'timeout' });
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2001);
    void r.ask('owner', 'op-cccccccc', Date.now() + 4000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2]).toBe(2000);
  });
  it('sends reader: true on the existing receipt verb', async () => {
    const send = vi.fn(async () => ownerReply({}));
    await reader(send).ask('owner', OP, Date.now() + 4000);
    expect(send.mock.calls[0][1]).toEqual({ type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId: OP, reader: true });
  });
});

describe('authorHolding', () => {
  it('admitted, or held with no ownerVerdict, is holding; a held row with ownerVerdict is not', () => {
    expect(authorHolding(audit({ owner: 'owner', author: 'author', state: 'admitted' }))).toBe(true);
    expect(authorHolding(audit({ owner: 'owner', author: 'author', state: 'held', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'refused' } }))).toBe(true);
    expect(authorHolding(audit({ owner: 'owner', author: 'author', state: 'held', holdReason: 'lease-not-held', holdDetail: { ownerVerdict: { outcome: 'not-delivered', failure: 'refused', at: 1 } } }))).toBe(false);
    expect(authorHolding(audit({ owner: 'owner', author: 'author', state: 'expired' }))).toBe(false);
  });
  it('authorStatement: delivered itself is delivered; an unresolved forward or an unnamed replacement is null (cannot tell)', () => {
    const accepted = audit({ owner: 'owner', author: 'author', state: 'accepted', childState: 'accepted', attempts: [{ attemptId: 'a', childId: 'c-1', materializationId: 'm', ownerBootId: 'forwarded:author',
      deliveryMachineId: 'author', phase: 'dispatched', outcome: 'accepted', receiptJson: '{"messageId":"812"}', createdAt: 1, resolvedAt: 1 }] });
    expect(authorStatement(accepted, null).holding).toBe(null);
    expect(authorStatement(accepted, classifyOperationOutcome(OP, accepted, []))).toEqual({ holding: false, delivered: { messageIds: ['812'] }, supersededBy: null });
    expect(authorStatement(audit({ owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'outcome-unknown', machineId: 'elsewhere' } }), null).holding).toBe(null);
    // A lost forward to the envelope's own owner is settled by that owner's verdict, which every asker reads.
    expect(authorStatement(audit({ owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'outcome-unknown', machineId: 'owner' } }), null).holding).toBe(false);
    expect(authorStatement(audit({ owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'local-sent' } }), null).holding).toBe(null);
    expect(authorStatement(audit({ owner: 'owner', author: 'author', state: 'superseded', holdDetail: {} }), null).holding).toBe(null);
    expect(authorStatement(audit({ owner: 'owner', author: 'author', state: 'suppressed', holdReason: 'quiet-notification-recorded', holdDetail: { quietId: 'q' } }), null).holding).toBe(null);
  });
});

describe('readOperationOutcome', () => {
  it('a one-machine agent makes no ask', async () => {
    const send = vi.fn();
    const out = await readOperationOutcome(deps('solo', { [OP]: audit({ owner: 'solo', author: 'solo', state: 'known-failed' }) }, reader(send, { self: 'solo' })), OP);
    expect(send).not.toHaveBeenCalled();
    expect(out.body).toMatchObject({ outcome: 'not-delivered', safeToResend: true, answeredBy: 'solo' });
  });
  it('a held, not-yet-forwarded reply on its author is pending with no mesh call', async () => {
    const send = vi.fn();
    const out = await readOperationOutcome(deps('author', { [OP]: audit({ owner: 'owner', author: 'author', state: 'held', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'unsettled' } }) }, reader(send, { self: 'author' })), OP);
    expect(send).not.toHaveBeenCalled();
    expect(out.body).toMatchObject({ outcome: 'pending', safeToResend: false });
  });
  it('the owner\'s failure with the author ending its row: not-delivered from the owner', async () => {
    const send = vi.fn(async () => ownerReply({}));
    const out = await readOperationOutcome(deps('author', { [OP]: audit({ owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'refused' } }) }, reader(send, { self: 'author' })), OP);
    expect(out.body).toMatchObject({ outcome: 'not-delivered', safeToResend: true, source: 'execution-owner', answeredBy: 'owner', failure: 'refused', resolution: 6 });
  });
  it('queried on the owner while the author on another machine still holds the failed forward: pending; author silent: unknown', async () => {
    const ownerRow = audit({ owner: 'owner', author: 'author', state: 'known-failed', attempts: [{ attemptId: 'a', childId: 'c-1', materializationId: 'm', ownerBootId: 'b',
      deliveryMachineId: 'owner', phase: 'resolved', outcome: 'known-failed', receiptJson: null, createdAt: 1, resolvedAt: 2, reason: 'telegram-400' }] });
    const holding = vi.fn(async () => authorReply(true));
    expect((await readOperationOutcome(deps('owner', { [OP]: ownerRow }, reader(holding, { self: 'owner' })), OP)).body).toMatchObject({ outcome: 'pending', resolution: 7 });
    expect(holding).toHaveBeenCalledWith('author', expect.anything(), expect.any(Number));
    const silent = vi.fn(async () => ({ ok: false }));
    const out = (await readOperationOutcome(deps('owner', { [OP]: ownerRow }, reader(silent, { self: 'owner' })), OP)).body;
    expect(out).toMatchObject({ outcome: 'unknown', why: 'author-unanswered', safeToResend: false });
  });
  it('switched off: no ask, and a stale local not-delivered is unknown with owner-read-off', async () => {
    const send = vi.fn();
    const row = audit({ owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'outcome-unknown' } });
    const out = (await readOperationOutcome(deps('author', { [OP]: row }, reader(send, { self: 'author', enabled: false })), OP)).body;
    expect(send).not.toHaveBeenCalled();
    expect(out).toMatchObject({ outcome: 'unknown', safeToResend: false, ownerAnswered: false, why: 'owner-read-off' });
  });
  it('suppressed with no outcome from an older owner: unknown, nothing safe to resend', async () => {
    const send = vi.fn(async () => ({ ok: true, result: { ok: true, operationId: OP, originId: `origin-${OP}`, envelopeDigest: digestOf(OP), state: 'suppressed', originReceiptConfirmed: false, messageIds: [] } }));
    const row = audit({ owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'refused' } });
    const out = (await readOperationOutcome(deps('author', { [OP]: row }, reader(send, { self: 'author' })), OP)).body;
    expect(out).toMatchObject({ outcome: 'unknown', safeToResend: false, why: 'old-version', ownerAnswered: false });
  });
  it('a new owner whose suppression has no reason answers unknown (owner-unresolved)', async () => {
    const send = vi.fn(async () => ownerReply({ state: 'suppressed', outcome: 'unknown', safeToResend: false, failure: null }));
    const row = audit({ owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'refused' } });
    expect((await readOperationOutcome(deps('author', { [OP]: row }, reader(send, { self: 'author' })), OP)).body).toMatchObject({ outcome: 'unknown', why: 'owner-unresolved', safeToResend: false });
  });
  it('no local row: asks the lease holder once, and finds the author through originMachineId', async () => {
    const send = vi.fn(async (machineId: string) => machineId === 'owner' ? ownerReply({}) : authorReply(true));
    const out = await readOperationOutcome(deps('third', {}, reader(send)), OP);
    expect(send.mock.calls.map(call => call[0])).toEqual(['owner', 'author']);
    expect(out).toMatchObject({ status: 200, body: { outcome: 'pending', resolution: 7, executionOwnerMachineId: 'owner' } });
  });
  it('no local row and the holder answers as author or no-record: not found, unknown', async () => {
    const send = vi.fn(async () => ({ ok: true, result: { ok: true, operationId: OP, state: 'no-record' } }));
    expect(await readOperationOutcome(deps('third', {}, reader(send)), OP)).toMatchObject({ status: 404, body: { outcome: 'unknown', safeToResend: false } });
  });
  it('a superseded local row is answered by its successor; an author-reported supersession never yields safeToResend; a loop is unknown', async () => {
    const send = vi.fn(async () => ownerReply({ operationId: 'op-bbbbbbbb', originId: 'origin-op-bbbbbbbb' }));
    const rows = { [OP]: audit({ owner: 'owner', author: 'author', state: 'superseded', holdDetail: { supersededBy: 'op-bbbbbbbb' } }),
      'op-bbbbbbbb': audit({ id: 'op-bbbbbbbb', owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'refused' } }) };
    expect((await readOperationOutcome(deps('author', rows, reader(send, { self: 'author' })), OP)).body)
      .toMatchObject({ operationId: OP, answeredFor: 'op-bbbbbbbb', supersededBy: 'op-bbbbbbbb', outcome: 'not-delivered' });
    // Third machine, evidence only for OP; the author says it was superseded.
    const viaAuthor = vi.fn(async (machineId: string, command: OriginMeshCommand) => {
      const id = (command as { operationId: string }).operationId;
      if (machineId === 'author') return id === OP ? authorReply(false, { supersededBy: 'op-bbbbbbbb' }) : authorReply(false, { operationId: id, originId: `origin-${id}` });
      return ownerReply({ operationId: id, originId: `origin-${id}` });
    });
    const third = { [OP]: audit({ owner: 'owner', author: 'author', state: null }), 'op-bbbbbbbb': audit({ id: 'op-bbbbbbbb', owner: 'owner', author: 'author', state: null }) };
    const followed = (await readOperationOutcome(deps('third', third, reader(viaAuthor)), OP)).body;
    expect(followed).toMatchObject({ outcome: 'not-delivered', safeToResend: false, supersededBy: 'op-bbbbbbbb' });
    const loop = { [OP]: audit({ owner: 'owner', author: 'author', state: 'superseded', holdDetail: { supersededBy: 'op-bbbbbbbb' } }),
      'op-bbbbbbbb': audit({ id: 'op-bbbbbbbb', owner: 'owner', author: 'author', state: 'superseded', holdDetail: { supersededBy: OP } }) };
    expect((await readOperationOutcome(deps('author', loop, reader(vi.fn(), { self: 'author' })), OP)).body).toMatchObject({ outcome: 'unknown', safeToResend: false });
  });
  it('an author that delivered the reply itself after the owner failed: delivered on a third machine, never safe to resend', async () => {
    const send = vi.fn(async (machineId: string) => machineId === 'owner' ? ownerReply({}) : authorReply(false, { delivered: true, messageIds: ['812'] }));
    const out = (await readOperationOutcome(deps('third', {}, reader(send)), OP)).body;
    expect(out).toMatchObject({ outcome: 'delivered', safeToResend: false, messageIds: ['812'], answeredBy: 'author', resolution: 1 });
  });
  it('an author that cannot tell (holding null) is no statement: owner failure reads unknown, author-unanswered', async () => {
    const send = vi.fn(async (machineId: string) => machineId === 'owner' ? ownerReply({}) : authorReply(null));
    expect((await readOperationOutcome(deps('third', {}, reader(send)), OP)).body).toMatchObject({ outcome: 'unknown', safeToResend: false, why: 'author-unanswered' });
  });
  it('on the owner with an unreadable author id, the local failure is not passed through as safe to resend', async () => {
    const row = audit({ owner: 'owner', author: 'bad id with spaces', state: 'known-failed' });
    const out = (await readOperationOutcome(deps('owner', { [OP]: row }, reader(vi.fn(), { self: 'owner' })), OP)).body;
    expect(out).toMatchObject({ safeToResend: false });
    expect(out.outcome).not.toBe('delivered');
  });
  it('an answer that does not name the expected envelope is refused, and a holder answer cached without it is not reused for it', async () => {
    expect(parseReceiptAnswer('owner', OP, ownerReply({ envelopeDigest: undefined }), { originId: `origin-${OP}`, envelopeDigest: digestOf(OP) })).toMatchObject({ kind: 'missing', why: 'refused' });
    const send = vi.fn(async () => ownerReply({}));
    const r = reader(send);
    await r.ask('owner', OP, Date.now() + 4000);
    await r.ask('owner', OP, Date.now() + 4000, { originId: `origin-${OP}`, envelopeDigest: digestOf(OP) });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('answers inside the route deadline even when every machine hangs', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<{ ok: boolean }>(() => undefined));
    const row = audit({ owner: 'owner', author: 'author', state: 'expired', holdReason: 'lease-not-held', holdDetail: { lastAttempt: 'refused' } });
    const started = Date.now();
    const pending = readOperationOutcome(deps('third', { [OP]: row }, reader(send, { budgetMs: 4000 })), OP);
    await vi.advanceTimersByTimeAsync(OWNER_READ_ROUTE_DEADLINE_MS);
    const out = await pending;
    expect(Date.now() - started).toBeLessThanOrEqual(OWNER_READ_ROUTE_DEADLINE_MS);
    expect(out.body).toMatchObject({ outcome: 'unknown', safeToResend: false, why: 'timeout' });
  });
});
