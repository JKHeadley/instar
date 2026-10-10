/**
 * Key bindings — tie an agent's Witness key to its Threadline identity, over time.
 *
 * A binding is signed by BOTH keys it names. The Threadline signature says
 * "the agent you already know on Threadline vouches for this Witness key";
 * the Witness signature proves whoever published the binding holds the
 * Witness private key, so nobody can bind a key they merely found.
 *
 * Bindings form a chain per agent: seq 0 starts it, and every later binding
 * names the hash of the one it supersedes and is ALSO signed by keys of that
 * previous binding (previous_signatures).
 *
 * The rules rest on one fact (Echo, PR 2161 review): theft COPIES a key, it
 * does not remove it. When a key is stolen, the real owner still holds both.
 *  - A successor signed by BOTH previous keys is a normal rotation and takes
 *    effect at once. A one-key thief cannot produce one.
 *  - A successor signed by ONE previous key is the recovery path, for a key
 *    that is actually lost. A store holds it pending for RECOVERY_HOLD_MS from
 *    when it first saw it. During the hold the other previous key can veto it
 *    (SuccessorVeto), which leaves the agent conflicted until a person
 *    re-pairs. When it matures, its window starts no earlier than first-seen,
 *    so it can never reach back over records already made.
 *  - A binding revocation signed by ONE of the binding's keys takes effect no
 *    earlier than first-seen minus the clock skew: an instant kill switch for
 *    the future, and at worst a fail-closed denial of service in a thief's
 *    hands. Backdating effective_from needs BOTH keys.
 *
 * The time-dependent parts (hold, first-seen) are judged by each store from
 * its own receipt times, so two stores can briefly disagree during a hold.
 * That is by design: the hold is what gives a veto time to spread.
 */

import crypto from 'node:crypto';
import { canonicalize } from './canonical.js';
import { isHex, keyIdFor, signBytes, verifyBytes } from './keys.js';
import { isIsoDate } from './record.js';

export const BINDING_TYPE = 'WitnessKeyBinding/v0';
export const BINDING_REVOCATION_TYPE = 'WitnessKeyRevocation/v0';
export const SUCCESSOR_VETO_TYPE = 'WitnessSuccessorVeto/v0';
/** How long a one-key successor waits, from first-seen, before it counts. */
export const RECOVERY_HOLD_MS = 72 * 3_600_000;

const THREADLINE_CONTEXT = 'instar-witness-binding-v0/threadline\n';
const WITNESS_CONTEXT = 'instar-witness-binding-v0/witness\n';
const PREVIOUS_CONTEXT = 'instar-witness-binding-v0/previous\n';
const REVOCATION_CONTEXT = 'instar-witness-binding-revocation-v0\n';
const VETO_CONTEXT = 'instar-witness-successor-veto-v0\n';
const HASH_CONTEXT = 'instar-witness-binding-v0/hash\n';

export type KeyRole = 'witness' | 'threadline';
export type RoleSignatures = { witness?: string; threadline?: string };
export type RoleKeys = { witness?: KeyPairHex; threadline?: KeyPairHex };

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
  /** Signatures by the PREVIOUS binding's keys. Present exactly when seq > 0. */
  previous_signatures?: RoleSignatures;
}

export interface BindingRevocation {
  type: typeof BINDING_REVOCATION_TYPE;
  agent: string;
  /** Hash of the binding being revoked. */
  binding: string;
  /** Requested start. With one signature a store clamps it to no earlier than first-seen minus clock skew. */
  effective_from: string;
  issued_at: string;
  reason: string;
  signatures: RoleSignatures;
}

