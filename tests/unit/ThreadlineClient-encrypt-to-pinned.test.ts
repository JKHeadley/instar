/**
 * Ordinary chat to a peer paired by invite is always encrypted to the PINNED key
 * (spec threadline-standalone-pairing D6, step 9). The bootstrap decides which peers qualify;
 * the client only trusts a resolver key that belongs to the recipient.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { ThreadlineClient } from '../../src/threadline/client/ThreadlineClient.js';
import { edPublicToX25519 } from '../../src/threadline/ThreadlineCrypto.js';

interface Enc { pk: Buffer; xk: Buffer; threadId: string; message: Record<string, unknown>; messageId?: string }

function keyFor(): { key: Buffer; fp: string } {
  const key = crypto.randomBytes(32);
  return { key, fp: key.subarray(0, 16).toString('hex') };
}

describe('ThreadlineClient: encrypt ordinary chat to the pinned key', () => {
  let client: ThreadlineClient;
  let encrypted: Enc[];
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    encrypted = []; sent = [];
    client = new ThreadlineClient({ name: 'T', stateDir: '/tmp/encrypt-to-pinned-test' }, () => 1_791_144_650_402);
    const internals = client as unknown as Record<string, unknown>;
    internals.relayClient = { sendMessage: (e: Record<string, unknown>) => { sent.push(e); } };
    internals.identity = { fingerprint: 'self-fp' };
    internals.encryptor = {
      encrypt: (pk: Buffer, xk: Buffer, threadId: string, message: Record<string, unknown>, messageId?: string) => {
        encrypted.push({ pk, xk, threadId, message, messageId });
        return { threadId, messageId: messageId ?? `msg-${encrypted.length}`, ephemeralPubKey: 'e' };
      },
    };
  });

  it('a resolver key for the recipient: encrypted to it (and its derived X25519) with no cached keys', () => {
    const peer = keyFor();
    client.setEncryptToResolver((fp) => (fp === peer.fp ? peer.key : null));
    const id = client.sendAuto(peer.fp, 'hello', undefined, 'msg-given', true);
    expect(id).toBe('msg-given');
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0].pk.equals(peer.key)).toBe(true);
    expect(encrypted[0].xk.equals(edPublicToX25519(peer.key))).toBe(true);
    expect(encrypted[0].message).toEqual({ content: 'hello', resend: true });
    expect(client.hasEncryptedSendPath(peer.fp)).toBe(true);
  });

  it('it takes precedence over keys the relay supplied', () => {
    const peer = keyFor();
    (client as unknown as { knownAgents: Map<string, unknown> }).knownAgents.set(peer.fp, { publicKey: Buffer.alloc(32, 7), x25519PublicKey: Buffer.alloc(32, 8) });
    client.setEncryptToResolver(() => peer.key);
    client.sendAuto(peer.fp, 'x');
    expect(encrypted[0].pk.equals(peer.key)).toBe(true);
  });

  it('a key that does not belong to the recipient, or a resolver that throws, is ignored (previous rule applies)', () => {
    const peer = keyFor(), other = keyFor();
    client.setEncryptToResolver(() => other.key);
    client.sendAuto(peer.fp, 'not to the wrong key');
    expect(encrypted).toHaveLength(0);
    expect(sent).toHaveLength(1); // plaintext, as before: no cached keys
    expect(client.hasEncryptedSendPath(peer.fp)).toBe(false);
    client.setEncryptToResolver(() => { throw new Error('store unavailable'); });
    client.sendAuto(peer.fp, 'again');
    expect(encrypted).toHaveLength(0);
    expect(sent).toHaveLength(2);
  });

  it('no resolver, or one returning null: unchanged behaviour', () => {
    const peer = keyFor();
    client.sendAuto(peer.fp, 'a');
    client.setEncryptToResolver(() => null);
    client.sendAuto(peer.fp, 'b');
    expect(encrypted).toHaveLength(0);
    expect(sent).toHaveLength(2);
  });
});
