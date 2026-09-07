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
      deliveryMachineId: 'owner', phase: 'resolved', outcome: 'accepted', receiptJson: '{}', createdAt: 1, resolvedAt: 2 }];
    expect(originAuditDeliveryConfirmed(audit)).toBe(true);
    audit.children.push({ ...audit.children[0], childId: 'child-2', deliveryId: 'delivery-2' });
    expect(originAuditDeliveryConfirmed(audit)).toBe(false);
  });
});
