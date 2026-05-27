/**
 * Tier-1 data-flow test for the live-tail RECEIVER path (spec §8 G3b/c).
 *
 * Proves the exact contract the server.ts /api/live-tail receiver closure relies
 * on: a flush encrypted by the holder for the standby's X25519 key round-trips
 * through encryptForSync → decryptFromSync, and applies (sequence-deduped) into
 * the LiveTailBuffer. Plus the security-negative: a machine that is NOT the
 * intended recipient cannot decrypt the tail (only the holder of the matching
 * X25519 private key can read it).
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encryptForSync, decryptFromSync } from '../../src/core/SecretStore.js';
import { LiveTailBuffer } from '../../src/core/LiveTailBuffer.js';

/** An X25519 keypair: { pubB64 (SPKI DER base64), priv (KeyObject) } — mirrors a machine's encryption key. */
function x25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { pubB64, priv: privateKey };
}

/** The receiver closure, exactly as wired in server.ts. */
function receive(buffer: LiveTailBuffer, ownPriv: crypto.KeyObject, flush: { topic: string; seq: number; enc: any }) {
  const decrypted = decryptFromSync(flush.enc, ownPriv) as { content?: unknown };
  const content = typeof decrypted.content === 'string' ? decrypted.content : '';
  return buffer.applyFlush({ topic: flush.topic, seq: flush.seq, content });
}

describe('live-tail receiver path (decrypt → sequence-deduped apply)', () => {
  it('round-trips an encrypted flush from holder to standby buffer', () => {
    const standby = x25519Pair();
    const buffer = new LiveTailBuffer({ outOfOrderTimeoutMs: 60_000, maxBytesPerTopic: 256 * 1024 });

    // Holder encrypts for the standby's public key (as server.ts encryptFor does).
    const enc1 = encryptForSync({ content: 'user: hello\n' }, standby.pubB64);
    const r1 = receive(buffer, standby.priv, { topic: '13481', seq: 1, enc: enc1 });
    expect(r1?.applied).toBe(true);

    const enc2 = encryptForSync({ content: 'agent: hi there\n' }, standby.pubB64);
    const r2 = receive(buffer, standby.priv, { topic: '13481', seq: 2, enc: enc2 });
    expect(r2?.applied).toBe(true);

    expect(buffer.getTail('13481').content).toBe('user: hello\nagent: hi there\n');
    expect(buffer.getLastAppliedSeq('13481')).toBe(2);
  });

  it('drops a replayed flush (no double-append corrupting the context window)', () => {
    const standby = x25519Pair();
    const buffer = new LiveTailBuffer({ outOfOrderTimeoutMs: 60_000, maxBytesPerTopic: 256 * 1024 });
    const enc = encryptForSync({ content: 'X' }, standby.pubB64);
    expect(receive(buffer, standby.priv, { topic: 't', seq: 1, enc })?.applied).toBe(true);
    // At-least-once redelivery of the same seq → dropped.
    const encReplay = encryptForSync({ content: 'X' }, standby.pubB64);
    const replay = receive(buffer, standby.priv, { topic: 't', seq: 1, enc: encReplay });
    expect(replay?.applied).toBe(false);
    expect(replay?.reason).toBe('duplicate');
    expect(buffer.getTail('t').content).toBe('X'); // not 'XX'
  });

  it('SECURITY: a non-recipient machine cannot decrypt the tail', () => {
    const standby = x25519Pair();
    const eavesdropper = x25519Pair();
    const buffer = new LiveTailBuffer({ outOfOrderTimeoutMs: 60_000, maxBytesPerTopic: 256 * 1024 });
    const enc = encryptForSync({ content: 'secret conversation' }, standby.pubB64);
    // The wrong private key must fail the AES-GCM auth tag → throw (route → 400).
    expect(() => receive(buffer, eavesdropper.priv, { topic: 't', seq: 1, enc })).toThrow();
  });
});
