/**
 * PoolLinkAssertion — the cross-machine user-authentication assertion for WS4.4
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 "Links that survive machine
 * boundaries"). SECURITY-SENSITIVE.
 *
 * When a tunnel-fronting machine proxies a `/view/:id` (or dashboard asset)
 * request to the machine that actually HOLDS the content, it must tell the
 * holder "I, the fronting machine, validated the END USER's credential (their
 * PIN session / view token)" — WITHOUT forwarding the raw credential. Each
 * machine's PIN secret and authToken NEVER cross the boundary (spec §WS4.4 b/e):
 * the holder makes its own authorization decision, but it needs to trust that
 * the user really authenticated at the edge.
 *
 * This module is PURE LOGIC — the canonical assertion bytes, the construction,
 * and the verification gate. Crypto (Ed25519 sign/verify, reusing
 * MachineIdentity.sign/verify), the single-use jti store, the peer-key lookup,
 * and the clock are injected as seams so the dangerous parts (audience-binding,
 * replay, expiry) are unit-testable with in-memory fakes. The HTTP transport +
 * production wiring sit on top and call these functions.
 *
 * Three independent properties protect every assertion (spec §WS4.4 e):
 *   (1) AUDIENCE-BOUND — the signed bytes name the EXPECTED holder fingerprint,
 *       the SPECIFIC view id, and the HTTP method. A capture cannot be replayed
 *       against another resource, another holder, or another verb.
 *   (2) SIGNED by the fronting machine's mesh key — the holder verifies the
 *       signature against the EXPECTED fronting machine's REGISTERED public key,
 *       so only a registered peer can mint a valid assertion.
 *   (3) SINGLE-USE within a short TTL — the jti is recorded by the holder on
 *       first accept; a replay inside the window is rejected, and the TTL bounds
 *       the window beyond which the assertion is stale regardless.
 *
 * The fronting machine is a DUMB RELAY: it validates the user credential locally
 * (its own concern), mints THIS assertion, and forwards it. It substitutes NO
 * machine/mesh credential for the user credential at the holder — the assertion
 * only attests "a user authenticated at the edge for this exact resource", and
 * the holder still applies its own per-view authorization on top.
 */

export type MachineFingerprint = string;

/**
 * The audience-binding triple — the exact (holder, resource, method) this
 * assertion is valid for. Any mismatch at the holder is a rejection.
 */
export interface PoolLinkAudience {
  /** The machine fingerprint (machineId) of the EXPECTED holder of the view. */
  holderFingerprint: MachineFingerprint;
  /** The specific view id this assertion authorizes (no wildcard). */
  viewId: string;
  /** The HTTP method this assertion authorizes (e.g. 'GET'). Upper-cased. */
  method: string;
}

/**
 * The assertion payload. `iss` (the fronting machine) is included in the signed
 * bytes AND used by the holder to pick which registered public key to verify
 * against — so an assertion signed by machine X cannot claim to come from Y.
 */
export interface PoolLinkAssertion {
  /** Issuer — the fronting machine fingerprint that signed this. */
  iss: MachineFingerprint;
  /** Audience — the (holder, view, method) this is bound to. */
  aud: PoolLinkAudience;
  /** Single-use id (replay control). Recorded by the holder on first accept. */
  jti: string;
  /** Issued-at, ms epoch. */
  iat: number;
  /** Expiry, ms epoch. The holder rejects at/after this. */
  exp: number;
  /**
   * The kind of end-user credential the fronting machine validated. NOT the
   * credential itself — the raw PIN / view token NEVER appears here (spec
   * §WS4.4 b). Purely informational for the holder's audit trail.
   */
  userAuth: 'pin-session' | 'view-sig' | 'view-pin';
  /** Ed25519 signature (base64) over the canonical bytes. */
  signature: string;
}

/** The canonical bytes the signature covers — field-ordered, audience included.
 *  Excludes `signature` itself. Stable ordering so sign/verify agree. */
export function canonicalizePoolLinkAssertion(
  a: Omit<PoolLinkAssertion, 'signature'>,
): string {
  return JSON.stringify([
    a.iss,
    a.aud.holderFingerprint,
    a.aud.viewId,
    a.aud.method,
    a.jti,
    a.iat,
    a.exp,
    a.userAuth,
  ]);
}

/** Default assertion lifetime (ms). Short by design — the proxy hop is sub-second. */
export const DEFAULT_POOL_LINK_TTL_MS = 30_000;

