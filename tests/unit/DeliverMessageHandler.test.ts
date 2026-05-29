/**
 * Tier-1 tests for createDeliverMessageHandler (Multi-Machine Session Pool §L4
 * owner-side receive). Covers the ACK protocol: queued (first), duplicate
 * (idempotent redelivery — not re-processed), stale-ownership (session moved),
 * and the onAccepted hand-off firing exactly once on first receipt.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import type { MeshCommand, MeshEnvelope } from '../../src/core/MeshRpc.js';

const ENV = {} as MeshEnvelope;
function deliver(over: Partial<Extract<MeshCommand, { type: 'deliverMessage' }>> = {}): MeshCommand {
  return { type: 'deliverMessage', session: 's1', messageId: 'm1', payload: {}, ownershipEpoch: 5, ...over };
}

describe('createDeliverMessageHandler (§L4)', () => {
  it('first receipt → queued, and onAccepted fires once', () => {
    const onAccepted = vi.fn();
    const seen = new Set<string>();
    const h = createDeliverMessageHandler({
      ownerEpochOf: () => 5,
      recordReceipt: (id) => (seen.has(id) ? false : (seen.add(id), true)),
      onAccepted,
    });
    expect(h(deliver(), 'ROUTER', ENV)).toEqual({ messageId: 'm1', accepted: 'queued' });
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it('redelivery of the same messageId → duplicate, onAccepted NOT fired again', () => {
    const onAccepted = vi.fn();
    const seen = new Set<string>();
    const h = createDeliverMessageHandler({ ownerEpochOf: () => null, recordReceipt: (id) => (seen.has(id) ? false : (seen.add(id), true)), onAccepted });
    h(deliver(), 'ROUTER', ENV);
    expect(h(deliver(), 'ROUTER', ENV)).toEqual({ messageId: 'm1', accepted: 'duplicate' });
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it('stale-ownership when the owner epoch advanced past the router view', () => {
    const h = createDeliverMessageHandler({ ownerEpochOf: () => 9, recordReceipt: () => true });
    expect(h(deliver({ ownershipEpoch: 5 }), 'ROUTER', ENV)).toEqual({ messageId: 'm1', accepted: 'stale-ownership' });
  });

  it('NOT stale when the router view matches or leads the owner epoch', () => {
    const h = createDeliverMessageHandler({ ownerEpochOf: () => 5, recordReceipt: () => true });
    expect(h(deliver({ ownershipEpoch: 5 }), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
    expect(h(deliver({ ownershipEpoch: 6 }), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
  });

  it('no ownership record (null epoch) → never stale; relies on receipt dedupe', () => {
    const seen = new Set<string>();
    const h = createDeliverMessageHandler({ ownerEpochOf: () => null, recordReceipt: (id) => (seen.has(id) ? false : (seen.add(id), true)) });
    expect(h(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
  });
});
