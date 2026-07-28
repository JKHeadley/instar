/**
 * Unit tests for the Secure A2A Verified Pairing credential gate (Increment 3).
 *
 * Covers BOTH sides of every boundary (spec §3.4 / §3.5 / FD5 / FD8 / FD9 / FD10):
 *   - OUTBOUND credential-share: allowed to a mutual-verified peer; refused to an
 *     unverified peer (fail-closed); refused over a plaintext-only path; non-credential
 *     send unaffected; flag off = full pass-through.
 *   - INBOUND credential ingestion via InboundMessageGate: refused when enforced;
 *     dryRun logs-but-allows; flag off = pass-through.
 *   - pair-verify receipt: valid receipt sets peerAcked; wrong pairingId / wrong sig /
 *     non-pending dropped (no-op); does NOT flip to mutual-verified alone; self-pair
 *     rejected; consumed as a control-plane message (never routed onward).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import {
  assertCanShareCredential,
  evaluateOutboundCredentialShare,
} from '../../src/threadline/CredentialShareGate.js';
import {
  processPairVerifyReceipt,
  receiptMessageBytes,
  parsePairVerifyPayload,
  PAIR_VERIFY_OP,
} from '../../src/threadline/PairVerifyReceipt.js';
import {
  generateIdentityKeyPair,
  sign,
  deriveSAS,
  deriveSasBits,
  deriveSasFingerprint,
} from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { InboundMessageGate, type VerifiedPairingGateConfig } from '../../src/threadline/InboundMessageGate.js';
import type { ReceivedMessage } from '../../src/threadline/client/ThreadlineClient.js';

// ── Helpers ───────────────────────────────────────────────────────────

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cred-gate-'));
}

interface PeerKeys {
  idPub: Buffer;
  idPriv: Buffer;
  fp: string;
}

function makePeer(): PeerKeys {
  const kp = generateIdentityKeyPair();
  return { idPub: kp.publicKey, idPriv: kp.privateKey, fp: computeFingerprint(kp.publicKey) };
}

/** Build a verified pairing on `tm` for `peer`, returning the pairing context. */
function setUpPairing(
  tm: AgentTrustManager,
  self: PeerKeys,
  peer: PeerKeys,
  opts: { verify?: boolean } = {},
): { pairingId: string; sasFingerprint: string; sasWords: string[] } {
  const sharedSecret = crypto.randomBytes(32);
  const sasBits = deriveSasBits(sharedSecret, self.idPub, peer.idPub);
  const sasWords = deriveSAS(sharedSecret, self.idPub, peer.idPub);
  const sasFingerprint = deriveSasFingerprint(sasBits);
  const pairingId = crypto.randomBytes(16).toString('hex');

  tm.recordPendingVerification(peer.fp, {
    pairingId,
    peerIdentityPub: peer.idPub.toString('hex'),
    sasWords,
    sasFingerprint,
    ownFp: self.fp,
  });

  if (opts.verify) {
    tm.markMutualVerified(peer.fp, { pairingId, operatorConfirm: true, ownFp: self.fp });
  }
  return { pairingId, sasFingerprint, sasWords };
}

/** Build a signed pair-verify payload FROM `sender` (the peer) TO `recipient` (us). */
function makeReceipt(
  sender: PeerKeys,
  recipientFp: string,
  pairingId: string,
  sasFingerprint: string,
): Record<string, unknown> {
  // From the SENDER's perspective: ownFp = sender, peerFp = recipient (us).
  const msg = receiptMessageBytes(pairingId, sender.fp, recipientFp, sasFingerprint);
  const sig = sign(sender.idPriv, msg);
  return {
    type: PAIR_VERIFY_OP,
    pairingId,
    ownFp: sender.fp,
    peerFp: recipientFp,
    sasFingerprint,
    signature: sig.toString('hex'),
  };
}

function vpConfig(over: Partial<VerifiedPairingGateConfig> = {}): VerifiedPairingGateConfig {
  return { enabled: true, dryRun: false, credentialShareEnforced: true, ...over };
}

function makeMessage(fromFp: string, content: unknown): ReceivedMessage {
  return {
    from: fromFp,
    fromName: fromFp.slice(0, 8),
    threadId: `thread-${Math.random().toString(36).slice(2)}`,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    content: content as never,
    timestamp: new Date().toISOString(),
  } as ReceivedMessage;
}

