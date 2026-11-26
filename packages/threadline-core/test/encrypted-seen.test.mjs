// The encryptedSeen mark as a unified record (spec D6, D11, rollout step 6): set once, merged as a
// union keeping the earliest time, removed only when the person unpairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PinnedKeyStore, earliestMark, generateIdentityKeyPair, isMarkTime, unifyEncryptedSeen } from '../dist/index.js';

const T1 = '2026-10-16T00:00:00.000Z';
const T2 = '2026-10-16T00:05:00.000Z';
const T3 = '2026-10-16T00:10:00.000Z';
const num = (a, b) => a - b;
const newKey = () => generateIdentityKeyPair().publicKey.toString('hex');

test('earliestMark keeps the earliest valid time and never clears', () => {
  assert.equal(earliestMark(T2, T1), T1);
  assert.equal(earliestMark(T1, T2), T1);
  assert.equal(earliestMark(undefined, T2), T2);
  assert.equal(earliestMark(T2, undefined), T2, 'a holder with no mark never removes one');
  assert.equal(earliestMark(T2, 'not a date'), T2, 'an invalid side is ignored');
  assert.equal(earliestMark(undefined, '<x>'), undefined);
  assert.equal(isMarkTime(T1), true);
  assert.equal(isMarkTime(''), false);
  assert.equal(isMarkTime(5), false);
});

test('union merge: earliest seen time for the pinned key, whatever order the holders report in', () => {
  const key = newKey();
  const events = [
    { kind: 'seen', peerIdentityPub: key, at: T3, order: 3 },
    { kind: 'seen', peerIdentityPub: key, at: T1, order: 1 },
    { kind: 'seen', peerIdentityPub: key, at: T2, order: 2 },
  ];
  assert.equal(unifyEncryptedSeen(events, key, num), T1);
  assert.equal(unifyEncryptedSeen([...events].reverse(), key, num), T1, 'order of arrival does not matter');
  // Commutative / idempotent: merging a holder's mark twice changes nothing.
  assert.equal(unifyEncryptedSeen([...events, ...events], key, num), T1);
});

test('a mark for another key never counts (a new key is a new agent)', () => {
  const key = newKey();
  const other = newKey();
  assert.equal(unifyEncryptedSeen([{ kind: 'seen', peerIdentityPub: other, at: T1, order: 1 }], key, num), undefined);
  assert.equal(unifyEncryptedSeen([{ kind: 'seen', peerIdentityPub: key, at: T1, order: 1 }], 'zz', num), undefined, 'no valid pin, no mark');
});

test('removed only by an unpair: an unpair after a mark cancels it; a mark after the unpair stands', () => {
  const key = newKey();
  const seen1 = { kind: 'seen', peerIdentityPub: key, at: T1, order: 1 };
  const unpair = { kind: 'unpaired', peerIdentityPub: key, order: 2 };
  const seen3 = { kind: 'seen', peerIdentityPub: key, at: T3, order: 3 };
  assert.equal(unifyEncryptedSeen([seen1, unpair], key, num), undefined, 'unpair removes the earlier mark');
  assert.equal(unifyEncryptedSeen([seen1, unpair, seen3], key, num), T3, 're-paired and spoke encrypted again');
  // An unpair for a DIFFERENT key removes nothing.
  assert.equal(unifyEncryptedSeen([seen1, { kind: 'unpaired', peerIdentityPub: newKey(), order: 2 }], key, num), T1);
  // An unpair that names no key applies to every key.
  assert.equal(unifyEncryptedSeen([seen1, { kind: 'unpaired', order: 2 }], key, num), undefined);
  // An unpair BEFORE the mark does not touch it.
  assert.equal(unifyEncryptedSeen([{ kind: 'unpaired', peerIdentityPub: key, order: 0 }, seen1], key, num), T1);
});

test('PinnedKeyStore: mergeEncryptedSeen keeps the earliest, needs the same pin, and the mark goes only with forget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlc-seen-'));
  let t = Date.parse(T2);
  const s = new PinnedKeyStore(dir, () => new Date(t), () => {});
  const key = newKey();
  const fp = key.slice(0, 32);
  assert.equal(s.mergeEncryptedSeen(fp, key, T1), false, 'no pin, nothing to merge into');
  s.recordInviteAccepted(fp, { peerIdentityPub: key });
  s.markEncryptedSeen(fp); // local mark at T2
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, T2);
  assert.equal(s.mergeEncryptedSeen(fp, key, T3), false, 'a later mark never moves it');
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, T2);
  assert.equal(s.mergeEncryptedSeen(fp, newKey(), T1), false, 'a mark for another key is ignored');
  assert.equal(s.mergeEncryptedSeen(fp, key, T1), true, 'an earlier mark from another holder wins');
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, T1);
  assert.equal(s.mergeEncryptedSeen(fp, key, 'garbage'), false);
  t += 60_000;
  s.markEncryptedSeen(fp);
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, T1, 'set once');
  s.demoteInvitePairing(fp, 'second accept');
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, T1, 'a pause is not an unpair');
  assert.equal(new PinnedKeyStore(dir, undefined, () => {}).getProfileByFingerprint(fp).encryptedSeenAt, T1, 'persisted');
  s.forget(fp);
  s.recordInviteAccepted(fp, { peerIdentityPub: key });
  assert.equal(s.getProfileByFingerprint(fp).encryptedSeenAt, undefined, 'forget (unpair) removed it');
});
