import { createHash, randomBytes } from 'node:crypto';

/** One-use proof that a pool front verified a dashboard PIN session for one
 * browser key and one target. The raw PIN and front-local session never leave
 * the front machine. This proof only admits a target-local operator session;
 * it is not a desktop grant or a stream ticket. */
export interface DesktopOperatorAssertion {
  version: 'instar-desktop-operator-v1';
  issuerMachineId: string;
  targetMachineId: string;
  browserKeyDigest: string;
  browserNonce: string;
  operation: 'begin';
  jti: string;
  issuedAtMs: number;
  expiresAtMs: number;
  signature: string;
}

export const DESKTOP_OPERATOR_MAX_TTL_MS = 30_000;
export const DESKTOP_OPERATOR_CLOCK_SKEW_MS = 2_000;
const MACHINE_ID = /^m_[a-f0-9]{32}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export function desktopBrowserKeyDigest(publicKey: string): string {
  if (!publicKey || publicKey.length > 512) throw new Error('desktop-browser-key-invalid');
  return createHash('sha256').update(publicKey, 'utf8').digest('base64url');
}

export function canonicalDesktopOperatorAssertion(
  assertion: Omit<DesktopOperatorAssertion, 'signature'>,
): string {
  return JSON.stringify([
    assertion.version, assertion.issuerMachineId, assertion.targetMachineId,
    assertion.browserKeyDigest, assertion.browserNonce, assertion.operation,
    assertion.jti, assertion.issuedAtMs, assertion.expiresAtMs,
  ]);
}

export function mintDesktopOperatorAssertion(input: {
  issuerMachineId: string;
  targetMachineId: string;
  browserPublicKey: string;
  browserNonce: string;
  nowMs: number;
  sign: (canonical: string) => string;
}): DesktopOperatorAssertion {
  if (!MACHINE_ID.test(input.issuerMachineId) || !MACHINE_ID.test(input.targetMachineId)
    || !NONCE.test(input.browserNonce) || !Number.isSafeInteger(input.nowMs)) {
    throw new Error('desktop-operator-assertion-invalid-input');
  }
  const unsigned: Omit<DesktopOperatorAssertion, 'signature'> = {
    version: 'instar-desktop-operator-v1',
    issuerMachineId: input.issuerMachineId,
    targetMachineId: input.targetMachineId,
    browserKeyDigest: desktopBrowserKeyDigest(input.browserPublicKey),
    browserNonce: input.browserNonce,
    operation: 'begin',
    jti: randomBytes(24).toString('base64url'),
    issuedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + DESKTOP_OPERATOR_MAX_TTL_MS,
  };
  return { ...unsigned, signature: input.sign(canonicalDesktopOperatorAssertion(unsigned)) };
}

/** Settings for one physical Mac, signed by the designated front. A separate
 * version, so `begin`'s bytes stay unchanged for targets not yet updated. */
export interface DesktopLockedAssertion {
  version: 'instar-desktop-locked-v1';
  issuerMachineId: string;
  targetMachineId: string;
  operation: 'locked-settings' | 'locked-disable';
  settingsDigest: string;
  jti: string;
  issuedAtMs: number;
  expiresAtMs: number;
  signature: string;
}

export function desktopLockedSettingsDigest(settings: unknown): string {
  return createHash('sha256').update(JSON.stringify(settings ?? null), 'utf8').digest('base64url');
}

export function canonicalDesktopLockedAssertion(assertion: Omit<DesktopLockedAssertion, 'signature'>): string {
  return JSON.stringify([assertion.version, assertion.issuerMachineId, assertion.targetMachineId,
    assertion.operation, assertion.settingsDigest, assertion.jti, assertion.issuedAtMs, assertion.expiresAtMs]);
}

export function mintDesktopLockedAssertion(input: {
  issuerMachineId: string; targetMachineId: string; operation: DesktopLockedAssertion['operation'];
  settings: unknown; nowMs: number; sign: (canonical: string) => string;
}): DesktopLockedAssertion {
  if (!MACHINE_ID.test(input.issuerMachineId) || !MACHINE_ID.test(input.targetMachineId)
    || !Number.isSafeInteger(input.nowMs)) throw new Error('desktop-operator-assertion-invalid-input');
  const unsigned: Omit<DesktopLockedAssertion, 'signature'> = {
    version: 'instar-desktop-locked-v1', issuerMachineId: input.issuerMachineId,
    targetMachineId: input.targetMachineId, operation: input.operation,
    settingsDigest: desktopLockedSettingsDigest(input.settings),
    jti: randomBytes(24).toString('base64url'),
    issuedAtMs: input.nowMs, expiresAtMs: input.nowMs + DESKTOP_OPERATOR_MAX_TTL_MS,
  };
  return { ...unsigned, signature: input.sign(canonicalDesktopLockedAssertion(unsigned)) };
}

