import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindingHash,
  canonicalize,
  createBinding,
  createBindingRevocation,
  createRecord,
  createRevocation,
  createSuccessorBinding,
  generateWitnessKey,
  loadOrCreateWitnessKey,
  recordHash,
  verifyBinding,
  verifyRecord,
  verifySuccessor,
  WitnessStore,
} from '../dist/index.js';

const DAWN = 'did:web:api.moltbridge.ai:agents:dawn';
const ECHO = 'did:web:api.moltbridge.ai:agents:echo';
const T0 = new Date('2026-10-10T12:00:00.000Z');
const at = ms => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'witness-test-'));
}

/** An agent with a Threadline key, a Witness key and a seq 0 binding issued at T0. */
function agent(did) {
  const threadline = generateWitnessKey(); // same raw Ed25519 format Threadline uses
  const witness = generateWitnessKey();
  return { did, threadline, witness, binding: createBinding({ agent: did, threadline, witness, issuedAt: T0 }) };
}

function sample(a, over = {}) {
  return createRecord(
    {
      issuer: a.did,
      subject: ECHO,
      claim: 'collaborated',
      context: 'Reviewed the Witness v0 design together',
      evidence: ['threadline:thread-e45ab4ad'],
      confidence: 90,
      issuedAt: at(HOUR),
      ...over,
    },
    a.witness,
  );
}

function storeWith(...agents) {
  const store = new WitnessStore({ dir: tmpdir() });
  for (const a of agents) assert.equal(store.addBinding(a.binding).status, 'added');
  return store;
}

// ── canonical form ───────────────────────────────────────────────────

test('canonicalize: sorted keys, integers only, rejects what JSON would drop', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => canonicalize({ a: 0.5 }), /safe integers/);
  assert.throws(() => canonicalize({ a: -0 }), /safe integers/);
  assert.throws(() => canonicalize({ a: 2 ** 53 }), /safe integers/);
  assert.throws(() => canonicalize({ a: undefined }), /unsupported undefined/);
  assert.throws(() => canonicalize({ a: new Date() }), /plain objects/);
});

// ── records ──────────────────────────────────────────────────────────

test('record: verifies, defaults to 180 days, survives a reordered JSON round trip', () => {
  const a = agent(DAWN);
  const r = sample(a);
  assert.deepEqual(verifyRecord(r, a.witness.publicKey, at(HOUR)), { ok: true, expired: false });
  assert.equal(Date.parse(r.valid_until) - Date.parse(r.issued_at), 180 * 86_400_000);
  const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(r))).reverse());
  assert.equal(verifyRecord(reordered, a.witness.publicKey, at(HOUR)).ok, true);
  assert.equal(recordHash(reordered), recordHash(r));
});

test('record hash covers what was signed, not the signature bytes', () => {
  const a = agent(DAWN);
  const r = sample(a);
  const { signature, ...unsigned } = r;
  assert.equal(recordHash(r), recordHash(unsigned));
  assert.equal(recordHash({ ...r, signature: 'f'.repeat(128) }), recordHash(r));
  assert.notEqual(recordHash({ ...r, context: 'other' }), recordHash(r));
});

test('record: any change to a signed field breaks verification; extra fields are rejected', () => {
  const a = agent(DAWN);
  const r = sample(a);
  for (const [field, value] of [
    ['subject', 'did:web:api.moltbridge.ai:agents:mallory'],
    ['claim', 'completed'],
    ['confidence', 100],
    ['context', 'something else'],
    ['evidence', []],
    ['valid_until', '2099-01-01T00:00:00.000Z'],
  ]) {
    assert.equal(verifyRecord({ ...r, [field]: value }, a.witness.publicKey, at(HOUR)).ok, false, field);
  }
  assert.match(verifyRecord({ ...r, score: 99 }, a.witness.publicKey, at(HOUR)).reason, /unknown field score/);
  assert.match(verifyRecord(r, generateWitnessKey().publicKey, at(HOUR)).reason, /key_id/);
});

