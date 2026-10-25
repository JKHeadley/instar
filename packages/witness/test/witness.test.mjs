import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RECOVERY_HOLD_MS,
  bindingHash,
  canonicalize,
  createBinding,
  createBindingRevocation,
  createRecord,
  createRevocation,
  createSuccessorBinding,
  createSuccessorVeto,
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
const HOLD = RECOVERY_HOLD_MS;

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
  for (const a of agents) assert.equal(store.addBinding(a.binding, {}, T0).status, 'added');
  return store;
}

/** A successor of `a`'s binding with fresh keys, signed by the given previous roles. */
function successor(a, roles, issuedAt, previous = a.binding) {
  const next = { threadline: generateWitnessKey(), witness: generateWitnessKey() };
  const previousKeys = Object.fromEntries(roles.map(r => [r, a[r]]));
  return { ...next, binding: createSuccessorBinding({ previous, ...next, previousKeys, issuedAt }) };
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

test('successor: reports which previous keys signed; a stranger or a bad signature fails', () => {
  const a = agent(DAWN);
  assert.deepEqual(verifySuccessor(a.binding, successor(a, ['witness', 'threadline'], at(10 * HOUR)).binding), {
    ok: true, signers: ['witness', 'threadline'],
  });
  assert.deepEqual(verifySuccessor(a.binding, successor(a, ['threadline'], at(10 * HOUR)).binding), { ok: true, signers: ['threadline'] });
  const stranger = { did: DAWN, binding: a.binding, witness: generateWitnessKey(), threadline: generateWitnessKey() };
  assert.match(verifySuccessor(a.binding, successor(stranger, ['witness'], at(10 * HOUR)).binding).reason, /bad witness signature/);
  // One good signature plus one bad one is a rejection, not a one-key successor.
  const good = successor(a, ['witness', 'threadline'], at(10 * HOUR)).binding;
  const mixed = { ...good, previous_signatures: { ...good.previous_signatures, threadline: 'f'.repeat(128) } };
  assert.match(verifySuccessor(a.binding, mixed).reason, /bad threadline signature/);
});

// ── store: chain rules ───────────────────────────────────────────────

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

  const impostor = createRecord(
    { issuer: DAWN, subject: ECHO, claim: 'completed', context: 'x', confidence: 100, issuedAt: at(HOUR) },
    echo.witness,
  );
  assert.match(store.add(impostor, at(HOUR)).reason, /no binding of .*dawn covers key/);
  assert.equal(store.add(sample(dawn, { issuedAt: at(-1) }), at(HOUR)).status, 'rejected', 'before the binding existed');
  assert.equal(store.add({ ...r, confidence: 1 }, at(HOUR)).status, 'rejected');
  assert.equal(store.list().length, 1, 'nothing rejected reaches disk');
});

test('store: bindings, revocations and vetoes dated in the future are refused', () => {
  const dawn = agent(DAWN);
  const store = new WitnessStore({ dir: tmpdir() });
  assert.match(store.addBinding(dawn.binding, {}, at(-5 * 60_000 - 1)).reason, /future/);
  assert.equal(store.addBinding(dawn.binding, {}, at(-5 * 60_000)).status, 'added');
  const rev = createBindingRevocation({
    binding: dawn.binding, keys: { threadline: dawn.threadline }, reason: 'x', effectiveFrom: at(HOUR), issuedAt: at(HOUR),
  });
  assert.match(store.addBindingRevocation(rev, at(0)).reason, /future/);
});

test('two-key rotation takes effect at once; old records stay valid, old key stops after it', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const before = sample(dawn, { issuedAt: at(HOUR) });
  store.add(before, at(HOUR));
  const next = successor(dawn, ['witness', 'threadline'], at(10 * HOUR));
  assert.equal(store.addBinding(next.binding, {}, at(10 * HOUR)).status, 'added');
  assert.equal(store.chain(DAWN, at(10 * HOUR)).links.length, 2);
  assert.equal(store.status(recordHash(before), at(11 * HOUR)), 'valid');
  assert.equal(store.add(sample(dawn, { issuedAt: at(11 * HOUR) }), at(11 * HOUR)).status, 'rejected');
  assert.equal(store.add(sample({ ...dawn, witness: next.witness }, { issuedAt: at(11 * HOUR) }), at(11 * HOUR)).status, 'added');
});

