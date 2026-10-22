/**
 * peerUrlGuard — shared https/allowlist check a pool fan-out must pass
 * BEFORE attaching this machine's Bearer token to a peer request
 * (GUARD-POSTURE-ENDPOINT-SPEC §3(c)).
 *
 * `lastKnownUrl` is self-advertised and git-synced, so the fan-out's trust
 * assumption is "the registry remote is operator-private." This helper makes
 * the hardening a shipping dependency for /guards (and adoptable by the
 * existing pool routes): the token is only ever sent to
 *   - https URLs whose host matches a known tunnel pattern (or an
 *     operator-extended allowlist), or
 *   - private-network/localhost hosts (http allowed for LAN peers).
 * A URL failing the check is refused VISIBLY — never silently skipped, never
 * sent the token.
 *
 * ── Shared predicate vocabulary (peer-credential-guard-tailscale-coherence) ──
 * The RFC-1918 / CGNAT range arithmetic lives in `PeerEndpointResolver` and is
 * IMPORTED here, never re-implemented. This file previously carried a third,
 * hand-written copy that had silently drifted: it never learned Tailscale CGNAT
 * `100.64.0.0/10`, so a tailnet rope was refused with the misleading
 * `scheme-not-allowed`, which read as "we don't do plaintext" when the true
 * statement is "we do plaintext inside ranges we treat as the operator's own,
 * and CGNAT is deliberately not one of them."
 * `mesh-endpoint-http-propagation.md`: "Both validate via the SAME function so
 * the two can never diverge."
 *
 * Deliberately NOT shared: `isForbiddenHost`. The resolver FORBIDS loopback
 * (`localhost`, `127/8`, `::1`) because a PEER advertising loopback is nonsense
 * or an attack. This guard ALLOWS it, because here loopback is *us* — a
 * same-machine call, not a peer rope. Importing `isForbiddenHost` wholesale
 * would regress that, and the resolver has no IPv6 ULA/link-local predicates at
 * all, so it would regress those too. The two layers answer different
 * questions; they share the VOCABULARY, not a single verdict.
 *
 * Redirect note: the credential-bearing read path sets `redirect: 'manual'` and
 * treats a 3xx as terminal, so a redirect can never produce a second
 * token-bearing request (same-origin included). Do not "fix" this by following
 * redirects with the header preserved.
 */

import { ipv4ToInt, isRfc1918, isTailscaleCgnat } from '../core/PeerEndpointResolver.js';

const DEFAULT_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)trycloudflare\.com$/i, // Cloudflare quick tunnels
  /(^|\.)dawn-tunnel\.dev$/i, // operator named-tunnel domain in this fleet
  /\.local$/i, // mDNS LAN names
];

/**
 * The transport kind a candidate rope was advertised as. REQUIRED on
 * `PeerEndpointSelection` so a caller cannot forget it: an absent kind used to
 * be expressible and produced the wrong refusal silently. `last-known-url` is
 * the explicit kind for a legacy `lastKnownUrl` with no matching endpoint
 * record, so "kind unknown" is a representable VALUE rather than a missing
 * argument.
 */
export type PeerEndpointKind = 'tailscale' | 'lan' | 'cloudflare' | 'last-known-url';

export interface PeerEndpointSelection {
  url: string;
  kind: PeerEndpointKind;
}

/** Strip the brackets URL.hostname keeps on an IPv6 literal. */
function bareHost(host: string): string {
  const h = host.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/**
 * Loopback — allowed HERE and forbidden in the resolver, deliberately (see the
 * header). This is `us`, not a peer.
 */
function isLoopbackSelf(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (bareHost(h) === '::1') return true;
  const ip = ipv4ToInt(h);
  if (ip === null) return false;
  const base = ipv4ToInt('127.0.0.0')!;
  const mask = (0xffffffff << (32 - 8)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

/**
 * IPv6 unique-local (fc00::/7) and link-local (fe80::/10). The resolver has NO
 * IPv6 predicates, so these stay local to this guard rather than being dropped
 * (security review 2026-06-12 finding T-05 — previously these over-blocked and
 * an IPv6 LAN peer dead-ended as url-rejected).
 */
function isIpv6PrivateHost(host: string): boolean {
  const v6 = bareHost(host);
  // fc00::/7 unique-local — the first hextet must be fc00..fdff, so it needs
  // EXACTLY four hex digits. The previous `{0,2}` quantifier also matched
  // `fc::1` (first hextet 0x00fc) and `fd0::1` (0x0fd0), which are OUTSIDE the
  // range — a pre-existing OVER-ADMISSION in a credential guard, found by the
  // second-pass reviewer on this change and fixed here rather than inherited.
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;
  // fe80::/10 link-local — fe80..febf, already exactly four digits.
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;
  return false;
}

/** A host inside the operator's own network, for the purposes of THIS guard. */
function isPrivateOrLocalHost(host: string): boolean {
  return isLoopbackSelf(host) || isIpv6PrivateHost(host) || isRfc1918(host);
}

export interface PeerUrlVerdict {
  ok: boolean;
  /** Normalized refusal reason (never a raw error string). */
  reason?:
    | 'invalid-url'
    | 'scheme-not-allowed'
    | 'host-not-allowlisted'
    /**
     * A Tailscale CGNAT (`100.64.0.0/10`) host over plaintext http. Refused
     * DELIBERATELY and named accurately: admitting it would release the full
     * agent API token to a destination nothing authenticates as the peer, on a
     * premise the spec documents as forgeable. Admission is sequenced behind
     * destination authentication, and is NOT built here.
     */
    | 'cgnat-plaintext-unsupported';
}

/**
 * May this peer URL receive our Bearer token?
 * `extraHostSuffixes` comes from config (`multiMachine.peerUrlAllowlist`,
 * plain suffix strings) so an operator on a custom tunnel domain has a lever
 * instead of a dead end.
 *
 * NOTE: there is NO kind for which a CGNAT host is admitted over http. The
 * `kind` is used to name refusals accurately and to let callers reason about
 * what was skipped — never to widen trust.
 */
export function isPeerUrlAllowedForCredentials(
  selection: PeerEndpointSelection,
  extraHostSuffixes?: readonly string[],
): PeerUrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(selection.url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  const host = parsed.hostname;

  if (parsed.protocol === 'http:') {
    // Plaintext is acceptable ONLY inside the operator's own network.
    if (isPrivateOrLocalHost(host)) return { ok: true };
    // Name the CGNAT case precisely instead of the misleading
    // `scheme-not-allowed`. Kind-independent: no kind admits it.
    if (isTailscaleCgnat(host)) return { ok: false, reason: 'cgnat-plaintext-unsupported' };
    return { ok: false, reason: 'scheme-not-allowed' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme-not-allowed' };
  }

  if (isPrivateOrLocalHost(host)) return { ok: true };
  if (DEFAULT_HOST_PATTERNS.some((p) => p.test(host))) return { ok: true };
  for (const suffix of extraHostSuffixes ?? []) {
    const s = suffix.trim().toLowerCase().replace(/^\*?\.?/, '');
    if (!s) continue;
    const h = host.toLowerCase();
    if (h === s || h.endsWith(`.${s}`)) return { ok: true };
  }
  return { ok: false, reason: 'host-not-allowlisted' };
}
