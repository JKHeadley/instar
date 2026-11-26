/**
 * threadline-core PinnedKeyStore and the credential gate (spec threadline-standalone-pairing D1, D7).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PinnedKeyStore, credentialSendKey, credentialAcceptFrom, PINNED_KEYS_FILE } from '../../../packages/threadline-core/src/trust.js';
import { generateIdentityKeyPair, edPublicToX25519 } from '../../../packages/threadline-core/src/crypto.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tl-core-trust-'));
const keyHex = () => generateIdentityKeyPair().publicKey.toString('hex');
const fpOf = (k: string) => k.slice(0, 32);

describe('PinnedKeyStore', () => {
  it('an accepted invite pins the inviter but is not credential-eligible; a finish makes it eligible', () => {
    const own = keyHex(), peer = keyHex();
    const s = new PinnedKeyStore(dir());
    expect(s.recordInviteAccepted(fpOf(peer), { peerIdentityPub: peer, displayName: 'scout', ownFp: fpOf(own) })).toBe(true);
    expect(s.getProfileByFingerprint(fpOf(peer))).toMatchObject({ pairingState: 'invite-accepted', peerIdentityPub: peer, agent: 'scout' });
    expect(s.isCredentialShareAllowedByFingerprint(fpOf(peer))).toBe(false);
    expect(s.markInviteVerified(fpOf(peer), { peerIdentityPub: peer, via: 'test', ownIdentityPub: own })).toBe(true);
    expect(s.isCredentialShareAllowedByFingerprint(fpOf(peer))).toBe(true);
  });

  it('never swaps a verified pin, refuses a key that does not match its fingerprint, and refuses itself', () => {
    const own = keyHex(), peer = keyHex(), other = keyHex();
    const s = new PinnedKeyStore(dir());
    s.markInviteVerified(fpOf(peer), { peerIdentityPub: peer, via: 't', ownIdentityPub: own });
    const forged = fpOf(peer) + other.slice(32); // same fingerprint, different key
    expect(s.markInviteVerified(fpOf(peer), { peerIdentityPub: forged, via: 't', ownIdentityPub: own })).toBe(false);
    expect(s.recordInviteAccepted(fpOf(peer), { peerIdentityPub: forged })).toBe(false);
    expect(s.getProfileByFingerprint(fpOf(peer))?.peerIdentityPub).toBe(peer);
    expect(s.recordInviteAccepted(fpOf(other), { peerIdentityPub: peer })).toBe(false); // fp/key mismatch
    expect(s.recordInviteAccepted(fpOf(own), { peerIdentityPub: own, ownFp: fpOf(own) })).toBe(false); // self
    // a verified pin for the SAME key is left verified by a later accept
    expect(s.recordInviteAccepted(fpOf(peer), { peerIdentityPub: peer })).toBe(true);
    expect(s.isCredentialShareAllowedByFingerprint(fpOf(peer))).toBe(true);
  });

  it('a demotion pauses eligibility', () => {
    const own = keyHex(), peer = keyHex();
    const s = new PinnedKeyStore(dir());
    s.markInviteVerified(fpOf(peer), { peerIdentityPub: peer, via: 't', ownIdentityPub: own });
    expect(s.demoteInvitePairing(fpOf(peer), 'leak')).toBe(true);
    expect(s.getProfileByFingerprint(fpOf(peer))?.pairingState).toBe('invite-accepted');
    expect(s.isCredentialShareAllowedByFingerprint(fpOf(peer))).toBe(false);
  });

  it('persists 0600 across a restart; an unreadable file pins nothing', () => {
    const d = dir(), own = keyHex(), peer = keyHex();
    new PinnedKeyStore(d).markInviteVerified(fpOf(peer), { peerIdentityPub: peer, via: 't', ownIdentityPub: own });
    const f = path.join(d, 'threadline', PINNED_KEYS_FILE);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(new PinnedKeyStore(d).isCredentialShareAllowedByFingerprint(fpOf(peer))).toBe(true);
    fs.writeFileSync(f, '{not json');
    expect(new PinnedKeyStore(d).list()).toEqual([]);
  });
});

describe('credential gate', () => {
  it('refuses an unknown, unverified or paused peer', () => {
    const own = keyHex(), peer = keyHex();
    const s = new PinnedKeyStore(dir());
    expect(credentialSendKey(s, fpOf(peer), own)).toEqual({ allow: false, reason: 'peer-not-mutually-verified' });
    s.recordInviteAccepted(fpOf(peer), { peerIdentityPub: peer });
    expect(credentialSendKey(s, fpOf(peer), own).allow).toBe(false);
    expect(credentialAcceptFrom(s, fpOf(peer))).toBe(false);
  });

  it('allows a verified peer and returns ONLY the key derived from the pinned identity', () => {
    const own = keyHex(), peer = keyHex();
    const s = new PinnedKeyStore(dir());
    s.markInviteVerified(fpOf(peer), { peerIdentityPub: peer, via: 't', ownIdentityPub: own });
    const d = credentialSendKey(s, fpOf(peer), own);
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.peerIdentityPub.toString('hex')).toBe(peer);
      expect(d.x25519.equals(edPublicToX25519(Buffer.from(peer, 'hex')))).toBe(true);
    }
    expect(credentialAcceptFrom(s, fpOf(peer))).toBe(true);
  });

  it('refuses after OUR key changed (the pairing no longer matches), until re-paired', () => {
    const own = keyHex(), rotated = keyHex(), peer = keyHex();
    const s = new PinnedKeyStore(dir());
    s.markInviteVerified(fpOf(peer), { peerIdentityPub: peer, via: 't', ownIdentityPub: own });
    expect(credentialSendKey(s, fpOf(peer), rotated)).toEqual({ allow: false, reason: 'encryption-key-not-bound' });
  });

  it('refuses a PAUSED peer even though its pairing id still matches (a leaked invite was used twice)', () => {
    const own = keyHex(), peer = keyHex();
    const s = new PinnedKeyStore(dir());
    s.markInviteVerified(fpOf(peer), { peerIdentityPub: peer, via: 't', ownIdentityPub: own });
    s.demoteInvitePairing(fpOf(peer), 'second accept');
    expect(s.getProfileByFingerprint(fpOf(peer))?.pairingId).toBeTruthy(); // the id survives the pause
    expect(credentialSendKey(s, fpOf(peer), own)).toEqual({ allow: false, reason: 'peer-not-mutually-verified' });
    expect(credentialAcceptFrom(s, fpOf(peer))).toBe(false);
  });

  it('fails closed on a throwing store', () => {
    const broken = { getProfileByFingerprint: () => { throw new Error('boom'); } };
    expect(credentialSendKey(broken, 'a'.repeat(32), keyHex())).toEqual({ allow: false, reason: 'peer-not-mutually-verified' });
    expect(credentialAcceptFrom(broken, 'a'.repeat(32))).toBe(false);
  });
});

describe('credentialAcceptFrom checks the pairing is bound to our current key (Echo, PR #2195)', () => {
  it('bound: accepted; a pairing bound to another key of ours: refused; no key given: the old rule', async () => {
    const { PinnedKeyStore, credentialAcceptFrom, generateIdentityKeyPair: gen } = await import('../../../packages/threadline-core/src/index.js');
    const me = gen(), other = gen(), peer = gen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-accept-'));
    const store = new PinnedKeyStore(dir);
    const fp = peer.publicKey.subarray(0, 16).toString('hex');
    store.markInviteVerified(fp, { peerIdentityPub: peer.publicKey.toString('hex'), via: 't', ownIdentityPub: me.publicKey.toString('hex') });
    expect(credentialAcceptFrom(store, fp, me.publicKey.toString('hex'))).toBe(true);
    expect(credentialAcceptFrom(store, fp, other.publicKey.toString('hex'))).toBe(false);
    expect(credentialAcceptFrom(store, fp)).toBe(true);
  });
});
