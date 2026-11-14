/**
 * poolPeerFetch — the ONE place a pool-scope read dials a peer, so that every
 * rope outcome reaches the shared health authority.
 *
 * Why this exists. Selection (`resolveMeshPeerPreferredSelection`) picks the
 * highest-priority ADMISSIBLE rope, and admissible is not the same as alive.
 * The selection fix shipped on 2026-10-22 without this half, and the result was
 * the original defect in a new costume: pool reads settled on a LAN rope
 * measured dead from the reader (`HTTP 000`) while the same peer answered on
 * its tunnel (`HTTP 200`), and nothing ever told rope health the LAN dial had
 * failed — so the next read chose it again, forever. A selection layer with no
 * feedback cannot converge; it can only be lucky.
 *
 * Recording here closes that loop against the SAME `PeerEndpointResolver`
 * instance the lease transport and the recovery prober already feed, so one
 * failed pool dial demotes the rope and the following read picks the healthy
 * one. No new state, no second source of truth.
 *
 * Rope health is a fact about the ROPE, never about the endpoint's verdict: any
 * Response that came back proves the rope carried traffic, so an HTTP 500
 * records `ok: true` — the path works and the application disagreed. Only a
 * thrown error (DNS failure, connection refused, timeout/abort) is a rope
 * failure. Conflating the two would demote a healthy rope every time a peer
 * returned 503 for a dark feature, which is most of them.
 *
 * A `last-known-url` carries no rope identity — it is not one of the three
 * transports health is keyed on — so its outcome is deliberately not recorded
 * rather than being attributed to a rope it may not belong to.
 */

/** The three transports rope health is keyed on. Narrower than PeerEndpointKind
 *  on purpose: `last-known-url` is not a rope. */
import { isPeerUrlAllowedForCredentials, type PeerEndpointSelection } from './peerUrlGuard.js';

export type RopeKind = 'tailscale' | 'lan' | 'cloudflare';

export interface RopeResultRecorder {
  (machineId: string, kind: RopeKind, ok: boolean, latencyMs: number, url?: string): void;
}

/** The shape `resolvePeerUrls()` already hands every fan-out site. `ropes`,
 *  when present, is every rope for the peer in priority order. */
export interface PoolPeerTarget {
  machineId: string;
  url: string;
  kind?: string | null;
  ropes?: ReadonlyArray<{ url: string; kind: string }>;
}

function ropeKindOf(kind: string | null | undefined): RopeKind | null {
  return kind === 'tailscale' || kind === 'lan' || kind === 'cloudflare' ? kind : null;
}

/**
 * A Cloudflare edge error: the tunnel answered on the peer's behalf because it
 * could not reach the peer (520-530, e.g. 530 "origin unreachable"). Instar
 * never sends these codes itself, so the reply proves the ROPE is down, not that
 * the peer disagreed. Recorded as a rope failure; the 2026-11-02 Studio saw a
 * peer's tunnel return 530 on every pooled read while its Tailscale rope worked,
 * and the rope was recorded healthy each time, so it was chosen again forever.
 */
export function isCloudflareEdgeFailure(kind: string | null | undefined, status: number): boolean {
  return kind === 'cloudflare' && status >= 520 && status <= 530;
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Caller rejected a dial BEFORE network activity. Not a rope failure or a retry signal. */
export class PoolPeerAdmissionError extends Error {
  override readonly name = 'PoolPeerAdmissionError';
}

/**
 * Drop-in for `fetch(`${peer.url}${path}`, init)` that reports the rope outcome.
 *
 * Deliberately transparent: it returns the raw `Response` and rethrows the
 * original error, so a call site keeps its own status handling and its own
 * `catch`. Nothing about admission is decided for the FIRST rope — the caller
 * still runs `isPeerUrlAllowedForCredentials` before dialling.
 *
 * Fallthrough (read-only requests only). When the request is a GET and the
 * rope proved dead — the dial threw (refused, no route, DNS) or a Cloudflare
 * edge error came back — the next rope in `peer.ropes` is tried, provided it
 * passes the same credential guard (never relaxed: no caller allowlist is
 * applied, so a fallback rope is held to the strict default). An abort or
 * timeout is not retried: the caller's signal is shared, so its budget is
 * spent. Any real reply from the peer, whatever its status, is returned as-is.
 * Non-GET requests never fall through: they may act on the peer.
 */
export async function poolPeerFetch(
  record: RopeResultRecorder | undefined,
  peer: PoolPeerTarget,
  path: string,
  init?: Parameters<typeof fetch>[1],
  fetchImpl: typeof fetch = fetch,
  admit: (rope: { url: string; kind: string }) => boolean = defaultAdmit,
): Promise<Response> {
  const method = String(init?.method ?? 'GET').toUpperCase();
  const fallbacks = method === 'GET' && Array.isArray(peer.ropes)
    ? peer.ropes.filter((r) => r && r.url !== peer.url && typeof r.url === 'string')
    : [];
  const attempts: Array<{ url: string; kind?: string | null }> = [{ url: peer.url, kind: peer.kind }, ...fallbacks];
  let lastError: unknown = null;
  let lastEdge: Response | null = null;
  for (let i = 0; i < attempts.length; i++) {
    const rope = attempts[i];
    if (i > 0 && !admit({ url: rope.url, kind: String(rope.kind ?? '') })) continue;
    const kind = ropeKindOf(rope.kind);
    const started = Date.now();
    try {
      const res = await fetchImpl(`${rope.url}${path}`, init);
      const edge = isCloudflareEdgeFailure(rope.kind, res.status);
      if (kind && record) record(peer.machineId, kind, !edge, Date.now() - started, rope.url);
      if (!edge) { void lastEdge?.body?.cancel().catch(() => {}); return res; }
      void lastEdge?.body?.cancel().catch(() => {});
      lastEdge = res;
    } catch (err) {
      if (err instanceof PoolPeerAdmissionError) {
        void lastEdge?.body?.cancel().catch(() => {});
        throw err;
      }
      if (kind && record) record(peer.machineId, kind, false, Date.now() - started, rope.url);
      if (isAbort(err)) { void lastEdge?.body?.cancel().catch(() => {}); throw err; }
      if (i === attempts.length - 1) { if (lastEdge) return lastEdge; throw err; }
      lastError = err;
    }
  }
  if (lastEdge) return lastEdge;
  throw lastError;
}

// E2E-PAIRING: EXEMPT — no route added or changed; this is the dial helper under the existing pool routes, covered by unit tests.
function defaultAdmit(rope: { url: string; kind: string }): boolean {
  return isPeerUrlAllowedForCredentials({ url: rope.url, kind: rope.kind as PeerEndpointSelection['kind'] }).ok;
}
