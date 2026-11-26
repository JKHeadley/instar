/**
 * Dashboard addresses (docs/specs/dashboard-console-default-and-pair-page.md). Dependency-free so
 * the CLI, the Telegram adapter and the pairing routes can share them with the server routes.
 */

/** Where a bare `/dashboard` goes. */
export const CONSOLE_PATH = '/dashboard/console/';
/** The legacy dashboard's own address. */
export const LEGACY_PATH = '/dashboard/legacy';
/** The pairing code page. */
export const PAIR_PAGE_PATH = '/dashboard/pair';

/** The code page for a phone that redeemed on `host` (fragment only: never sent to a server). */
export function codePageUrlForDevice(host: string, deviceId: string): string {
  return `https://${host}${PAIR_PAGE_PATH}#d=${encodeURIComponent(deviceId)}`;
}

/** The code page on an origin (`https://name.example`). */
export function codePageUrlForOrigin(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${PAIR_PAGE_PATH}`;
}

/** A console page on an origin, by its hash route (`#/work/sessions`). */
export function consolePageUrl(origin: string, hashRoute: string): string {
  return `${origin.replace(/\/+$/, '')}${CONSOLE_PATH}${hashRoute}`;
}

/**
 * Where an operator-facing link (a notice, reminder or attention row) should point.
 *
 * A link sent to the operator must open on their phone. `localhost` never does, so when this
 * agent HAS a tunnel the local address is not an acceptable fallback just because the tunnel
 * is not up yet (right after a restart it usually is not): the caller defers and tries again
 * on its next pass. Only an agent with no tunnel at all gets the local address, because that
 * is the only address it has.
 *
 * - `public`: the tunnel is up; use its origin.
 * - `local`: no tunnel is configured (`no-tunnel`), or the tunnel stayed down past `maxWaitMs`
 *   (`tunnel-wait-exceeded`) so the notice is not withheld forever.
 * - `pending`: a tunnel is configured but has no public URL yet; defer the send.
 */
export type OperatorLinkOrigin =
  | { kind: 'public'; origin: string }
  | { kind: 'local'; origin: string; reason: 'no-tunnel' | 'tunnel-wait-exceeded' }
  | { kind: 'pending' };

/** How long a configured-but-down tunnel may hold a link-bearing notice before the local link is used. */
export const DEFAULT_PUBLIC_LINK_MAX_WAIT_MS = 30 * 60_000;

/** Thrown by a notice sender that must wait for the public link; delivery paths that retry on rejection retry it. */
export class PublicLinkPendingError extends Error {
  constructor() { super('public-link-pending: the tunnel has no public URL yet'); this.name = 'PublicLinkPendingError'; }
}

export interface OperatorLinkOriginDeps {
  port: number;
  /** True when this agent runs a tunnel (whether or not it is up right now). */
  tunnelConfigured: () => boolean;
  /** The tunnel's public origin, or null while it is down / starting. May throw (treated as null). */
  tunnelUrl: () => string | null | undefined;
  maxWaitMs?: number;
  now?: () => number;
}

/**
 * A resolver for operator-link origins. Stateful only in remembering when the tunnel was first
 * seen down, so the wait ceiling is measured from then; it resets once the tunnel is up.
 */
export function createOperatorLinkOriginResolver(d: OperatorLinkOriginDeps): () => OperatorLinkOrigin {
  let pendingSince: number | null = null;
  const local = `http://localhost:${d.port}`;
  return () => {
    let configured = false;
    try { configured = d.tunnelConfigured(); } catch { configured = false; } // @silent-fallback-ok — unreadable config reads as no tunnel
    if (!configured) { pendingSince = null; return { kind: 'local', origin: local, reason: 'no-tunnel' }; }
    let url: string | null = null;
    try { url = d.tunnelUrl() || null; } catch { url = null; } // @silent-fallback-ok — an unreadable tunnel reads as not up yet
    if (url) { pendingSince = null; return { kind: 'public', origin: url.replace(/\/+$/, '') }; }
    const now = (d.now ?? Date.now)();
    if (pendingSince === null) pendingSince = now;
    const maxWait = d.maxWaitMs ?? DEFAULT_PUBLIC_LINK_MAX_WAIT_MS;
    if (now - pendingSince >= maxWait) return { kind: 'local', origin: local, reason: 'tunnel-wait-exceeded' };
    return { kind: 'pending' };
  };
}

/** The origin to put in a link, or null when the send should wait for the public link. */
export function originOrNull(o: OperatorLinkOrigin): string | null {
  return o.kind === 'pending' ? null : o.origin;
}
