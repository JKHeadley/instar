/**
 * PasskeyCellMandate — the signed, cross-machine authority carrier for agent-held Google passkeys
 * (spec docs/specs/agent-held-google-passkey.md §3.3, FD12).
 *
 * A mandate type SEPARATE from `account-follow-me`. It reuses the WS5.2 idea (an Ed25519 signature
 * by the issuing machine's identity key, bound to that machine's fingerprint) with three additions
 * the follow-me scheme does not have: an EXPECTED-ISSUER SET on the receiver, a durable NONCE
 * LEDGER, and a short EXPIRY (15 minutes, ±2 minutes skew) — except for `revoke`, which only removes
 * authority and is deliberately exempt from expiry so it can be re-delivered for weeks unchanged.
 *
 * Isolation both ways is structural: the signed bytes carry a DISTINCT domain tag, so a follow-me
 * issuance signature can never verify as a passkey-cell mandate and vice versa, whatever the
 * payload claims; the follow-me consumer additionally refuses any bundle without an
 * `account-follow-me` authority, and the passkey receiver refuses any body whose `type` is not
 * `passkey-cell`.
 *
 * Pure logic over injected seams (issuer public-key resolver, issuer set, nonce ledger, clock) so
 * the authority decision is unit-testable without a server. The dashboard PIN never appears here.
 */
import crypto from 'node:crypto';
import type { PasskeyIssuerSet, IssuerTrustVerdict } from './PasskeyIssuerSet.js';
import type { PasskeyNonceLedger } from './PasskeyNonceLedger.js';

/** Domain-separation tag — never interchangeable with the follow-me issuance tag. */
export const PASSKEY_CELL_DOMAIN = 'instar-passkey-cell-mandate-v1';
export const PASSKEY_MANDATE_TTL_MS = 15 * 60_000;
export const PASSKEY_MANDATE_SKEW_MS = 2 * 60_000;

export const PASSKEY_CELL_OPS = [
  'grant', 'revoke', 'enroll', 'prove', 'adopt', 'delete-legacy', 'revert-method', 'attest-google-removed',
  'suspend-now', 'resume-suspension', 'issuer-add', 'issuer-remove', 'exclude-peer', 'include-peer', 'recheck-chrome',
] as const;
export type PasskeyCellOp = typeof PASSKEY_CELL_OPS[number];

export interface PasskeyCellMandateBody {
  v: 1;
  type: 'passkey-cell';
  /** The VERIFIED principal on the issuing machine (operator uid / dashboard-PIN identity). */
  principal: string;
  /** Canonical account email the op addresses ('' for non-cell ops such as issuer-add). */
  canonicalEmail: string;
  /** The machine that must act — the receiver refuses anything not addressed to itself. */
  targetMachineId: string;
  op: PasskeyCellOp;
  /** Op arguments (e.g. revoke: { revokesGrantSeq?: number }; issuer-add: { machineId }). */
  args: Record<string, unknown>;
  issuedAt: string;
  nonce: string;
  expiresAt: string;
  /** Re-signed revoke: the nonce of the copy it replaces (same principal/issuedAt/cutoff). */
  replacesNonce?: string;
}

export interface PasskeyCellSignature {
  alg: 'ed25519';
  /** The issuing machine's id/fingerprint — bound into the signed bytes. */
  issuerFingerprint: string;
  sig: string;
}

export interface PortablePasskeyCellMandate {
  body: PasskeyCellMandateBody;
  signature: PasskeyCellSignature;
}

/** Deterministic canonical form: sorted keys, no whitespace. */
export function canonicalPasskeyCellBody(body: PasskeyCellMandateBody): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sortKeys(body));
}

function signingInput(canonical: string, issuerFingerprint: string): Buffer {
  return Buffer.from(`${PASSKEY_CELL_DOMAIN}\x1f${issuerFingerprint}\x1f${canonical}`, 'utf-8');
}

export function mintPasskeyCellBody(input: {
  principal: string; canonicalEmail: string; targetMachineId: string; op: PasskeyCellOp;
  args?: Record<string, unknown>; now?: number; ttlMs?: number; replacesNonce?: string;
}): PasskeyCellMandateBody {
  const now = input.now ?? Date.now();
  return {
    v: 1, type: 'passkey-cell', principal: input.principal, canonicalEmail: input.canonicalEmail.trim().toLowerCase(),
    targetMachineId: input.targetMachineId, op: input.op, args: input.args ?? {},
    issuedAt: new Date(now).toISOString(), nonce: crypto.randomUUID(),
    expiresAt: new Date(now + (input.ttlMs ?? PASSKEY_MANDATE_TTL_MS)).toISOString(),
    ...(input.replacesNonce ? { replacesNonce: input.replacesNonce } : {}),
  };
}

/** Sign on the issuing machine with its Ed25519 identity private key. */
export function signPasskeyCellMandate(body: PasskeyCellMandateBody, issuerFingerprint: string, ed25519PrivateKey: crypto.KeyObject | string): PortablePasskeyCellMandate {
  if (!issuerFingerprint) throw new Error('passkey-cell-issuer-fingerprint-required');
  if (body.type !== 'passkey-cell' || !PASSKEY_CELL_OPS.includes(body.op)) throw new Error('passkey-cell-body-invalid');
  const key = typeof ed25519PrivateKey === 'string' ? crypto.createPrivateKey(ed25519PrivateKey) : ed25519PrivateKey;
  const sig = crypto.sign(null, signingInput(canonicalPasskeyCellBody(body), issuerFingerprint), key);
  return { body, signature: { alg: 'ed25519', issuerFingerprint, sig: sig.toString('base64') } };
}

