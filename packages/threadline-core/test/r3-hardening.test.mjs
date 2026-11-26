// Spec r3 hardening: key acceptance when pinning (D8), invite classification and host-neutral
// invite text (D4), and the encryptedSeen mark living in the pin record (D6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INVITE_HOW_TO, PinnedKeyStore, classifyInviteText, computeFingerprint, createInvite, encodeInvite,
  generateIdentityKeyPair, inviteMessage, isAcceptableIdentityKey,
} from '../dist/index.js';

const SMALL_ORDER = [
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
];

test('real identity keys are accepted; small-order, non-canonical and off-curve keys are not', () => {
  for (let i = 0; i < 20; i++) assert.equal(isAcceptableIdentityKey(generateIdentityKeyPair().publicKey), true);
  for (const h of SMALL_ORDER) assert.equal(isAcceptableIdentityKey(Buffer.from(h, 'hex')), false, h);
  // y = p (non-canonical encoding of y = 0)
  assert.equal(isAcceptableIdentityKey(Buffer.from('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex')), false);
  // x = 0 with the sign bit set
  assert.equal(isAcceptableIdentityKey(Buffer.from('0100000000000000000000000000000000000000000000000000000000000080', 'hex')), false);
  // y = 2 is not on the curve (control: off-curve keys exist and are refused)
  assert.equal(isAcceptableIdentityKey(Buffer.from('0200000000000000000000000000000000000000000000000000000000000000', 'hex')), false);
  assert.equal(isAcceptableIdentityKey(Buffer.alloc(31)), false);
});

test('the store refuses to pin a small-order key, and pins a real one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlc-r3-'));
  const s = new PinnedKeyStore(dir, undefined, () => {});
  const bad = SMALL_ORDER[3];
  assert.equal(s.recordInviteAccepted(bad.slice(0, 32), { peerIdentityPub: bad }), false);
  const good = generateIdentityKeyPair().publicKey.toString('hex');
  assert.equal(s.recordInviteAccepted(computeFingerprint(Buffer.from(good, 'hex')), { peerIdentityPub: good }), true);
});

test('encryptedSeen is set once in the pin record, survives verification, and goes with forget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlc-r3-'));
  let t = Date.parse('2026-10-16T00:00:00Z');
  const s = new PinnedKeyStore(dir, () => new Date(t), () => {});
  const key = generateIdentityKeyPair().publicKey.toString('hex');
  const fp = key.slice(0, 32);
  assert.equal(s.markEncryptedSeen(fp), false, 'no pin, no mark');
  s.recordInviteAccepted(fp, { peerIdentityPub: key });
  assert.equal(s.markEncryptedSeen(fp), true);
  const first = s.getProfileByFingerprint(fp).encryptedSeenAt;
  t += 60_000;
  s.markEncryptedSeen(fp);
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, first, 'earliest time kept');
  s.markInviteVerified(fp, { peerIdentityPub: key, via: 'invite' });
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, first, 'kept through verification');
  assert.equal(new PinnedKeyStore(dir, undefined, () => {}).getProfileByFingerprint(fp).encryptedSeenAt, first, 'persisted');
  s.forget(fp);
  s.recordInviteAccepted(fp, { peerIdentityPub: key });
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, undefined, 'forget removed it');
});

test('invite text is classified: a checksum-valid token is an invite, a look-alike is not', () => {
  const kp = generateIdentityKeyPair();
  const inv = createInvite({ identityPubHex: kp.publicKey.toString('hex'), owner: 'Justin', agent: 'echo' });
  const token = encodeInvite(inv);
  assert.equal(classifyInviteText(`here: ${token} thanks`), 'valid');
  assert.equal(classifyInviteText('history shows tlinv1:abc123'), 'lookalike');
  const damaged = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.equal(classifyInviteText(damaged), 'lookalike');
  assert.equal(classifyInviteText('no invite here'), null);
  // a look-alike first must not hide a real one after it
  assert.equal(classifyInviteText(`tlinv1:x.y and ${token}`), 'valid');
});

test('the invite message carries the host-neutral instruction', () => {
  const kp = generateIdentityKeyPair();
  const msg = inviteMessage(createInvite({ identityPubHex: kp.publicKey.toString('hex'), owner: 'Justin', agent: 'echo' }));
  assert.ok(msg.includes(INVITE_HOW_TO));
  assert.ok(msg.includes('not into the chat'));
  assert.equal(classifyInviteText(msg), 'valid');
});
