/**
 * Key binding — ties an agent's Witness key to its Threadline identity.
 *
 * Signed by BOTH keys. The Threadline signature says "the agent you already
 * know on Threadline vouches for this Witness key"; the Witness signature
 * proves whoever published the binding actually holds the Witness private key
 * (so nobody can bind a key they found to their own identity).
 *
 * The fingerprint is checked against the Threadline public key using
 * Threadline's own rule (first 16 bytes of the key, hex), so a binding can
 * never name one fingerprint while being signed by another key.
 */

import { canonicalize } from './canonical.js';
import { isHex, keyIdFor, signBytes, verifyBytes } from './keys.js';

export const BINDING_TYPE = 'WitnessKeyBinding/v0';
const THREADLINE_CONTEXT = 'instar-witness-binding-v0/threadline\n';
const WITNESS_CONTEXT = 'instar-witness-binding-v0/witness\n';

export interface UnsignedBinding {
  type: typeof BINDING_TYPE;
  agent: string;
  threadline_fingerprint: string;
  threadline_public_key: string;
  witness_public_key: string;
  key_id: string;
  issued_at: string;
}

export interface KeyBinding extends UnsignedBinding {
  threadline_signature: string;
  witness_signature: string;
}

/** Threadline's fingerprint rule (MessageEncryptor.computeFingerprint): first 16 bytes of the Ed25519 key. */
export function threadlineFingerprint(threadlinePublicKeyHex: string): string {
  return threadlinePublicKeyHex.slice(0, 32);
}

export function createBinding(input: {
  agent: string;
  threadline: { publicKey: string; privateKey: string };
  witness: { publicKey: string; privateKey: string };
  issuedAt?: Date;
}): KeyBinding {
  const unsigned: UnsignedBinding = {
    type: BINDING_TYPE,
    agent: input.agent,
    threadline_fingerprint: threadlineFingerprint(input.threadline.publicKey),
    threadline_public_key: input.threadline.publicKey,
    witness_public_key: input.witness.publicKey,
    key_id: keyIdFor(input.witness.publicKey),
    issued_at: (input.issuedAt ?? new Date()).toISOString(),
  };
  const body = canonicalize(unsigned);
  return {
    ...unsigned,
    threadline_signature: signBytes(input.threadline.privateKey, Buffer.from(THREADLINE_CONTEXT + body)),
    witness_signature: signBytes(input.witness.privateKey, Buffer.from(WITNESS_CONTEXT + body)),
  };
}

export type BindingResult = { ok: true; binding: KeyBinding } | { ok: false; reason: string };

/**
 * Verify a binding. Pass `expectedFingerprint` when you already know the agent's
 * Threadline fingerprint (from a verified pairing, say) — without it you only
 * learn that the binding is internally consistent, not that it is the agent you meant.
 */
export function verifyBinding(binding: unknown, expectedFingerprint?: string): BindingResult {
  if (!binding || typeof binding !== 'object') return { ok: false, reason: 'not an object' };
  const { threadline_signature, witness_signature, ...rest } = binding as Record<string, unknown>;
  const b = rest as unknown as UnsignedBinding;
  const allowed = ['type', 'agent', 'threadline_fingerprint', 'threadline_public_key', 'witness_public_key', 'key_id', 'issued_at'];
  if (Object.keys(rest).some(k => !allowed.includes(k))) return { ok: false, reason: 'unknown field' };
  if (b.type !== BINDING_TYPE) return { ok: false, reason: `type must be ${BINDING_TYPE}` };
  if (typeof b.agent !== 'string' || !b.agent.startsWith('did:')) return { ok: false, reason: 'agent must be a did: URI' };
  if (!isHex(b.threadline_public_key, 32) || !isHex(b.witness_public_key, 32)) {
    return { ok: false, reason: 'keys must be 32 bytes of hex' };
  }
  if (b.threadline_fingerprint !== threadlineFingerprint(b.threadline_public_key)) {
    return { ok: false, reason: 'threadline_fingerprint does not match threadline_public_key' };
  }
  if (expectedFingerprint !== undefined && b.threadline_fingerprint !== expectedFingerprint) {
    return { ok: false, reason: 'binding is for a different Threadline fingerprint' };
  }
  if (b.key_id !== keyIdFor(b.witness_public_key)) return { ok: false, reason: 'key_id does not match witness_public_key' };
  if (typeof b.issued_at !== 'string' || Number.isNaN(Date.parse(b.issued_at))) {
    return { ok: false, reason: 'issued_at must be a timestamp' };
  }
  const body = canonicalize(b);
  if (!verifyBytes(b.threadline_public_key, Buffer.from(THREADLINE_CONTEXT + body), threadline_signature as string)) {
    return { ok: false, reason: 'bad threadline signature' };
  }
  if (!verifyBytes(b.witness_public_key, Buffer.from(WITNESS_CONTEXT + body), witness_signature as string)) {
    return { ok: false, reason: 'bad witness signature' };
  }
  return { ok: true, binding: binding as KeyBinding };
}