/**
 * Hard ceiling (ms) on the TTL SPAN (`exp - iat`) a holder will honor, regardless
 * of what the issuer minted. A misbehaving (but registered) peer could otherwise
 * mint a far-future `exp` and pin its jti in the holder's single-use store for
 * that whole span — an unbounded-retention DoS. The holder rejects any span over
 * this ceiling as `ttl-too-long` BEFORE the jti is ever recorded. 5 min is far
 * above the sub-second proxy hop + the default 30s mint, so it never rejects a
 * legitimate assertion. (P19 — bounded by construction.)
 */
export const DEFAULT_POOL_LINK_MAX_TTL_MS = 5 * 60_000;

export interface MintPoolLinkAssertionDeps {
  /** This (fronting) machine's fingerprint — becomes `iss`. */
  selfFingerprint: MachineFingerprint;
  /** Sign the canonical bytes with THIS machine's Ed25519 signing key. */
  sign: (canonical: string) => string;
  /** Mint a fresh, unguessable jti (crypto-random in prod; deterministic in tests). */
  mintJti: () => string;
  now: () => number;
  /** Assertion lifetime (ms). Default DEFAULT_POOL_LINK_TTL_MS. */
  ttlMs?: number;
}

/**
 * Build + sign a pool-link assertion naming THIS fronting machine as issuer and
 * binding it to the (holder, view, method) audience. The method is upper-cased
 * so the audience-binding is case-insensitive on the verb (HTTP methods are
 * case-insensitive by spec, but we canonicalize to avoid an accidental mismatch).
 */
export function mintPoolLinkAssertion(
  audience: { holderFingerprint: MachineFingerprint; viewId: string; method: string },
  userAuth: PoolLinkAssertion['userAuth'],
  deps: MintPoolLinkAssertionDeps,
): PoolLinkAssertion {
  const iat = deps.now();
  const exp = iat + (deps.ttlMs ?? DEFAULT_POOL_LINK_TTL_MS);
  const aud: PoolLinkAudience = {
    holderFingerprint: audience.holderFingerprint,
    viewId: audience.viewId,
    method: audience.method.toUpperCase(),
  };
  const unsigned: Omit<PoolLinkAssertion, 'signature'> = {
    iss: deps.selfFingerprint,
    aud,
    jti: deps.mintJti(),
    iat,
    exp,
    userAuth,
  };
  return { ...unsigned, signature: deps.sign(canonicalizePoolLinkAssertion(unsigned)) };
}

export type PoolLinkVerifyReason =
  | 'ok'
  | 'malformed'
  | 'wrong-holder'
  | 'wrong-view'
  | 'wrong-method'
  | 'unexpected-issuer'
  | 'unknown-issuer'
  | 'signature-invalid'
  | 'expired'
  | 'not-yet-valid'
  | 'ttl-too-long'
  | 'replayed';

export interface VerifyPoolLinkAssertionDeps {
  /** THIS (holder) machine's fingerprint — `aud.holderFingerprint` MUST equal it. */
  selfFingerprint: MachineFingerprint;
  /**
   * The fronting machine the holder EXPECTS this assertion to come from. The
   * fronting machine identity is proven independently by the mesh transport
   * (the machine-authed request carries the sender id); the holder passes that
   * authenticated id here so `iss` must match it — a captured assertion cannot
   * be replayed by a DIFFERENT machine. Pass null to skip (not recommended).
   */
  expectedIssuer: MachineFingerprint | null;
  /** Resolve `iss`'s REGISTERED Ed25519 public key (PEM), or null if unknown. */
  resolveIssuerPublicKeyPem: (iss: MachineFingerprint) => string | null;
  /** Verify the Ed25519 signature over `canonical` against `publicKeyPem`. */
  verify: (canonical: string, signature: string, publicKeyPem: string) => boolean;
  /**
   * Has this jti been seen (replay guard)? Single-use store, persisted on the
   * holder. Returns true if already recorded.
   */
  seenJti: (jti: string) => boolean;
  now: () => number;
  /** Tolerance for a slightly-future iat (clock skew), ms. Default 5000. */
  clockSkewToleranceMs?: number;
  /**
   * Hard ceiling on the accepted TTL span (`exp - iat`), ms. An assertion whose
   * span exceeds this is rejected as `ttl-too-long` before the jti is recorded —
   * so a misbehaving peer cannot pin a far-future jti in the holder's store.
   * Default DEFAULT_POOL_LINK_MAX_TTL_MS (5 min).
   */
  maxTtlMs?: number;
}

