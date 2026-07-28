/**
 * silent-loss-refusal-conservation §2.B — the DeliverMessageHandler onRejected
 * trace (metadata-only) + the per-(session,messageId) suppression cache that
 * short-circuits validateSender so a replay flood can't force a read-DoS.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import type { MeshCommand, MeshEnvelope } from '../../src/core/MeshRpc.js';

const ENV = {} as MeshEnvelope;
function deliver(over: Partial<Extract<MeshCommand, { type: 'deliverMessage' }>> = {}): MeshCommand {
  return { type: 'deliverMessage', session: 's1', messageId: 'm1', payload: { text: 'hi' }, ownershipEpoch: 5, senderEnvelope: { userId: 4242 }, ...over } as MeshCommand;
}

describe('§2.B DeliverMessageHandler onRejected + suppression cache', () => {
  it('a rejected sender NACKs sender-rejected AND fires onRejected exactly once (metadata-only)', () => {
    const onRejected = vi.fn();
    const h = createDeliverMessageHandler({
      ownerEpochOf: () => 5,
      recordReceipt: () => true,
      validateSender: () => false,
      onRejected,
    });
    expect(h(deliver(), 'ROUTER', ENV)).toEqual({ messageId: 'm1', accepted: 'sender-rejected' });
    expect(onRejected).toHaveBeenCalledOnce();
    const meta = onRejected.mock.calls[0][0];
    expect(meta).toEqual({ reason: 'sender-rejected', session: 's1', messageId: 'm1', senderUid: 4242 });
  });

  it('rejection-trace-never-contains-payload: onRejected meta carries NO command/payload', () => {
    const onRejected = vi.fn();
    const h = createDeliverMessageHandler({ ownerEpochOf: () => null, recordReceipt: () => true, validateSender: () => false, onRejected });
    h(deliver({ payload: { text: 'SECRET PAYLOAD' } }), 'ROUTER', ENV);
    const meta = onRejected.mock.calls[0][0];
    expect(JSON.stringify(meta)).not.toContain('SECRET PAYLOAD');
    expect(meta).not.toHaveProperty('payload');
    expect(meta).not.toHaveProperty('command');
  });

  it('N-replays-cause-≤1-registry-read: the suppression cache short-circuits validateSender on replay', () => {
    const validateSender = vi.fn(() => false); // stands in for the registry read
    const onRejected = vi.fn();
    const h = createDeliverMessageHandler({ ownerEpochOf: () => null, recordReceipt: () => true, validateSender, onRejected });
    // 10 replays of the SAME (session, messageId).
    for (let i = 0; i < 10; i++) expect(h(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'sender-rejected' });
    // validateSender (the registry read) ran ONCE; the rest were served from cache.
    expect(validateSender).toHaveBeenCalledTimes(1);
    // The trace fired once (bounded — not per replay).
    expect(onRejected).toHaveBeenCalledOnce();
  });

  it('a DISTINCT messageId is validated afresh (cache is per (session,messageId))', () => {
    const validateSender = vi.fn(() => false);
    const h = createDeliverMessageHandler({ ownerEpochOf: () => null, recordReceipt: () => true, validateSender });
    h(deliver({ messageId: 'a' }), 'ROUTER', ENV);
    h(deliver({ messageId: 'b' }), 'ROUTER', ENV);
    expect(validateSender).toHaveBeenCalledTimes(2);
  });

  it('an ACCEPTED sender is recorded + queued (validateSender true → recordReceipt runs)', () => {
    const recordReceipt = vi.fn(() => true);
    const h = createDeliverMessageHandler({ ownerEpochOf: () => null, recordReceipt, validateSender: () => true });
    expect(h(deliver(), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
    expect(recordReceipt).toHaveBeenCalledOnce();
  });

  it('no envelope → validateSender not consulted (old peer / live local frame)', () => {
    const validateSender = vi.fn(() => false);
    const h = createDeliverMessageHandler({ ownerEpochOf: () => null, recordReceipt: () => true, validateSender });
    expect(h(deliver({ senderEnvelope: undefined }), 'ROUTER', ENV)).toMatchObject({ accepted: 'queued' });
    expect(validateSender).not.toHaveBeenCalled();
  });
});