// Encrypted-path probe stub.
function encryptedPath(known: boolean) {
  return { hasEncryptedSendPath: () => known };
}

// ── Outbound credential-share gate ────────────────────────────────────

describe('CredentialShareGate — outbound (load-bearing, §3.5/FD9)', () => {
  let tm: AgentTrustManager;
  let self: PeerKeys;
  let peer: PeerKeys;
  let dir: string;

  beforeEach(() => {
    dir = tmpStateDir();
    tm = new AgentTrustManager({ stateDir: dir });
    self = makePeer();
    peer = makePeer();
  });

  it('ALLOWS a credential to a mutual-verified peer over the encrypted path', () => {
    setUpPairing(tm, self, peer, { verify: true });
    const d = evaluateOutboundCredentialShare(tm, encryptedPath(true), peer.fp);
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it('REFUSES a credential to an UNVERIFIED peer (fail-closed)', () => {
    setUpPairing(tm, self, peer, { verify: false }); // pending, not mutual-verified
    const d = evaluateOutboundCredentialShare(tm, encryptedPath(true), peer.fp);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('peer-not-mutually-verified');
  });

  it('REFUSES a credential to a totally unknown peer (fail-closed)', () => {
    const d = evaluateOutboundCredentialShare(tm, encryptedPath(true), peer.fp);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('peer-not-mutually-verified');
  });

  it('REFUSES a credential when only the plaintext path is available (verified peer)', () => {
    setUpPairing(tm, self, peer, { verify: true });
    const d = evaluateOutboundCredentialShare(tm, encryptedPath(false), peer.fp);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('credential-requires-encrypted-path');
  });

  it('REFUSES when the encrypted-path probe is missing (fail-closed)', () => {
    setUpPairing(tm, self, peer, { verify: true });
    const d = evaluateOutboundCredentialShare(tm, null, peer.fp);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('credential-requires-encrypted-path');
  });

  it('fails closed if the trust manager throws while resolving pairing', () => {
    const throwing = {
      isCredentialShareAllowedByFingerprint: () => { throw new Error('boom'); },
    };
    const d = evaluateOutboundCredentialShare(throwing, encryptedPath(true), peer.fp);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('peer-not-mutually-verified');
  });

  it('assertCanShareCredential mirrors the verified/unverified decision', () => {
    expect(assertCanShareCredential(tm, peer.fp).allow).toBe(false);
    setUpPairing(tm, self, peer, { verify: true });
    expect(assertCanShareCredential(tm, peer.fp).allow).toBe(true);
  });
});

// ── pair-verify receipt (§3.4) ────────────────────────────────────────

describe('PairVerifyReceipt — control-plane receipt (§3.4/FD8)', () => {
  let tm: AgentTrustManager;
  let self: PeerKeys;
  let peer: PeerKeys;
  let dir: string;

  beforeEach(() => {
    dir = tmpStateDir();
    tm = new AgentTrustManager({ stateDir: dir });
    self = makePeer();
    peer = makePeer();
  });

  it('a VALID receipt sets peerAcked (but not mutual-verified)', () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    const payload = makeReceipt(peer, self.fp, pairingId, sasFingerprint);
    const outcome = processPairVerifyReceipt(tm, peer.fp, payload, self.fp);
    expect(outcome.processed).toBe(true);

    const profile = tm.getProfileByFingerprint(peer.fp)!;
    expect(profile.peerAcked).toBe(true);
    // Receipt alone does NOT flip to mutual-verified (FD8).
    expect(profile.pairingState).toBe('pending-verification');
    expect(profile.source).not.toBe('mutual-verified');
    expect(tm.isCredentialShareAllowedByFingerprint(peer.fp)).toBe(false);
  });

  it('does NOT flip to mutual-verified on receipt alone — credential-share still denied', () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    processPairVerifyReceipt(tm, peer.fp, makeReceipt(peer, self.fp, pairingId, sasFingerprint), self.fp);
    expect(evaluateOutboundCredentialShare(tm, encryptedPath(true), peer.fp).allow).toBe(false);
  });

  it('DROPS a receipt with the WRONG pairingId (no state change)', () => {
    const { sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    const payload = makeReceipt(peer, self.fp, 'deadbeef'.repeat(4), sasFingerprint);
    const outcome = processPairVerifyReceipt(tm, peer.fp, payload, self.fp);
    expect(outcome.processed).toBe(false);
    expect(tm.getProfileByFingerprint(peer.fp)!.peerAcked).toBeUndefined();
  });

  it('DROPS a receipt with an INVALID signature (no state change)', () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    const payload = makeReceipt(peer, self.fp, pairingId, sasFingerprint);
    payload.signature = (payload.signature as string).replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    const outcome = processPairVerifyReceipt(tm, peer.fp, payload, self.fp);
    expect(outcome.processed).toBe(false);
    expect(tm.getProfileByFingerprint(peer.fp)!.peerAcked).toBeUndefined();
  });

  it('DROPS a receipt signed by a DIFFERENT key than the bound peerIdentityPub', () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    const imposter = makePeer();
    // Imposter signs but presents the real peer's fingerprint claims.
    const msg = receiptMessageBytes(pairingId, peer.fp, self.fp, sasFingerprint);
    const payload = {
      type: PAIR_VERIFY_OP, pairingId, ownFp: peer.fp, peerFp: self.fp, sasFingerprint,
      signature: sign(imposter.idPriv, msg).toString('hex'),
    };
    const outcome = processPairVerifyReceipt(tm, peer.fp, payload, self.fp);
    expect(outcome.processed).toBe(false);
  });

  it('DROPS a receipt for a NON-pending pairing (verification-failed)', () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    tm.markVerificationFailed(peer.fp, 'operator-asserted mismatch');
    const payload = makeReceipt(peer, self.fp, pairingId, sasFingerprint);
    const outcome = processPairVerifyReceipt(tm, peer.fp, payload, self.fp);
    expect(outcome.processed).toBe(false);
  });

  it('DROPS a receipt for an UNKNOWN peer (no pending record)', () => {
    const stranger = makePeer();
    const payload = makeReceipt(stranger, self.fp, crypto.randomBytes(16).toString('hex'), 'abc123');
    const outcome = processPairVerifyReceipt(tm, stranger.fp, payload, self.fp);
    expect(outcome.processed).toBe(false);
  });

  it('REJECTS a self-pair receipt (sender claims to be us, FD12)', () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    // ownFp asserts our own fingerprint → self-pair guard.
    const payload = makeReceipt(peer, self.fp, pairingId, sasFingerprint);
    const outcome = processPairVerifyReceipt(tm, self.fp, payload, self.fp);
    expect(outcome.processed).toBe(false);
  });

  it('REJECTS a malformed payload at the schema layer', () => {
    expect(parsePairVerifyPayload(null)).toBeNull();
    expect(parsePairVerifyPayload({ pairingId: 'xyz' })).toBeNull(); // missing fields
    expect(parsePairVerifyPayload({ pairingId: 'gg', ownFp: 'a', peerFp: 'b', sasFingerprint: 'c', signature: 'd' })).toBeNull(); // non-hex
  });
});

