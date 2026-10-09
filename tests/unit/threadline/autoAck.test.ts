/**
 * Unit tests — the automatic acknowledgement (docs/specs/a2a-ack-never-acked.md).
 *
 * INVARIANT under test: an ack is never acked, never routed, never spawns; it
 * only records delivery. Both sides of every boundary, with real dependencies
 * (a real InboundIdLedger ticket, a real A2ADeliveryTracker, a real
 * ThreadlineClient encoding the wire payload).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AUTO_ACK_TYPE,
  DEFAULT_AUTO_ACK_MESSAGE,
  createAckRateLimiter,
  decodePlaintextPayload,
  encodePlaintextPayload,
  isAutoAckBody,
  isAutoAckInbound,
  autoAckRecognition,
  autoAckBodyRecognition,
  looksLikeAutoAckText,
  runRelayAckStage,
  type RelayAckStageDeps,
} from '../../../src/threadline/autoAck.js';
import { InboundIdLedger } from '../../../src/threadline/InboundIdLedger.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import { recordInboundAck } from '../../../src/threadline/recordInboundAck.js';
import { ThreadlineClient } from '../../../src/threadline/client/ThreadlineClient.js';

const PEER = 'a'.repeat(32);

describe('isAutoAckInbound — structural marker first, legacy text second', () => {
  it('recognises the typed ack whatever its text (a custom autoAckMessage included)', () => {
    expect(isAutoAckInbound({ type: AUTO_ACK_TYPE, text: DEFAULT_AUTO_ACK_MESSAGE })).toBe(true);
    expect(isAutoAckInbound({ type: 'ack', text: 'Got your note — thinking.' })).toBe(true);
    expect(isAutoAckInbound({ type: 'ack', text: '' })).toBe(true);
  });

  it('recognises an older peer\'s ack: the whole message is exactly the fixed sentence (type chat, or none)', () => {
    expect(isAutoAckInbound({ type: 'chat', text: DEFAULT_AUTO_ACK_MESSAGE })).toBe(true);
    expect(isAutoAckInbound({ text: 'Message received. Composing response...' })).toBe(true);
    expect(isAutoAckInbound({ type: undefined, text: '  Message received. Composing response...  ' })).toBe(true);
  });

  it('does NOT treat ordinary content as an ack', () => {
    expect(isAutoAckInbound({ type: 'chat', text: 'Can you review the relay patch?' })).toBe(false);
    expect(isAutoAckInbound({ type: 'chat', text: 'thanks' })).toBe(false); // the gate's job, not the ack stage's
    expect(isAutoAckInbound({ type: 'status', text: 'still building' })).toBe(false);
    expect(isAutoAckInbound({ text: null })).toBe(false);
    expect(isAutoAckInbound({})).toBe(false);
  });

  it('never a prefix, never a vocabulary: anything beyond the exact sentence is content', () => {
    for (const text of [
      'Message received. Did you also want the logs?',
      'Message received. Deploy the fix now.',
      'Message received, thanks.',
      'Message received.',
      'Message received. Composing response... and here is the analysis',
      'message received. composing response...',
    ]) {
      expect(isAutoAckInbound({ type: 'chat', text }), text).toBe(false);
      // …but the structural marker is never second-guessed by its words.
      expect(isAutoAckInbound({ type: 'ack', text }), text).toBe(true);
    }
  });

  it('names WHY a message was recognised, for the audit log', () => {
    expect(autoAckRecognition({ type: 'ack', text: 'On it.' })).toBe('type');
    expect(autoAckRecognition({ type: 'chat', text: DEFAULT_AUTO_ACK_MESSAGE })).toBe('exact-text');
    expect(autoAckRecognition({ type: 'chat', text: 'Message received. Deploy the fix now.' })).toBeNull();
    expect(autoAckBodyRecognition({ content: 'On it.', type: 'ack' })).toBe('type');
    expect(autoAckBodyRecognition(DEFAULT_AUTO_ACK_MESSAGE)).toBe('exact-text');
    expect(autoAckBodyRecognition({ text: 'hello' })).toBeNull();
  });

  it('looksLikeAutoAckText keeps the old prefix test for the reply waiter only', () => {
    expect(looksLikeAutoAckText('Message received. Composing response...')).toBe(true);
    expect(looksLikeAutoAckText('Message received, working on it.')).toBe(true);
    expect(looksLikeAutoAckText('The message was received.')).toBe(false);
    expect(looksLikeAutoAckText(null)).toBe(false);
  });

  it('isAutoAckBody reads HTTP bodies: a string, or an object with content/text + type', () => {
    expect(isAutoAckBody('Message received. Composing response...')).toBe(true);
    expect(isAutoAckBody({ content: 'anything', type: 'ack' })).toBe(true);
    expect(isAutoAckBody({ text: 'Message received. Composing response...' })).toBe(true);
    expect(isAutoAckBody('Message received. Deploy the fix now.')).toBe(false);
    expect(isAutoAckBody('hello there')).toBe(false);
    expect(isAutoAckBody({ content: 'hello there', type: 'chat' })).toBe(false);
    expect(isAutoAckBody(undefined)).toBe(false);
    expect(isAutoAckBody(42)).toBe(false);
  });
});

describe('runRelayAckStage', () => {
  let ledger: InboundIdLedger | null = null;
  let tracker: A2ADeliveryTracker | null = null;
  afterEach(() => { ledger?.close(); tracker?.close(); ledger = null; tracker = null; });

  function deps(over: Partial<RelayAckStageDeps> = {}): RelayAckStageDeps & { sendAck: ReturnType<typeof vi.fn>; recordDelivery: ReturnType<typeof vi.fn> } {
    return {
      autoAckEnabled: true,
      isAckRateLimited: () => false,
      sendAck: vi.fn(),
      recordDelivery: vi.fn(),
      ...over,
    } as never;
  }
  const input = (over: Record<string, unknown> = {}) => ({
    isAutoAck: false, trustLevel: 'verified', msgType: 'chat', senderFingerprint: PEER, threadId: 'thread-1', ticket: null, ...over,
  });

  it('an ack on a thread WE started: nothing is sent, delivery is recorded, the ledger row is no-reply', () => {
    ledger = InboundIdLedger.openMemory();
    tracker = A2ADeliveryTracker.openMemory();
    // We started the thread: our message is awaiting the peer's ack.
    tracker.recordSent({ messageId: 'ours-1', peerFp: PEER, threadId: 'thread-ours' });
    expect(tracker.pending(PEER)).toHaveLength(1);

    const adm = ledger.admit({ senderKey: `unverified:${PEER}`, messageId: 'ack-1', ingress: 'relay-unknown-sender', threadId: 'thread-ours' });
    if (adm.kind !== 'admitted') throw new Error('expected admission');
    const d = deps({
      recordDelivery: vi.fn(() => recordInboundAck({ a2aDeliveryTracker: tracker }, { threadId: 'thread-ours', senderFingerprint: PEER })),
    });

    const out = runRelayAckStage(d, input({ isAutoAck: true, msgType: 'ack', threadId: 'thread-ours', ticket: adm.ticket }));
    adm.ticket.finish();

    expect(out).toBe('ack-consumed');
    expect(d.sendAck).not.toHaveBeenCalled();
    expect(d.recordDelivery).toHaveBeenCalledTimes(1);
    expect(tracker.pending(PEER)).toHaveLength(0); // the delivery ack landed
    expect(tracker.get('ours-1')?.state).toBe('acked');
    expect(ledger.getRow(`unverified:${PEER}`, 'ack-1')?.disposition).toBe('no-reply');
  });

  it('delivery is tracked per THREAD, oldest first: one ack clears one outstanding message, a second ack the next', () => {
    tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'first', peerFp: PEER, threadId: 'thread-two', sentAt: '2026-10-08T10:00:00.000Z' });
    tracker.recordSent({ messageId: 'second', peerFp: PEER, threadId: 'thread-two', sentAt: '2026-10-08T10:00:05.000Z' });
    const d = deps({
      recordDelivery: vi.fn(() => recordInboundAck({ a2aDeliveryTracker: tracker }, { threadId: 'thread-two', senderFingerprint: PEER })),
    });
    runRelayAckStage(d, input({ isAutoAck: true, threadId: 'thread-two' }));
    expect(tracker.get('first')?.state).toBe('acked');
    expect(tracker.get('second')?.state).toBe('awaiting-ack'); // never over-acked
    runRelayAckStage(d, input({ isAutoAck: true, threadId: 'thread-two' }));
    expect(tracker.get('second')?.state).toBe('acked');
    // A further ack with nothing outstanding is harmless.
    expect(runRelayAckStage(d, input({ isAutoAck: true, threadId: 'thread-two' }))).toBe('ack-consumed');
  });

  it('an ack is consumed even when our own acks are switched off, rate-limited, or the sender is untrusted', () => {
    for (const over of [{ autoAckEnabled: false }, { isAckRateLimited: () => true }]) {
      const d = deps(over);
      expect(runRelayAckStage(d, input({ isAutoAck: true }))).toBe('ack-consumed');
      expect(d.sendAck).not.toHaveBeenCalled();
    }
    const d = deps();
    expect(runRelayAckStage(d, input({ isAutoAck: true, trustLevel: 'untrusted' }))).toBe('ack-consumed');
    expect(d.sendAck).not.toHaveBeenCalled();
  });

  it('a real message gets exactly one ack with the default text, and handling continues', () => {
    const d = deps();
    expect(runRelayAckStage(d, input())).toBe('continue');
    expect(d.sendAck).toHaveBeenCalledTimes(1);
    expect(d.sendAck).toHaveBeenCalledWith(PEER, DEFAULT_AUTO_ACK_MESSAGE, 'thread-1');
    expect(d.recordDelivery).not.toHaveBeenCalled(); // the caller records it on the normal path
  });

  it('uses the configured ack text', () => {
    const d = deps({ autoAckMessage: 'On it.' });
    runRelayAckStage(d, input());
    expect(d.sendAck).toHaveBeenCalledWith(PEER, 'On it.', 'thread-1');
  });

  it('sends no ack for a status message, an untrusted sender, autoAck off, or a rate-limited sender', () => {
    const cases: Array<[Partial<RelayAckStageDeps>, Record<string, unknown>]> = [
      [{}, { msgType: 'status' }],
      [{}, { trustLevel: 'untrusted' }],
      [{ autoAckEnabled: false }, {}],
      [{ isAckRateLimited: () => true }, {}],
    ];
    for (const [dOver, iOver] of cases) {
      const d = deps(dOver);
      expect(runRelayAckStage(d, input(iOver))).toBe('continue');
      expect(d.sendAck).not.toHaveBeenCalled();
    }
  });

  it('a failing ack send never breaks inbound handling', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps({ sendAck: vi.fn(() => { throw new Error('Not connected'); }) });
    expect(runRelayAckStage(d, input())).toBe('continue');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('createAckRateLimiter — flood protection stays in place', () => {
  it('allows `limit` acks per sender per window, per sender, and recovers after the window', () => {
    let now = 1_000;
    const limited = createAckRateLimiter(5, 60_000, () => now);
    for (let i = 0; i < 5; i++) expect(limited(PEER)).toBe(false);
    expect(limited(PEER)).toBe(true);
    expect(limited('b'.repeat(32))).toBe(false); // another sender is unaffected
    now += 60_001;
    expect(limited(PEER)).toBe(false);
  });
});

describe('the wire format', () => {
  it('encode/decode round-trips text, type and the resend mark', () => {
    expect(decodePlaintextPayload(encodePlaintextPayload('hi', 'chat'))).toEqual({ text: 'hi', type: 'chat', resend: false });
    expect(decodePlaintextPayload(encodePlaintextPayload('hi', 'ack', true))).toEqual({ text: 'hi', type: 'ack', resend: true });
  });

  it('decodes a bare string, a foreign object, and refuses garbage', () => {
    expect(decodePlaintextPayload(Buffer.from(JSON.stringify('plain')).toString('base64'))).toEqual({ text: 'plain', resend: false });
    expect(decodePlaintextPayload(Buffer.from(JSON.stringify({ a: 1 })).toString('base64'))).toEqual({ text: '{"a":1}', resend: false });
    expect(decodePlaintextPayload(Buffer.from('not json').toString('base64'))).toBeNull();
    expect(decodePlaintextPayload(undefined)).toBeNull();
  });

  function connectedClient() {
    const sent: Array<Record<string, unknown>> = [];
    const client = new ThreadlineClient({ name: 'unit', stateDir: '.' } as never);
    Object.assign(client as unknown as Record<string, unknown>, {
      relayClient: { sendMessage: (e: Record<string, unknown>) => sent.push(e) },
      identity: { fingerprint: 'f'.repeat(32) },
    });
    return { client, sent };
  }

  it('ThreadlineClient.sendAck puts type "ack" on the wire, on the caller\'s thread', () => {
    const { client, sent } = connectedClient();
    const id = client.sendAck(PEER, DEFAULT_AUTO_ACK_MESSAGE, 'thread-9');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: PEER, threadId: 'thread-9', messageId: id, from: 'f'.repeat(32) });
    expect(decodePlaintextPayload(sent[0].payload)).toEqual({ text: DEFAULT_AUTO_ACK_MESSAGE, type: 'ack', resend: false });
  });

  it('ThreadlineClient.sendPlaintext is unchanged: type "chat", caller id echoed, resend marked', () => {
    const { client, sent } = connectedClient();
    expect(client.sendPlaintext(PEER, 'hello', 'thread-9', 'my-id', true)).toBe('my-id');
    expect(decodePlaintextPayload(sent[0].payload)).toEqual({ text: 'hello', type: 'chat', resend: true });
  });

  it('sendAck refuses when not connected (the stage swallows it)', () => {
    const client = new ThreadlineClient({ name: 'unit', stateDir: '.' } as never);
    expect(() => client.sendAck(PEER, 'x')).toThrow('Not connected');
  });
});