export function verifyDesktopLockedAssertion(input: {
  assertion: DesktopLockedAssertion; expectedTargetMachineId: string; expectedIssuerMachineId: string;
  settings: unknown; nowMs: number; resolveIssuerKey: (machineId: string) => string | null;
  verifySignature: (canonical: string, signature: string, publicKey: string) => boolean;
  seenJti: (jti: string) => boolean;
}): { ok: true; jti: string } | { ok: false; reason: DesktopOperatorAssertionRefusal } {
  const a = input.assertion;
  if (!a || a.version !== 'instar-desktop-locked-v1' || (a.operation !== 'locked-settings' && a.operation !== 'locked-disable')
    || !MACHINE_ID.test(a.issuerMachineId) || !MACHINE_ID.test(a.targetMachineId)
    || !/^[A-Za-z0-9_-]{32}$/.test(a.jti) || !Number.isSafeInteger(a.issuedAtMs) || !Number.isSafeInteger(a.expiresAtMs)
    || typeof a.signature !== 'string' || a.signature.length < 32 || a.signature.length > 256) return { ok: false, reason: 'malformed' };
  if (a.targetMachineId !== input.expectedTargetMachineId) return { ok: false, reason: 'wrong-target' };
  if (a.issuerMachineId !== input.expectedIssuerMachineId) return { ok: false, reason: 'wrong-issuer' };
  if (a.settingsDigest !== desktopLockedSettingsDigest(input.settings)) return { ok: false, reason: 'wrong-browser' };
  if (a.expiresAtMs <= input.nowMs) return { ok: false, reason: 'expired' };
  if (a.issuedAtMs > input.nowMs + DESKTOP_OPERATOR_CLOCK_SKEW_MS) return { ok: false, reason: 'not-yet-valid' };
  if (a.expiresAtMs <= a.issuedAtMs || a.expiresAtMs - a.issuedAtMs > DESKTOP_OPERATOR_MAX_TTL_MS) return { ok: false, reason: 'ttl-invalid' };
  const key = input.resolveIssuerKey(a.issuerMachineId);
  if (!key) return { ok: false, reason: 'unknown-issuer' };
  const { signature: _signature, ...unsigned } = a;
  if (!input.verifySignature(canonicalDesktopLockedAssertion(unsigned), a.signature, key)) return { ok: false, reason: 'signature-invalid' };
  if (input.seenJti(a.jti)) return { ok: false, reason: 'replayed' };
  return { ok: true, jti: a.jti };
}

export type DesktopOperatorAssertionRefusal =
  | 'malformed' | 'wrong-target' | 'wrong-issuer' | 'wrong-browser'
  | 'expired' | 'not-yet-valid' | 'ttl-invalid' | 'unknown-issuer'
  | 'signature-invalid' | 'replayed';

/** Caller records the jti only after an accepted result, before creating the
 * target-local session. Verification never trusts the issuer claimed in body:
 * the authenticated mesh transport supplies expectedIssuerMachineId. */
export function verifyDesktopOperatorAssertion(input: {
  assertion: DesktopOperatorAssertion;
  expectedTargetMachineId: string;
  expectedIssuerMachineId: string;
  browserPublicKey: string;
  browserNonce: string;
  nowMs: number;
  resolveIssuerKey: (machineId: string) => string | null;
  verifySignature: (canonical: string, signature: string, publicKey: string) => boolean;
  seenJti: (jti: string) => boolean;
}): { ok: true; jti: string } | { ok: false; reason: DesktopOperatorAssertionRefusal } {
  const a = input.assertion;
  if (!a || a.version !== 'instar-desktop-operator-v1'
    || !MACHINE_ID.test(a.issuerMachineId) || !MACHINE_ID.test(a.targetMachineId)
    || !DIGEST.test(a.browserKeyDigest) || !NONCE.test(a.browserNonce)
    || a.operation !== 'begin' || !/^[A-Za-z0-9_-]{32}$/.test(a.jti)
    || !Number.isSafeInteger(a.issuedAtMs) || !Number.isSafeInteger(a.expiresAtMs)
    || typeof a.signature !== 'string' || a.signature.length < 32 || a.signature.length > 256
    || !Number.isSafeInteger(input.nowMs)) return { ok: false, reason: 'malformed' };
  if (a.targetMachineId !== input.expectedTargetMachineId) return { ok: false, reason: 'wrong-target' };
  if (a.issuerMachineId !== input.expectedIssuerMachineId) return { ok: false, reason: 'wrong-issuer' };
  let digest: string;
  try { digest = desktopBrowserKeyDigest(input.browserPublicKey); }
  catch { return { ok: false, reason: 'wrong-browser' }; }
  if (a.browserKeyDigest !== digest || a.browserNonce !== input.browserNonce) return { ok: false, reason: 'wrong-browser' };
  if (a.expiresAtMs <= input.nowMs) return { ok: false, reason: 'expired' };
  if (a.issuedAtMs > input.nowMs + DESKTOP_OPERATOR_CLOCK_SKEW_MS) return { ok: false, reason: 'not-yet-valid' };
  if (a.expiresAtMs <= a.issuedAtMs || a.expiresAtMs - a.issuedAtMs > DESKTOP_OPERATOR_MAX_TTL_MS) {
    return { ok: false, reason: 'ttl-invalid' };
  }
  const key = input.resolveIssuerKey(a.issuerMachineId);
  if (!key) return { ok: false, reason: 'unknown-issuer' };
  const { signature: _signature, ...unsigned } = a;
  if (!input.verifySignature(canonicalDesktopOperatorAssertion(unsigned), a.signature, key)) {
    return { ok: false, reason: 'signature-invalid' };
  }
  if (input.seenJti(a.jti)) return { ok: false, reason: 'replayed' };
  return { ok: true, jti: a.jti };
}
