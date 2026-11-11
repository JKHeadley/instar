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

describe('session-pool-no-silent-drop', () => {
  it('a machine that cannot serve refuses as stale ownership, records nothing and hands nothing on', () => {
    const recordReceipt = vi.fn(() => true);
    const onAccepted = vi.fn();
    const onCannotServe = vi.fn();
    const h = createDeliverMessageHandler({ ownerEpochOf: () => 5, recordReceipt, onAccepted, refusal: { canServe: () => false, alreadyReceived: () => false, onCannotServe } });
    expect(h(deliver(), 'ROUTER', ENV)).toEqual({ messageId: 'm1', accepted: 'stale-ownership' });
    expect(recordReceipt).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onCannotServe).toHaveBeenCalledOnce();
  });
  it('after a refusal the same message is accepted once the machine can serve: the refusal left no receipt', () => {
    let can = false;
    const seen = new Set<string>();
    const h = createDeliverMessageHandler({ ownerEpochOf: () => 5, recordReceipt: (id) => (seen.has(id) ? false : (seen.add(id), true)), refusal: { canServe: () => can, alreadyReceived: () => false } });
    expect(h(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'stale-ownership' });
    can = true;
    expect(h(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
  });
  it('a machine that can serve behaves as before, and an absent check means it can', () => {
    expect(createDeliverMessageHandler({ ownerEpochOf: () => 5, recordReceipt: () => true, refusal: { canServe: () => true, alreadyReceived: () => false } })(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
    expect(createDeliverMessageHandler({ ownerEpochOf: () => 5, recordReceipt: () => true })(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
  });
  it('a throwing trace does not change the answer', () => {
    const h = createDeliverMessageHandler({ ownerEpochOf: () => 5, recordReceipt: () => true, refusal: { canServe: () => false, alreadyReceived: () => false, onCannotServe: () => { throw new Error('x'); } } });
    expect(h(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'stale-ownership' });
  });
  it('processed, ack lost, then the machine can no longer serve: the retry is a duplicate, not handed back', () => {
    let can = true;
    const seen = new Set<string>();
    const h = createDeliverMessageHandler({
      ownerEpochOf: () => 5,
      recordReceipt: (id) => (seen.has(id) ? false : (seen.add(id), true)),
      refusal: { canServe: () => can, alreadyReceived: (id) => seen.has(id) },
    });
    expect(h(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
    can = false;
    expect(h(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'duplicate' });
    expect(h(deliver({ messageId: 'm2' }), 'ROUTER', ENV)).toMatchObject({ accepted: 'stale-ownership' });
  });
  it('a stale epoch still answers first', () => {
    const canServe = vi.fn(() => false);
    createDeliverMessageHandler({ ownerEpochOf: () => 9, recordReceipt: () => true, refusal: { canServe, alreadyReceived: () => false } })(deliver(), 'ROUTER', ENV);
    expect(canServe).not.toHaveBeenCalled();
  });
});

describe('createDeliverMessageHandler (§L4)', () => {
  it('first receipt → queued, and onAccepted fires once', () => {
    const onAccepted = vi.fn();
    const seen = new Set<string>();
    const h = createDeliverMessageHandler({
      ownerEpochOf: () => 5,
      recordReceipt: (id) => (seen.has(id) ? false : (seen.add(id), true)),
      onAccepted,
    });
    const command = deliver();
    const envelope = { sender: 'ROUTER', recipient: 'OWNER', command, signature: 'original-signature', nonce: 17 } as unknown as MeshEnvelope;
    expect(h(command, 'ROUTER', envelope)).toEqual({ messageId: 'm1', accepted: 'queued' });
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith(command, 'ROUTER', envelope);
    expect(onAccepted.mock.calls[0][2]).toBe(envelope);
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
  it('cannot record a transport ACK when synchronous dispatch custody fails',()=>{
    const recordReceipt=vi.fn(()=>true),accepted=vi.fn();
    const handler=createDeliverMessageHandler({ownerEpochOf:()=>null,recordReceipt,onAccepted:accepted,beforeReceipt:()=>{throw new Error('custody-unavailable');}});
    expect(()=>handler(deliver(),'ROUTER',ENV)).toThrow('custody-unavailable');
    expect(recordReceipt).not.toHaveBeenCalled();expect(accepted).not.toHaveBeenCalled();
  });

});
