/**
 * PairVerifyReceipt — the `pair-verify` control-plane message (spec §3.4).
 *
 * Part of Secure A2A Verified Pairing (docs/specs/secure-a2a-verified-pairing.md §3.4).
 *
 * A peer that has computed the same SAS for a live handshake sends a signed RECEIPT:
 *   receipt = sign(idPriv, "threadline-pair-verify-v1" ‖ pairingId ‖ ownFp ‖ peerFp ‖ sasFingerprint)
 * where `ownFp`/`peerFp` are from the SENDER's perspective (so on receive: sender.ownFp
 * is OUR peerFp, sender.peerFp is OUR ownFp).
 *
 * The receipt is a LIVENESS ACK only (FD8): it proves key-possession + SAS-agreement,
 * NOT that a human looked. It therefore sets the optional `peerAcked` flag via
 * `recordPeerAck` — it does NOT by itself flip a pairing to `mutual-verified` (that
 * requires a real operator-PIN confirm, a later route increment, §3.3 anti-confabulation).
 *
 * Control-plane EXEMPT ≠ security-exempt (spec §3.4): processed BEFORE the trust gate
 * (so the bootstrap message arrives before trust is raised), but still subject — BEFORE
 * any state mutation — to strict schema validation, Ed25519 signature verification
 * against the identity pubkey bound into the LIVE pending record, pairingId +
 * sasFingerprint match, the pending-verification (or mutual-verified) lookup, size
 * limits + replay protection + rate limits (enforced by the caller / InboundMessageGate),
 * and the self-pair guard. A receipt failing ANY check is dropped with NO state change.
 */

import { Buffer } from 'node:buffer';
import { sign, verify } from './ThreadlineCrypto.js';
import type { AgentTrustManager } from './AgentTrustManager.js';

// ── Types ────────────────────────────────────────────────────────────

/** The `pair-verify` control-plane message kind (gate-exempt, like 'probe'). */
export const PAIR_VERIFY_OP = 'pair-verify';

/**
 * The signing context string bound into the receipt (spec §3.4). v2 (2026-10-10): the
 * receipt also signs `issuedAt`. Under v2 the SAS is a function of the two identity keys,
 * so pairingId + sasFingerprint no longer change per handshake; freshness moves into the
 * receipt instead (FD4 v2).
 */
const RECEIPT_CONTEXT = 'threadline-pair-verify-v2';

/** Allowed clock skew between the sender's issuedAt and our clock / record time. */
export const RECEIPT_CLOCK_SKEW_MS = 5 * 60_000;

/** Defensive payload field caps (a malformed/oversized receipt is dropped). */
const MAX_HEX_LEN = 4096;

/**
 * The wire shape of a `pair-verify` payload. `ownFp`/`peerFp` are the SENDER's view.
 * `signature` is the hex Ed25519 signature over the bound message.
 */
export interface PairVerifyPayload {
  type?: string;
  pairingId: string;
  /** The SENDER's own fingerprint (== our peerFp). */
  ownFp: string;
  /** The SENDER's view of the peer fingerprint (== our ownFp). */
  peerFp: string;
  sasFingerprint: string;
  /** ISO-8601 UTC time the sender signed the receipt (v2). */
  issuedAt: string;
  /** Hex-encoded Ed25519 signature over the bound message. */
  signature: string;
}

export type PairVerifyOutcome =
  | { processed: true; peerAcked: true }
  | { processed: false; reason: string };

// ── Schema validation ─────────────────────────────────────────────────

function isHexString(v: unknown, maxLen = MAX_HEX_LEN): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen && /^[0-9a-f]+$/i.test(v);
}

/**
 * Strict schema validation (spec §3.4). Returns the typed payload or null. Rejects any
 * malformed/oversized payload BEFORE any crypto or state lookup.
 */
export function parsePairVerifyPayload(raw: unknown): PairVerifyPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!isHexString(p.pairingId)) return null;
  if (!isHexString(p.ownFp, 256)) return null;
  if (!isHexString(p.peerFp, 256)) return null;
  if (!isHexString(p.sasFingerprint, 256)) return null;
  if (!isHexString(p.signature)) return null;
  if (typeof p.issuedAt !== 'string' || p.issuedAt.length > 64 || Number.isNaN(Date.parse(p.issuedAt))) return null;
  return {
    type: typeof p.type === 'string' ? p.type : PAIR_VERIFY_OP,
    pairingId: p.pairingId,
    ownFp: p.ownFp.toLowerCase(),
    peerFp: p.peerFp.toLowerCase(),
    sasFingerprint: p.sasFingerprint.toLowerCase(),
    issuedAt: p.issuedAt,
    signature: p.signature,
  };
}

/** The exact message bytes the receipt signs (spec §3.4). */
export function receiptMessageBytes(
  pairingId: string,
  senderOwnFp: string,
  senderPeerFp: string,
  sasFingerprint: string,
  issuedAt: string,
): Buffer {
  // Length-prefixed fields so no two field tuples can produce the same bytes.
  const field = (v: string) => {
    const b = Buffer.from(v, 'utf-8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([
    Buffer.from(RECEIPT_CONTEXT, 'utf-8'),
    field(pairingId),
    field(senderOwnFp),
    field(senderPeerFp),
    field(sasFingerprint),
    field(issuedAt),
  ]);
}