test('one-key successor is held for the full hold, measured from first-seen', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const seenAt = 10 * HOUR;
  const thief = successor(dawn, ['witness'], at(seenAt));
  store.addBinding(thief.binding, {}, at(seenAt));
  const c = store.chain(DAWN, at(seenAt + HOLD - 1));
  assert.equal(c.links.length, 1);
  assert.equal(c.pending.maturesAt, T0.getTime() + seenAt + HOLD);
  // While pending, the owner's key keeps working.
  assert.equal(store.add(sample(dawn, { issuedAt: at(seenAt + HOUR) }), at(seenAt + HOUR)).status, 'added');
  assert.equal(store.chain(DAWN, at(seenAt + HOLD)).links.length, 2);
});

test('backdating: a matured one-key successor cannot reach back past first-seen', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const ownerRecord = sample(dawn, { issuedAt: at(5 * HOUR) });
  store.add(ownerRecord, at(5 * HOUR));
  // The thief claims a time one second after the owner's binding, but this store first sees it at hour 10.
  const thief = successor(dawn, ['witness'], at(1000));
  store.addBinding(thief.binding, {}, at(10 * HOUR));
  const later = at(10 * HOUR + HOLD);
  assert.equal(store.chain(DAWN, later).links[1].start, T0.getTime() + 10 * HOUR);
  assert.equal(store.status(recordHash(ownerRecord), later), 'valid');
});

test('veto: the unsigned key can veto during the hold; the signing key cannot; a late veto is ignored', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const early = sample(dawn, { issuedAt: at(HOUR) });
  store.add(early, at(HOUR));
  const thief = successor(dawn, ['witness'], at(10 * HOUR));
  store.addBinding(thief.binding, {}, at(10 * HOUR));

  const selfVeto = createSuccessorVeto({ successor: thief.binding, signer: 'witness', key: dawn.witness, reason: 'x', issuedAt: at(11 * HOUR) });
  assert.match(store.addVeto(selfVeto, at(11 * HOUR)).reason, /did not sign/);

  const veto = createSuccessorVeto({ successor: thief.binding, signer: 'threadline', key: dawn.threadline, reason: 'not me', issuedAt: at(11 * HOUR) });
  assert.equal(store.addVeto(veto, at(11 * HOUR)).status, 'added');
  const c = store.chain(DAWN, at(11 * HOUR));
  assert.equal(c.conflict.seq, 1);
  assert.equal(c.conflict.reason, 'recovery was vetoed');
  // Records this store had before the conflict keep counting; new ones do not.
  assert.equal(store.status(recordHash(early), at(12 * HOUR)), 'valid');
  assert.match(store.add(sample(dawn, { issuedAt: at(12 * HOUR) }), at(12 * HOUR)).reason, /conflicting/);

  // Same shape, but the veto lands after the hold: it does not count.
  const dawn2 = agent(DAWN);
  const store2 = storeWith(dawn2);
  const thief2 = successor(dawn2, ['witness'], at(10 * HOUR));
  store2.addBinding(thief2.binding, {}, at(10 * HOUR));
  const late = createSuccessorVeto({ successor: thief2.binding, signer: 'threadline', key: dawn2.threadline, reason: 'late', issuedAt: at(10 * HOUR + HOLD) });
  store2.addVeto(late, at(10 * HOUR + HOLD));
  const c2 = store2.chain(DAWN, at(10 * HOUR + HOLD));
  assert.equal(c2.conflict, undefined);
  assert.equal(c2.links.length, 2);
});

