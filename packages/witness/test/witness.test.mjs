import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalize,
  createBinding,
  createRecord,
  createRevocation,
  generateWitnessKey,
  loadOrCreateWitnessKey,
  recordHash,
  verifyBinding,
  verifyRecord,
  WitnessStore,
} from '../dist/index.js';

const DAWN = 'did:web:api.moltbridge.ai:agents:dawn';
const ECHO = 'did:web:api.moltbridge.ai:agents:echo';
const T0 = new Date('2026-10-10T12:00:00.000Z');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'witness-test-'));
}

function sample(key, over = {}) {
  return createRecord(
    {
      issuer: DAWN,
      subject: ECHO,
      claim: 'collaborated',
      context: 'Reviewed the Witness v0 design together',
      evidence: ['threadline:thread-e45ab4ad'],
      confidence: 0.9,
      issuedAt: T0,
      ...over,
    },
    key,
  );
}

test('canonicalize sorts keys at every depth and rejects values JSON would drop', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => canonicalize({ a: undefined }), /unsupported undefined/);
  assert.throws(() => canonicalize({ a: NaN }), /non-finite/);
  assert.throws(() => canonicalize({ a: new Date() }), /plain objects/);
});

test('a record verifies with its issuer key and defaults to 180 days', () => {
  const key = generateWitnessKey();
  const r = sample(key);
  assert.deepEqual(verifyRecord(r, key.publicKey, T0), { ok: true, expired: false });
  assert.equal(Date.parse(r.valid_until) - Date.parse(r.issued_at), 180 * 86_400_000);
  assert.equal(r.key_id, key.keyId);
});

test('a record survives a JSON round trip with reordered keys', () => {
  const key = generateWitnessKey();
  const r = sample(key);
  const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(r))).reverse());
  assert.equal(verifyRecord(reordered, key.publicKey, T0).ok, true);
});

test('any change to a signed field breaks verification', () => {
  const key = generateWitnessKey();
  const r = sample(key);
  for (const [field, value] of [
    ['subject', 'did:web:api.moltbridge.ai:agents:mallory'],
    ['claim', 'completed'],
    ['confidence', 1],
    ['context', 'something else'],
    ['evidence', []],
    ['valid_until', '2099-01-01T00:00:00.000Z'],
  ]) {
    const res = verifyRecord({ ...r, [field]: value }, key.publicKey, T0);
    assert.equal(res.ok, false, `tampering with ${field} must fail`);
  }
});

test('an added field is rejected, not silently ignored', () => {
  const key = generateWitnessKey();
  const res = verifyRecord({ ...sample(key), score: 99 }, key.publicKey, T0);
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown field score/);
});

test('the wrong key fails on key_id before the signature is even tried', () => {
  const a = generateWitnessKey();
  const b = generateWitnessKey();
  const res = verifyRecord(sample(a), b.publicKey, T0);
  assert.equal(res.ok, false);
  assert.match(res.reason, /key_id/);
});

test('expired is a genuine signature past valid_until, not a failure', () => {
  const key = generateWitnessKey();
  const r = sample(key, { validUntil: new Date(T0.getTime() + 1000) });
  assert.deepEqual(verifyRecord(r, key.publicKey, new Date(T0.getTime() + 999)), { ok: true, expired: false });
  assert.deepEqual(verifyRecord(r, key.publicKey, new Date(T0.getTime() + 1000)), { ok: true, expired: true });
});

test('shape rules hold on both sides of each boundary', () => {
  const key = generateWitnessKey();
  assert.doesNotThrow(() => sample(key, { confidence: 0 }));
  assert.doesNotThrow(() => sample(key, { confidence: 1 }));
  assert.throws(() => sample(key, { confidence: 1.01 }), /confidence/);
  assert.throws(() => sample(key, { confidence: -0.01 }), /confidence/);
  assert.doesNotThrow(() => sample(key, { context: 'x'.repeat(2000) }));
  assert.throws(() => sample(key, { context: 'x'.repeat(2001) }), /context/);
  assert.throws(() => sample(key, { context: '' }), /context/);
  assert.throws(() => sample(key, { issuer: 'dawn' }), /issuer/);
  assert.throws(() => sample(key, { claim: 'trusted' }), /claim/);
  assert.throws(() => sample(key, { validUntil: T0 }), /after issued_at/);
  assert.throws(() => sample(key, { revokes: 'a'.repeat(64) }), /only allowed when claim is revoked/);
  assert.throws(() => sample(key, { claim: 'revoked' }), /must name the revoked record/);
});

