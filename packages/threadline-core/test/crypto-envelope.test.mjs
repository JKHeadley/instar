// threadline-core crypto + envelope. Compatibility is proven against vectors produced by
// INSTAR'S OWN CODE (fixtures/instar-vectors.json, see generate-instar-vectors.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EnvelopeCrypto, canonicalizeEnvelope, computeFingerprint, derivePairingId, deriveX25519PublicKey, edPublicToX25519,
  generateIdentityKeyPair, isX25519BoundToIdentity, publicKeyFromSeed, sign, verify,
} from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'instar-vectors.json'), 'utf8'));
const hex = (h) => Buffer.from(h, 'hex');

test('keys, fingerprints and X25519 derivations match Instar exactly', () => {
  for (const who of [V.alice, V.bob]) {
    const pub = publicKeyFromSeed(hex(who.seed));
    assert.equal(pub.toString('hex'), who.pub);
    assert.equal(computeFingerprint(pub), who.fp);
    assert.equal(deriveX25519PublicKey(hex(who.seed)).toString('hex'), who.x25519FromSeed);
    assert.equal(edPublicToX25519(pub).toString('hex'), who.x25519FromPub);
    // the seed-derived and public-key-derived X25519 keys are the same key
    assert.equal(who.x25519FromSeed, who.x25519FromPub);
    assert.equal(isX25519BoundToIdentity(pub, hex(who.x25519FromPub)), true);
  }
});

test('the pairing id matches Instar and does not depend on argument order', () => {
  assert.equal(derivePairingId(hex(V.alice.pub), hex(V.bob.pub)), V.pairingId);
  assert.equal(derivePairingId(hex(V.bob.pub), hex(V.alice.pub)), V.pairingId);
});

test('core decrypts and verifies envelopes Instar encrypted', () => {
  const bob = new EnvelopeCrypto(hex(V.bob.seed), hex(V.bob.pub));
  for (const { message, envelope } of V.envelopesAliceToBob) {
    const out = bob.decrypt(envelope, hex(V.alice.pub), edPublicToX25519(hex(V.alice.pub)));
    assert.deepEqual(out, message);
  }
});

test('a tampered Instar envelope is refused (payload, a signed field, or the signature)', () => {
  const bob = new EnvelopeCrypto(hex(V.bob.seed), hex(V.bob.pub));
  const { envelope } = V.envelopesAliceToBob[0];
  const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  const aliceX = edPublicToX25519(hex(V.alice.pub));
  assert.throws(() => bob.decrypt({ ...envelope, payload: flip(envelope.payload) }, hex(V.alice.pub), aliceX));
  assert.throws(() => bob.decrypt({ ...envelope, threadId: 'other' }, hex(V.alice.pub), aliceX));
  assert.throws(() => bob.decrypt({ ...envelope, signature: flip(envelope.signature) }, hex(V.alice.pub), aliceX));
  // signed by someone else: wrong sender key
  assert.throws(() => bob.decrypt(envelope, hex(V.bob.pub), aliceX));
});

test('round trip core → core, and the envelope is addressed by fingerprint', () => {
  const a = generateIdentityKeyPair(), b = generateIdentityKeyPair();
  const A = new EnvelopeCrypto(a.privateKey, a.publicKey), B = new EnvelopeCrypto(b.privateKey, b.publicKey);
  const env = A.encrypt(b.publicKey, edPublicToX25519(b.publicKey), 't1', { content: 'hi', type: 'chat' });
  assert.equal(env.from, computeFingerprint(a.publicKey));
  assert.equal(env.to, computeFingerprint(b.publicKey));
  assert.deepEqual(B.decrypt(env, a.publicKey, edPublicToX25519(a.publicKey)), { content: 'hi', type: 'chat' });
  // a third party cannot read it
  const c = generateIdentityKeyPair();
  assert.throws(() => new EnvelopeCrypto(c.privateKey, c.publicKey).decrypt(env, a.publicKey, edPublicToX25519(a.publicKey)));
  // decrypt refuses a static key that does not belong to the signing identity
  assert.throws(() => B.decrypt(env, a.publicKey, edPublicToX25519(c.publicKey)), /not bound to the sender identity/);
});

test('sign/verify, and verify never throws on garbage', () => {
  const k = generateIdentityKeyPair();
  const sig = sign(k.privateKey, Buffer.from('m'));
  assert.equal(verify(k.publicKey, Buffer.from('m'), sig), true);
  assert.equal(verify(k.publicKey, Buffer.from('n'), sig), false);
  assert.equal(verify(Buffer.alloc(3), Buffer.from('m'), sig), false);
  assert.equal(isX25519BoundToIdentity(Buffer.alloc(3), Buffer.alloc(32)), false);
});

test('canonical form: keys sorted, signature left out, no spaces (what both sides sign)', () => {
  assert.equal(canonicalizeEnvelope({ b: 1, signature: 'x', a: 'y' }), '{"a":"y","b":1}');
});
