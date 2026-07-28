/**
 * PeerEndpointRecorder — records a peer's advertised mesh endpoints into THIS
 * machine's registry, idempotently and fail-closed (mesh-endpoint-http-propagation).
 *
 * The single chokepoint for "I just learned a peer's fast ropes from the signed lease
 * RPC body" — shared by BOTH directions so the gate + validation + idempotency live in
 * exactly one place:
 *   - the receiver routes (`/api/lease`, `/api/lease/pull`) record the authenticated
 *     SENDER's / PULLER's endpoints, and
 *   - the puller transport records the holder's endpoints out of a pull RESPONSE,
 *     bound to the cryptographically-verified responder identity.
 *
 * Invariants (spec Receiver §):
 *   1. meshTransport gate — a no-op when `multiMachine.meshTransport` is off.
 *   2. Absence is a no-op, NEVER a wipe — undefined/null/`[]`/fully-invalid leaves the
 *      peer's prior ropes intact (a silent or un-upgraded sender must not erase them).
 *   3. Synchronous per-kind validation BEFORE storage (defense-in-depth, not authority).
 *   4. Idempotent — skip the write (and its `lastSeen` bump + registry-dirty mark) when
 *      the normalized set is unchanged, preventing ~720 no-op rewrites/day on a stable
 *      2-machine setup.
 *   5. Advisory — a peer set is recorded ONLY into THAT peer's entry; it never mutates
 *      this machine's own self-endpoints. The resolver remains the dial-time authority.
 */

import type { MeshEndpoint } from './types.js';
import { validateMeshEndpoints, meshEndpointsEqual } from './MeshEndpointValidator.js';

export interface PeerEndpointRecorderDeps {
  /** Read the peer's currently-recorded endpoint set (for the idempotency compare). */
  getPeerEndpoints: (machineId: string) => MeshEndpoint[] | undefined;
  /** Write the peer's endpoint set (bumps lastSeen + persists — only called when changed). */
  updateMachineEndpoints: (machineId: string, endpoints: MeshEndpoint[]) => void;
  /** Live read: false ⇒ recording is a strict no-op (the lease handling is unchanged). */
  meshTransportEnabled: () => boolean;
  logger?: (msg: string) => void;
}

export class PeerEndpointRecorder {
  private readonly d: PeerEndpointRecorderDeps;

  constructor(deps: PeerEndpointRecorderDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[mesh-endpoints] ${m}`);
  }

  /**
   * Validate + idempotently record `raw` (the untrusted advertised set) as `peerMachineId`'s
   * endpoints. Returns true iff it actually wrote a new value. Never throws — a write to an
   * unknown machine (or any registry error) is swallowed (the peer simply keeps its prior set).
   *
   * `peerMachineId` MUST be the AUTHENTICATED / cryptographically-verified identity of the
   * advertising machine (the route's `auth.machineId`, or the pull-response ack's verified
   * responder). Never pass a self-asserted body field — that is the load-bearing binding.
   */
  record(peerMachineId: string, raw: unknown): boolean {
    if (!this.d.meshTransportEnabled()) return false;
    if (!peerMachineId) return false;
    if (raw === undefined || raw === null) return false; // absence → no-op
    const validated = validateMeshEndpoints(raw);
    if (validated.length === 0) return false; // empty/fully-invalid → no-op, never a wipe
    try {
      const current = this.d.getPeerEndpoints(peerMachineId);
      if (meshEndpointsEqual(current, validated)) return false; // idempotent — skip the write
      this.d.updateMachineEndpoints(peerMachineId, validated);
      this.log(`recorded ${validated.length} endpoint(s) for ${peerMachineId} [${validated.map((e) => e.kind).join(',')}]`);
      return true;
    } catch (err) {
      // @silent-fallback-ok: recording is best-effort enrichment. An unknown-machine write
      // (MACHINE_NOT_FOUND) or a registry race means the peer keeps its prior endpoint set and
      // the next lease RPC retries — strictly no worse than today's cloudflare-only behavior.
      this.log(`skip record for ${peerMachineId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
