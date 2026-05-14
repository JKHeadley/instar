/**
 * RemediationContext — sign/verify helpers for the capability-token that
 * the Remediator hands to a surface at `invokeFromRemediator(ctx)` entry.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A3 / §A23 / §A42:
 *   - The `RemediationContext` is a capability token. Possession of a
 *     valid-HMAC ctx is the surface's authority to act.
 *   - The HMAC is computed over a canonical body that pins:
 *       attemptId, runbookId, expiresAt, monotonicDeadline.
 *     `lockHandle` and `auditToken` are not part of the body — the lock
 *     handle has its own per-lock signature (F-1 inflight leaf), and the
 *     audit token is its own capability verified by AuditWriter.
 *   - The leaf key is per-`runbookId` (`capability` context). Forging a
 *     ctx for runbook A using a ctx legitimately issued for runbook B is
 *     not possible because the verify recomputes the HMAC with a leaf key
 *     derived from `ctx.runbookId`.
 *
 * Surfaces (currently NativeModuleHealer.invokeFromRemediator) MUST call
 * `verifyRemediationContext(ctx, keyVault)` at entry. An invalid ctx is
 * NOT an exception — it just means the surface SHOULD NOT act as if a
 * Remediator authorized the call. Per spec the correct response is to
 * fall back to the in-line legacy path + emit a `remediation.surface.
 * invalid-context` warning.
 */

import crypto from 'node:crypto';
import type { RemediationKeyVault } from './RemediationKeyVault.js';
import type { RemediationContext } from './Remediator.js';

// Re-export the type so surfaces can import it from one place.
export type { RemediationContext };

/**
 * Structural narrowing of the keyVault dependency. We accept anything that
 * implements `deriveLeafKey('capability', runbookId)` so tests can stub the
 * real vault without standing up the keychain backend.
 */
export interface CapabilityLeafKeyVault {
  deriveLeafKey(context: 'capability', scopeId: string): Buffer;
}

const HMAC_TAG = Buffer.from('instar-f8-ctx-v1\x00', 'utf-8');

/**
 * Build the deterministic byte body that the HMAC covers. Order + width
 * are fixed: tag | attemptId-prefixed | runbookId-prefixed |
 * expiresAt(u64be) | monotonicDeadline(u64be).
 */
function canonicalContextBody(
  ctx: Pick<
    RemediationContext,
    'attemptId' | 'runbookId' | 'expiresAt' | 'monotonicDeadline'
  >,
): Buffer {
  const writeStr = (s: string): Buffer => {
    const body = Buffer.from(s, 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  };

  const expiresAtBuf = Buffer.alloc(8);
  expiresAtBuf.writeBigUInt64BE(
    BigInt(Math.max(0, Math.floor(ctx.expiresAt))),
    0,
  );

  const monoBuf = Buffer.alloc(8);
  const mono =
    typeof ctx.monotonicDeadline === 'bigint' && ctx.monotonicDeadline >= 0n
      ? ctx.monotonicDeadline
      : 0n;
  monoBuf.writeBigUInt64BE(mono, 0);

  return Buffer.concat([
    HMAC_TAG,
    writeStr(ctx.attemptId),
    writeStr(ctx.runbookId),
    expiresAtBuf,
    monoBuf,
  ]);
}

/**
 * Compute the HMAC for a `RemediationContext`. The caller assigns the
 * returned buffer to `ctx.hmac` before handing the ctx to a surface.
 *
 * Derives the leaf via `keyVault.deriveLeafKey('capability', runbookId)`
 * per F-1. Throws if the keyVault rejects the derivation (e.g. master
 * missing) — sign-side failure is fail-closed.
 */
export function signRemediationContext(
  ctx: Pick<
    RemediationContext,
    'attemptId' | 'runbookId' | 'expiresAt' | 'monotonicDeadline'
  >,
  keyVault: CapabilityLeafKeyVault | RemediationKeyVault,
): Buffer {
  const leaf = (keyVault as CapabilityLeafKeyVault).deriveLeafKey(
    'capability',
    ctx.runbookId,
  );
  const body = canonicalContextBody(ctx);
  return crypto.createHmac('sha256', leaf).update(body).digest();
}

/**
 * Verify the HMAC on a `RemediationContext`. Returns `true` iff the
 * signature is a valid HMAC over the canonical body, using a leaf key
 * derived from `ctx.runbookId`. Uses `crypto.timingSafeEqual` to avoid
 * timing-side-channel leaks on the comparison.
 *
 * Returns `false` (never throws) for any of:
 *   - `ctx.hmac` missing / not a buffer
 *   - `ctx.runbookId` missing / empty
 *   - keyVault derivation throws
 *   - HMAC length / value mismatch
 *
 * The boolean return shape lets the surface fall back to the legacy
 * in-line path on rejection without crashing the request.
 */
export function verifyRemediationContext(
  ctx: RemediationContext | (RemediationContext & { hmac?: Buffer }),
  keyVault: CapabilityLeafKeyVault | RemediationKeyVault,
): boolean {
  // Structural guards. A missing hmac field is the most common forgery
  // shape (caller forgot to sign, or hostile caller dropped the field).
  const candidate = (ctx as RemediationContext & { hmac?: Buffer }).hmac;
  if (!Buffer.isBuffer(candidate) || candidate.length === 0) return false;
  if (typeof ctx.runbookId !== 'string' || ctx.runbookId.length === 0) {
    return false;
  }

  let leaf: Buffer;
  try {
    leaf = (keyVault as CapabilityLeafKeyVault).deriveLeafKey(
      'capability',
      ctx.runbookId,
    );
  } catch {
    return false;
  }

  const body = canonicalContextBody(ctx);
  const expected = crypto.createHmac('sha256', leaf).update(body).digest();
  if (expected.length !== candidate.length) return false;
  try {
    return crypto.timingSafeEqual(expected, candidate);
  } catch {
    return false;
  }
}
