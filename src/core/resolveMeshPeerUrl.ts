import type { MeshEndpoint } from './types.js';
import type { PeerEndpointResolver } from './PeerEndpointResolver.js';

/**
 * Resolve a peer URL without making optional mesh initialization a server-start
 * prerequisite. The resolver is assigned inside the best-effort lease/mesh
 * bootstrap; if that bootstrap degrades before assignment, legacy registry URLs
 * must continue to keep the rest of the server alive.
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
