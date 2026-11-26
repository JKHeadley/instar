/**
 * threadline-core ↔ Instar wire compatibility (spec docs/specs/threadline-standalone-pairing.md D2).
 * Live keys, both directions: core-encrypted envelopes decrypt in Instar's MessageEncryptor and the
 * reverse, and both sides derive the same fingerprints, X25519 keys and pairing ids.
 */
import { describe, it, expect } from 'vitest';
import { MessageEncryptor } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair as instarKeys, derivePairingIdV2, edPublicToX25519 as instarEdToX } from '../../../src/threadline/ThreadlineCrypto.js';
import { EnvelopeCrypto, derivePairingId, edPublicToX25519, computeFingerprint } from '../../../packages/threadline-core/src/index.js';

describe('threadline-core ↔ Instar envelopes', () => {
  it('core → Instar: Instar decrypts and verifies what core encrypted', () => {
    const a = instarKeys(), b = instarKeys();
    const core = new EnvelopeCrypto(a.privateKey, a.publicKey);
    const instar = new MessageEncryptor(b.privateKey, b.publicKey);
    const env = core.encrypt(b.publicKey, edPublicToX25519(b.publicKey), 'thread-x', { content: 'from core', type: 'chat', metadata: { n: 1 } });
    expect(instar.decrypt(env, a.publicKey, instarEdToX(a.publicKey))).toEqual({ content: 'from core', type: 'chat', metadata: { n: 1 } });
  });

  it('Instar → core: core decrypts and verifies what Instar encrypted', () => {
    const a = instarKeys(), b = instarKeys();
    const instar = new MessageEncryptor(a.privateKey, a.publicKey);
    const core = new EnvelopeCrypto(b.privateKey, b.publicKey);
    const env = instar.encrypt(b.publicKey, core.x25519Public, 'thread-y', { content: 'from instar', type: 'pair-invite-ack' });
    expect(core.decrypt(env, a.publicKey, edPublicToX25519(a.publicKey))).toEqual({ content: 'from instar', type: 'pair-invite-ack' });
  });

  it('both derive the same fingerprint, X25519 key and pairing id', () => {
    const a = instarKeys(), b = instarKeys();
    expect(computeFingerprint(a.publicKey)).toBe(new MessageEncryptor(a.privateKey, a.publicKey).fingerprint);
    expect(edPublicToX25519(a.publicKey).equals(instarEdToX(a.publicKey))).toBe(true);
    expect(derivePairingId(a.publicKey, b.publicKey)).toBe(derivePairingIdV2(a.publicKey, b.publicKey));
  });
});
