import type { MeshEndpoint } from './types.js';
import type { PeerEndpointResolver } from './PeerEndpointResolver.js';
import {
  isPeerUrlAllowedForCredentials,
  type PeerEndpointKind,
  type PeerEndpointSelection,
  type PeerUrlVerdict,
} from '../server/peerUrlGuard.js';

/**
 * Resolve a peer URL without making optional mesh initialization a server-start
 * prerequisite. The resolver is assigned inside the best-effort lease/mesh
 * bootstrap; if that bootstrap degrades before assignment, legacy registry URLs
 * must continue to keep the rest of the server alive.
 *
 * NOTE: this returns the resolver's single best candidate WITHOUT consulting the
 * credential guard, which is why a pool fan-out using it dead-ended whenever that
 * candidate was inadmissible. It is retained unchanged for callers that layer
 * their own transport (the identity mesh-send path); credential-bearing pool
 * reads should use `resolveMeshPeerSelection` instead.
 */
export function resolveMeshPeerUrl(
  resolver: PeerEndpointResolver | undefined,
  machineId: string,
  endpoints: MeshEndpoint[] | undefined,
  lastKnownUrl: string | undefined,
): string | null {
  if (!resolver) return lastKnownUrl ?? null;
  return resolver.resolve(machineId, endpoints, lastKnownUrl)[0]?.url ?? null;
}

export interface RopeRefusal {
  url: string;
  kind: PeerEndpointKind;
  reason: PeerUrlVerdict['reason'];
}

export type PeerSelectionResult =
  | { ok: true; selection: PeerEndpointSelection; refusals: RopeRefusal[] }
  | {
      ok: false;
      outcome: 'url-rejected' | 'no-known-url';
      refusals: RopeRefusal[];
    };

/**
 * The best candidate rope THAT THE CREDENTIAL GUARD ADMITS.
 *
 * The defect this exists to fix: `resolveMeshPeerUrl` takes `resolve(...)[0]`,
 * so a pool fan-out received the resolver's highest-ranked rope, discovered the
 * guard refused it, and gave up — with the peer's remaining ropes never tried,
 * even when they were already admissible. Filtering by admission BEFORE
 * selecting removes that dead-end without contacting any additional host within
 * a call: exactly one rope is selected and exactly one request is made, as today.
 *
 * `refusals` is present on BOTH branches, so a SUCCESSFUL selection still
 * reports which ropes were skipped and why — the observability that made the
 * original defect invisible.
 */
export function resolveMeshPeerSelection(
  resolver: PeerEndpointResolver | undefined,
  machineId: string,
  endpoints: MeshEndpoint[] | undefined,
  lastKnownUrl: string | undefined,
  extraHostSuffixes?: readonly string[],
): PeerSelectionResult {
  const candidates: PeerEndpointSelection[] = [];
  if (resolver) {
    for (const ep of resolver.resolve(machineId, endpoints, lastKnownUrl)) {
      // A resolved endpoint carries its advertised kind; the legacy
      // `lastKnownUrl` fallback the resolver may append has none, so it is
      // represented explicitly rather than left absent.
      const kind = (ep as { kind?: PeerEndpointKind }).kind ?? 'last-known-url';
      candidates.push({ url: ep.url, kind });
    }
  } else if (lastKnownUrl) {
    candidates.push({ url: lastKnownUrl, kind: 'last-known-url' });
  }

  if (candidates.length === 0) return { ok: false, outcome: 'no-known-url', refusals: [] };

  const refusals: RopeRefusal[] = [];
  for (const candidate of candidates) {
    const verdict = isPeerUrlAllowedForCredentials(candidate, extraHostSuffixes);
    if (verdict.ok) return { ok: true, selection: candidate, refusals };
    refusals.push({ url: candidate.url, kind: candidate.kind, reason: verdict.reason });
  }
  // Every rope existed and every one was refused — distinct from having none.
  return { ok: false, outcome: 'url-rejected', refusals };
}

/**
 * The rope a credential-bearing fan-out should USE, with its kind.
 *
 * Prefers the best candidate the guard ADMITS (the fix: an inadmissible
 * highest-ranked rope no longer dead-ends the peer). When NO candidate is
 * admissible it returns the first candidate anyway, so the caller's own guard
 * check still refuses it and still emits its `url-rejected` row — the refusal
 * stays VISIBLE rather than becoming a silent omission. `null` only when the
 * peer advertised nothing at all (`no-known-url`).
 */
export function resolveMeshPeerPreferredSelection(
  resolver: PeerEndpointResolver | undefined,
  machineId: string,
  endpoints: MeshEndpoint[] | undefined,
  lastKnownUrl: string | undefined,
  extraHostSuffixes?: readonly string[],
): { selection: PeerEndpointSelection; refusals: RopeRefusal[] } | null {
  const result = resolveMeshPeerSelection(resolver, machineId, endpoints, lastKnownUrl, extraHostSuffixes);
  // Refusals are carried on BOTH outcomes: a caller that only received the
  // selection could not report WHICH ropes were skipped, which is the
  // observability whose absence made the original defect invisible. The
  // second-pass reviewer caught this wrapper dropping them on success.
  if (result.ok) return { selection: result.selection, refusals: result.refusals };
  if (result.outcome === 'no-known-url') return null;
  const first = result.refusals[0];
  return first
    ? { selection: { url: first.url, kind: first.kind }, refusals: result.refusals }
    : null;
}
