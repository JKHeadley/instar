/**
 * Key bindings — tie an agent's Witness key to its Threadline identity, over time.
 *
 * A binding is signed by BOTH keys it names. The Threadline signature says
 * "the agent you already know on Threadline vouches for this Witness key";
 * the Witness signature proves whoever published the binding holds the
 * Witness private key, so nobody can bind a key they merely found.
 *
 * Bindings form a chain per agent. seq 0 starts it. Every later binding names
 * the hash of the one it supersedes and carries one more signature, made by
 * either key of the PREVIOUS binding: the Threadline key when the Witness key
 * is being replaced, the Witness key when identity recovery rotated the
 * Threadline key. A record is judged against the binding that was current at
 * its issued_at: binding k covers [k.issued_at, (k+1).issued_at).
 *
 * A binding can also be revoked (for compromise) by either of its own keys,
 * with an effective_from time. Records it covered from that time on stop
 * counting; records before it stay valid.
 *
 * Known v0 limit: if one key of a binding is stolen, the thief can publish a
 * successor too. Two different bindings at the same seq are a FORK; a store
 * that sees one refuses the second and marks the agent conflicted, which stops
 * new records from that agent counting until a human resolves it (re-pair and
 * compare the SAS words).
 */

import crypto from 'node:crypto';
import { canonicalize } from './canonical.js';
import { isHex, keyIdFor, signBytes, verifyBytes } from './keys.js';
import { isIsoDate } from './record.js';

export const BINDING_TYPE = 'WitnessKeyBinding/v0';
export const BINDING_REVOCATION_TYPE = 'WitnessKeyRevocation/v0';
const THREADLINE_CONTEXT = 'instar-witness-binding-v0/threadline\n';
const WITNESS_CONTEXT = 'instar-witness-binding-v0/witness\n';
const PREVIOUS_CONTEXT = 'instar-witness-binding-v0/previous\n';
const REVOCATION_CONTEXT = 'instar-witness-binding-revocation-v0\n';
const HASH_CONTEXT = 'instar-witness-binding-v0/hash\n';

export type KeyRole = 'witness' | 'threadline';

export interface UnsignedBinding {
  type: typeof BINDING_TYPE;
  agent: string;
  seq: number;
  /** Hash of the binding this one replaces. Present exactly when seq > 0. */
  supersedes?: string;
  threadline_fingerprint: string;
  threadline_public_key: string;
  witness_public_key: string;
  key_id: string;
  issued_at: string;
}

export interface KeyBinding extends UnsignedBinding {
  threadline_signature: string;
  witness_signature: string;
  /** Which key of the previous binding signed this one. Present exactly when seq > 0. */
  previous_signer?: KeyRole;
  previous_signature?: string;
}

export interface BindingRevocation {
  type: typeof BINDING_REVOCATION_TYPE;
  agent: string;
  /** Hash of the binding being revoked. */
  binding: string;
  /** Records the binding covered from this time on stop counting. May be earlier than issued_at (compromised since). */
  effective_from: string;
  issued_at: string;
  reason: string;
  signer: KeyRole;
  signature: string;
}

interface KeyPairHex {
  publicKey: string;
  privateKey: string;
}

/** Threadline's fingerprint rule (MessageEncryptor.computeFingerprint): first 16 bytes of the Ed25519 key. */
export function threadlineFingerprint(threadlinePublicKeyHex: string): string {
  return threadlinePublicKeyHex.slice(0, 32);
}

export function bindingHash(binding: UnsignedBinding | KeyBinding): string {
  return crypto.createHash('sha256').update(HASH_CONTEXT + canonicalize(unsignedPart(binding))).digest('hex');
}

/** Start an agent's chain (seq 0). */
export function createBinding(input: {
  agent: string;
  threadline: KeyPairHex;
  witness: KeyPairHex;
  issuedAt?: Date;
}): KeyBinding {
  return sign(body(input.agent, 0, undefined, input.threadline, input.witness, input.issuedAt), input.threadline, input.witness);
}

/**
 * Replace `previous` with a binding for new keys (either or both may change).
 * `previousKey` must be one of previous's keys; say which with `previousSigner`.
 */