test('record: expiry and the future-time limit, on both sides of each boundary', () => {
  const a = agent(DAWN);
  const r = sample(a, { validUntil: at(HOUR + 1000) });
  assert.deepEqual(verifyRecord(r, a.witness.publicKey, at(HOUR + 999)), { ok: true, expired: false });
  assert.deepEqual(verifyRecord(r, a.witness.publicKey, at(HOUR + 1000)), { ok: true, expired: true });
  // issued_at is at(HOUR); a verifier 5 minutes behind accepts it, 5 minutes and 1 ms behind refuses it.
  assert.equal(verifyRecord(r, a.witness.publicKey, at(HOUR - 5 * 60_000)).ok, true);
  assert.match(verifyRecord(r, a.witness.publicKey, at(HOUR - 5 * 60_000 - 1)).reason, /future/);
});

test('record shape rules hold on both sides of each boundary', () => {
  const a = agent(DAWN);
  assert.doesNotThrow(() => sample(a, { confidence: 0 }));
  assert.doesNotThrow(() => sample(a, { confidence: 100 }));
  assert.throws(() => sample(a, { confidence: 101 }), /confidence/);
  assert.throws(() => sample(a, { confidence: -1 }), /confidence/);
  assert.throws(() => sample(a, { confidence: 0.9 }), /confidence/);
  assert.doesNotThrow(() => sample(a, { context: 'x'.repeat(2000) }));
  assert.throws(() => sample(a, { context: 'x'.repeat(2001) }), /context/);
  assert.throws(() => sample(a, { context: '' }), /context/);
  assert.throws(() => sample(a, { issuer: 'dawn' }), /issuer/);
  assert.throws(() => sample(a, { claim: 'trusted' }), /claim/);
  assert.throws(() => sample(a, { validUntil: at(HOUR) }), /after issued_at/);
  assert.throws(() => sample(a, { revokes: 'a'.repeat(64) }), /only allowed when claim is revoked/);
  assert.throws(() => sample(a, { claim: 'revoked' }), /must name the revoked record/);
});

test('revocations never lapse: they carry no valid_until, and one with valid_until is invalid', () => {
  const a = agent(DAWN);
  const rev = createRevocation(sample(a), 'filed in error', a.witness, at(2 * HOUR));
  assert.equal(rev.valid_until, undefined);
  assert.deepEqual(verifyRecord(rev, a.witness.publicKey, at(1000 * 86_400_000)), { ok: true, expired: false });
  assert.match(
    verifyRecord({ ...rev, valid_until: '2027-01-01T00:00:00.000Z' }, a.witness.publicKey, at(2 * HOUR)).reason,
    /never lapse/,
  );
});

// ── bindings ─────────────────────────────────────────────────────────

test('binding: both signatures and the fingerprint rule are enforced', () => {
  const a = agent(DAWN);
  const b = a.binding;
  assert.equal(b.threadline_fingerprint, a.threadline.publicKey.slice(0, 32));
  assert.equal(verifyBinding(b).ok, true);
  assert.equal(verifyBinding(b, b.threadline_fingerprint).ok, true);
  assert.match(verifyBinding(b, 'f'.repeat(32)).reason, /different Threadline fingerprint/);
  const other = generateWitnessKey();
  assert.equal(verifyBinding({ ...b, witness_public_key: other.publicKey, key_id: other.keyId }).ok, false);
  assert.match(verifyBinding({ ...b, threadline_fingerprint: other.publicKey.slice(0, 32) }).reason, /does not match/);
  assert.match(verifyBinding({ ...b, agent: ECHO }).reason, /bad threadline signature/);
  assert.match(verifyBinding({ ...b, supersedes: 'a'.repeat(64) }).reason, /seq 0/);
});

