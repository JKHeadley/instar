/**
 * Spec threadline-standalone-pairing D9 (Echo's review of #2231): NO public send method puts a
 * plaintext `chat` envelope on the wire to a peer that encrypt-to-pinned enforces for. The
 * methods are ENUMERATED from the prototype, and an unclassified `send*` method fails the test,
 * so a new send path cannot slip past this. When the pin resolves, chat goes ENCRYPTED to it
 * (a redrive nudge through sendPlaintext becomes an encrypted nudge); when it cannot be resolved
 * (lookup-failed sentinel, resolver throw, malformed key) the send throws EncryptToPinnedSendError
 * and nothing is sent. Acks and invite-control plaintext keep their envelopes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  ThreadlineClient,
  EncryptToPinnedSendError,
  ENCRYPT_TO_LOOKUP_FAILED,
  type EncryptToResolver,
} from '../../src/threadline/client/ThreadlineClient.js';
import { decodePlaintextPayload } from '../../src/threadline/autoAck.js';

function keyFor(): { key: Buffer; fp: string } {
  const key = crypto.randomBytes(32);
  return { key, fp: key.subarray(0, 16).toString('hex') };
}

type Wire = Record<string, unknown>;
const isPlaintext = (e: Wire) => typeof e.payload === 'string' && !('ephemeralPubKey' in e);
const plaintextType = (e: Wire) => (decodePlaintextPayload(String(e.payload)) as { type?: string } | null)?.type ?? 'chat';

/** Every `send*` method on the prototype, classified. Unclassified → the test fails. */
const CHAT_SENDERS: Record<string, (c: ThreadlineClient, fp: string) => unknown> = {
  send: (c, fp) => c.send(fp, 'hi'),
  sendPlaintext: (c, fp) => c.sendPlaintext(fp, 'nudge', 'thread-1'),
  sendAuto: (c, fp) => c.sendAuto(fp, 'hi'),
  sendAutoWithThread: (c, fp) => c.sendAutoWithThread(fp, 'hi'),
};
const NOT_CHAT: Record<string, string> = {
  sendAck: 'typed ack: a delivery receipt, stays plaintext by design',
  sendInviteControlPlaintext: 'invite accept: the inviter holds no key yet (spec §4.3); typed op, not chat',
  sendCredentialToPinned: 'always encrypted to the given pinned key',
  sendPairVerifyReceipt: 'always encrypted to the given pinned key',
  sendNoticeToPinned: 'fixed server notice, always encrypted to the given pinned key',
  sendInviteControlToKey: 'always encrypted to the given key',
};
const PRIVATE = new Set(['sendPlaintextTyped', 'sendPlaintextRaw', 'sendToPinned', 'sendEncryptedKnown', 'sendPinnedOrFail']);