test('a two-key rotation during the hold beats the pending one-key successor', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const thief = successor(dawn, ['witness'], at(10 * HOUR));
  store.addBinding(thief.binding, {}, at(10 * HOUR));
  const owner = successor(dawn, ['witness', 'threadline'], at(11 * HOUR));
  store.addBinding(owner.binding, {}, at(11 * HOUR));
  const c = store.chain(DAWN, at(10 * HOUR + HOLD + HOUR));
  assert.equal(c.conflict, undefined);
  assert.equal(c.links[1].hash, bindingHash(owner.binding));
});

test('a two-key rotation after a recovery already took effect is a fork', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const thief = successor(dawn, ['witness'], at(10 * HOUR));
  store.addBinding(thief.binding, {}, at(10 * HOUR));
  const owner = successor(dawn, ['witness', 'threadline'], at(10 * HOUR + HOLD + HOUR));
  store.addBinding(owner.binding, {}, at(10 * HOUR + HOLD + HOUR));
  assert.equal(store.chain(DAWN, at(10 * HOUR + HOLD + HOUR)).conflict.reason, 'rotation arrived after a recovery had taken effect');
});

test('conflict resolution: a person picks which binding to keep, and the chain continues', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const a1 = successor(dawn, ['witness', 'threadline'], at(10 * HOUR));
  const a2 = successor(dawn, ['witness', 'threadline'], at(10 * HOUR));
  store.addBinding(a1.binding, {}, at(10 * HOUR));
  store.addBinding(a2.binding, {}, at(10 * HOUR + 1));
  assert.equal(store.chain(DAWN, at(11 * HOUR)).conflict.reason, 'two different rotations');
  const r = sample({ ...dawn, witness: a1.witness }, { issuedAt: at(12 * HOUR) });
  assert.match(store.add(r, at(12 * HOUR)).reason, /conflicting/);

  assert.match(store.resolveConflict(DAWN, 1, 'f'.repeat(64), 'SAS compared', at(12 * HOUR)).reason, /no stored binding/);
  assert.equal(store.resolveConflict(DAWN, 1, bindingHash(a1.binding), 'SAS words compared with Dawn over Threadline', at(12 * HOUR)).status, 'added');
  assert.equal(store.chain(DAWN, at(12 * HOUR)).conflict, undefined);
  assert.equal(store.add(r, at(12 * HOUR)).status, 'added');
});

test('signature stripping: a stripped two-key rotation delivered first cannot be held or vetoed', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const owner = successor(dawn, ['witness', 'threadline'], at(10 * HOUR));
  const { threadline: _dropped, ...kept } = owner.binding.previous_signatures;
  const stripped = { ...owner.binding, previous_signatures: kept }; // now looks like a witness-only recovery
  assert.equal(bindingHash(stripped), bindingHash(owner.binding), 'same statement, different copy');

  assert.equal(store.addBinding(stripped, {}, at(10 * HOUR)).status, 'added');
  assert.equal(store.addBinding(owner.binding, {}, at(10 * HOUR + 1)).status, 'added', 'the full copy is kept, not a duplicate');
  // The thief holds the threadline key and vetoes as "the key that didn't sign": refused, it did sign another copy.
  const veto = createSuccessorVeto({ successor: stripped, signer: 'threadline', key: dawn.threadline, reason: 'x', issuedAt: at(10 * HOUR + 2) });
  assert.match(store.addVeto(veto, at(10 * HOUR + 2)).reason, /did not sign/);

  const c = store.chain(DAWN, at(10 * HOUR + 3));
  assert.equal(c.conflict, undefined);
  assert.equal(c.pending, undefined);
  assert.equal(c.links.length, 2, 'the rotation takes effect at once');
  assert.equal(store.add(sample(dawn, { issuedAt: at(11 * HOUR) }), at(11 * HOUR)).status, 'rejected', 'the old key is cut off');
});

