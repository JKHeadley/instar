/**
 * PasskeyBrowserPolicy — the deterministic rules that bound WHERE the agent's
 * Google passkey may be present inside a browser (spec
 * docs/specs/agent-held-google-passkey.md §1.1, §3.1, §3.5).
 *
 * The credential's relying-party id is `google.com`, so ANY `*.google.com`
 * origin could technically request an assertion from the virtual authenticator.
 * The spec therefore holds the credential only while the top-level origin is
 * exactly `accounts.google.com`, and removes it at REQUEST time — before a
 * document request leaves — for:
 *   - any top-level navigation away from accounts.google.com, and
 *   - any frame (iframe, fenced frame, popup) navigating to a google.com origin
 *     other than accounts.google.com.
 * Frames on unrelated sites (a CAPTCHA provider, telemetry) cannot claim a
 * google.com passkey and are allowed, so the real sign-in flow is not blocked.
 *
 * The rules are parameterised by an `OriginPolicy` so the SAME code is exercised
 * against the local WebAuthn fixture (relying party `localhost`) in tests and the
 * Chrome-version self-check. Production always uses `GOOGLE_ORIGIN_POLICY`.
 *
 * Pure functions, no I/O, fully unit-tested; the browser calls them from its
 * Fetch interception handler.
 */

export interface OriginPolicy {
  /** The ONLY origin on which the credential may be present (exact match). */
  holderOrigin: string;
  /** The relying-party apex host; every host equal to it or under it can claim the key. */
  apexHost: string;
  /** Fixture-only: accept http:// for the apex family (WebAuthn treats localhost as secure). */
  allowInsecure?: boolean;
  /**
   * The account-settings origin whose passkey pages the closed page classes
   * recognise (spec §3.6): myaccount.google.com in production, the fixture's
   * OTHER origin in tests. It is in the relying-party family, so the stored
   * credential is REMOVED before any document there loads — classification
   * there never coexists with the key. Absent ⇒ no account-origin class matches.
   */
  accountOrigin?: string;
}

export const ACCOUNTS_GOOGLE_ORIGIN = 'https://accounts.google.com';
export const MYACCOUNT_GOOGLE_ORIGIN = 'https://myaccount.google.com';

export const GOOGLE_ORIGIN_POLICY: OriginPolicy = Object.freeze({
  holderOrigin: ACCOUNTS_GOOGLE_ORIGIN,
  apexHost: 'google.com',
  accountOrigin: MYACCOUNT_GOOGLE_ORIGIN,
});

/** Origin of a URL, or null when it cannot be parsed. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    // @silent-fallback-ok — a pure parse: null means "not a URL", and every caller
    // treats null as the STRICT case (mustRemoveCredentialBefore removes on it).
    return null;
  }
}

/** The apex host itself or any subdomain of it, over https (or http when the policy allows). */
export function isRpFamilyOrigin(origin: string, policy: OriginPolicy = GOOGLE_ORIGIN_POLICY): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && !(policy.allowInsecure && u.protocol === 'http:')) return false;
    const host = u.hostname.toLowerCase();
    const apex = policy.apexHost.toLowerCase();
    return host === apex || host.endsWith(`.${apex}`);
  } catch {
    // @silent-fallback-ok — a pure parse: an unparseable origin is not in the
    // relying-party family; callers never grant anything on this branch.
    return false;
  }
}

/** Back-compat name for the production policy. */
export function isGoogleOrigin(origin: string): boolean {
  return isRpFamilyOrigin(origin, GOOGLE_ORIGIN_POLICY);
}

export interface DocumentRequest {
  url: string;
  /** True for the top-level frame's document, false for a subframe/fenced frame. */
  topLevel: boolean;
}

/**
 * Whether the credential must be removed from the virtual authenticator BEFORE this
 * document request is allowed to proceed.
 */
export function mustRemoveCredentialBefore(req: DocumentRequest, policy: OriginPolicy = GOOGLE_ORIGIN_POLICY): boolean {
  const origin = originOf(req.url);
  if (origin === null) return true; // unparseable ⇒ fail closed
  if (origin === policy.holderOrigin) return false;
  if (req.topLevel) return true;
  return isRpFamilyOrigin(origin, policy);
}

/**
 * Whether the credential may be ADDED right now, given the origins of every frame
 * currently in the target. Requires the top-level frame on the holder origin and
 * no other frame on a different relying-party-family origin.
 */
export function mayAddCredential(
  frames: { origin: string; topLevel: boolean }[],
  policy: OriginPolicy = GOOGLE_ORIGIN_POLICY,
): boolean {
  const top = frames.find((f) => f.topLevel);
  if (!top || top.origin !== policy.holderOrigin) return false;
  return frames.every((f) => f.topLevel || f.origin === policy.holderOrigin || !isRpFamilyOrigin(f.origin, policy));
}

/** Chrome launch flags every passkey-capable session carries (spec §3.5). */
export const PASSKEY_SESSION_CHROME_ARGS = [
  '--remote-debugging-pipe',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-features=Prerender2,SpeculationRulesPrefetchFuture',
] as const;
