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
export type RopeKind = 'tailscale' | 'lan' | 'cloudflare';

export interface RopeResultRecorder {
  (machineId: string, kind: RopeKind, ok: boolean, latencyMs: number, url?: string): void;
}

/** The shape `resolvePeerUrls()` already hands every fan-out site. */
export interface PoolPeerTarget {
  machineId: string;
  url: string;
  kind?: string | null;
}

function ropeKindOf(kind: string | null | undefined): RopeKind | null {
  return kind === 'tailscale' || kind === 'lan' || kind === 'cloudflare' ? kind : null;
}

/**
 * Drop-in for `fetch(`${peer.url}${path}`, init)` that reports the rope outcome.
 *
 * Deliberately transparent: it returns the raw `Response` and rethrows the
 * original error, so a call site keeps its own status handling and its own
 * `catch`. Nothing about admission is decided here — the caller still runs
 * `isPeerUrlAllowedForCredentials` before dialling, because refusing to send a
 * credential is a separate question from whether the wire works.
 */
export async function poolPeerFetch(
  record: RopeResultRecorder | undefined,
  peer: PoolPeerTarget,
  path: string,
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const rope = ropeKindOf(peer.kind);
  const started = Date.now();
  try {
    const res = await fetch(`${peer.url}${path}`, init);
    if (rope && record) record(peer.machineId, rope, true, Date.now() - started, peer.url);
    return res;
  } catch (err) {
    if (rope && record) record(peer.machineId, rope, false, Date.now() - started, peer.url);
    throw err;
  }
}