test('signature stripping: a veto accepted before the full copy arrived stops counting once it does', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const owner = successor(dawn, ['witness', 'threadline'], at(10 * HOUR));
  const { threadline: _dropped, ...kept } = owner.binding.previous_signatures;
  store.addBinding({ ...owner.binding, previous_signatures: kept }, {}, at(10 * HOUR));
  const veto = createSuccessorVeto({ successor: owner.binding, signer: 'threadline', key: dawn.threadline, reason: 'x', issuedAt: at(10 * HOUR + 1) });
  assert.equal(store.addVeto(veto, at(10 * HOUR + 1)).status, 'added');
  assert.equal(store.chain(DAWN, at(10 * HOUR + 1)).conflict.reason, 'recovery was vetoed');
  store.addBinding(owner.binding, {}, at(10 * HOUR + 2));
  const c = store.chain(DAWN, at(10 * HOUR + 3));
  assert.equal(c.conflict, undefined);
  assert.equal(c.links.length, 2);
});

test('signature stripping: a stripped two-key revocation does not lose its backdating', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const mid = sample(dawn, { issuedAt: at(3 * HOUR) });
  store.add(mid, at(3 * HOUR));
  const full = createBindingRevocation({
    binding: dawn.binding, keys: { witness: dawn.witness, threadline: dawn.threadline },
    reason: 'compromised since hour 2', effectiveFrom: at(2 * HOUR), issuedAt: at(10 * HOUR),
  });
  const stripped = { ...full, signatures: { witness: full.signatures.witness } };
  assert.equal(store.addBindingRevocation(stripped, at(10 * HOUR)).status, 'added');
  assert.equal(store.status(recordHash(mid), at(10 * HOUR)), 'valid', 'one key alone cannot reach back');
  assert.equal(store.addBindingRevocation(full, at(10 * HOUR + 1)).status, 'added', 'the full copy is kept');
  assert.equal(store.status(recordHash(mid), at(10 * HOUR + 2)), 'key-revoked');
});

// ── store: binding revocation ────────────────────────────────────────

test('one-key revocation cannot reach back further than first-seen minus clock skew', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const early = sample(dawn, { issuedAt: at(HOUR) });
  const late = sample(dawn, { issuedAt: at(9 * HOUR + 56 * 60_000) });
  store.add(early, at(HOUR));
  store.add(late, at(9 * HOUR + 56 * 60_000));
  // Asks to void everything since T0, but is first seen at hour 10: clamp to 9:55.
  const rev = createBindingRevocation({
    binding: dawn.binding, keys: { witness: dawn.witness }, reason: 'key leaked', effectiveFrom: at(0), issuedAt: at(10 * HOUR),
  });
  assert.equal(store.addBindingRevocation(rev, at(10 * HOUR)).status, 'added');
  assert.equal(store.status(recordHash(early), at(11 * HOUR)), 'valid');
  assert.equal(store.status(recordHash(late), at(11 * HOUR)), 'key-revoked');
});

test('two-key revocation may backdate effective_from', () => {
  const dawn = agent(DAWN);
  const store = storeWith(dawn);
  const early = sample(dawn, { issuedAt: at(HOUR) });
  const mid = sample(dawn, { issuedAt: at(3 * HOUR) });
  store.add(early, at(3 * HOUR));
  store.add(mid, at(3 * HOUR));
  const rev = createBindingRevocation({
    binding: dawn.binding, keys: { witness: dawn.witness, threadline: dawn.threadline },
    reason: 'compromised since hour 2', effectiveFrom: at(2 * HOUR), issuedAt: at(10 * HOUR),
  });
  store.addBindingRevocation(rev, at(10 * HOUR));
  assert.equal(store.status(recordHash(early), at(11 * HOUR)), 'valid');
  assert.equal(store.status(recordHash(mid), at(11 * HOUR)), 'key-revoked');

  const forged = createBindingRevocation({
    binding: dawn.binding, keys: { witness: generateWitnessKey() }, reason: 'x', effectiveFrom: at(0), issuedAt: at(10 * HOUR),
  });
  assert.match(store.addBindingRevocation(forged, at(10 * HOUR)).reason, /bad witness signature/);
});

// ── store: records ───────────────────────────────────────────────────

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
  assert.equal(store.add(rev, at(2 * HOUR)).status, 'added');
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
  store.addBinding(dawn.binding, {}, T0);
  const { hash } = store.add(sample(dawn), at(HOUR));
  const file = path.join(dir, 'records', `${hash}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), context: 'edited on disk' }));
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