test('successor: linked by hash and signed by a key of the previous binding', () => {
  const a = agent(DAWN);
  const newWitness = generateWitnessKey();
  const next = createSuccessorBinding({
    previous: a.binding, threadline: a.threadline, witness: newWitness,
    previousSigner: 'threadline', previousKey: a.threadline, issuedAt: at(10 * HOUR),
  });
  assert.equal(verifyBinding(next).ok, true);
  assert.deepEqual(verifySuccessor(a.binding, next), { ok: true });
  assert.equal(next.supersedes, bindingHash(a.binding));

  // Signed by a key that was never in the previous binding.
  const stranger = generateWitnessKey();
  const forged = createSuccessorBinding({
    previous: a.binding, threadline: stranger, witness: stranger,
    previousSigner: 'witness', previousKey: stranger, issuedAt: at(10 * HOUR),
  });
  assert.match(verifySuccessor(a.binding, forged).reason, /bad previous_signature/);
  // Flipping which previous key it claims to be signed by fails too.
  assert.equal(verifySuccessor(a.binding, { ...next, previous_signer: 'witness' }).ok, false);
});

// ── store ────────────────────────────────────────────────────────────

test('store: a record counts only through a binding naming its issuer', () => {
  const dawn = agent(DAWN);
  const echo = agent(ECHO);
  const store = storeWith(dawn, echo);
  const r = sample(dawn);
  const added = store.add(r, at(HOUR));
  assert.equal(added.status, 'added');
  assert.equal(added.hash, recordHash(r));
  assert.equal(store.add(JSON.parse(JSON.stringify(r)), at(HOUR)).status, 'duplicate');
  assert.equal(store.status(added.hash, at(HOUR)), 'valid');

  // Echo's genuine key, but the record claims to be from Dawn: no Dawn binding has that key.
  const impostor = createRecord(
    { issuer: DAWN, subject: ECHO, claim: 'completed', context: 'x', confidence: 100, issuedAt: at(HOUR) },
    echo.witness,
  );
  assert.match(store.add(impostor, at(HOUR)).reason, /no binding of .*dawn covers key/);

  // A record dated before the binding existed is not covered by it.
  assert.equal(store.add(sample(dawn, { issuedAt: at(-1) }), at(HOUR)).status, 'rejected');
  assert.equal(store.add({ ...r, confidence: 1 }, at(HOUR)).status, 'rejected');
  assert.equal(store.list().length, 1, 'nothing rejected reaches disk');
});

test('store: rotation — old records stay valid, the old key stops counting after the successor', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const before = sample(dawn, { issuedAt: at(HOUR) });
  assert.equal(store.add(before, at(HOUR)).status, 'added');

  const newWitness = generateWitnessKey();
  const next = createSuccessorBinding({
    previous: dawn.binding, threadline: dawn.threadline, witness: newWitness,
    previousSigner: 'threadline', previousKey: dawn.threadline, issuedAt: at(10 * HOUR),
  });
  assert.equal(store.addBinding(next).status, 'added');

  assert.equal(store.status(recordHash(before), at(11 * HOUR)), 'valid');
  assert.equal(store.add(sample(dawn, { issuedAt: at(11 * HOUR) }), at(11 * HOUR)).status, 'rejected');
  assert.equal(store.add(sample({ ...dawn, witness: newWitness }, { issuedAt: at(11 * HOUR) }), at(11 * HOUR)).status, 'added');
});

test('store: a successor arriving before its predecessor is refused, then accepted in order', () => {
  const dawn = agent(DAWN);
  const next = createSuccessorBinding({
    previous: dawn.binding, threadline: dawn.threadline, witness: generateWitnessKey(),
    previousSigner: 'threadline', previousKey: dawn.threadline, issuedAt: at(10 * HOUR),
  });
  const store = new WitnessStore({ dir: tmpdir() });
  assert.match(store.addBinding(next).reason, /predecessor/);
  assert.equal(store.addBinding(dawn.binding).status, 'added');
  assert.equal(store.addBinding(next).status, 'added');
});

test('store: a fork marks the agent conflicted and stops its records counting', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const r = sample(dawn);
  const { hash } = store.add(r, at(HOUR));
  const mk = () => createSuccessorBinding({
    previous: dawn.binding, threadline: dawn.threadline, witness: generateWitnessKey(),
    previousSigner: 'witness', previousKey: dawn.witness, issuedAt: at(10 * HOUR),
  });
  assert.equal(store.addBinding(mk()).status, 'added');
  assert.equal(store.addBinding(mk()).status, 'conflict');
  assert.equal(store.isConflicted(DAWN), true);
  assert.equal(store.status(hash, at(HOUR)), 'conflicted');
  assert.equal(store.add(sample(dawn, { context: 'new' }), at(HOUR)).status, 'rejected');
});

