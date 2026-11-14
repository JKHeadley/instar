/**
 * a2a-required-acknowledgment — the codec, the ack-stage branch, capability gating,
 * monotonic sender state, receipts, the watch and the pending rows. Runs the
 * production RequiredAckService on the real tracker database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';
import { MessageEncryptor, computeFingerprint, deriveX25519PublicKey } from '../../src/threadline/client/MessageEncryptor.js';
import { ThreadlineClient, KindedAckKeysUnavailableError } from '../../src/threadline/client/ThreadlineClient.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { edPublicToX25519 } from '../../src/threadline/ThreadlineCrypto.js';
import { encodePlaintextPayload, decodePlaintextPayload, runRelayAckStage, isAutoAckInbound } from '../../src/threadline/autoAck.js';
import { runRelayInboundWithLedger } from '../../src/threadline/inboundIdLedgerWiring.js';
import { RequiredAckService, DEFAULT_ATTENTION_MS, DEFAULT_REMINDER_MS, PENDING_TTL_MS, resolveRequiredAckEnabled, resolveRequiredAckThresholds, type KindedAckRoute } from '../../src/threadline/requiredAckService.js';
import { HELD_TEXT, heldStateRank, parseKindedAck, refusalReason, requiredAckInstruction, requiredAckReminder, sanitizeAckSummary, summaryProblem, type KindedAckWire } from '../../src/threadline/requiredAck.js';

const PEER = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const T0 = Date.parse('2026-11-04T18:00:00.000Z');

interface Sent { peerFp: string; ack: KindedAckWire; text: string; opts: { threadId: string | null; triggerEncrypted: boolean } }

function harness(over: { enabled?: boolean; routeKind?: 'relay' | 'none'; throwOnSend?: boolean; alive?: (n: string) => boolean; lane?: (n: string) => 'interactive' | 'headless' | null } = {}, tracker = A2ADeliveryTracker.openMemory()) {
  const sent: Sent[] = [];
  const reminders: Array<{ session: string; text: string }> = [];
  const clock = { now: T0 };
  const ctl = { routeKind: over.routeKind ?? 'relay', throwOnSend: over.throwOnSend ?? false, enabled: over.enabled ?? true, pinned: false, profile: true, standby: false };
  const route = (): KindedAckRoute => ctl.routeKind === 'relay'
    ? { kind: 'relay', send: (peerFp, ack, text, opts) => { if (ctl.throwOnSend) throw new Error('down'); sent.push({ peerFp, ack, text, opts }); } }
    : { kind: 'none' };
  const svc = new RequiredAckService({
    tracker,
    enabled: () => ctl.enabled,
    thresholds: () => ({ reminderMs: DEFAULT_REMINDER_MS, attentionMs: DEFAULT_ATTENTION_MS, reminderDailyCap: 20 }),
    route,
    isStandby: () => ctl.standby,
    hasTrustProfile: () => ctl.profile,
    isPinned: () => ctl.pinned,
    isSessionAlive: over.alive ?? (() => true),
    injectReminder: (session, text) => { reminders.push({ session, text }); return true; },
    laneOf: over.lane,
    threadPeer: () => PEER,
    now: () => clock.now,
    log: () => {},
  });
  return { svc, tracker, sent, reminders, clock, ctl };
}

const STAMPED = { content: 'PEER-TEXT-MARKER', ackKinds: 1 };
function prepared(h: ReturnType<typeof harness>, id = 'm1', thread = 't1', encrypted = false) {
  h.svc.notePeerMessage(PEER, STAMPED);
  const handle = h.svc.prepare({ peerFp: PEER, messageId: id, threadId: thread, triggerEncrypted: encrypted });
  if (!handle) throw new Error('expected a handle');
  return handle;
}

describe('D1 codec', () => {
  it('plaintext round trip keeps ack and stamp; an old payload decodes as before', () => {
    const ack = { kind: 'held', state: 'queued', reason: 'busy', refMessageIds: ['x'] };
    const d = decodePlaintextPayload(encodePlaintextPayload('t', 'ack', false, { ack, ackKinds: 1 }));
    expect(d).toMatchObject({ text: 't', type: 'ack', ack, ackKinds: 1, resend: false });
    const old = decodePlaintextPayload(encodePlaintextPayload('t', 'chat'));
    expect(old).toEqual({ text: 't', type: 'chat', resend: false });
  });

  it('encrypted round trip keeps ack and stamp', () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    const enc = new MessageEncryptor(a.privateKey, a.publicKey);
    const dec = new MessageEncryptor(b.privateKey, b.publicKey);
    const ack = { kind: 'read', refMessageIds: ['x'], summary: 'asked for a review' };
    const env = enc.encrypt(b.publicKey, deriveX25519PublicKey(b.privateKey), 'th', { content: 't', type: 'ack', ack, ackKinds: 1 });
    const plain = dec.decrypt(env, a.publicKey, deriveX25519PublicKey(a.privateKey));
    expect(plain).toMatchObject({ type: 'ack', ack, ackKinds: 1 });
    expect(parseKindedAck(plain)).toEqual(ack);
  });

  it('parseKindedAck is structural: only an ack-typed message with an ack field', () => {
    expect(parseKindedAck({ type: 'chat', ack: { kind: 'read' } })).toBeNull();
    expect(parseKindedAck({ ack: { kind: 'read' } })).toBeNull();
    expect(parseKindedAck({ type: 'ack' })).toBeNull();
    expect(parseKindedAck('text')).toBeNull();
    expect(parseKindedAck({ type: 'ack', ack: { kind: 'future', refMessageIds: Array(30).fill('i') } })?.refMessageIds).toHaveLength(20);
  });
});

describe('D1 sendKindedAck: which envelope', () => {
  function client(known?: { publicKey: Buffer; x25519PublicKey: Buffer }, pinnedKey?: Buffer) {
    const me = generateIdentityKeyPair();
    const c = new ThreadlineClient({ name: 'x', relayUrl: 'ws://127.0.0.1:1/v1/connect', visibility: 'public', stateDir: '/nonexistent' }) as any;
    const wire: any[] = [];
    c.relayClient = { sendMessage: (e: unknown) => wire.push(e) };
    c.identity = { fingerprint: computeFingerprint(me.publicKey) };
    c.encryptor = new MessageEncryptor(me.privateKey, me.publicKey);
    if (known) c.knownAgents.set(computeFingerprint(known.publicKey), { ...known, agentId: computeFingerprint(known.publicKey), name: 'p' });
    if (pinnedKey) c.encryptToResolver = () => pinnedKey;
    return { c, wire, me };
  }
  const isPlain = (e: any) => decodePlaintextPayload(e.payload)?.type === 'ack';

  it('plaintext when the trigger was plaintext, even with known keys', () => {
    const peer = generateIdentityKeyPair();
    const x = deriveX25519PublicKey(peer.privateKey);
    const fp = computeFingerprint(peer.publicKey);
    const { c, wire } = client({ publicKey: peer.publicKey, x25519PublicKey: x });
    c.sendKindedAck(fp, { kind: 'held', state: 'queued', refMessageIds: ['m'] }, 'txt', { threadId: 't', triggerEncrypted: false });
    expect(isPlain(wire[0])).toBe(true);
    expect(decodePlaintextPayload(wire[0].payload)?.ack?.state).toBe('queued');
  });

  it('encrypted when the keys are known and the trigger was encrypted; no thread affinity recorded', () => {
    const peer = generateIdentityKeyPair();
    const x = deriveX25519PublicKey(peer.privateKey);
    const fp = computeFingerprint(peer.publicKey);
    const { c, wire } = client({ publicKey: peer.publicKey, x25519PublicKey: x });
    const before = c.peekClientAffinity(fp);
    c.sendKindedAck(fp, { kind: 'read', refMessageIds: ['m'], summary: 's' }, 'txt', { threadId: 't', triggerEncrypted: true });
    expect(wire).toHaveLength(1);
    expect(decodePlaintextPayload(wire[0].payload)?.type).not.toBe('ack');
    expect(c.peekClientAffinity(fp)).toBe(before);
  });

  it('encrypted to the pinned key whatever the trigger was', () => {
    const peer = generateIdentityKeyPair();
    const fp = computeFingerprint(peer.publicKey);
    const { c, wire, me } = client(undefined, peer.publicKey);
    c.sendKindedAck(fp, { kind: 'read', refMessageIds: ['m'] }, 'txt', { threadId: 't', triggerEncrypted: false });
    expect(decodePlaintextPayload(wire[0].payload)?.type).not.toBe('ack');
    // It opens with the peer's own keys, carrying the ack.
    const opened = new MessageEncryptor(peer.privateKey, peer.publicKey).decrypt(wire[0], me.publicKey, edPublicToX25519(me.publicKey));
    expect(parseKindedAck(opened)).toEqual({ kind: 'read', refMessageIds: ['m'] });
  });

  it('a read whose trigger was encrypted never downgrades: with the keys gone it throws, and nothing goes out', () => {
    const peer = generateIdentityKeyPair();
    const fp = computeFingerprint(peer.publicKey);
    const { c, wire } = client();
    expect(() => c.sendKindedAck(fp, { kind: 'read', refMessageIds: ['m'] }, 'txt', { threadId: 't', triggerEncrypted: true })).toThrow(KindedAckKeysUnavailableError);
    expect(wire).toHaveLength(0);
  });

  it('every kind refuses to downgrade: a peer holding our keys would drop a plaintext ack, and the row would read as sent', () => {
    const peer = generateIdentityKeyPair();
    const fp = computeFingerprint(peer.publicKey);
    const { c, wire } = client();
    for (const state of ['queued', 'dropped', 'unknown', 'unacknowledged']) {
      expect(() => c.sendKindedAck(fp, { kind: 'held', state, refMessageIds: ['m'] }, 'txt', { threadId: 't', triggerEncrypted: true })).toThrow(KindedAckKeysUnavailableError);
    }
    expect(wire).toHaveLength(0);
  });

  it('chat advertises support; a plain delivery ack does not', () => {
    const { c, wire } = client();
    c.sendPlaintextRaw('chat', PEER, 'x', 't');
    c.sendAck(PEER, 'Message received.', 't');
    expect(decodePlaintextPayload(wire[0].payload)?.ackKinds).toBe(1);
    expect(decodePlaintextPayload(wire[1].payload)?.ackKinds).toBeUndefined();
  });

  it('every encrypted chat site stamps, including the direct sendToPinned callers', () => {
    const peer = generateIdentityKeyPair();
    const fp = computeFingerprint(peer.publicKey);
    const { c, wire, me } = client({ publicKey: peer.publicKey, x25519PublicKey: deriveX25519PublicKey(peer.privateKey) });
    c.sendEncryptedKnown(fp, 'known', 't');
    c.sendNoticeToPinned(fp, peer.publicKey.toString('hex'), 'notice');
    const dec = new MessageEncryptor(peer.privateKey, peer.publicKey);
    const myX = deriveX25519PublicKey(me.privateKey);
    expect((dec.decrypt(wire[0], me.publicKey, myX) as any).ackKinds).toBe(1);
    expect((dec.decrypt(wire[1], me.publicKey, edPublicToX25519(me.publicKey)) as any).ackKinds).toBe(1);
  });
});

describe('D1 ack stage', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.tracker.recordSent({ messageId: 'mine-1', peerFp: PEER, threadId: 'th', transport: 'relay' });
    h.tracker.recordSent({ messageId: 'mine-2', peerFp: PEER, threadId: 'th', transport: 'relay' });
    h.tracker.recordSent({ messageId: 'theirs', peerFp: OTHER, threadId: 'th2', transport: 'relay' });
  });
  afterEach(() => h.tracker.close());

  const stage = (ack: KindedAckWire, from = PEER, arrivedEncrypted = true) => {
    let delivery = 0;
    const out = runRelayAckStage({
      autoAckEnabled: true, isAckRateLimited: () => false, sendAck: () => { throw new Error('an ack is never acked'); },
      recordDelivery: () => { delivery++; },
      consumeKindedAck: (a) => { h.svc.consumeInboundAck({ from, ack: a, arrivedEncrypted }); },
    }, { isAutoAck: true, trustLevel: 'trusted', msgType: 'ack', senderFingerprint: from, kindedAck: ack, ticket: null });
    return { out, delivery };
  };

  it('held never acks: no delivery record, no state change, only the held fields', () => {
    const { out, delivery } = stage({ kind: 'held', state: 'queued', reason: 'session-limit', refMessageIds: ['mine-1'] });
    expect(out).toBe('ack-consumed');
    expect(delivery).toBe(0);
    expect(h.tracker.get('mine-1')).toMatchObject({ state: 'awaiting-ack', heldState: 'queued', heldReason: 'session-limit', readAt: null });
  });

  it('read flips exactly its rows, never by thread', () => {
    const { delivery } = stage({ kind: 'read', refMessageIds: ['mine-2'], summary: 'asked\nfor a  review\u0007' });
    expect(delivery).toBe(0);
    expect(h.tracker.get('mine-2')).toMatchObject({ state: 'acked', heldState: 'read', readSummaryPeerText: 'asked for a review' });
    expect(h.tracker.get('mine-1')).toMatchObject({ state: 'awaiting-ack', readAt: null });
  });

  it('a wrong fingerprint has no effect: a stranger, and a mixed list', () => {
    stage({ kind: 'read', refMessageIds: ['mine-1'] }, OTHER);
    expect(h.tracker.get('mine-1')).toMatchObject({ state: 'awaiting-ack', readAt: null, heldState: null });
    stage({ kind: 'held', state: 'dropped', refMessageIds: ['mine-1', 'theirs'] });
    expect(h.tracker.get('mine-1')?.heldState).toBeNull();
    expect(h.svc.counters.ignoredRow).toBe(2);
  });

  it('a read from a pinned peer must arrive encrypted; a held need not', () => {
    h.ctl.pinned = true;
    stage({ kind: 'read', refMessageIds: ['mine-1'] }, PEER, false);
    expect(h.tracker.get('mine-1')?.readAt).toBeNull();
    stage({ kind: 'read', refMessageIds: ['mine-1'] }, PEER, true);
    expect(h.tracker.get('mine-1')?.readAt).not.toBeNull();
  });

  it('an unknown kind or state is consumed and otherwise ignored', () => {
    expect(stage({ kind: 'future', refMessageIds: ['mine-1'] }).out).toBe('ack-consumed');
    stage({ kind: 'held', state: 'future', refMessageIds: ['mine-1'] });
    expect(h.tracker.get('mine-1')?.heldState).toBeNull();
  });

  it('the per-peer inbound limiter stops effects but still consumes', () => {
    for (let i = 0; i < 25; i++) stage({ kind: 'held', state: 'queued', refMessageIds: ['mine-1'] });
    expect(h.svc.counters.inboundLimited).toBe(5);
  });

  it('a plain delivery ack keeps today\'s behaviour', () => {
    let delivery = 0;
    runRelayAckStage({ autoAckEnabled: true, isAckRateLimited: () => false, sendAck: () => {}, recordDelivery: () => { delivery++; } },
      { isAutoAck: isAutoAckInbound({ type: 'ack', text: 'x' }), trustLevel: 'trusted', msgType: 'ack', senderFingerprint: PEER, ticket: null });
    expect(delivery).toBe(1);
  });

  it('kinded acks skip ledger admission; a plain ack does not', async () => {
    const admitted: unknown[] = [];
    const ledger = { admit: (q: unknown) => { admitted.push(q); return { kind: 'unrecorded', ticket: { finish() {}, recordHandoffFailed() {} } }; } } as any;
    const deps = { ledger: () => ledger, tracker: () => null, extractMessageId: () => 'id' };
    let tickets: unknown[] = [];
    await runRelayInboundWithLedger({ message: { from: PEER, content: { type: 'ack', content: 'x', ack: { kind: 'read', refMessageIds: ['m'] } } } }, deps, async (t) => { tickets.push(t); });
    expect(admitted).toHaveLength(0);
    expect(tickets).toEqual([null]);
    await runRelayInboundWithLedger({ message: { from: PEER, content: { type: 'ack', content: 'x' } } }, deps, async () => {});
    expect(admitted).toHaveLength(1);
  });
});

describe('a thread-matched delivery ack and a held row', () => {
  it('flips the row with no held state first, and the held row only when it is the last one waiting', () => {
    const { tracker } = harness();
    tracker.recordSent({ messageId: 'old', peerFp: PEER, threadId: 'th', sentAt: '2026-11-04T18:00:00.000Z' });
    tracker.recordSent({ messageId: 'new', peerFp: PEER, threadId: 'th', sentAt: '2026-11-04T18:01:00.000Z' });
    tracker.recordHeld('old', 'unknown', 'restart', '2026-11-04T18:02:00.000Z');
    expect(tracker.recordAckByThread('th')).toBe('new');
    expect(tracker.recordAckByThread('th')).toBe('old');
  });
});

describe('a resend never lowers the encryption rule', () => {
  it('a resend that arrives encrypted makes the watch encrypted, whichever copy came first', () => {
    const h = harness();
    h.svc.notePeerMessage(PEER, STAMPED);
    const first = h.svc.prepare({ peerFp: PEER, messageId: 'm', threadId: 't', triggerEncrypted: false });
    h.svc.prepare({ peerFp: PEER, messageId: 'm', threadId: 't', triggerEncrypted: true });
    expect(first).not.toBeNull();
    expect(h.tracker.ackStore.watchForRef(first!.ackRef)?.triggerEncrypted).toBe(true);
    h.svc.prepare({ peerFp: PEER, messageId: 'm', threadId: 't', triggerEncrypted: false });
    expect(h.tracker.ackStore.watchForRef(first!.ackRef)?.triggerEncrypted).toBe(true);
  });
});

describe('D1 capability gating', () => {
  it('a kinded ack goes only to a peer with a row; a message without the stamp removes it; higher values stick', () => {
    const h = harness();
    expect(h.svc.prepare({ peerFp: PEER, messageId: 'm', threadId: 't', triggerEncrypted: false })).toBeNull();
    h.svc.notePeerMessage(PEER, { content: 'x', ackKinds: 3 });
    h.svc.notePeerMessage(PEER, { content: 'x', ackKinds: 1 });
    expect(h.tracker.ackStore.peerAckKinds(PEER)).toBe(3);
    expect(h.svc.prepare({ peerFp: PEER, messageId: 'm', threadId: 't', triggerEncrypted: false })).not.toBeNull();
    h.svc.notePeerMessage(PEER, { content: 'rolled back' });
    expect(h.tracker.ackStore.peerAckKinds(PEER)).toBeNull();
    expect(h.svc.prepare({ peerFp: PEER, messageId: 'm2', threadId: 't', triggerEncrypted: false })).toBeNull();
    h.tracker.close();
  });

  it('off: no handle, no instruction, no sends; omitted means on', () => {
    const h = harness({ enabled: false });
    h.svc.notePeerMessage(PEER, STAMPED);
    expect(h.svc.prepare({ peerFp: PEER, messageId: 'm', threadId: 't', triggerEncrypted: false })).toBeNull();
    expect(resolveRequiredAckEnabled(undefined, {})).toBe(true);
    expect(resolveRequiredAckEnabled(false, {})).toBe(false);
    expect(resolveRequiredAckEnabled(undefined, { threadline: { requiredAck: { enabled: false } } })).toBe(false);
    expect(resolveRequiredAckThresholds({ threadline: { requiredAck: { reminderMs: 0 } } }).reminderMs).toBe(0);
    h.tracker.close();
  });
});

describe('D2 immediate receipt', () => {
  it.each([
    [{ delivered: false, queued: true, spawnQueued: true, error: 'Spawn denied: Session limit reached (20/20). Priority medium insufficient to override.' }, 'queued', 'session-limit'],
    [{ delivered: false, queued: true, error: undefined }, 'waiting', 'other'],
    [{ delivered: false, error: 'Spawn denied: Memory pressure too high for new session' }, 'refused', 'memory-pressure'],
  ])('%#: maps the router result', (result, state, reason) => {
    const h = harness();
    h.svc.settleRouterResult(prepared(h), result);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].ack).toEqual({ kind: 'held', state, reason, refMessageIds: ['m1'] });
    expect(h.sent[0].text).toBe(HELD_TEXT.received);
    expect(h.sent[0].text).not.toContain('PEER-TEXT-MARKER');
    h.tracker.close();
  });

  it('a peer without a trust profile gets busy, so capacity is not told to strangers', () => {
    const h = harness();
    h.ctl.profile = false;
    h.svc.settleRouterResult(prepared(h), { delivered: false, spawnQueued: true, queued: true, error: 'Session limit reached' });
    expect(h.sent[0].ack.reason).toBe('busy');
    expect(refusalReason('Cooldown: 3s', true)).toBe('cooldown');
    expect(refusalReason('Subscription quota gate: x', true)).toBe('quota');
    h.tracker.close();
  });

  it('deliveryPending: waiting at once; settled delivered opens the watch; undelivered sends a second waiting', async () => {
    const h = harness();
    h.svc.settleRouterResult(prepared(h, 'p1'), { delivered: false, sessionName: 'sess', deliveryPending: Promise.resolve({ delivered: true, reason: 'submitted' }) });
    expect(h.sent[0].text).toBe(HELD_TEXT.pending);
    await new Promise((r) => setImmediate(r));
    expect(h.tracker.ackStore.watchForMessage(PEER, 'p1')?.status).toBe('open');
    h.svc.settleRouterResult(prepared(h, 'p2'), { delivered: false, deliveryPending: Promise.resolve({ delivered: false, reason: 'stuck' }) });
    await new Promise((r) => setImmediate(r));
    expect(h.sent.filter((s) => s.ack.refMessageIds[0] === 'p2')).toHaveLength(2);
    expect(h.tracker.ackStore.watchForMessage(PEER, 'p2')?.status).toBe('closed');
    h.tracker.close();
  });

  it('a delivered result sends no held receipt; immediate receipts are best-effort over the limit', () => {
    const h = harness();
    h.svc.settleRouterResult(prepared(h), { delivered: true, sessionName: 's' });
    expect(h.sent).toHaveLength(0);
    for (let i = 0; i < 25; i++) h.svc.settleRouterResult(prepared(h, `b${i}`), { delivered: false });
    expect(h.sent).toHaveLength(20);
    expect(h.svc.counters.heldSkippedLimit).toBe(5);
    h.tracker.close();
  });

  it('a thrown send never reaches the router handler', () => {
    const h = harness({ throwOnSend: true });
    expect(() => h.svc.settleRouterResult(prepared(h), { delivered: false })).not.toThrow();
    h.tracker.close();
  });
});

describe('D3 a held message that dies says so', () => {
  it('expired and evicted send a pending dropped receipt', async () => {
    const h = harness();
    const a = prepared(h, 'e1');
    h.svc.settleRouterResult(a, { delivered: false, spawnQueued: true, queued: true });
    h.svc.onQueueDropped(a.receipt, 'expired');
    await h.svc.flushPending();
    const dropped = h.sent.find((s) => s.ack.state === 'dropped');
    expect(dropped?.ack).toMatchObject({ kind: 'held', state: 'dropped', reason: 'expired', refMessageIds: ['e1'] });
    expect(dropped?.text).toBe(HELD_TEXT.expired);
    const b = prepared(h, 'e2');
    h.svc.settleRouterResult(b, { delivered: false, spawnQueued: true, queued: true });
    h.svc.onQueueDropped(b.receipt, 'evicted');
    await h.svc.flushPending();
    expect(h.sent.find((s) => s.ack.reason === 'evicted')?.text).toBe(HELD_TEXT.evicted);
    h.tracker.close();
  });

  it('a resend that reached a session: a later expiry of the earlier queued copy sends nothing', async () => {
    const h = harness();
    const first = prepared(h, 'r1');
    h.svc.settleRouterResult(first, { delivered: false, spawnQueued: true, queued: true });
    const copy = prepared(h, 'r1'); // the resend, same id: same row, same handle
    expect(copy.ackRef).toBe(first.ackRef);
    h.svc.settleRouterResult(copy, { delivered: true, sessionName: 's' });
    h.sent.length = 0;
    h.svc.onQueueDropped(first.receipt, 'expired');
    await h.svc.flushPending();
    expect(h.sent).toHaveLength(0);
    h.tracker.close();
  });

  it('two queued copies: one dying says nothing while the other is still queued', async () => {
    const h = harness();
    const first = prepared(h, 'c1');
    h.svc.settleRouterResult(first, { delivered: false, spawnQueued: true, queued: true });
    const second = prepared(h, 'c1');
    h.svc.settleRouterResult(second, { delivered: false, spawnQueued: true, queued: true });
    h.sent.length = 0;
    h.svc.onQueueDropped(first.receipt, 'evicted');
    await h.svc.flushPending();
    expect(h.sent).toHaveLength(0);
    h.svc.onQueueDropped(second.receipt, 'expired');
    await h.svc.flushPending();
    expect(h.sent).toHaveLength(1);
    h.tracker.close();
  });

  it('restart: open journal rows become unknown, including the hand-off crash window, once', async () => {
    const h = harness({ routeKind: 'none' });
    h.svc.settleRouterResult(prepared(h, 'q1'), { delivered: false, spawnQueued: true, queued: true });
    prepared(h, 'crash-window'); // the router call never returned
    // A new boot on the same database.
    const h2 = harness({}, h.tracker);
    expect(h2.svc.recoverAfterRestart()).toBe(2);
    expect(h2.svc.recoverAfterRestart()).toBe(0);
    await h2.svc.flushPending();
    expect(h2.sent).toHaveLength(1);
    expect(h2.sent[0].ack).toMatchObject({ kind: 'held', state: 'unknown', reason: 'restart' });
    expect(h2.sent[0].ack.refMessageIds.sort()).toEqual(['crash-window', 'q1']);
    expect(h2.sent[0].text).toBe('A restart interrupted this. It may not have reached a session.');
    h.tracker.close();
  });

  it('sender state moves one way; a read is final; a resend resets held but never read', () => {
    const h = harness();
    h.tracker.recordSent({ messageId: 'x', peerFp: PEER, threadId: 't', transport: 'relay' });
    const held = (state: any) => h.tracker.recordHeld('x', state, null);
    expect(held('queued')).toBe(true);
    expect(held('waiting')).toBe(true);
    expect(held('unacknowledged')).toBe(true);
    expect(held('queued')).toBe(false);
    expect(held('unknown')).toBe(true);
    expect(held('unacknowledged')).toBe(false);
    expect(held('dropped')).toBe(true);
    expect(held('unknown')).toBe(false);
    h.tracker.resetHeldForResend('x');
    expect(h.tracker.get('x')?.heldState).toBeNull();
    expect(held('queued')).toBe(true);
    h.tracker.recordRead('x', 'seen');
    expect(held('dropped')).toBe(false);
    h.tracker.resetHeldForResend('x');
    expect(h.tracker.get('x')).toMatchObject({ heldState: 'read', readSummaryPeerText: 'seen' });
    expect(heldStateRank('read')).toBeGreaterThan(heldStateRank('dropped'));
    h.tracker.close();
  });
});

describe('D4 the session acknowledgment', () => {
  const summary = 'asks for a review of the reconnect patch';

  it('the instruction and reminder carry fixed text and the handle, nothing a peer supplied', () => {
    const h = harness();
    const handle = prepared(h, 'peer-chosen-id-<<inject>>', 'peer-thread');
    expect(handle.instruction).toBe(requiredAckInstruction(handle.ackRef));
    expect(handle.instruction).not.toContain('peer-chosen-id');
    expect(handle.instruction).not.toContain('peer-thread');
    expect(handle.ackRef).toMatch(/^ack-[0-9a-f]{12}$/);
    expect(requiredAckReminder([handle.ackRef])).toContain(handle.ackRef);
    h.tracker.close();
  });

  it('covers only the handles listed, closes those watches, and sends one read', async () => {
    const h = harness();
    const a = prepared(h, 'a1');
    const b = prepared(h, 'a2');
    h.svc.onDelivered(a.receipt, { sessionName: 's' });
    h.svc.onDelivered(b.receipt, { sessionName: 's' });
    const res = await h.svc.acceptSessionAck({ threadId: 't1', ackRefs: [a.ackRef, 'ack-nope'], summary });
    expect(res.body).toMatchObject({ sent: true, accepted: 1, unknownRefs: ['ack-nope'] });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].ack).toEqual({ kind: 'read', refMessageIds: ['a1'], summary });
    expect(h.tracker.ackStore.watchForRef(a.ackRef)).toMatchObject({ status: 'closed', closeReason: 'acknowledged' });
    expect(h.tracker.ackStore.watchForRef(b.ackRef)?.status).toBe('open');
    h.tracker.close();
  });

  it('validates the summary and the handles', async () => {
    const h = harness();
    expect((await h.svc.acceptSessionAck({ ackRefs: ['x'], summary: '' })).status).toBe(400);
    expect((await h.svc.acceptSessionAck({ ackRefs: ['x'], summary: 'two\nlines' })).status).toBe(400);
    expect((await h.svc.acceptSessionAck({ ackRefs: ['x'], summary: 'y'.repeat(281) })).status).toBe(400);
    expect((await h.svc.acceptSessionAck({ ackRefs: [], summary })).status).toBe(400);
    expect(summaryProblem('fine')).toBeNull();
    expect(sanitizeAckSummary('a\u0000b\n c')).toBe('a b c');
    h.tracker.close();
  });

  it('a peer without support: sent:false peer-does-not-support, nothing queued', async () => {
    const h = harness();
    const a = prepared(h, 'n1');
    h.svc.notePeerMessage(PEER, { content: 'no stamp now' });
    const res = await h.svc.acceptSessionAck({ ackRefs: [a.ackRef], summary });
    expect(res.body).toEqual({ sent: false, reason: 'peer-does-not-support' });
    expect(h.sent).toHaveLength(0);
    h.tracker.close();
  });

  it('on a standby a missing caps row means unknown: it accepts and forwards', async () => {
    const h = harness({ routeKind: 'none' });
    h.ctl.standby = true;
    const a = prepared(h, 'n2');
    h.svc.notePeerMessage(PEER, {});
    const res = await h.svc.acceptSessionAck({ ackRefs: [a.ackRef], summary });
    expect(res.body).toMatchObject({ sent: true, accepted: 1 });
    h.tracker.close();
  });

  it('a read survives a limit and a crash: the pending row is written before the watch closes', async () => {
    const h = harness();
    const a = prepared(h, 'l1');
    h.svc.onDelivered(a.receipt, { sessionName: 's' });
    h.ctl.routeKind = 'none'; // the relay is down when the session acknowledges
    expect((await h.svc.acceptSessionAck({ ackRefs: [a.ackRef], summary })).body).toMatchObject({ sent: true });
    expect(h.tracker.ackStore.watchForRef(a.ackRef)?.status).toBe('closed');
    // Crash. A new boot on the same database, relay back.
    const h2 = harness({}, h.tracker);
    h2.clock.now = T0 + 60_000;
    await h2.svc.flushPending();
    expect(h2.sent[0].ack).toMatchObject({ kind: 'read', refMessageIds: ['l1'], summary });
    h.tracker.close();
  });

  it('a read over the outbound limit waits, and goes when the limit clears', async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.svc.settleRouterResult(prepared(h, `f${i}`), { delivered: false });
    const a = prepared(h, 'l2');
    h.svc.onDelivered(a.receipt, { sessionName: 's' });
    await h.svc.acceptSessionAck({ ackRefs: [a.ackRef], summary });
    expect(h.sent.filter((s) => s.ack.kind === 'read')).toHaveLength(0);
    h.clock.now += 61_000;
    await h.svc.flushPending();
    expect(h.sent.filter((s) => s.ack.kind === 'read')).toHaveLength(1);
    h.tracker.close();
  });
});

describe('D5 the watch', () => {
  const open = (h: ReturnType<typeof harness>, id: string, session = 'sess', thread = 't1') => {
    const a = prepared(h, id, thread);
    h.svc.onDelivered(a.receipt, { sessionName: session });
    return a;
  };

  it('reminds once at 5 minutes per session and peer, however large the burst', async () => {
    const h = harness();
    for (let i = 0; i < 50; i++) open(h, `b${i}`);
    h.clock.now += DEFAULT_REMINDER_MS - 1000;
    await h.svc.tick();
    expect(h.reminders).toHaveLength(0);
    h.clock.now += 1000;
    await h.svc.tick();
    await h.svc.tick();
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0].text).toContain('threadline_ack');
    h.tracker.close();
  });

  it('a headless one-shot worker gets no reminder; at 15 minutes the sender hears once', async () => {
    const h = harness({ lane: () => 'headless' });
    open(h, 'h1');
    h.clock.now += DEFAULT_REMINDER_MS + 1;
    await h.svc.tick();
    expect(h.reminders).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    h.clock.now = T0 + DEFAULT_ATTENTION_MS;
    await h.svc.tick();
    await h.svc.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].ack).toMatchObject({ kind: 'held', state: 'unacknowledged', refMessageIds: ['h1'] });
    expect(h.sent[0].text).toBe("A session has this and hasn't acknowledged it.");
    expect(h.tracker.peerHealth(PEER).requiredAck.unacknowledged).toBe(1);
    h.tracker.close();
  });

  it('an ended session goes to unacknowledged at once, with no reminder', async () => {
    const h = harness({ alive: () => false });
    open(h, 'g1');
    h.clock.now += 1000;
    await h.svc.tick();
    expect(h.reminders).toHaveLength(0);
    expect(h.sent[0]?.ack.state).toBe('unacknowledged');
    h.tracker.close();
  });

  it('the daily cap skips the reminder step, not the unacknowledged step', async () => {
    const h = harness();
    for (let i = 0; i < 21; i++) {
      open(h, `d${i}`, `s${i}`);
      h.clock.now += DEFAULT_REMINDER_MS;
      await h.svc.tick();
    }
    expect(h.reminders).toHaveLength(20);
    h.tracker.close();
  });

  it('a session-authored send closes open rows on that thread and peer only', () => {
    const h = harness();
    const a = open(h, 'r1');
    const b = open(h, 'r2', 'sess', 't2');
    h.svc.onSessionSendAccepted(PEER, 't1');
    expect(h.tracker.ackStore.watchForRef(a.ackRef)).toMatchObject({ status: 'closed', closeReason: 'replied' });
    expect(h.tracker.ackStore.watchForRef(b.ackRef)?.status).toBe('open');
    h.svc.onSessionSendAccepted(OTHER, 't2');
    expect(h.tracker.ackStore.watchForRef(b.ackRef)?.status).toBe('open');
    h.tracker.close();
  });

  it('a reply that beats the row: the row opens already closed', async () => {
    const h = harness();
    const a = prepared(h, 'rb');
    h.svc.onSessionSendAccepted(PEER, 't1');
    h.svc.onDelivered(a.receipt, { sessionName: 's' });
    expect(h.tracker.ackStore.watchForRef(a.ackRef)).toMatchObject({ status: 'closed', closeReason: 'replied' });
    h.clock.now += DEFAULT_ATTENTION_MS;
    await h.svc.tick();
    expect(h.sent).toHaveLength(0);
    h.tracker.close();
  });

  it('the drain path opens a row through the delivered callback', () => {
    const h = harness();
    const a = prepared(h, 'dr');
    h.svc.settleRouterResult(a, { delivered: false, spawnQueued: true, queued: true });
    expect(h.tracker.ackStore.watchForRef(a.ackRef)?.status).toBe('queued');
    h.svc.onDelivered(a.receipt, { sessionName: 'late', interactive: false });
    expect(h.tracker.ackStore.watchForRef(a.ackRef)).toMatchObject({ status: 'open', sessionName: 'late', launchLane: 'headless' });
    h.tracker.close();
  });

  it('a remote topic session is not watched, and health says so', () => {
    const h = harness();
    const a = prepared(h, 'rt');
    h.svc.settleRouterResult(a, { delivered: true, remoteTopic: true });
    expect(h.tracker.ackStore.watchForRef(a.ackRef)?.closeReason).toBe('remote-topic');
    expect(h.tracker.peerHealth(PEER).requiredAck.notWatchedRemoteTopic).toBe(1);
    h.tracker.close();
  });

  it('off: no reminders and no sends from the tick', async () => {
    const h = harness();
    open(h, 'o1');
    h.ctl.enabled = false;
    h.clock.now += DEFAULT_ATTENTION_MS;
    await h.svc.tick();
    expect(h.reminders).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    h.tracker.close();
  });

  it('closed rows are removed after 14 days by the tracker sweep', () => {
    const h = harness();
    const a = open(h, 'old');
    h.svc.onSessionSendAccepted(PEER, 't1');
    h.tracker.sweepSilence(T0 + 13 * 86_400_000);
    expect(h.tracker.ackStore.watchForRef(a.ackRef)).not.toBeNull();
    h.tracker.sweepSilence(Date.now() + 15 * 86_400_000);
    expect(h.tracker.ackStore.watchForRef(a.ackRef)).toBeNull();
    h.tracker.close();
  });
});

describe('D1 pending rows', () => {
  it('retry with doubling, coalesce per peer, and expire after an hour, counted on health', async () => {
    const h = harness({ routeKind: 'none' });
    for (const id of ['p1', 'p2', 'p3']) {
      const a = prepared(h, id);
      h.svc.settleRouterResult(a, { delivered: false, spawnQueued: true, queued: true });
      h.svc.onQueueDropped(a.receipt, 'expired');
    }
    await h.svc.flushPending();
    const first = h.tracker.ackStore.duePending(new Date(T0 + 29_000).toISOString());
    expect(first).toHaveLength(0);
    const after = h.tracker.ackStore.duePending(new Date(T0 + 31_000).toISOString());
    expect(after).toHaveLength(3);

    h.clock.now = T0 + 31_000;
    await h.svc.flushPending();
    expect(h.tracker.ackStore.duePending(new Date(T0 + 31_000 + 59_000).toISOString())).toHaveLength(0); // doubled

    h.ctl.routeKind = 'relay';
    h.clock.now = T0 + 31_000 + 61_000;
    await h.svc.flushPending();
    expect(h.sent).toHaveLength(1); // one wire ack for the three rows
    expect(h.sent[0].ack.refMessageIds.sort()).toEqual(['p1', 'p2', 'p3']);

    const again = prepared(h, 'late');
    h.svc.settleRouterResult(again, { delivered: false, spawnQueued: true, queued: true });
    h.ctl.routeKind = 'none';
    h.svc.onQueueDropped(again.receipt, 'expired');
    h.clock.now += PENDING_TTL_MS + 1000;
    await h.svc.flushPending();
    expect(h.tracker.peerHealth(PEER).requiredAck.pendingExpired).toBe(1);
    expect(h.tracker.peerHealth(PEER).requiredAck.pending).toBe(0);
    h.tracker.close();
  });

  it('pending rows retry after a restart with no relay yet', async () => {
    const h = harness({ routeKind: 'none' });
    const a = prepared(h, 'boot');
    h.svc.settleRouterResult(a, { delivered: false, spawnQueued: true, queued: true });
    const h2 = harness({ routeKind: 'none' }, h.tracker);
    h2.svc.recoverAfterRestart();
    await h2.svc.flushPending();
    expect(h2.sent).toHaveLength(0);
    h2.ctl.routeKind = 'relay';
    h2.clock.now += 31_000;
    await h2.svc.flushPending();
    expect(h2.sent[0].ack.state).toBe('unknown');
    h.tracker.close();
  });

  it('the holder side: refuses when off, standby, unsupported; sends from its row or the standby capability', () => {
    const h = harness();
    const relay: Extract<KindedAckRoute, { kind: 'relay' }> = { kind: 'relay', send: (peerFp, ack, text, opts) => { h.sent.push({ peerFp, ack, text, opts }); } };
    const payload = { peerFp: PEER, ack: { kind: 'read', refMessageIds: ['m'], summary: 's' }, text: 't', threadId: 'th', triggerEncrypted: true };
    expect(h.svc.handleForwardedAck(payload, { relay })).toEqual({ outcome: 'refused', reason: 'peer-does-not-support' });
    expect(h.svc.handleForwardedAck({ ...payload, ackKinds: 1 }, { relay })).toEqual({ outcome: 'sent' });
    expect(h.sent[0].opts.triggerEncrypted).toBe(true);
    expect(h.svc.handleForwardedAck({ ...payload, ackKinds: 1 }, { relay: null })).toMatchObject({ reason: 'holder-is-standby' });
    h.ctl.enabled = false;
    expect(h.svc.handleForwardedAck({ ...payload, ackKinds: 1 }, { relay })).toMatchObject({ reason: 'required-ack-disabled' });
    expect(h.svc.handleForwardedAck({ peerFp: PEER, ack: undefined, text: 't' } as any, { relay })).toMatchObject({ outcome: 'refused' });
    h.tracker.close();
  });
});

describe('a peer that rolled back', () => {
  it('a pending row to a peer that stopped advertising is closed, never sent', async () => {
    const h = harness();
    const a = prepared(h, 'rb1');
    h.svc.settleRouterResult(a, { delivered: false, spawnQueued: true, queued: true });
    h.sent.length = 0;
    h.ctl.routeKind = 'none';
    h.svc.onQueueDropped(a.receipt, 'expired');
    h.svc.notePeerMessage(PEER, { content: 'older build, no stamp' });
    h.ctl.routeKind = 'relay';
    h.clock.now += 31_000;
    await h.svc.flushPending();
    expect(h.sent).toHaveLength(0);
    expect(h.tracker.peerHealth(PEER).requiredAck.pending).toBe(0);
    h.tracker.close();
  });
});

describe('the router result refines the callback', () => {
  it('a thread the router resolved lands on a row the spawn callback already opened', () => {
    const h = harness();
    h.svc.notePeerMessage(PEER, STAMPED);
    const a = h.svc.prepare({ peerFp: PEER, messageId: 'nt', threadId: null, triggerEncrypted: false })!;
    h.svc.onDelivered(a.receipt, { sessionName: 's', interactive: false });
    h.svc.settleRouterResult(a, { delivered: true, threadId: 'minted', sessionName: 's' });
    expect(h.tracker.ackStore.watchForRef(a.ackRef)?.threadId).toBe('minted');
    h.svc.onSessionSendAccepted(PEER, 'minted');
    expect(h.tracker.ackStore.watchForRef(a.ackRef)?.closeReason).toBe('replied');
    h.tracker.close();
  });
});

describe('D6 what the sender can see', () => {
  it('peer health reports lastHeld and lastRead, with the summary labelled and sanitised', () => {
    const h = harness();
    h.tracker.recordSent({ messageId: 's1', peerFp: PEER, threadId: 't', transport: 'relay' });
    expect(h.tracker.peerHealth(PEER)).toMatchObject({ lastHeld: null, lastRead: null });
    h.tracker.recordHeld('s1', 'queued', 'session-limit');
    expect(h.tracker.peerHealth(PEER).lastHeld).toMatchObject({ messageId: 's1', state: 'queued', reason: 'session-limit' });
    h.tracker.recordRead('s1', 'line one\nline two');
    const read = h.tracker.peerHealth(PEER).lastRead;
    expect(read).toMatchObject({ messageId: 's1', summaryPeerText: 'line one line two' });
    expect(h.tracker.peerHealth(PEER).lastHeld).toBeNull();
    expect(h.tracker.receiptsForThread('t')[0]).toMatchObject({ heldState: 'read', readSummaryPeerText: 'line one line two' });
    h.tracker.close();
  });
});
