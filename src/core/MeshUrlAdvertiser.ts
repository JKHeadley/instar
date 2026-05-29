/**
 * MeshUrlAdvertiser — populate a machine's `lastKnownUrl` so cross-machine
 * routing can actually reach it.
 *
 * THE BUG THIS FIXES (found via real-hardware dogfooding, 2026-05-29):
 * the Multi-Machine Session Pool routes every cross-machine RPC (deliver /
 * transfer / lease) to a peer by reading `registry.machines[id].lastKnownUrl`.
 * But the only writer of that field — `MachineIdentityManager.updateMachineUrl`
 * — had ZERO callers. So in production every peer's URL was null, the peer
 * filters (`!!e.lastKnownUrl`) dropped every peer, and no session could ever be
 * delivered or transferred across machines. The 3-tier tests missed it because
 * they inject peers with mock URLs and never exercise the runtime "where does
 * lastKnownUrl come from" path.
 *
 * A machine's reachable URL is its tunnel URL: a named tunnel's hostname is
 * known from config; a quick tunnel's URL is only known once `tunnel.start()`
 * resolves it. This module turns either into the value to advertise, and writes
 * it into the registry entry — from where the existing git-backed registry sync
 * (RegistrySyncDebouncer) propagates it to peers.
 */

export interface MeshTunnelConfig {
  enabled?: boolean;
  type?: string;
  hostname?: string;
}

/**
 * Resolve the URL this machine should advertise to the mesh.
 *
 * Preference order:
 *  1. A concretely-resolved tunnel URL (quick tunnels only know it at runtime;
 *     `tunnel.start()` returns it). This is authoritative when present.
 *  2. A named tunnel's deterministic `https://<hostname>`.
 *  3. null — no reachable URL (tunnel disabled / not configured). A machine
 *     with no tunnel is genuinely not reachable cross-machine; advertising
 *     nothing is correct (peers will skip it rather than route to a dead URL).
 */
export function resolveAdvertisedMeshUrl(
  tunnel: MeshTunnelConfig | undefined,
  resolvedTunnelUrl?: string | null,
): string | null {
  if (resolvedTunnelUrl && /^https?:\/\/\S+$/.test(resolvedTunnelUrl.trim())) {
    return resolvedTunnelUrl.trim().replace(/\/+$/, '');
  }
  if (tunnel?.enabled !== false && tunnel?.hostname && tunnel.hostname.trim()) {
    const host = tunnel.hostname.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (host) return `https://${host}`;
  }
  return null;
}

/** Minimal slice of MachineIdentityManager this module needs (keeps it testable). */
export interface MeshUrlRecorder {
  getMachineUrl(machineId: string): string | null;
  updateMachineUrl(machineId: string, url: string): void;
}

/**
 * Advertise this machine's reachable URL into its own registry entry so peers
 * can route to it. Idempotent (no write when unchanged), and tolerant when the
 * self entry isn't present yet (best-effort — boot ordering can race the
 * registration). Returns true iff it wrote a new value.
 */
export function advertiseSelfMeshUrl(
  recorder: MeshUrlRecorder,
  selfMachineId: string,
  url: string | null,
  log?: (msg: string) => void,
): boolean {
  if (!url || !selfMachineId) return false;
  try {
    if (recorder.getMachineUrl(selfMachineId) === url) return false; // idempotent
    recorder.updateMachineUrl(selfMachineId, url);
    log?.(`  Mesh: advertised self URL → ${url}`);
    return true;
  } catch {
    // Self entry not present yet — caller may retry on a later lifecycle event.
    return false;
  }
}