test('store: binding revocation cuts off records from effective_from, keeps earlier ones', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const early = sample(dawn, { issuedAt: at(HOUR) });
  const late = sample(dawn, { issuedAt: at(3 * HOUR) });
  store.add(early, at(3 * HOUR));
  store.add(late, at(3 * HOUR));
  const rev = createBindingRevocation({
    binding: dawn.binding, signer: 'threadline', key: dawn.threadline,
    reason: 'witness key leaked', effectiveFrom: at(2 * HOUR), issuedAt: at(4 * HOUR),
  });
  assert.equal(store.addBindingRevocation(rev).status, 'added');
  assert.equal(store.status(recordHash(early), at(4 * HOUR)), 'valid');
  assert.equal(store.status(recordHash(late), at(4 * HOUR)), 'key-revoked');
  assert.match(store.add(sample(dawn, { issuedAt: at(2 * HOUR) }), at(4 * HOUR)).reason, /revoked/);

  const stranger = generateWitnessKey();
  const forged = createBindingRevocation({
    binding: dawn.binding, signer: 'witness', key: stranger,
    reason: 'x', effectiveFrom: at(0), issuedAt: at(4 * HOUR),
  });
  assert.match(store.addBindingRevocation(forged).reason, /bad signature/);
});

test('store: only the original issuer can revoke a record, and a revocation cannot be revoked', () => {
  const dawn = agent(DAWN);
  const echo = agent(ECHO);
  const store = storeWith(dawn, echo);
  const r = sample(dawn);
  const { hash } = store.add(r, at(HOUR));

  const notEchos = createRecord(
    { issuer: ECHO, subject: ECHO, claim: 'revoked', context: 'not mine to revoke', confidence: 100, issuedAt: at(HOUR), revokes: hash },
    echo.witness,
  );
  assert.equal(store.add(notEchos, at(HOUR)).status, 'added');
  assert.equal(store.status(hash, at(HOUR)), 'valid');

  const rev = createRevocation(r, 'filed in error', dawn.witness, at(2 * HOUR));
  const revAdded = store.add(rev, at(2 * HOUR));
  assert.equal(revAdded.status, 'added');
  assert.equal(store.status(hash, at(2 * HOUR)), 'revoked');
  assert.equal(store.status(hash, at(1000 * 86_400_000)), 'revoked', 'revocations never lapse');

  const revOfRev = createRevocation(rev, 'undo', dawn.witness, at(3 * HOUR));
  assert.match(store.add(revOfRev, at(3 * HOUR)).reason, /cannot be revoked/);
  assert.equal(store.status('0'.repeat(64)), 'unknown');
});

test('store: a file whose content no longer matches its name is not returned', () => {
  const dawn = agent(DAWN);
  const dir = tmpdir();
  const store = new WitnessStore({ dir });
  store.addBinding(dawn.binding);
  const { hash } = store.add(sample(dawn), at(HOUR));
  const file = path.join(dir, 'records', `${hash}.json`);
  const tampered = { ...JSON.parse(fs.readFileSync(file, 'utf8')), context: 'edited on disk' };
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.equal(store.get(hash), undefined);
  assert.equal(store.list().length, 0);
  assert.equal(store.status(hash, at(HOUR)), 'unknown');
});

// ── key file ─────────────────────────────────────────────────────────

test('key file: created once with 0600, reloaded unchanged, never overwritten', () => {
  const dir = tmpdir();
  const a = loadOrCreateWitnessKey(dir);
  assert.equal(a.created, true);
  assert.equal(fs.statSync(path.join(dir, 'witness-key.json')).mode & 0o777, 0o600);
  const b = loadOrCreateWitnessKey(dir);
  assert.equal(b.created, false);
  assert.deepEqual(b.key, a.key);
  fs.writeFileSync(path.join(dir, 'witness-key.json'), JSON.stringify({ ...a.key, publicKey: generateWitnessKey().publicKey }));
  assert.throws(() => loadOrCreateWitnessKey(dir), /does not match/);
});
