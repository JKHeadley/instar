import { describe, expect, it } from 'vitest';
import { InboundDeliveryStore } from '../../src/core/InboundDeliveryStore.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Codex inbound effect journal integration', () => {
  it('preserves a possibly-applied key rung across reconciliation', () => {
    const store = InboundDeliveryStore.openMemory();
    const row = store.prepare({ conversationId: 'telegram:59199', incarnation: 'codex-1', framework: 'codex-cli', envelope: '[telegram:59199] continue', hmacKey: 'agent-key' });
    store.transition(row.conversationId, row.deliveryId, 'prepared', 'dispatch-armed');
    store.transition(row.conversationId, row.deliveryId, 'dispatch-armed', 'dispatch-started');
    store.transition(row.conversationId, row.deliveryId, 'dispatch-started', 'dispatched');
    expect(store.armAttempt(row.conversationId, row.deliveryId, 0)).toBe(true);
    expect(store.transitionAttempt(row.conversationId, row.deliveryId, 0, 'attempt-armed', 'attempt-started')).toBe(true);
    expect(store.reconcileInterruptedEffects()).toEqual({ deliveries: 0, attempts: 1 });
    expect(store.armAttempt(row.conversationId, row.deliveryId, 0)).toBe(false);
    expect(store.armAttempt(row.conversationId, row.deliveryId, 1)).toBe(true);
  });

  it('serializes admission across file-backed writers and shares durable breaker state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-delivery-bounds-'));
    const options = { maxLiveRows: 2, maxLiveBytes: 1024, maxLogicalRows: 2 };
    const writerA = InboundDeliveryStore.open(dir, options);
    const writerB = InboundDeliveryStore.open(dir, options);
    writerA.prepare({ conversationId: 'c', deliveryId: 'a', incarnation: 'i', framework: 'codex-cli', envelope: 'one', hmacKey: 'k' });
    writerB.prepare({ conversationId: 'c', deliveryId: 'b', incarnation: 'i', framework: 'codex-cli', envelope: 'two', hmacKey: 'k' });
    expect(() => writerA.prepare({ conversationId: 'c', deliveryId: 'c', incarnation: 'i', framework: 'codex-cli', envelope: 'three', hmacKey: 'k' }))
      .toThrowError(expect.objectContaining({ reason: 'storage-breaker' }));
    expect(writerB.status()).toMatchObject({
      liveRows: 2,
      logicalRows: 2,
      breaker: { open: true, epoch: 1, reason: 'logical-row-limit' },
    });
  });
});