export function createSuccessorBinding(input: {
  previous: KeyBinding;
  threadline: KeyPairHex;
  witness: KeyPairHex;
  previousSigner: KeyRole;
  previousKey: KeyPairHex;
  issuedAt?: Date;
}): KeyBinding {
  const b = body(
    input.previous.agent,
    input.previous.seq + 1,
    bindingHash(input.previous),
    input.threadline,
    input.witness,
    input.issuedAt,
  );
  const signed = sign(b, input.threadline, input.witness);
  return {
    ...signed,
    previous_signer: input.previousSigner,
    previous_signature: signBytes(input.previousKey.privateKey, Buffer.from(PREVIOUS_CONTEXT + canonicalize(b))),
  };
}

export type BindingResult = { ok: true; binding: KeyBinding } | { ok: false; reason: string };

/**
 * Check a binding on its own: shape, fingerprint rule, and the two signatures by
 * the keys it names. Pass `expectedFingerprint` when you already know the agent's
 * Threadline fingerprint (from a verified pairing) — without it you only learn the
 * binding is internally consistent, not that it is the agent you meant.
 * A successor's link to its predecessor is checked by verifySuccessor.
 */
export function verifyBinding(binding: unknown, expectedFingerprint?: string): BindingResult {
  if (!binding || typeof binding !== 'object') return { ok: false, reason: 'not an object' };
  const full = binding as Record<string, unknown>;
  const allowed = [
    'type', 'agent', 'seq', 'supersedes', 'threadline_fingerprint', 'threadline_public_key',
    'witness_public_key', 'key_id', 'issued_at', 'threadline_signature', 'witness_signature',
    'previous_signer', 'previous_signature',
  ];
  const unknown = Object.keys(full).find(k => !allowed.includes(k));
  if (unknown) return { ok: false, reason: `unknown field ${unknown}` };
  const b = full as unknown as KeyBinding;
  if (b.type !== BINDING_TYPE) return { ok: false, reason: `type must be ${BINDING_TYPE}` };
  if (typeof b.agent !== 'string' || !/^did:[a-z0-9]+:\S+$/.test(b.agent)) return { ok: false, reason: 'agent must be a did: URI' };
  if (!Number.isSafeInteger(b.seq) || b.seq < 0) return { ok: false, reason: 'seq must be a non-negative integer' };
  if (b.seq === 0) {
    if (b.supersedes !== undefined || b.previous_signer !== undefined || b.previous_signature !== undefined) {
      return { ok: false, reason: 'a seq 0 binding cannot supersede anything' };
    }
  } else {
    if (!isHex(b.supersedes, 32)) return { ok: false, reason: 'a successor must name the superseded binding hash' };
    if (b.previous_signer !== 'witness' && b.previous_signer !== 'threadline') {
      return { ok: false, reason: 'a successor must say which previous key signed it' };
    }
    if (!isHex(b.previous_signature, 64)) return { ok: false, reason: 'a successor must carry previous_signature' };
  }
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
  if (!isIsoDate(b.issued_at)) return { ok: false, reason: 'issued_at must be an ISO-8601 UTC timestamp' };
  const msg = canonicalize(unsignedPart(b));
  if (!verifyBytes(b.threadline_public_key, Buffer.from(THREADLINE_CONTEXT + msg), b.threadline_signature)) {
    return { ok: false, reason: 'bad threadline signature' };
  }
  if (!verifyBytes(b.witness_public_key, Buffer.from(WITNESS_CONTEXT + msg), b.witness_signature)) {
    return { ok: false, reason: 'bad witness signature' };
  }
  return { ok: true, binding: b };
}

/** Is `next` a valid successor of `previous`? Both must already pass verifyBinding. */
export function verifySuccessor(previous: KeyBinding, next: KeyBinding): { ok: true } | { ok: false; reason: string } {
  if (next.agent !== previous.agent) return { ok: false, reason: 'successor names a different agent' };
  if (next.seq !== previous.seq + 1) return { ok: false, reason: 'successor seq must be previous seq + 1' };
  if (next.supersedes !== bindingHash(previous)) return { ok: false, reason: 'successor does not name this binding' };
  if (Date.parse(next.issued_at) <= Date.parse(previous.issued_at)) {
    return { ok: false, reason: 'successor must be issued after the binding it supersedes' };
  }
  const key = next.previous_signer === 'witness' ? previous.witness_public_key : previous.threadline_public_key;
  const msg = Buffer.from(PREVIOUS_CONTEXT + canonicalize(unsignedPart(next)));
  if (!next.previous_signature || !verifyBytes(key, msg, next.previous_signature)) {
    return { ok: false, reason: `bad previous_signature from the previous ${next.previous_signer} key` };
  }
  return { ok: true };
}

