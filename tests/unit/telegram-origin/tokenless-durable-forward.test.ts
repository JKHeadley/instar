/**
 * standby-durable-forward-without-token — a standby without the bot token keeps a
 * reply when the lease holder is unreachable (§1, §2, §4). How a pre-prepare relay
 * failure is worded to the caller belongs to native-conversation-base slice 3b.
 *
 * Incidents: 2026-11-11 05:04Z (topic 141469) and ~20:23Z (topic 141014). The M5
 * standby's direct relay threw `origin-peer-unreachable` before preparing anything,
 * the reply script said "do not resend", and both replies were lost.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  forwardReplyToHolder, recoverForwardedHold, supersedingOperationId, validHolderCapabilities,
  UNRESOLVED_LEASE_HOLDER, UNRESOLVED_TOKENLESS_ACCOUNT, HOLD_REASON_LEASE_NOT_HELD,
} from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardDeps, ForwardLeaseView, HolderSubmitResult, HeldForwardDetail, HolderCapabilities, HolderProbe } from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { OriginPreparedBotOperation } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import type { HeldOperationRow } from '../../../src/messaging/telegram-origin/StoreTypes.js';
import { relayOriginBot } from '../../../src/messaging/telegram-origin/OriginMeshRelay.js';
import { TelegramOriginHoldError } from '../../../src/messaging/telegram-origin/types.js';
import { ORIGIN_MESH_PROTOCOL } from '../../../src/messaging/telegram-origin/OriginMesh.js';

const LIVE: HolderCapabilities = { accountId: '8615114091', executionOwnerMachineId: 'holder' };

function op(holder: string, operationId: string, accountId: string): OriginPreparedBotOperation {
  return {
    record: { operationId, originId: `origin-${operationId}`, originMachineId: 'standby', executionOwnerMachineId: holder,
      contentDigest: 'c0ffee', destination: { accountId, chatId: '-100123', topicId: '9210' } } as never,
    admission: { operationId, preparedAt: 1, children: [{}] } as never,
  };
}
function lease(overrides: Partial<ForwardLeaseView> = {}): ForwardLeaseView {
  return { selfMachineId: 'standby', leaseHolder: () => 'holder', holdsLease: () => false, isHolderHealthy: () => true, ...overrides };
}
function clock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}
const input = { topicId: 9210, chatId: '-100123', text: 'The root cause.' };

function fdeps(probeAnswer: HolderProbe, overrides: Partial<ForwardDeps> = {}) {
  const c = clock();
  const prepare = vi.fn(async (holder: string, _i: unknown, operationId?: string, accountId?: string) =>
    op(holder, operationId ?? `op-${prepare.mock.calls.length}`, accountId ?? 'token-account'));
  const submit = vi.fn<(holder: string, o: OriginPreparedBotOperation, caps?: HolderCapabilities) => Promise<HolderSubmitResult>>(async (holder) =>
    ({ ok: true, messageId: 77, deliveryMachineId: holder, receiptJson: '{"messageId":77}' }));
  const probe = vi.fn(async () => probeAnswer);
  const hold = vi.fn(async () => true);
  const d: ForwardDeps = { lease: lease(), prepare, submit, hold, sleep: c.sleep, now: c.now, tokenless: true, probe, settleTimeoutMs: 1, ...overrides };
  return { d, prepare, submit, probe, hold };
}

describe('validHolderCapabilities — only a credential owner with a numeric account counts', () => {
  const ok = { ok: true, result: { ok: true, protocol: ORIGIN_MESH_PROTOCOL, credentialOwner: true, accountId: '8615114091', executionOwnerMachineId: 'holder' } };
  it('accepts a valid answer', () => expect(validHolderCapabilities(ok)).toEqual({ ok: true, capabilities: LIVE }));
  it('treats a holder without a token (accountId null) as unreachable', () =>
    expect(validHolderCapabilities({ ok: true, result: { ...ok.result, credentialOwner: false, accountId: null } }).ok).toBe(false));
  it('treats a non-numeric account as unreachable', () =>
    expect(validHolderCapabilities({ ok: true, result: { ...ok.result, accountId: 'abc' } }).ok).toBe(false));
});

describe('supersedingOperationId — deterministic, flat, unique per hop', () => {
  const plan = { contentDigest: 'c0ffee', accountId: '8615114091', owner: 'holder', destination: { chatId: '-100123', topicId: '9210' }, children: 1 };
  it('the same plan gives the same id (a retried supersede cannot mint two successors)', () =>
    expect(supersedingOperationId('op-1', plan)).toBe(supersedingOperationId('op-1', plan)));
  it('keeps the root and counts hops', () => {
    const first = supersedingOperationId('op-1', plan);
    expect(first).toMatch(/^op-1~r1-[0-9a-f]{8}$/);
    expect(supersedingOperationId(first, { ...plan, owner: 'holder-2' })).toMatch(/^op-1~r2-[0-9a-f]{8}$/);
  });
  it('a different holder or account gives a different id', () => {
    expect(supersedingOperationId('op-1', plan)).not.toBe(supersedingOperationId('op-1', { ...plan, owner: 'holder-2' }));
    expect(supersedingOperationId('op-1', plan)).not.toBe(supersedingOperationId('op-1', { ...plan, accountId: '1' }));
  });
});

describe('forwardReplyToHolder on a token-less machine (§1, §4)', () => {
  it('healthy pool: one read, sealed with the live account, delivered once, no placeholder', async () => {
    const h = fdeps({ ok: true, capabilities: LIVE });
    const out = await forwardReplyToHolder(h.d, input);
    expect(out.kind).toBe('sent');
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.prepare.mock.calls[0][3]).toBe(LIVE.accountId);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0][2]).toEqual(LIVE);
    expect(h.hold).not.toHaveBeenCalled();
  });
  it('holder unreachable: the reply is HELD durably with the placeholder seal and nothing is submitted (the 2026-11-11 loss)', async () => {
    const h = fdeps({ ok: false, reason: 'origin-peer-unreachable' });
    const out = await forwardReplyToHolder(h.d, input);
    expect(out.kind).toBe('held');
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.prepare.mock.calls[0][3]).toBe(UNRESOLVED_TOKENLESS_ACCOUNT);
    expect(h.hold).toHaveBeenCalledTimes(1);
    const [held, detail] = h.hold.mock.calls[0] as unknown as [OriginPreparedBotOperation, HeldForwardDetail];
    expect(held.record.destination.accountId).toBe(UNRESOLVED_TOKENLESS_ACCOUNT);
    expect(held.record.executionOwnerMachineId).toBe('holder');
    expect(detail.lastAttempt).toBe('unreachable');
    if (out.kind === 'held') expect(out.operationId).toBe(held.record.operationId);
  });
  it('a self settle never becomes a local send: held with the unresolved owner', async () => {
    const h = fdeps({ ok: true, capabilities: LIVE }, { lease: lease({ leaseHolder: () => 'standby', holdsLease: () => true }) });
    const out = await forwardReplyToHolder(h.d, input);
    expect(out.kind).toBe('held');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.prepare.mock.calls[0][0]).toBe(UNRESOLVED_LEASE_HOLDER);
    expect(h.prepare.mock.calls[0][3]).toBe(UNRESOLVED_TOKENLESS_ACCOUNT);
  });
  it('a machine WITH a token is unchanged: no probe, local on self', async () => {
    const h = fdeps({ ok: true, capabilities: LIVE }, { tokenless: false, lease: lease({ leaseHolder: () => 'standby', holdsLease: () => true }) });
    expect(await forwardReplyToHolder(h.d, input)).toEqual({ kind: 'local' });
    expect(h.probe).not.toHaveBeenCalled();
  });
});

describe('recoverForwardedHold on a token-less machine (§2, §4)', () => {
  const row = (owner: string, accountId: string, detail: Partial<HeldForwardDetail> = {}): HeldOperationRow => ({
    operationId: 'op-1', originId: 'o', state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
    holdDetail: { kind: 'forward-to-holder', lastAttempt: 'unreachable', machineId: owner, topicId: 9210, chatId: '-100123', text: 'The root cause.',
      reason: 'origin-peer-unreachable', at: 1, noticeDelivered: false, ladder: { attempts: 0, nextAt: 5 }, ...detail },
    preparedAt: 1, deadlineAt: 2, executionOwnerMachineId: owner, destination: { accountId, chatId: '-100123', topicId: '9210' }, recovery: null, expiryReportedAt: null,
  } as HeldOperationRow);
  function rdeps(probeAnswer: HolderProbe, overrides: Partial<Parameters<typeof recoverForwardedHold>[0]> = {}) {
    const prepare = vi.fn(async (holder: string, _i: unknown, operationId?: string, accountId?: string) => op(holder, operationId ?? 'op-new', accountId ?? 'token-account'));
    const submit = vi.fn<(holder: string, o: OriginPreparedBotOperation, caps?: HolderCapabilities) => Promise<HolderSubmitResult>>(async (holder) =>
      ({ ok: true, messageId: 9, deliveryMachineId: holder, receiptJson: '{"messageId":9}' }));
    const probe = vi.fn(async () => probeAnswer);
    const rehold = vi.fn(async () => true);
    const supersede = vi.fn(async (_o: string, _n: OriginPreparedBotOperation, _d: HeldForwardDetail) => true);
    const resolve = vi.fn(async () => true);
    const sendLocal = vi.fn(async () => ({ messageId: 3 }));
    const onAccountChanged = vi.fn();
    const d = { lease: lease(), prepare, submit, probe, rehold, supersede, resolve, sendLocal, onAccountChanged, tokenless: true,
      receipt: vi.fn(async () => ({ state: 'unreachable' as const })), settleUnknown: vi.fn(async () => true), now: () => 5, ...overrides };
    return { d, prepare, submit, probe, rehold, supersede, resolve, sendLocal, onAccountChanged };
  }

  it('placeholder seal + holder back: one supersede to the LIVE account under a derived id, delivered once in the same pass', async () => {
    const h = rdeps({ ok: true, capabilities: LIVE });
    expect(await recoverForwardedHold(h.d, row(UNRESOLVED_LEASE_HOLDER, UNRESOLVED_TOKENLESS_ACCOUNT), op(UNRESOLVED_LEASE_HOLDER, 'op-1', UNRESOLVED_TOKENLESS_ACCOUNT))).toBe('sent');
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    const [holder, , id, account] = h.prepare.mock.calls[0];
    expect(holder).toBe('holder');
    expect(account).toBe(LIVE.accountId);
    expect(id).toMatch(/^op-1~r1-[0-9a-f]{8}$/);
    expect(h.supersede).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0][1].record.destination.accountId).toBe(LIVE.accountId);
    expect(h.submit.mock.calls[0][2]).toEqual(LIVE);
  });
  it('placeholder seal on the SAME owner still re-seals (never submits a placeholder)', async () => {
    const h = rdeps({ ok: true, capabilities: LIVE });
    expect(await recoverForwardedHold(h.d, row('holder', UNRESOLVED_TOKENLESS_ACCOUNT), op('holder', 'op-1', UNRESOLVED_TOKENLESS_ACCOUNT))).toBe('sent');
    expect(h.submit.mock.calls.every(call => call[1].record.destination.accountId !== UNRESOLVED_TOKENLESS_ACCOUNT)).toBe(true);
  });
  it('holder still unreachable: retained, nothing prepared or submitted', async () => {
    const h = rdeps({ ok: false, reason: 'origin-peer-unreachable' });
    expect(await recoverForwardedHold(h.d, row('holder', UNRESOLVED_TOKENLESS_ACCOUNT), op('holder', 'op-1', UNRESOLVED_TOKENLESS_ACCOUNT))).toBe('retained');
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
    // No attempt reached the holder: the ladder is kept as it was (§2), never advanced.
    const kept = (h.rehold.mock.calls.at(-1) as unknown as [string, HeldForwardDetail])[1];
    expect(kept.ladder).toEqual({ attempts: 0, nextAt: 5 });
    expect(kept.lastAttempt).toBe('unreachable');
  });
  it('a concrete seal for another bot is never re-sealed or sent: retained and reported', async () => {
    const h = rdeps({ ok: true, capabilities: { ...LIVE, accountId: '999' } });
    expect(await recoverForwardedHold(h.d, row('holder', '8615114091'), op('holder', 'op-1', '8615114091'))).toBe('retained');
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
    expect(h.onAccountChanged).toHaveBeenCalledWith(expect.objectContaining({ sealedAccountId: '8615114091', liveAccountId: '999' }));
  });
  it('a holder change keeps the concrete seal (never launders it into the placeholder)', async () => {
    const h = rdeps({ ok: true, capabilities: { ...LIVE, executionOwnerMachineId: 'holder-2' } }, { lease: lease({ leaseHolder: () => 'holder-2' }) });
    expect(await recoverForwardedHold(h.d, row('holder', LIVE.accountId), op('holder', 'op-1', LIVE.accountId))).toBe('sent');
    expect(h.prepare.mock.calls[0][3]).toBe(LIVE.accountId);
    expect(h.prepare.mock.calls[0][0]).toBe('holder-2');
  });
  it('lease on this token-less machine: retained WITHOUT the local-sent marker, no local send', async () => {
    const h = rdeps({ ok: true, capabilities: LIVE }, { lease: lease({ leaseHolder: () => 'standby', holdsLease: () => true }) });
    expect(await recoverForwardedHold(h.d, row('holder', LIVE.accountId), op('holder', 'op-1', LIVE.accountId))).toBe('retained');
    expect(h.sendLocal).not.toHaveBeenCalled();
    for (const call of h.rehold.mock.calls) expect((call as unknown as [string, HeldForwardDetail])[1].lastAttempt).not.toBe('local-sent');
  });
  it('lease flap holder → self → holder: delivered once afterwards', async () => {
    let selfHolds = true;
    const view = lease({ leaseHolder: () => (selfHolds ? 'standby' : 'holder'), holdsLease: () => selfHolds });
    const h = rdeps({ ok: true, capabilities: LIVE }, { lease: view });
    const r = row('holder', LIVE.accountId);
    expect(await recoverForwardedHold(h.d, r, op('holder', 'op-1', LIVE.accountId))).toBe('retained');
    selfHolds = false;
    const after = { ...r, holdDetail: (h.rehold.mock.calls.at(-1) as unknown as [string, HeldForwardDetail])[1] } as HeldOperationRow;
    expect(await recoverForwardedHold(h.d, after, op('holder', 'op-1', LIVE.accountId))).toBe('sent');
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.sendLocal).not.toHaveBeenCalled();
  });
});

describe('relayNothingPrepared — a relay failure before any operation existed (reporting only)', () => {
  const runtime = { service: {} } as never;
  it.each([
    ['unreachable holder', async () => { throw new Error('ECONNREFUSED'); }, 'origin-peer-unreachable'],
    ['holder without the credential', async () => ({ ok: true, result: { ok: true, protocol: ORIGIN_MESH_PROTOCOL, credentialOwner: false } }), 'origin-peer-protocol-unavailable'],
  ] as const)('%s', async (_label, send, reason) => {
    const err = await relayOriginBot({ runtime, topicId: 9210, chatId: '-100123', text: 'x', send: send as never }).catch(e => e);
    expect(err).toBeInstanceOf(TelegramOriginHoldError);
    expect(err.reason).toBe(reason);
    expect(err.operationId).toBeNull();
    const { relayNothingPrepared } = await import('../../../src/messaging/telegram-origin/types.js');
    expect(relayNothingPrepared(err)).toBe(true);
  });
  it('a hold with an operation id is not a pre-prepare failure', async () => {
    const { relayNothingPrepared } = await import('../../../src/messaging/telegram-origin/types.js');
    expect(relayNothingPrepared(new TelegramOriginHoldError('origin-peer-unreachable', 'op-1'))).toBe(false);
    expect(relayNothingPrepared(new TelegramOriginHoldError('duplicate-content'))).toBe(false);
  });
});

describe('followSupersedeChain — recovery finds the delivered copy at the end of its chain (§2)', () => {
  const audit = (next?: string) => ({ operation: { holdDetail: next ? { supersededBy: next } : {} } }) as never;
  it('walks two hops to the terminal row', async () => {
    const rows: Record<string, unknown> = { a: audit('a~r1-00000000'), 'a~r1-00000000': audit('a~r2-11111111'), 'a~r2-11111111': audit() };
    const { followSupersedeChain } = await import('../../../src/messaging/telegram-origin/OriginForwardToHolder.js');
    const end = await followSupersedeChain('a', async id => (rows[id] ?? null) as never);
    expect(end).toMatchObject({ kind: 'terminal', operationId: 'a~r2-11111111' });
  });
  it('a pruned successor is missing, never the last row seen', async () => {
    const { followSupersedeChain } = await import('../../../src/messaging/telegram-origin/OriginForwardToHolder.js');
    const end = await followSupersedeChain('a', async id => (id === 'a' ? audit('gone') : null) as never);
    expect(end).toEqual({ kind: 'missing', operationId: 'gone' });
  });
  it('a cycle stops the walk', async () => {
    const rows: Record<string, unknown> = { a: audit('b'), b: audit('a') };
    const { followSupersedeChain } = await import('../../../src/messaging/telegram-origin/OriginForwardToHolder.js');
    expect((await followSupersedeChain('a', async id => (rows[id] ?? null) as never)).kind).toBe('cycle');
  });
});

describe('notice-class sends are never held; the holder answering again triggers the re-post (§8)', () => {
  it('only the explicit notice producers count', async () => {
    const { isNoticeClass } = await import('../../../src/messaging/telegram-origin/OriginForwardToHolder.js');
    expect(isNoticeClass({ noticeClass: 'attention-hub-post' })).toBe(true);
    expect(isNoticeClass({ noticeClass: 'reply-delivery-notice' })).toBe(true);
    expect(isNoticeClass({ messageKind: 'health-alert' })).toBe(false);
    expect(isNoticeClass(undefined)).toBe(false);
  });
  it('a successful probe fires onHolderReachable, an unreachable one does not', async () => {
    const reach = vi.fn();
    const ok = fdeps({ ok: true, capabilities: LIVE }, { onHolderReachable: reach });
    await forwardReplyToHolder(ok.d, input);
    expect(reach).toHaveBeenCalledTimes(1);
    const down = vi.fn();
    const bad = fdeps({ ok: false, reason: 'origin-peer-unreachable' }, { onHolderReachable: down });
    await forwardReplyToHolder(bad.d, input);
    expect(down).not.toHaveBeenCalled();
  });
});
