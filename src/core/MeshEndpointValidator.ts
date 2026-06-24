/**
 * MeshEndpointValidator — shared ingest validation for advertised mesh endpoints
 * (mesh-endpoint-http-propagation, defense-in-depth, NOT authority).
 *
 * When a machine receives a peer's advertised endpoint set inside the signed lease
 * RPC body, this validates the set BEFORE it is recorded into the local registry,
 * so the registry can never be poisoned by a malformed/hostile-but-authenticated
 * advertisement. Ingest validation gates REGISTRY INTEGRITY (no garbage stored); it
 * is NOT the trust authority — `PeerEndpointResolver` re-validates the SAME per-kind
 * host rules at dial time (the final line), and its health map decides whether an
 * endpoint is actually reachable/trusted. Both validate via the SAME pure helpers
 * (the per-kind host functions exported from `PeerEndpointResolver`) so ingest and
 * resolve can never diverge: ingest is the first line (no poisoning), resolve is the
 * final line (no bypass). Signal vs. Authority (docs/signal-vs-authority.md).
 *
 * Spec: docs/specs/mesh-endpoint-http-propagation.md (Receiver §).
 */

import type { MeshEndpoint } from './types.js';
import {
  MAX_ENDPOINTS,
  hostOf,
  isForbiddenHost,
  isTailscaleCgnat,
  isRfc1918,
  isPublicHttps,
} from './PeerEndpointResolver.js';

/** A whole batch larger than this is treated as malformed and rejected outright. */
export const MAX_ENDPOINTS_BATCH = MAX_ENDPOINTS * 2;
/** Drop any single endpoint whose url exceeds this length (defends the registry + parser). */
export const MAX_ENDPOINT_URL_LEN = 2048;

const KINDS: ReadonlySet<MeshEndpoint['kind']> = new Set(['tailscale', 'lan', 'cloudflare']);

/**
 * Pure per-element shape + per-kind host validation — the NON-config-gated subset
 * shared with `PeerEndpointResolver.resolve()` (the resolver additionally applies its
 * own `tailscaleEnabled` + LAN-subnet gates, which are dial-time policy, not ingest
 * integrity). Rejects: wrong shape, unknown kind, missing/oversized url, unparseable
 * or forbidden host (loopback/link-local/metadata), a tailscale rope not in
 * 100.64/10, a lan rope not in RFC-1918, a cloudflare rope that is not public https.
 */
export function isValidMeshEndpointShape(e: unknown): e is MeshEndpoint {
  if (!e || typeof e !== 'object') return false;
  const { kind, url } = e as { kind?: unknown; url?: unknown };
  if (typeof kind !== 'string' || !KINDS.has(kind as MeshEndpoint['kind'])) return false;
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_ENDPOINT_URL_LEN) return false;
  if (kind === 'cloudflare') return isPublicHttps(url);
  const host = hostOf(url);
  if (!host || isForbiddenHost(host)) return false;
  if (kind === 'tailscale') return isTailscaleCgnat(host);
  if (kind === 'lan') return isRfc1918(host);
  return false;
}

/**
 * Validate an UNTRUSTED advertised endpoint set into a clean, capped `MeshEndpoint[]`.
 *
 * Order (spec Receiver §3): (a) require an array; reject the whole batch as malformed
 * if `length > MAX_ENDPOINTS_BATCH`, else clamp the working slice to `MAX_ENDPOINTS+1`
 * BEFORE the per-element loop (bounds the O(N) walk); (b) drop each element that fails
 * shape/url-length/per-kind-host validation (malformed ELEMENTS are dropped, not the
 * whole batch); (c) cap the kept set to `MAX_ENDPOINTS`. Fail-closed: a non-array or a
 * fully-invalid set returns `[]` (the caller treats `[]` as absence → a no-op, NEVER a
 * wipe of the peer's prior ropes).
 */
export function validateMeshEndpoints(input: unknown): MeshEndpoint[] {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_ENDPOINTS_BATCH) return [];
  const slice = input.length > MAX_ENDPOINTS + 1 ? input.slice(0, MAX_ENDPOINTS + 1) : input;
  const kept: MeshEndpoint[] = [];
  for (const e of slice) {
    if (isValidMeshEndpointShape(e)) kept.push({ kind: e.kind, url: e.url });
    if (kept.length >= MAX_ENDPOINTS) break;
  }
  return kept;
}

/**
 * Canonicalize an endpoint url for idempotent comparison: lower-case host, strip a
 * trailing slash, drop a redundant default port. Prevents a cosmetically-different but
 * semantically-equal advertisement (`…:4042` vs `…:4042/`, `HOST` vs `host`) from
 * defeating the unchanged-set check and churning the registry. Unparseable input is
 * returned trimmed-lowercased (best-effort; it would have failed validation anyway).
 */
export function normalizeEndpointUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (out.endsWith('/') && !url.endsWith('/')) out = out.slice(0, -1);
    return out.replace(/\/$/, '');
  } catch {
    // @silent-fallback-ok: a url that does not parse here also fails validation, so it
    // never reaches a real record; this only keeps the comparator total.
    return url.trim().toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Order-independent value equality of two endpoint sets, normalizing each url first —
 * the idempotency comparator for the receiver (skip the registry write when unchanged).
 */
export function meshEndpointsEqual(
  a: MeshEndpoint[] | undefined,
  b: MeshEndpoint[] | undefined,
): boolean {
  const norm = (x: MeshEndpoint[] | undefined) =>
    (x ?? [])
      .map((e) => `${e.kind} ${normalizeEndpointUrl(e.url)}`)
      .sort()
      .join('|');
  return norm(a) === norm(b);
}
