/**
 * AgentIdentityHandover — carry an agent's identity to a machine joining its mesh.
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §1.
 * Constitution: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions".
 *
 * WHY. `joinMesh` provisions a MACHINE identity and never the AGENT identity, so the joining
 * machine finds none and mints its own — one agent silently becomes two sharing a name
 * (observed live 2026-08-19; a plain-text message signed on the new machine is rejected as
 * `bad-signature` by both peers, so agent-signature provenance is inoperative there).
 *
 * The channel already exists: `POST /api/pair` validates a single-use code the operator
 * carried out-of-band and ALREADY receives the joiner's X25519 encryption public key, which
 * it currently validates and uses for nothing. This seals the identity to that key and
 * returns it in the same response.
 *
 * SEALING REUSES `SecretStore.encryptForSync` — the reviewed, in-production primitive behind
 * cross-machine secret sync (ephemeral X25519 ECDH + HKDF-SHA256 + AES-256-GCM, ephemeral
 * private key discarded). Inventing a second sealing scheme for the same job would be a new
 * and less-tested attack surface for no gain.
 *
 * ── WHAT AUTHENTICATES WHAT (spec §1, round-3 + round-6 corrections) ──────────────────
 * The SIGNATURE does NOT authenticate the responder. An attacker controlling the response
 * supplies its own signing key alongside it, and the signature verifies perfectly against the
 * key it shipped with. What identifies the responder is POSSESSION OF THE PAIRING SESSION the
 * operator's code belongs to. The transcript binding below stops a genuine envelope being
 * lifted from one exchange into another; it does not, and cannot, stand in for that.
 *
 * The joiner additionally pins the agent FINGERPRINT carried in the pairing artefact and
 * refuses any identity that does not hash to it — so a hostile listener that merely COLLECTS
 * a code cannot hand back a fabricated identity, because it cannot produce a keypair matching
 * a fingerprint whose private key it does not hold.
 */

import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { encryptForSync, decryptFromSync, type EncryptedSecretPayload } from './SecretStore.js';

/** How an identity came to exist on a machine. Spec §3 — lineage, not "who did I join". */
export type IdentityOrigin = 'minted-standalone' | 'received-on-join';

/**
 * Provenance travelling with an identity.
 *
 * HONEST LIMIT (spec §3): this is OPERATIONAL EVIDENCE, not cryptographic authority. A
 * compromised host or an older binary can self-sign a false claim, and version skew keeps old
 * joiners minting. It orders a set of cooperating machines running current code; it is not a
 * defence against a machine that lies. Any candidate set containing an unattested version
 * falls back to operator selection.
 */
export interface IdentityProvenance {
  schemaVersion: 1;
  origin: IdentityOrigin;
  /** Fingerprint of the `minted-standalone` root this identity descends from. */
  rootFingerprint: string;
  /** Machine that minted (standalone) or received (join) it. */
  machineId: string;
  createdAt: string;
  /** instar version that produced the record — an unrecognised one is `unknown-origin`. */
  producedBy: string;
}

/** The transcript the envelope is bound to. Every field is checked by the joiner. */
export interface HandoverTranscript {
  pairingSessionId: string;
  joinerMachineId: string;
  /** The joiner's X25519 encryption public key, base64 — the key the payload is sealed to. */
  joinerEncryptionPublicKey: string;
  agentName: string;
  expiresAt: string;
}

export interface IdentityHandoverEnvelope {
  schemaVersion: 1;
  transcript: HandoverTranscript;
  sealed: EncryptedSecretPayload;
  /** Fingerprint of the identity inside, so a mismatch is caught before decryption is trusted. */
  identityFingerprint: string;
}

/** Everything the joiner needs to become this agent. */
export interface HandoverPayload {
  identity: { publicKey: string; privateKey: string; createdAt: string };
  provenance: IdentityProvenance;
}

export type HandoverRefusal =
  | 'no-identity-on-source'
  | 'session-expired'
  | 'session-bound-to-other-joiner'
  | 'malformed-joiner-key';

/**
 * Seal the agent identity for one specific joiner.
 *
 * Refuses rather than partially succeeding: every refusal is a named reason the caller turns
 * into an explicit failure, never a silent omission that would let the joiner mint.
 */