test('binding: both signatures and the fingerprint rule are enforced', () => {
  const threadline = generateWitnessKey(); // same Ed25519 raw-key format Threadline uses
  const witness = generateWitnessKey();
  const b = createBinding({ agent: DAWN, threadline, witness, issuedAt: T0 });
  assert.equal(b.threadline_fingerprint, threadline.publicKey.slice(0, 32));
  assert.equal(verifyBinding(b).ok, true);
  assert.equal(verifyBinding(b, b.threadline_fingerprint).ok, true);
  assert.match(verifyBinding(b, 'f'.repeat(32)).reason, /different Threadline fingerprint/);

  const other = generateWitnessKey();
  // Swapping in a key the publisher does not hold breaks the witness signature.
  assert.match(
    verifyBinding({ ...b, witness_public_key: other.publicKey, key_id: other.keyId }).reason,
    /bad threadline signature|bad witness signature/,
  );
  // Claiming another agent's fingerprint while signing with your own Threadline key fails.
  assert.match(verifyBinding({ ...b, threadline_fingerprint: other.publicKey.slice(0, 32) }).reason, /does not match/);
  assert.match(verifyBinding({ ...b, agent: ECHO }).reason, /bad threadline signature/);
});

test('store: verifies before storing, dedupes by content hash, refuses unknown issuers', () => {
  const dir = tmpdir();
  const key = generateWitnessKey();
  const store = new WitnessStore({ dir, resolveKey: (iss, kid) => (iss === DAWN && kid === key.keyId ? key.publicKey : undefined) });
  const r = sample(key);
  const first = store.add(r, T0);
  assert.equal(first.status, 'added');
  assert.equal(first.hash, recordHash(r));
  assert.equal(store.add(JSON.parse(JSON.stringify(r)), T0).status, 'duplicate');
  assert.equal(store.list().length, 1);

  assert.equal(store.add({ ...r, confidence: 0.1 }, T0).status, 'rejected');
  const stranger = generateWitnessKey();
  const res = store.add(sample(stranger), T0);
  assert.equal(res.status, 'rejected');
  assert.match(res.reason, /no known Witness key/);
  assert.equal(fs.readdirSync(path.join(dir, 'records')).length, 1, 'nothing rejected reaches disk');
});

test('store: only the original issuer can revoke', () => {
  const dir = tmpdir();
  const dawn = generateWitnessKey();
  const echo = generateWitnessKey();
  const keys = { [DAWN]: dawn, [ECHO]: echo };
  const store = new WitnessStore({ dir, resolveKey: (iss, kid) => (keys[iss]?.keyId === kid ? keys[iss].publicKey : undefined) });
  const r = sample(dawn);
  const { hash } = store.add(r, T0);
  assert.equal(store.status(hash, T0), 'valid');

  // Echo signs a "revocation" of Dawn's record: valid signature, but not the issuer's to revoke.
  const forged = createRecord(
    { issuer: ECHO, subject: ECHO, claim: 'revoked', context: 'not mine to revoke', confidence: 1, issuedAt: T0, revokes: hash },
    echo,
  );
  assert.equal(store.add(forged, T0).status, 'added');
  assert.equal(store.status(hash, T0), 'valid');

  assert.equal(store.add(createRevocation(r, 'filed in error', dawn, T0), T0).status, 'added');
  assert.equal(store.status(hash, T0), 'revoked');
  assert.equal(store.status('0'.repeat(64)), 'unknown');
});

test('key file: created once with 0600, reloaded unchanged, never overwritten', () => {
  const dir = tmpdir();
  const a = loadOrCreateWitnessKey(dir);
  assert.equal(a.created, true);
  assert.equal(fs.statSync(path.join(dir, 'witness-key.json')).mode & 0o777, 0o600);
  const b = loadOrCreateWitnessKey(dir);
  assert.equal(b.created, false);
  assert.deepEqual(b.key, a.key);

  const file = path.join(dir, 'witness-key.json');
  const bad = { ...a.key, publicKey: generateWitnessKey().publicKey };
  fs.writeFileSync(file, JSON.stringify(bad));
  assert.throws(() => loadOrCreateWitnessKey(dir), /does not match/);
});