/**
 * Verify an assertion at the HOLDER, evaluated IN ORDER (spec §WS4.4 e). PURE:
 * it does NOT record the jti — the caller records it ONLY on a fully-accepted
 * assertion (so a rejected one never burns a jti, and a replay is caught by the
 * EXPECTED `requested` audience matching the stored jti). The `requested`
 * argument is the audience derived from the ACTUAL incoming request (this
 * machine's own fingerprint, the view id in the URL, the request method) — the
 * assertion's `aud` must match it exactly, which is what makes the binding real:
 * a captured assertion presented for a different view/method is rejected.
 */
export function verifyPoolLinkAssertion(
  assertion: PoolLinkAssertion,
  requested: { viewId: string; method: string },
  deps: VerifyPoolLinkAssertionDeps,
): { ok: boolean; reason: PoolLinkVerifyReason } {
  // (0) shape
  if (
    !assertion ||
    typeof assertion.iss !== 'string' ||
    !assertion.aud ||
    typeof assertion.aud.holderFingerprint !== 'string' ||
    typeof assertion.aud.viewId !== 'string' ||
    typeof assertion.aud.method !== 'string' ||
    typeof assertion.jti !== 'string' ||
    typeof assertion.iat !== 'number' ||
    typeof assertion.exp !== 'number' ||
    typeof assertion.signature !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // (1) audience-bound: holder fingerprint must be THIS machine.
  if (assertion.aud.holderFingerprint !== deps.selfFingerprint) {
    return { ok: false, reason: 'wrong-holder' };
  }
  // (2) audience-bound: the assertion's view must match the REQUESTED view,
  //     and both must match the incoming URL — no wildcard, no cross-resource.
  if (assertion.aud.viewId !== requested.viewId) {
    return { ok: false, reason: 'wrong-view' };
  }
  // (3) audience-bound: method match (case-insensitive via canonicalization).
  if (assertion.aud.method !== requested.method.toUpperCase()) {
    return { ok: false, reason: 'wrong-method' };
  }
  // (4) the authenticated transport sender must equal the claimed issuer — a
  //     captured assertion cannot be presented by a different machine.
  if (deps.expectedIssuer !== null && assertion.iss !== deps.expectedIssuer) {
    return { ok: false, reason: 'unexpected-issuer' };
  }
  // (5) signature valid for the claimed issuer's REGISTERED key.
  const pem = deps.resolveIssuerPublicKeyPem(assertion.iss);
  if (!pem) return { ok: false, reason: 'unknown-issuer' };
  const canonical = canonicalizePoolLinkAssertion({
    iss: assertion.iss,
    aud: assertion.aud,
    jti: assertion.jti,
    iat: assertion.iat,
    exp: assertion.exp,
    userAuth: assertion.userAuth,
  });
  if (!deps.verify(canonical, assertion.signature, pem)) {
    return { ok: false, reason: 'signature-invalid' };
  }
  // (6) freshness: TTL-span ceiling + expiry + not-yet-valid (small skew tolerance).
  const now = deps.now();
  const skew = deps.clockSkewToleranceMs ?? 5000;
  // (6a) span ceiling FIRST — reject an absurd exp regardless of the current
  //      clock, so a far-future-exp assertion can never reach the jti store and
  //      pin a record there (unbounded-retention DoS). P19 — bounded span.
  const maxTtl = deps.maxTtlMs ?? DEFAULT_POOL_LINK_MAX_TTL_MS;
  if (assertion.exp - assertion.iat > maxTtl) return { ok: false, reason: 'ttl-too-long' };
  if (now >= assertion.exp) return { ok: false, reason: 'expired' };
  if (assertion.iat - now > skew) return { ok: false, reason: 'not-yet-valid' };
  // (7) single-use: jti unseen within the window.
  if (deps.seenJti(assertion.jti)) return { ok: false, reason: 'replayed' };

  return { ok: true, reason: 'ok' };
}

/** HTTP status for each verify reason — auth failures 401/403, freshness/replay 409. */
export function statusForPoolLinkReason(reason: PoolLinkVerifyReason): number {
  switch (reason) {
    case 'malformed':
      return 400;
    case 'wrong-holder':
    case 'wrong-view':
    case 'wrong-method':
    case 'unexpected-issuer':
    case 'unknown-issuer':
    case 'signature-invalid':
      return 401;
    case 'expired':
    case 'not-yet-valid':
    case 'ttl-too-long':
    case 'replayed':
      return 409;
    default:
      return 400;
  }
}