export function sealIdentityForJoiner(input: {
  payload: HandoverPayload;
  transcript: HandoverTranscript;
  identityFingerprint: string;
}): { ok: true; envelope: IdentityHandoverEnvelope } | { ok: false; refusal: HandoverRefusal } {
  const key = input.transcript.joinerEncryptionPublicKey;
  if (typeof key !== 'string' || key.length === 0) return { ok: false, refusal: 'malformed-joiner-key' };
  let sealed: EncryptedSecretPayload;
  try {
    sealed = encryptForSync(input.payload as unknown as Parameters<typeof encryptForSync>[0], key);
  } catch {
    // A key we cannot seal to is a malformed key. Named refusal, never a partial response.
    return { ok: false, refusal: 'malformed-joiner-key' };
  }
  return {
    ok: true,
    envelope: {
      schemaVersion: 1,
      transcript: input.transcript,
      sealed,
      identityFingerprint: input.identityFingerprint,
    },
  };
}

export type HandoverRejection =
  | 'schema-unsupported'
  | 'transcript-session-mismatch'
  | 'transcript-machine-mismatch'
  | 'transcript-key-mismatch'
  | 'transcript-agent-mismatch'
  | 'expired'
  | 'fingerprint-not-pinned'
  | 'undecryptable'
  | 'fingerprint-mismatch';

/**
 * Open an envelope, checking every transcript field against what THIS joiner actually sent.
 *
 * Fails closed on every branch: a rejection provisions nothing, and the caller must NOT fall
 * back to minting (spec Frontloaded Decision 2 — a silent twin is worse than a loud failure).
 */
export function openHandoverEnvelope(input: {
  envelope: IdentityHandoverEnvelope;
  /** What this joiner sent, to compare the transcript against. */
  expected: HandoverTranscript;
  /** The agent fingerprint from the pairing artefact the operator carried. */
  pinnedFingerprint: string;
  now?: Date;
  decrypt?: (p: EncryptedSecretPayload, priv: KeyObject) => unknown;
  /** PEM of the joiner's X25519 encryption private key — the one generated during join. */
  joinerEncryptionPrivateKeyPem: string;
}): { ok: true; payload: HandoverPayload } | { ok: false; rejection: HandoverRejection } {
  const { envelope, expected } = input;
  if (envelope?.schemaVersion !== 1) return { ok: false, rejection: 'schema-unsupported' };

  const t = envelope.transcript;
  if (t?.pairingSessionId !== expected.pairingSessionId) return { ok: false, rejection: 'transcript-session-mismatch' };
  if (t.joinerMachineId !== expected.joinerMachineId) return { ok: false, rejection: 'transcript-machine-mismatch' };
  if (t.joinerEncryptionPublicKey !== expected.joinerEncryptionPublicKey) return { ok: false, rejection: 'transcript-key-mismatch' };
  if (t.agentName !== expected.agentName) return { ok: false, rejection: 'transcript-agent-mismatch' };

  const now = input.now ?? new Date();
  const expiry = Date.parse(t.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) return { ok: false, rejection: 'expired' };

  // Pin BEFORE decrypting: a hostile listener cannot produce a keypair matching a fingerprint
  // whose private key it does not hold, so this is what stops a fabricated identity.
  if (envelope.identityFingerprint !== input.pinnedFingerprint) {
    return { ok: false, rejection: 'fingerprint-not-pinned' };
  }

  const decrypt = input.decrypt ?? ((p, priv) => decryptFromSync(p, priv));
  let opened: unknown;
  try {
    opened = decrypt(envelope.sealed, createPrivateKey(input.joinerEncryptionPrivateKeyPem));
  } catch {
    // Covers a malformed key, a wrong key, and a tampered ciphertext alike. All three are
    // "this joiner cannot open this envelope", and none may fall back to minting.
    return { ok: false, rejection: 'undecryptable' };
  }

  const payload = opened as HandoverPayload;
  if (!payload?.identity?.publicKey || !payload.identity.privateKey) {
    return { ok: false, rejection: 'undecryptable' };
  }

  // The sealed contents must match the fingerprint that was pinned — otherwise a valid-looking
  // envelope could carry a different key than the one advertised.
  if (fingerprintOf(payload.identity.publicKey) !== input.pinnedFingerprint) {
    return { ok: false, rejection: 'fingerprint-mismatch' };
  }

  return { ok: true, payload };
}

/** The routing fingerprint of an Ed25519 public key: first 16 bytes of its SHA-256, hex. */
export function fingerprintOf(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
}
