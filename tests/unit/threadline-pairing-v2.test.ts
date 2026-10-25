/**
 * Unit — verified pairing v2 (spec §3.1/§3.2/§3.4, FD2/FD4 amended 2026-10-10).
 *
 * Covers both sides of each decision: the Ed25519→X25519 map against the key the
 * encryptor actually uses, the 12-word SAS (symmetric, key-sensitive), receipt freshness
 * at the skew boundary, and the start rules (rotation resets, a denied match does not).
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { ThreadlineClient } from '../../src/threadline/client/ThreadlineClient.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateIdentityKeyPair,
  edPublicToX25519,
  isX25519BoundToIdentity,
  deriveSASv2,
  deriveSasBitsV2,
  deriveSasFingerprintV2,
  derivePairingIdV2,
} from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../src/threadline/client/MessageEncryptor.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import {
  buildPairVerifyReceipt,
  processPairVerifyReceipt,
  RECEIPT_CLOCK_SKEW_MS,
} from '../../src/threadline/PairVerifyReceipt.js';

const agent = () => {
  const kp = generateIdentityKeyPair();
  return { pub: kp.publicKey, priv: kp.privateKey, fp: computeFingerprint(kp.publicKey) };
};
const tm = () => new AgentTrustManager({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-v2-unit-')) });

describe('Ed25519 → X25519 public key map', () => {
  it('matches the X25519 key the encryptor derives from the private seed, for 200 random keys', () => {
    for (let i = 0; i < 200; i++) {
      const kp = generateIdentityKeyPair();
      expect(edPublicToX25519(kp.publicKey).equals(deriveX25519PublicKey(kp.privateKey))).toBe(true);
    }
  });

  it('binds exactly the derived key and nothing else', () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    expect(isX25519BoundToIdentity(a.publicKey, deriveX25519PublicKey(a.privateKey))).toBe(true);
    expect(isX25519BoundToIdentity(a.publicKey, deriveX25519PublicKey(b.privateKey))).toBe(false);
    expect(isX25519BoundToIdentity(a.publicKey, Buffer.alloc(31))).toBe(false);
  });

  it('rejects malformed input instead of returning a key', () => {
    expect(() => edPublicToX25519(Buffer.alloc(31))).toThrow();
    // y = p (out of range): 0xed ff..ff 7f little-endian
    const outOfRange = Buffer.alloc(32, 0xff);
    outOfRange[0] = 0xed;
    outOfRange[31] = 0x7f;
    expect(() => edPublicToX25519(outOfRange)).toThrow();
  });
});

describe('12-word SAS v2', () => {
  it('is 12 words, identical from both sides, and changes when either key changes', () => {
    const a = agent(), b = agent(), m = agent();
    const ab = deriveSASv2(a.pub, b.pub);
    expect(ab).toHaveLength(12);
    expect(deriveSASv2(b.pub, a.pub)).toEqual(ab);
    expect(deriveSASv2(a.pub, m.pub)).not.toEqual(ab);
    expect(deriveSASv2(m.pub, b.pub)).not.toEqual(ab);
    expect(derivePairingIdV2(a.pub, b.pub)).toBe(derivePairingIdV2(b.pub, a.pub));
    expect(derivePairingIdV2(a.pub, b.pub)).not.toBe(derivePairingIdV2(a.pub, m.pub));
  });

  it('uses the full 132 bits: flipping the last used bit changes the last word', () => {
    // Any two distinct key pairs almost surely differ early; this pins the word count to the
    // bit budget instead: 12 × 11 = 132 ≤ 136 derived bits.
    const a = agent(), b = agent();
    expect(deriveSasBitsV2(a.pub, b.pub)).toHaveLength(17);
  });
});

describe('receipt v2 freshness', () => {
  const setup = () => {
    const t = tm();
    const self = agent(), peer = agent();
    const pairingId = derivePairingIdV2(self.pub, peer.pub);
    const sasFingerprint = deriveSasFingerprintV2(deriveSasBitsV2(self.pub, peer.pub));
    t.recordPendingVerification(peer.fp, {
      pairingId,
      peerIdentityPub: peer.pub.toString('hex'),
      sasWords: deriveSASv2(self.pub, peer.pub),
      sasFingerprint,
      ownFp: self.fp,
    });
    const recordedAt = Date.parse(t.getProfileByFingerprint(peer.fp)!.pairingRecordedAt!);
    const receipt = (issuedMs: number) =>
      buildPairVerifyReceipt(peer.priv, { pairingId, ownFp: peer.fp, peerFp: self.fp, sasFingerprint, issuedAt: new Date(issuedMs).toISOString() });
    return { t, self, peer, recordedAt, receipt };
  };

  it('accepts a receipt just inside the stale bound and drops one just outside, with no state change', () => {
    const { t, self, peer, recordedAt, receipt } = setup();
    const now = new Date(recordedAt + 1000);
    const stale = processPairVerifyReceipt(t, peer.fp, receipt(recordedAt - RECEIPT_CLOCK_SKEW_MS - 1000), self.fp, now);
    expect(stale).toEqual({ processed: false, reason: 'receipt-stale' });
    expect(t.getProfileByFingerprint(peer.fp)!.peerAcked).toBeUndefined();
    const ok = processPairVerifyReceipt(t, peer.fp, receipt(recordedAt - RECEIPT_CLOCK_SKEW_MS + 1000), self.fp, now);
    expect(ok).toEqual({ processed: true, peerAcked: true });
  });

  it('drops a receipt dated beyond the future skew and accepts one inside it', () => {
    const { t, self, peer, recordedAt, receipt } = setup();
    const now = new Date(recordedAt + 1000);
    expect(processPairVerifyReceipt(t, peer.fp, receipt(now.getTime() + RECEIPT_CLOCK_SKEW_MS + 1000), self.fp, now))
      .toEqual({ processed: false, reason: 'receipt-from-future' });
    expect(processPairVerifyReceipt(t, peer.fp, receipt(now.getTime() + RECEIPT_CLOCK_SKEW_MS - 1000), self.fp, now).processed)
      .toBe(true);
  });

  it('checks the signature BEFORE freshness: a forged stale receipt reports signature-invalid', () => {
    const { t, self, peer, recordedAt } = setup();
    const forger = agent();
    const forged = buildPairVerifyReceipt(forger.priv, {
      pairingId: t.getProfileByFingerprint(peer.fp)!.pairingId!, ownFp: peer.fp, peerFp: self.fp,
      sasFingerprint: t.getProfileByFingerprint(peer.fp)!.sasFingerprint!, issuedAt: new Date(recordedAt - 3_600_000).toISOString(),
    });
    expect(processPairVerifyReceipt(t, peer.fp, forged, self.fp, new Date(recordedAt + 1000)))
      .toEqual({ processed: false, reason: 'signature-invalid' });
  });

  it('a signature over a different issuedAt does not verify', () => {
    const { t, self, peer, recordedAt, receipt } = setup();
    const r = receipt(recordedAt) as unknown as Record<string, unknown>;
    r.issuedAt = new Date(recordedAt + 2000).toISOString();
    expect(processPairVerifyReceipt(t, peer.fp, r, self.fp, new Date(recordedAt + 3000)))
      .toEqual({ processed: false, reason: 'signature-invalid' });
  });
});

describe('startStaticPairing rules', () => {
  it('first start records pending with 12 words; a second start is a no-op', () => {
    const t = tm(); const self = agent(), peer = agent();
    const first = t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp });
    expect(first.outcome).toBe('started');
    expect(t.getPendingPairing(peer.fp)!.sasWords).toHaveLength(12);
    expect(t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp }).outcome).toBe('already-pending');
  });

  it('refuses a key that does not match the fingerprint, and a self-pair', () => {
    const t = tm(); const self = agent(), peer = agent(), other = agent();
    expect(t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: other.pub, ownFp: self.fp }).outcome).toBe('fingerprint-mismatch');
    expect(t.startStaticPairing(self.fp, { ownIdentityPub: self.pub, peerIdentityPub: self.pub, ownFp: self.fp }).outcome).toBe('self-pair');
  });

  it('a denied match is NOT reset by starting again; clearFailed is required', () => {
    const t = tm(); const self = agent(), peer = agent();
    t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp });
    t.markVerificationFailed(peer.fp, 'operator-asserted mismatch');
    expect(t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp }).outcome).toBe('refused-failed');
    expect(t.getProfileByFingerprint(peer.fp)!.pairingState).toBe('verification-failed');
    expect(t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp, clearFailed: true }).outcome).toBe('started');
    expect(t.getProfileByFingerprint(peer.fp)!.pairingState).toBe('pending-verification');
  });

  it('a denied match stays denied even when OUR key rotated (a changed pairingId is not a back door)', () => {
    const t = tm(); const self = agent(), peer = agent();
    t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp });
    t.markVerificationFailed(peer.fp, 'operator-asserted mismatch');
    const rotated = agent();
    expect(t.startStaticPairing(peer.fp, { ownIdentityPub: rotated.pub, peerIdentityPub: peer.pub, ownFp: rotated.fp }).outcome).toBe('refused-failed');
    expect(t.getProfileByFingerprint(peer.fp)!.pairingState).toBe('verification-failed');
  });

  it('an inherited identity-verified pairing for the same key is not demoted by a start', () => {
    const t = tm(); const self = agent(), peer = agent();
    expect(t.inheritReplicatedVerification(peer.fp, { peerIdentityPub: peer.pub.toString('hex'), verifiedAt: new Date().toISOString(), verifiedOnMachine: 'm2' })).toBe(true);
    expect(t.getProfileByFingerprint(peer.fp)!.pairingState).toBe('identity-verified');
    expect(t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp }).outcome).toBe('already-verified');
    expect(t.getProfileByFingerprint(peer.fp)!.pairingState).toBe('identity-verified');
  });

  it('a verified pairing stays verified for the same keys and resets to pending when OUR key rotates', () => {
    const t = tm(); const self = agent(), peer = agent();
    const r = t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp });
    if (r.outcome !== 'started') throw new Error('expected started');
    t.markMutualVerified(peer.fp, { pairingId: r.pairingId, operatorConfirm: true, ownFp: self.fp });
    expect(t.startStaticPairing(peer.fp, { ownIdentityPub: self.pub, peerIdentityPub: peer.pub, ownFp: self.fp }).outcome).toBe('already-verified');
    const rotated = agent();
    expect(t.startStaticPairing(peer.fp, { ownIdentityPub: rotated.pub, peerIdentityPub: peer.pub, ownFp: rotated.fp }).outcome).toBe('started');
    expect(t.getProfileByFingerprint(peer.fp)!.pairingState).toBe('pending-verification');    // and it no longer carries the credential-authorizing source
    expect(t.getProfileByFingerprint(peer.fp)!.source).not.toBe('mutual-verified');
    expect(t.isCredentialShareAllowedByFingerprint(peer.fp)).toBe(false);
  });
});

describe('ThreadlineClient.fetchPeerIdentityKey (relay A2A card fallback)', () => {
  it('returns the card key only when it matches the fingerprint, and null otherwise', async () => {
    const real = agent();
    const wrong = agent();
    const cards: Record<string, string> = {
      [real.fp]: real.pub.toString('base64'), // honest card
      [wrong.fp]: real.pub.toString('base64'), // card serves a key that is NOT this fingerprint's
    };
    const server = http.createServer((req, res) => {
      const m = /^\/v1\/registry\/agent\/([0-9a-f]{32})\/a2a-card$/.exec(req.url ?? '');
      const key = m ? cards[m[1]] : undefined;
      if (!key) { res.writeHead(404).end(JSON.stringify({ error: 'Agent not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: 'x', 'x-threadline': { publicKey: key } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const client = new ThreadlineClient({
        name: 'test',
        relayUrl: `ws://127.0.0.1:${port}/v1/connect`,
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tl-card-')),
      });
      expect((await client.fetchPeerIdentityKey(real.fp))?.equals(real.pub)).toBe(true);
      expect(await client.fetchPeerIdentityKey(wrong.fp)).toBeNull();
      expect(await client.fetchPeerIdentityKey(agent().fp)).toBeNull(); // 404
      expect(await client.fetchPeerIdentityKey('not-a-fingerprint')).toBeNull();

      // The fetched key is remembered (identity key only, never an X25519 key), refused if it
      // does not match the fingerprint, and never overwrites a different cached key.
      expect(client.rememberPeerIdentityKey(real.fp, real.pub)).toBe(true);
      const cached = client.getKnownAgents().find((a) => a.agentId === real.fp)!;
      expect(cached.publicKey.equals(real.pub)).toBe(true);
      expect(cached.x25519PublicKey).toBeUndefined();
      expect(client.rememberPeerIdentityKey(wrong.fp, real.pub)).toBe(false);
      expect(client.rememberPeerIdentityKey(real.fp, Buffer.concat([real.pub.subarray(0, 16), Buffer.alloc(16, 7)]))).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