// ── Inbound gate integration (§3.5/FD5/FD10) ──────────────────────────

describe('InboundMessageGate — credential ingestion + pair-verify (§3.5/FD10)', () => {
  let tm: AgentTrustManager;
  let self: PeerKeys;
  let peer: PeerKeys;
  let dir: string;

  function gateWith(vp: VerifiedPairingGateConfig | null): InboundMessageGate {
    return new InboundMessageGate(tm, null, {
      ownFingerprint: self.fp,
      getVerifiedPairingConfig: vp ? () => vp : undefined,
    });
  }

  beforeEach(() => {
    dir = tmpStateDir();
    tm = new AgentTrustManager({ stateDir: dir });
    self = makePeer();
    peer = makePeer();
    // Give the peer a baseline trust profile so non-credential messages pass.
    tm.getOrCreateProfileByFingerprint(peer.fp, 'Peer');
  });

  it('flag OFF = full pass-through to LEGACY behavior: credential gate never engages', async () => {
    // With the flag off the verified-pairing credential gate does NOT engage — the
    // message is evaluated by the legacy gate exactly as before. `credential-share` was
    // never in a 'verified' peer's allowed ops, so legacy blocks it as insufficient_trust
    // (NOT the new credential_not_mutually_verified reason). The point: zero new behavior.
    const gate = gateWith({ enabled: false, dryRun: true, credentialShareEnforced: false });
    const msg = makeMessage(peer.fp, { content: 'secret', type: 'credential-share' });
    const d = await gate.evaluate(msg);
    expect(d.reason).not.toBe('credential_not_mutually_verified');
    expect(gate.getMetrics().credentialBlocked).toBe(0);
    expect(gate.getMetrics().credentialDryRunWouldBlock).toBe(0);
  });

  it('ENFORCED + non-verified sender: inbound credential REFUSED (fail-closed)', async () => {
    const gate = gateWith(vpConfig());
    const msg = makeMessage(peer.fp, { content: 'secret', type: 'credential-share' });
    const d = await gate.evaluate(msg);
    expect(d.action).toBe('block');
    expect(d.reason).toBe('credential_not_mutually_verified');
  });

  it('ENFORCED + mutual-verified sender: inbound credential PASSES', async () => {
    setUpPairing(tm, self, peer, { verify: true });
    const gate = gateWith(vpConfig());
    const msg = makeMessage(peer.fp, { content: 'secret', type: 'credential-share' });
    const d = await gate.evaluate(msg);
    expect(d.action).toBe('pass');
  });

  it('dryRun LOGS-but-ALLOWS inbound (FD10): non-verified credential still passes', async () => {
    const gate = gateWith(vpConfig({ dryRun: true }));
    const msg = makeMessage(peer.fp, { content: 'secret', type: 'credential-share' });
    const d = await gate.evaluate(msg);
    // Inbound observability only — the message is not blocked under dryRun.
    expect(d.action).toBe('pass');
    expect(gate.getMetrics().credentialDryRunWouldBlock).toBe(1);
    expect(gate.getMetrics().credentialBlocked).toBe(0);
  });

  it('non-credential message unaffected whether flag on or off', async () => {
    const onGate = gateWith(vpConfig());
    const offGate = gateWith({ enabled: false, dryRun: true, credentialShareEnforced: false });
    const msg1 = makeMessage(peer.fp, { content: 'hi', type: 'message' });
    const msg2 = makeMessage(peer.fp, { content: 'hi', type: 'message' });
    expect((await onGate.evaluate(msg1)).action).toBe('pass');
    expect((await offGate.evaluate(msg2)).action).toBe('pass');
  });

  it('a VALID pair-verify message is consumed as control-plane (not routed) and sets peerAcked', async () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    const gate = gateWith(vpConfig());
    const payload = { ...makeReceipt(peer, self.fp, pairingId, sasFingerprint) };
    const d = await gate.evaluate(makeMessage(peer.fp, payload));
    expect(d.action).toBe('block');
    expect(d.controlPlane).toBe(true);
    expect(d.reason).toBe('pair-verify');
    expect(tm.getProfileByFingerprint(peer.fp)!.peerAcked).toBe(true);
    expect(gate.getMetrics().pairVerifyProcessed).toBe(1);
  });

  it('an INVALID pair-verify is still consumed control-plane but drops with no state change', async () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    const gate = gateWith(vpConfig());
    const payload = makeReceipt(peer, self.fp, pairingId, sasFingerprint);
    payload.signature = '00'.repeat(64); // invalid sig
    const d = await gate.evaluate(makeMessage(peer.fp, payload));
    expect(d.action).toBe('block');
    expect(d.controlPlane).toBe(true);
    expect(tm.getProfileByFingerprint(peer.fp)!.peerAcked).toBeUndefined();
    expect(gate.getMetrics().pairVerifyDropped).toBe(1);
  });

  it('flag OFF: a pair-verify message is NOT specially handled (no control-plane consume)', async () => {
    const { pairingId, sasFingerprint } = setUpPairing(tm, self, peer, { verify: false });
    const gate = gateWith({ enabled: false, dryRun: true, credentialShareEnforced: false });
    const payload = makeReceipt(peer, self.fp, pairingId, sasFingerprint);
    const d = await gate.evaluate(makeMessage(peer.fp, payload));
    // With the flag off the gate treats it as an ordinary op (pair-verify is not in
    // allowedOps for a 'verified' peer ⇒ insufficient_trust block, NOT control-plane).
    expect(d.controlPlane).toBeUndefined();
  });
});