export interface SuccessorVeto {
  type: typeof SUCCESSOR_VETO_TYPE;
  agent: string;
  /** Hash of the one-key successor being objected to. */
  successor: string;
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
  return sha256(HASH_CONTEXT + canonicalize(unsignedPart(binding)));
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
 * Sign with BOTH of previous's keys for a normal rotation; with one only when the
 * other is genuinely lost (that successor is held for RECOVERY_HOLD_MS).
 */
export function createSuccessorBinding(input: {
  previous: KeyBinding;
  threadline: KeyPairHex;
  witness: KeyPairHex;
  previousKeys: RoleKeys;
  issuedAt?: Date;
}): KeyBinding {
  const b = body(input.previous.agent, input.previous.seq + 1, bindingHash(input.previous), input.threadline, input.witness, input.issuedAt);
  const msg = Buffer.from(PREVIOUS_CONTEXT + canonicalize(b));
  return { ...sign(b, input.threadline, input.witness), previous_signatures: signAs(input.previousKeys, msg) };
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
    'witness_public_key', 'key_id', 'issued_at', 'threadline_signature', 'witness_signature', 'previous_signatures',
  ];
  const unknown = Object.keys(full).find(k => !allowed.includes(k));
  if (unknown) return { ok: false, reason: `unknown field ${unknown}` };
  const b = full as unknown as KeyBinding;
  if (b.type !== BINDING_TYPE) return { ok: false, reason: `type must be ${BINDING_TYPE}` };
  if (typeof b.agent !== 'string' || !/^did:[a-z0-9]+:\S+$/.test(b.agent)) return { ok: false, reason: 'agent must be a did: URI' };
  if (!Number.isSafeInteger(b.seq) || b.seq < 0) return { ok: false, reason: 'seq must be a non-negative integer' };
  if (b.seq === 0) {
    if (b.supersedes !== undefined || b.previous_signatures !== undefined) {
      return { ok: false, reason: 'a seq 0 binding cannot supersede anything' };
    }
  } else {
    if (!isHex(b.supersedes, 32)) return { ok: false, reason: 'a successor must name the superseded binding hash' };
    if (!roleSignaturesShapeOk(b.previous_signatures)) {
      return { ok: false, reason: 'a successor must carry previous_signatures from one or both previous keys' };
    }
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

/**
 * Is `next` a successor of `previous`, and which of previous's keys signed it?
 * Both must already pass verifyBinding. Every signature present must be valid —
 * a bad one is a rejection, never silently ignored.
 */
export function verifySuccessor(
  previous: KeyBinding,
  next: KeyBinding,
): { ok: true; signers: KeyRole[] } | { ok: false; reason: string } {
  if (next.agent !== previous.agent) return { ok: false, reason: 'successor names a different agent' };
  if (next.seq !== previous.seq + 1) return { ok: false, reason: 'successor seq must be previous seq + 1' };
  if (next.supersedes !== bindingHash(previous)) return { ok: false, reason: 'successor does not name this binding' };
  if (Date.parse(next.issued_at) <= Date.parse(previous.issued_at)) {
    return { ok: false, reason: 'successor must be issued after the binding it supersedes' };
  }
  const msg = Buffer.from(PREVIOUS_CONTEXT + canonicalize(unsignedPart(next)));
  return checkRoleSignatures(previous, next.previous_signatures, msg, 'previous_signatures');
}

export function createBindingRevocation(input: {
  binding: KeyBinding;
  keys: RoleKeys;
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
  } as const;
  return { ...unsigned, signatures: signAs(input.keys, Buffer.from(REVOCATION_CONTEXT + canonicalize(unsigned))) };
}

/** Verify a binding revocation against the binding it names; returns which of that binding's keys signed. */
export function verifyBindingRevocation(
  rev: unknown,
  binding: KeyBinding,
): { ok: true; signers: KeyRole[] } | { ok: false; reason: string } {
  if (!rev || typeof rev !== 'object') return { ok: false, reason: 'not an object' };
  const { signatures, ...unsigned } = rev as BindingRevocation;
  const allowed = ['type', 'agent', 'binding', 'effective_from', 'issued_at', 'reason'];
  if (Object.keys(unsigned).some(k => !allowed.includes(k))) return { ok: false, reason: 'unknown field' };
  if (unsigned.type !== BINDING_REVOCATION_TYPE) return { ok: false, reason: `type must be ${BINDING_REVOCATION_TYPE}` };
  if (unsigned.agent !== binding.agent || unsigned.binding !== bindingHash(binding)) {
    return { ok: false, reason: 'revocation does not name this binding' };
  }
  if (!isIsoDate(unsigned.effective_from) || !isIsoDate(unsigned.issued_at)) return { ok: false, reason: 'bad timestamp' };
  if (!validReason(unsigned.reason)) return { ok: false, reason: 'reason must be a non-empty string' };
  if (!roleSignaturesShapeOk(signatures)) return { ok: false, reason: 'signatures must hold one or both keys' };
  return checkRoleSignatures(binding, signatures, Buffer.from(REVOCATION_CONTEXT + canonicalize(unsigned)), 'signatures');
}

export function bindingRevocationHash(rev: BindingRevocation): string {
  const { signatures: _ignored, ...unsigned } = rev;
  return sha256(REVOCATION_CONTEXT + canonicalize(unsigned));
}

/** An objection to a one-key successor, by the PREVIOUS binding's key that did not sign it. */
export function createSuccessorVeto(input: {
  successor: KeyBinding;
  signer: KeyRole;
  key: KeyPairHex;
  reason: string;
  issuedAt?: Date;
}): SuccessorVeto {
  const unsigned = {
    type: SUCCESSOR_VETO_TYPE,
    agent: input.successor.agent,
    successor: bindingHash(input.successor),
    issued_at: (input.issuedAt ?? new Date()).toISOString(),
    reason: input.reason,
    signer: input.signer,
  } as const;
  return { ...unsigned, signature: signBytes(input.key.privateKey, Buffer.from(VETO_CONTEXT + canonicalize(unsigned))) };
}

/** A veto counts only if signed by the previous binding's key that did NOT sign the successor. */
export function verifySuccessorVeto(
  veto: unknown,
  successor: KeyBinding,
  previous: KeyBinding,
): { ok: true } | { ok: false; reason: string } {
  if (!veto || typeof veto !== 'object') return { ok: false, reason: 'not an object' };
  const { signature, ...unsigned } = veto as SuccessorVeto;
  const allowed = ['type', 'agent', 'successor', 'issued_at', 'reason', 'signer'];
  if (Object.keys(unsigned).some(k => !allowed.includes(k))) return { ok: false, reason: 'unknown field' };
  if (unsigned.type !== SUCCESSOR_VETO_TYPE) return { ok: false, reason: `type must be ${SUCCESSOR_VETO_TYPE}` };
  if (unsigned.agent !== successor.agent || unsigned.successor !== bindingHash(successor)) {
    return { ok: false, reason: 'veto does not name this successor' };
  }
  if (!isIsoDate(unsigned.issued_at) || !validReason(unsigned.reason)) return { ok: false, reason: 'bad timestamp or reason' };
  if (unsigned.signer !== 'witness' && unsigned.signer !== 'threadline') return { ok: false, reason: 'bad signer' };
  if (successor.previous_signatures?.[unsigned.signer] !== undefined) {
    return { ok: false, reason: 'a veto must come from the previous key that did not sign the successor' };
  }
  const key = unsigned.signer === 'witness' ? previous.witness_public_key : previous.threadline_public_key;
  if (!verifyBytes(key, Buffer.from(VETO_CONTEXT + canonicalize(unsigned)), signature)) {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true };
}

export function successorVetoHash(veto: SuccessorVeto): string {
  const { signature: _ignored, ...unsigned } = veto;
  return sha256(VETO_CONTEXT + canonicalize(unsigned));
}

// ── helpers ──────────────────────────────────────────────────────────

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

function signAs(keys: RoleKeys, msg: Buffer): RoleSignatures {
  const out: RoleSignatures = {};
  if (keys.witness) out.witness = signBytes(keys.witness.privateKey, msg);
  if (keys.threadline) out.threadline = signBytes(keys.threadline.privateKey, msg);
  if (!out.witness && !out.threadline) throw new TypeError('at least one key is required');
  return out;
}

function roleSignaturesShapeOk(s: unknown): s is RoleSignatures {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  const keys = Object.keys(s);
  return keys.length >= 1 && keys.every(k => (k === 'witness' || k === 'threadline') && isHex((s as Record<string, unknown>)[k], 64));
}

function checkRoleSignatures(
  signer: KeyBinding,
  sigs: RoleSignatures | undefined,
  msg: Buffer,
  field: string,
): { ok: true; signers: KeyRole[] } | { ok: false; reason: string } {
  const signers: KeyRole[] = [];
  for (const role of ['witness', 'threadline'] as const) {
    const sig = sigs?.[role];
    if (sig === undefined) continue;
    const key = role === 'witness' ? signer.witness_public_key : signer.threadline_public_key;
    if (!verifyBytes(key, msg, sig)) return { ok: false, reason: `bad ${role} signature in ${field}` };
    signers.push(role);
  }
  if (!signers.length) return { ok: false, reason: `${field} is empty` };
  return { ok: true, signers };
}

function validReason(r: unknown): boolean {
  return typeof r === 'string' && r.length > 0 && r.length <= 2000;
}

function unsignedPart(b: UnsignedBinding | KeyBinding): UnsignedBinding {
  const { threadline_signature: _t, witness_signature: _w, previous_signatures: _p, ...rest } = b as KeyBinding;
  return rest;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