/** Build a signed v2 `pair-verify` receipt (the sender side). */
export function buildPairVerifyReceipt(
  identityPrivateKey: Buffer,
  args: { pairingId: string; ownFp: string; peerFp: string; sasFingerprint: string; issuedAt?: string },
): PairVerifyPayload {
  const issuedAt = args.issuedAt ?? new Date().toISOString();
  const ownFp = args.ownFp.toLowerCase();
  const peerFp = args.peerFp.toLowerCase();
  const sasFingerprint = args.sasFingerprint.toLowerCase();
  const signature = sign(
    identityPrivateKey,
    receiptMessageBytes(args.pairingId, ownFp, peerFp, sasFingerprint, issuedAt),
  ).toString('hex');
  return { type: PAIR_VERIFY_OP, pairingId: args.pairingId, ownFp, peerFp, sasFingerprint, issuedAt, signature };
}

// ── Receipt processing (the inbound control-plane handler) ────────────

/**
 * Process an inbound `pair-verify` receipt (spec §3.4). `senderFp` is the relay-
 * resolved sender fingerprint (the message's `from`) — used to look up the LIVE
 * pending record; the signature is verified against the `peerIdentityPub` bound
 * INTO that record (not merely the relay-supplied fingerprint).
 *
 * On EVERY failure path the receipt is dropped with NO state change. On success the
 * optional `peerAcked` flag is set via `recordPeerAck` — never the mutual-verified flip.
 *
 * @param ownFp THIS agent's own fingerprint — used for the self-pair guard (FD12).
 */
export function processPairVerifyReceipt(
  trustManager: Pick<AgentTrustManager, 'getProfileByFingerprint' | 'recordPeerAck'>,
  senderFp: string,
  rawPayload: unknown,
  ownFp?: string,
  now: Date = new Date(),
): PairVerifyOutcome {
  try {
    const payload = parsePairVerifyPayload(rawPayload);
    if (!payload) return { processed: false, reason: 'schema-invalid' };

    // FD12 — reject a self-pair receipt (sender claims to be us, or names us as both).
    if (ownFp) {
      const me = ownFp.toLowerCase();
      if (senderFp.toLowerCase() === me) return { processed: false, reason: 'self-pair' };
      if (payload.ownFp === me) return { processed: false, reason: 'self-pair' };
    }

    // Look up OUR live pending record for this sender. The bound peerIdentityPub is
    // the load-bearing key the signature must verify against (spec §3.4).
    const profile = trustManager.getProfileByFingerprint(senderFp);
    if (!profile) return { processed: false, reason: 'no-pairing' };
    if (!profile.peerIdentityPub) return { processed: false, reason: 'no-pairing' };

    // Pairing must be in pending-verification (or already mutual-verified — a late
    // receipt just re-affirms peerAcked). verification-failed/none is dropped.
    if (profile.pairingState !== 'pending-verification' && profile.pairingState !== 'mutual-verified') {
      return { processed: false, reason: 'not-pending' };
    }

    // Epoch binding: the receipt's pairingId + sasFingerprint must match OUR record.
    if (!profile.pairingId || profile.pairingId !== payload.pairingId) {
      return { processed: false, reason: 'pairing-id-mismatch' };
    }
    if (!profile.sasFingerprint || profile.sasFingerprint.toLowerCase() !== payload.sasFingerprint) {
      return { processed: false, reason: 'sas-fingerprint-mismatch' };
    }

    // The sender's `ownFp` is OUR peer (the sender). The sender's `peerFp` is US.
    // Bind both into the verified bytes so a cross-pairing receipt can't be replayed.
    if (payload.ownFp !== senderFp.toLowerCase()) {
      return { processed: false, reason: 'sender-fingerprint-mismatch' };
    }
    if (ownFp && payload.peerFp !== ownFp.toLowerCase()) {
      return { processed: false, reason: 'recipient-fingerprint-mismatch' };
    }

    // Freshness (FD4 v2). The SAS no longer changes per handshake, so a receipt must be
    // newer than the pairing it answers. Allow clock skew; a too-old or future receipt
    // is dropped with no state change and the sender may retry (it only sets peerAcked).
    const issuedMs = Date.parse(payload.issuedAt);
    if (issuedMs > now.getTime() + RECEIPT_CLOCK_SKEW_MS) return { processed: false, reason: 'receipt-from-future' };
    const recordedMs = profile.pairingRecordedAt ? Date.parse(profile.pairingRecordedAt) : NaN;
    if (Number.isNaN(recordedMs)) return { processed: false, reason: 'no-pairing' };
    if (issuedMs < recordedMs - RECEIPT_CLOCK_SKEW_MS) return { processed: false, reason: 'receipt-stale' };

    // Ed25519 signature verification against the BOUND identity key (spec §3.4).
    let sigOk = false;
    try {
      const idPub = Buffer.from(profile.peerIdentityPub, 'hex');
      const sig = Buffer.from(payload.signature, 'hex');
      const msg = receiptMessageBytes(payload.pairingId, payload.ownFp, payload.peerFp, payload.sasFingerprint, payload.issuedAt);
      sigOk = verify(idPub, msg, sig);
    } catch {
      sigOk = false;
    }
    if (!sigOk) return { processed: false, reason: 'signature-invalid' };

    // All checks passed — set the OPTIONAL peerAcked liveness flag. NEVER the
    // mutual-verified flip (that requires a real operator-PIN confirm, §3.3).
    const acked = trustManager.recordPeerAck(senderFp, payload.pairingId);
    if (!acked) return { processed: false, reason: 'ack-rejected' };
    return { processed: true, peerAcked: true };
  } catch {
    // Any uncertainty → drop with no state change.
    return { processed: false, reason: 'error' };
  }
}
