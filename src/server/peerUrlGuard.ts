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
 * A URL failing the check is refused VISIBLY (`url-rejected` failure row) —
 * never silently skipped, never sent the token.
 */

const DEFAULT_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)trycloudflare\.com$/i, // Cloudflare quick tunnels
  /(^|\.)dawn-tunnel\.dev$/i, // operator named-tunnel domain in this fleet
  /\.local$/i, // mDNS LAN names
];

function isPrivateOrLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  // RFC-1918 + loopback IPv4 literals.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

export interface PeerUrlVerdict {
  ok: boolean;
  /** Normalized refusal reason (never a raw error string). */
  reason?: 'invalid-url' | 'scheme-not-allowed' | 'host-not-allowlisted';
}

/**
 * May this peer URL receive our Bearer token?
 * `extraHostPatterns` comes from config (`multiMachine.peerUrlAllowlist`,
 * plain suffix strings) so an operator on a custom tunnel domain has a lever
 * instead of a dead end.
 */
export function isPeerUrlAllowedForCredentials(
  rawUrl: string,
  extraHostSuffixes?: readonly string[],
): PeerUrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  const host = parsed.hostname;

  if (parsed.protocol === 'http:') {
    // Plaintext is acceptable ONLY inside the operator's own network.
    return isPrivateOrLocalHost(host) ? { ok: true } : { ok: false, reason: 'scheme-not-allowed' };
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