export function createBindingRevocation(input: {
  binding: KeyBinding;
  signer: KeyRole;
  key: KeyPairHex;
  reason: string;
  effectiveFrom: Date;
  issuedAt?: Date;
}): BindingRevocation {
  const unsigned = {
    type: BINDING_REVOCATION_TYPE,
    agent: input.binding.agent,
    binding: bindingHash(input.binding),
    effective_from: input.effectiveFrom.toISOString(),
    issued_at: (input.issuedAt ?? new Date()).toISOString(),
    reason: input.reason,
    signer: input.signer,
  } as const;
  return {
    ...unsigned,
    signature: signBytes(input.key.privateKey, Buffer.from(REVOCATION_CONTEXT + canonicalize(unsigned))),
  };
}

/** Verify a binding revocation against the binding it names. Either of that binding's keys may sign it. */
export function verifyBindingRevocation(rev: unknown, binding: KeyBinding): { ok: true } | { ok: false; reason: string } {
  if (!rev || typeof rev !== 'object') return { ok: false, reason: 'not an object' };
  const { signature, ...unsigned } = rev as BindingRevocation;
  const allowed = ['type', 'agent', 'binding', 'effective_from', 'issued_at', 'reason', 'signer'];
  if (Object.keys(unsigned).some(k => !allowed.includes(k))) return { ok: false, reason: 'unknown field' };
  if (unsigned.type !== BINDING_REVOCATION_TYPE) return { ok: false, reason: `type must be ${BINDING_REVOCATION_TYPE}` };
  if (unsigned.agent !== binding.agent || unsigned.binding !== bindingHash(binding)) {
    return { ok: false, reason: 'revocation does not name this binding' };
  }
  if (!isIsoDate(unsigned.effective_from) || !isIsoDate(unsigned.issued_at)) return { ok: false, reason: 'bad timestamp' };
  if (typeof unsigned.reason !== 'string' || unsigned.reason.length === 0 || unsigned.reason.length > 2000) {
    return { ok: false, reason: 'reason must be a non-empty string' };
  }
  if (unsigned.signer !== 'witness' && unsigned.signer !== 'threadline') return { ok: false, reason: 'bad signer' };
  const key = unsigned.signer === 'witness' ? binding.witness_public_key : binding.threadline_public_key;
  if (!verifyBytes(key, Buffer.from(REVOCATION_CONTEXT + canonicalize(unsigned)), signature)) {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true };
}

export function bindingRevocationHash(rev: BindingRevocation): string {
  const { signature: _ignored, ...unsigned } = rev;
  return crypto.createHash('sha256').update(REVOCATION_CONTEXT + canonicalize(unsigned)).digest('hex');
}

function body(
  agent: string,
  seq: number,
  supersedes: string | undefined,
  threadline: KeyPairHex,
  witness: KeyPairHex,
  issuedAt?: Date,
): UnsignedBinding {
  return {
    type: BINDING_TYPE,
    agent,
    seq,
    ...(supersedes ? { supersedes } : {}),
    threadline_fingerprint: threadlineFingerprint(threadline.publicKey),
    threadline_public_key: threadline.publicKey,
    witness_public_key: witness.publicKey,
    key_id: keyIdFor(witness.publicKey),
    issued_at: (issuedAt ?? new Date()).toISOString(),
  };
}

function sign(b: UnsignedBinding, threadline: KeyPairHex, witness: KeyPairHex): KeyBinding {
  const msg = canonicalize(b);
  return {
    ...b,
    threadline_signature: signBytes(threadline.privateKey, Buffer.from(THREADLINE_CONTEXT + msg)),
    witness_signature: signBytes(witness.privateKey, Buffer.from(WITNESS_CONTEXT + msg)),
  };
}

function unsignedPart(b: UnsignedBinding | KeyBinding): UnsignedBinding {
  const {
    threadline_signature: _t,
    witness_signature: _w,
    previous_signer: _ps,
    previous_signature: _pg,
    ...rest
  } = b as KeyBinding;
  return rest;
}