describe('no plaintext chat to an enforce-mode invite peer, by any public send method', () => {
  let client: ThreadlineClient;
  let wire: Wire[];
  let encrypted: Array<{ pk: Buffer; message: Record<string, unknown> }>;
  const peer = keyFor();

  beforeEach(() => {
    wire = []; encrypted = [];
    client = new ThreadlineClient({ name: 'T', stateDir: '/tmp/no-plaintext-chat-test' }, () => 1_791_144_650_402);
    const internals = client as unknown as Record<string, unknown>;
    internals.relayClient = { sendMessage: (e: Wire) => { wire.push(e); } };
    internals.identity = { fingerprint: 'self-fp', privateKey: crypto.randomBytes(32) };
    internals.encryptor = {
      encrypt: (pk: Buffer, _xk: Buffer, threadId: string, message: Record<string, unknown>, messageId?: string) => {
        encrypted.push({ pk, message });
        return { threadId, messageId: messageId ?? `msg-${encrypted.length}`, ephemeralPubKey: 'e', payload: 'ciphertext' };
      },
    };
    // Relay-supplied keys cached too: they must NOT be used for a pinned peer.
    (client as unknown as { knownAgents: Map<string, unknown> }).knownAgents.set(peer.fp, { publicKey: Buffer.alloc(32, 7), x25519PublicKey: Buffer.alloc(32, 8) });
  });

  it('every send* method on the prototype is classified', () => {
    const names = Object.getOwnPropertyNames(ThreadlineClient.prototype).filter((n) => /^send/.test(n));
    const unclassified = names.filter((n) => !(n in CHAT_SENDERS) && !(n in NOT_CHAT) && !PRIVATE.has(n));
    expect(unclassified).toEqual([]);
    // Control: the enumeration actually sees the methods (a broken filter would pass vacuously).
    expect(names).toEqual(expect.arrayContaining(['send', 'sendPlaintext', 'sendAuto', 'sendAck']));
  });

  it('pin resolves: every chat sender goes ENCRYPTED to the pinned key; none emits plaintext chat', () => {
    client.setEncryptToResolver((fp) => (fp === peer.fp ? peer.key : null));
    for (const [name, call] of Object.entries(CHAT_SENDERS)) {
      const before = encrypted.length;
      expect(() => call(client, peer.fp), name).not.toThrow();
      expect(encrypted.length, name).toBe(before + 1);
      expect(encrypted[encrypted.length - 1].pk.equals(peer.key), name).toBe(true);
    }
    expect(wire.filter((e) => isPlaintext(e) && plaintextType(e) === 'chat')).toEqual([]);
  });

  it('a redrive-style sendPlaintext nudge becomes an encrypted nudge (content and thread kept)', () => {
    client.setEncryptToResolver(() => peer.key);
    const id = client.sendPlaintext(peer.fp, 'nudge text', 'thread-redrive');
    expect(typeof id).toBe('string');
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0].message).toEqual({ content: 'nudge text' });
    expect(wire[0].threadId).toBe('thread-redrive');
  });

  const unresolvable: Array<[string, EncryptToResolver, RegExp]> = [
    ['lookup-failed sentinel', () => ENCRYPT_TO_LOOKUP_FAILED, /lookup-failed/],
    ['resolver throws', () => { throw new Error('store down'); }, /resolver-error/],
    ['key for another agent', () => keyFor().key, /malformed-pinned-key/],
    ['key of the wrong length', () => Buffer.concat([peer.key, Buffer.alloc(1)]), /malformed-pinned-key/],
  ];
  for (const [label, resolver, reason] of unresolvable) {
    it(`pin unresolvable (${label}): every chat sender throws EncryptToPinnedSendError and nothing is sent`, () => {
      client.setEncryptToResolver(resolver);
      for (const [name, call] of Object.entries(CHAT_SENDERS)) {
        let err: unknown;
        try { call(client, peer.fp); } catch (e) { err = e; }
        expect(err, name).toBeInstanceOf(EncryptToPinnedSendError);
        expect(String((err as Error).message), name).toMatch(reason);
      }
      expect(wire).toEqual([]);
      expect(encrypted).toEqual([]);
      expect(client.hasEncryptedSendPath(peer.fp)).toBe(false);
    });
  }

  it('acks and invite-control plaintext keep their plaintext envelopes (typed, not chat)', () => {
    client.setEncryptToResolver(() => peer.key);
    client.sendAck(peer.fp, 'received');
    client.sendInviteControlPlaintext(peer.fp, 'pair-invite-accept', { x: 1 });
    expect(wire.map((e) => (isPlaintext(e) ? plaintextType(e) : 'encrypted'))).toEqual(['ack', 'pair-invite-accept']);
  });

  it('a non-pinned peer (resolver null) still gets plaintext chat as before', () => {
    client.setEncryptToResolver(() => null);
    client.sendPlaintext(keyFor().fp, 'to a stranger');
    expect(wire).toHaveLength(1);
    expect(isPlaintext(wire[0]) && plaintextType(wire[0])).toBe('chat');
  });
});
