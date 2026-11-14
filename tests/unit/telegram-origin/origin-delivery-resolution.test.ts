import { afterEach, describe, expect, it, vi } from 'vitest';
import { originAuditDeliveryConfirmed, originDeliveryConfirmed } from '../../../src/messaging/telegram-origin/OriginDeliveryResolution.js';
import type { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import type { OriginAuditRecord } from '../../../src/messaging/telegram-origin/StoreTypes.js';
import { wireDigest } from '../../../src/messaging/telegram-origin/CanonicalOrigin.js';

afterEach(() => vi.useRealTimers());
function evidence() {
  const envelopeJson = JSON.stringify({ originId: 'origin-1', operationId: 'operation-1', agentId: 'echo', originMachineId: 'source', executionOwnerMachineId: 'owner' });
  return { sequence: 1, record: { originId: 'origin-1', machineId: 'source', createdAt: 1, envelopeJson, envelopeDigest: wireDigest(envelopeJson) },
    operation: null, children: [], attempts: [] } satisfies OriginAuditRecord;
}
describe('origin delivery resolution', () => {
  it('bounds a stuck local read and never starts a late remote query after the deadline', async () => {
    vi.useFakeTimers(); let resolveRead!: (row: OriginAuditRecord) => void;
    const store = { getOperation: vi.fn(() => new Promise<OriginAuditRecord>(resolve => { resolveRead = resolve; })) } as unknown as OriginStore;
    const send = vi.fn();
    const pending = originDeliveryConfirmed(store, 'operation-1', { selfMachineId: 'source', agentId: 'echo', send });
    await vi.advanceTimersByTimeAsync(2000); expect(await pending).toBe(false);
    resolveRead(evidence()); await vi.advanceTimersByTimeAsync(1); expect(send).not.toHaveBeenCalled();
  });
  it('bounds a stuck remote read and does not retry it', async () => {
    vi.useFakeTimers();
    const store = { getOperation: vi.fn(async () => evidence()) } as unknown as OriginStore;
    const send = vi.fn(() => new Promise<{ ok: boolean }>(() => undefined));
    const pending = originDeliveryConfirmed(store, 'operation-1', { selfMachineId: 'source', agentId: 'echo', send });
    await vi.advanceTimersByTimeAsync(2000); expect(await pending).toBe(false); expect(send).toHaveBeenCalledOnce();
  });
  it('never queries peer evidence belonging to a different source principal', async () => {
    const store = { getOperation: vi.fn(async () => evidence()) } as unknown as OriginStore;
    const send = vi.fn();
    expect(await originDeliveryConfirmed(store, 'operation-1', { selfMachineId: 'other', agentId: 'echo', send })).toBe(false);
    expect(await originDeliveryConfirmed(store, 'operation-1', { selfMachineId: 'source', agentId: 'other-agent', send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('requires every accepted child to have a committed receipt', () => {
    const audit = evidence() as OriginAuditRecord;
    audit.operation = { operationId: 'operation-1', state: 'accepted', preparedAt: 1, deadlineAt: 2, maxAttempts: 2 };
    audit.children = [{ childId: 'child-1', deliveryId: 'delivery-1', destinationJson: '{}', generation: 0, state: 'accepted', attempts: 1 }];
    expect(originAuditDeliveryConfirmed(audit)).toBe(false);
    audit.attempts = [{ attemptId: 'attempt-1', childId: 'child-1', materializationId: 'materialization-1', ownerBootId: 'boot-1',
      deliveryMachineId: 'owner', phase: 'resolved', outcome: 'accepted', receiptJson: '{"messageId":"1508"}', createdAt: 1, resolvedAt: 2 }];
    expect(originAuditDeliveryConfirmed(audit)).toBe(true);
    audit.children.push({ ...audit.children[0], childId: 'child-2', deliveryId: 'delivery-2' });
    expect(originAuditDeliveryConfirmed(audit)).toBe(false);
  });
});

// ── native-conversation-base §3b: the receipt handler's `reader` branch ──────
import { handleOriginMesh } from '../../../src/messaging/telegram-origin/OriginMesh.js';
import type { OriginMeshCommand } from '../../../src/messaging/telegram-origin/OriginMesh.js';

function rowFor(self: { author: string; owner: string }, state: string, holdDetail: Record<string, unknown> | null = null): OriginAuditRecord {
  const envelopeJson = JSON.stringify({ originId: 'origin-1', operationId: 'operation-1', agentId: 'echo', originMachineId: self.author, executionOwnerMachineId: self.owner });
  return { sequence: 1, record: { originId: 'origin-1', machineId: self.author, createdAt: 1, envelopeJson, envelopeDigest: wireDigest(envelopeJson) } as never,
    operation: { operationId: 'operation-1', state, preparedAt: 1, deadlineAt: 2, maxAttempts: 2, ...(holdDetail ? { holdReason: 'lease-not-held', holdDetail } : {}) },
    children: [{ childId: 'child-1', deliveryId: 'delivery-1', destinationJson: '{}', generation: 0, state: state === 'known-failed' ? 'known-failed' : 'queued', attempts: 1 }],
    attempts: state === 'known-failed' ? [{ attemptId: 'a-1', childId: 'child-1', materializationId: 'm', ownerBootId: 'b', deliveryMachineId: 'owner', phase: 'resolved',
      outcome: 'known-failed', receiptJson: null, createdAt: 1, resolvedAt: 2, reason: 'telegram-400' }] : [] };
}
function meshRuntime(machineId: string, row: OriginAuditRecord | null) {
  return { options: { identity: { agentId: 'echo', originMachineId: machineId }, bot: {} }, store: { getOperation: async () => row }, unrecordedReceipts: { forOperation: () => [] } } as never;
}
const key = (machineId: string, extra: Record<string, unknown> = {}) => ({ machineId, agentId: 'echo', keyId: `${machineId}:1`, keyEpoch: 1, publicKey: 'pk',
  validFrom: 0, validUntil: null, revokedAt: null, ...extra });
const receipt = (reader?: boolean): OriginMeshCommand => ({ type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId: 'operation-1', ...(reader === undefined ? {} : { reader }) });

describe('receipt reader branch', () => {
  it('a third machine with reader gets the owner\'s classified verdict and the author id; without reader it is refused', async () => {
    const runtime = meshRuntime('owner', rowFor({ author: 'source', owner: 'owner' }, 'known-failed'));
    expect(await handleOriginMesh({ runtime, command: receipt(), authenticatedSender: 'third', resolveKey: m => key(m) }))
      .toEqual({ ok: false, reason: 'origin-receipt-unavailable' });
    expect(await handleOriginMesh({ runtime, command: receipt(true), authenticatedSender: 'third', resolveKey: m => key(m) })).toMatchObject({
      ok: true, role: 'execution-owner', state: 'known-failed', outcome: 'not-delivered', safeToResend: true, failure: 'refused', originMachineId: 'source', executionOwnerMachineId: 'owner' });
  });
  it('the author answers only holding and its successor, never a verdict', async () => {
    const runtime = meshRuntime('source', rowFor({ author: 'source', owner: 'owner' }, 'held', { lastAttempt: 'refused' }));
    const answer = await handleOriginMesh({ runtime, command: receipt(true), authenticatedSender: 'third', resolveKey: m => key(m) }) as Record<string, unknown>;
    expect(answer).toMatchObject({ ok: true, role: 'author', holding: true, supersededBy: null });
    expect(answer).not.toHaveProperty('outcome'); expect(answer).not.toHaveProperty('state');
  });
  it('an author that delivered it itself says so; an author with an unresolved forward says it cannot tell', async () => {
    const accepted = rowFor({ author: 'source', owner: 'owner' }, 'accepted');
    accepted.children[0].state = 'accepted';
    accepted.attempts = [{ attemptId: 'a-2', childId: 'child-1', materializationId: 'm', ownerBootId: 'forwarded:source', deliveryMachineId: 'source', phase: 'dispatched',
      outcome: 'accepted', receiptJson: '{"messageId":"812"}', createdAt: 1, resolvedAt: 1 }];
    expect(await handleOriginMesh({ runtime: meshRuntime('source', accepted), command: receipt(true), authenticatedSender: 'third', resolveKey: m => key(m) }))
      .toMatchObject({ ok: true, role: 'author', holding: null, delivered: true, messageIds: ['812'] });
    expect(await handleOriginMesh({ runtime: meshRuntime('source', rowFor({ author: 'source', owner: 'owner' }, 'expired', { lastAttempt: 'outcome-unknown' })), command: receipt(true), authenticatedSender: 'third', resolveKey: m => key(m) }))
      .toMatchObject({ ok: true, role: 'author', holding: null });
  });
  it('a machine that is neither owner nor author answers origin-receipt-unavailable', async () => {
    const runtime = meshRuntime('bystander', rowFor({ author: 'source', owner: 'owner' }, 'held', { lastAttempt: 'refused' }));
    expect(await handleOriginMesh({ runtime, command: receipt(true), authenticatedSender: 'third', resolveKey: m => key(m) })).toEqual({ ok: false, reason: 'origin-receipt-unavailable' });
  });
  it('refuses a revoked or foreign-agent key even with reader', async () => {
    const runtime = meshRuntime('owner', rowFor({ author: 'source', owner: 'owner' }, 'known-failed'));
    expect(await handleOriginMesh({ runtime, command: receipt(true), authenticatedSender: 'third', resolveKey: m => key(m, { revokedAt: Date.now() - 1 }) })).toEqual({ ok: false, reason: 'origin-peer-unavailable' });
    expect(await handleOriginMesh({ runtime, command: receipt(true), authenticatedSender: 'third', resolveKey: m => key(m, { agentId: 'other-agent' }) })).toEqual({ ok: false, reason: 'origin-peer-unavailable' });
  });
  it('the existing author ask (no reader) keeps its raw state for the forward ladder, with the verdict beside it', async () => {
    const runtime = meshRuntime('owner', rowFor({ author: 'source', owner: 'owner' }, 'known-failed'));
    expect(await handleOriginMesh({ runtime, command: receipt(), authenticatedSender: 'source', resolveKey: m => key(m) }))
      .toMatchObject({ ok: true, state: 'known-failed', originReceiptConfirmed: false, outcome: 'not-delivered' });
  });
});