export type PasskeyCellVerifyReason =
  | 'malformed' | 'not-a-passkey-cell-mandate' | 'unknown-op' | 'unsupported-alg' | 'issuer-not-trusted'
  | 'no-issuer-key' | 'bad-issuer-key' | 'bad-signature' | 'target-not-this-machine' | 'expired' | 'not-yet-valid'
  | 'replay' | 'nonce-ledger-unreadable' | 'ttl-too-long';

export type PasskeyCellVerifyResult =
  | { ok: true; body: PasskeyCellMandateBody; issuerMachineId: string }
  | { ok: false; reason: PasskeyCellVerifyReason; detail?: string; issuerVerdict?: IssuerTrustVerdict; replayOf?: string };

export interface PasskeyCellVerifyDeps {
  selfMachineId: string;
  /** The REGISTERED Ed25519 public key (PEM) for a machine id, from THIS machine's registry — never from the payload. */
  issuerPublicKeyPem: (machineId: string) => string | null;
  issuers: Pick<PasskeyIssuerSet, 'verdict'>;
  nonces: Pick<PasskeyNonceLedger, 'get'>;
  now?: () => number;
  skewMs?: number;
}

/**
 * Verify a received mandate. FAILS CLOSED on every uncertainty. Order: shape → issuer trusted →
 * signature → target → freshness (revoke exempt) → replay. Recording the nonce is the CALLER's
 * step (it must be written together with the revoke cutoff BEFORE acting).
 */
export function verifyPasskeyCellMandate(portable: unknown, deps: PasskeyCellVerifyDeps): PasskeyCellVerifyResult {
  const p = portable as Partial<PortablePasskeyCellMandate> | null | undefined;
  if (!p || typeof p !== 'object' || !p.body || typeof p.body !== 'object' || !p.signature || typeof p.signature !== 'object') {
    return { ok: false, reason: 'malformed' };
  }
  const body = p.body as PasskeyCellMandateBody;
  const signature = p.signature as PasskeyCellSignature;
  if (body.v !== 1 || body.type !== 'passkey-cell') return { ok: false, reason: 'not-a-passkey-cell-mandate' };
  if (!PASSKEY_CELL_OPS.includes(body.op)) return { ok: false, reason: 'unknown-op', detail: String(body.op) };
  for (const f of ['principal', 'targetMachineId', 'issuedAt', 'nonce', 'expiresAt'] as const) {
    if (typeof body[f] !== 'string' || !body[f]) return { ok: false, reason: 'malformed', detail: f };
  }
  if (typeof body.canonicalEmail !== 'string' || !body.args || typeof body.args !== 'object') return { ok: false, reason: 'malformed' };
  if (signature.alg !== 'ed25519' || typeof signature.issuerFingerprint !== 'string' || typeof signature.sig !== 'string') {
    return { ok: false, reason: 'unsupported-alg' };
  }
  // Expected-issuer set FIRST: an untrusted issuer is refused before any key lookup (no TOFU).
  const issuerVerdict = deps.issuers.verdict(signature.issuerFingerprint);
  if (!issuerVerdict.trusted) return { ok: false, reason: 'issuer-not-trusted', issuerVerdict };
  const pem = deps.issuerPublicKeyPem(signature.issuerFingerprint);
  if (!pem) return { ok: false, reason: 'no-issuer-key' };
  let pub: crypto.KeyObject;
  try { pub = crypto.createPublicKey(pem); } catch (err) { return { ok: false, reason: 'bad-issuer-key', detail: err instanceof Error ? err.message : String(err) }; }
  let valid = false;
  try {
    valid = crypto.verify(null, signingInput(canonicalPasskeyCellBody(body), signature.issuerFingerprint), pub, Buffer.from(signature.sig, 'base64'));
  } catch { valid = false; }
  if (!valid) return { ok: false, reason: 'bad-signature' };
  if (body.targetMachineId !== deps.selfMachineId) return { ok: false, reason: 'target-not-this-machine' };
  const now = (deps.now ?? Date.now)();
  const skew = deps.skewMs ?? PASSKEY_MANDATE_SKEW_MS;
  const issued = Date.parse(body.issuedAt);
  const expires = Date.parse(body.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return { ok: false, reason: 'malformed', detail: 'timestamps' };
  if (issued - skew > now) return { ok: false, reason: 'not-yet-valid' };
  // Defence in depth: an issuer cannot mint a long-lived mandate by stretching expiresAt.
  if (expires - issued > PASSKEY_MANDATE_TTL_MS + skew) return { ok: false, reason: 'ttl-too-long' };
  // Only `revoke` is exempt from expiry (it can only remove authority); every other op must be fresh.
  if (body.op !== 'revoke' && now > expires + skew) return { ok: false, reason: 'expired' };
  let seen;
  try {
    seen = deps.nonces.get(body.nonce) ?? (body.replacesNonce ? deps.nonces.get(body.replacesNonce) : null);
  } catch (err) {
    return { ok: false, reason: 'nonce-ledger-unreadable', detail: err instanceof Error ? err.message : String(err) };
  }
  if (seen) return { ok: false, reason: 'replay', replayOf: seen.nonce };
  return { ok: true, body, issuerMachineId: signature.issuerFingerprint };
}

/** `<canonicalEmail>@<targetMachineId>` — the ledger's cell key. */
export function passkeyCellKey(body: Pick<PasskeyCellMandateBody, 'canonicalEmail' | 'targetMachineId'>): string {
  return `${body.canonicalEmail}@${body.targetMachineId}`;
}
