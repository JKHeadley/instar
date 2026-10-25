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
 *   2b. Degradation does not discard a PROVEN rope — a non-empty advertisement that
 *      OMITS a kind whose local health record says it is currently alive RETAINS that
 *      kind instead of replacing it away. Invariant 2 guarded the empty case only, so a
 *      peer that can no longer SEE its own best address (an agent inside a NAT'd VM —
 *      the 2026-08-29 WSL machine, whose only visible NIC was an unreachable virtual
 *      one) replaced a demonstrably-working tailscale rope with a dead-on-arrival lan
 *      one, and the mesh lost its only route to that machine. Evidence beats assertion:
 *      a rope carrying traffic is not dropped because an announcement forgot it. A rope
 *      the health record calls dead (or has never dialed) is still dropped, so a
 *      genuinely-retired endpoint does not linger forever.
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
  /**
   * Invariant 2b evidence source: is (peer, kind) CURRENTLY alive in this machine's own
   * rope-health record? Only a `true` retains an omitted kind — `false` (dead) and
   * `undefined` (never dialed, no evidence) both fall through to replace semantics.
   * Optional so a caller that wires no health source keeps the pre-2b behaviour exactly.
   */
  isEndpointAlive?: (machineId: string, kind: MeshEndpoint['kind']) => boolean | undefined;
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
    // Validation reconstructs {kind,url}, deliberately stripping any peer-supplied
    // `origin`; absence means advertised for backward-compatible registries.
    const validated = validateMeshEndpoints(raw);
    if (validated.length === 0) return false; // empty/fully-invalid → no-op, never a wipe
    try {
      const current = this.d.getPeerEndpoints(peerMachineId);
      const next = this.retainProvenOmitted(peerMachineId, current, validated);
      if (meshEndpointsEqual(current, next)) return false; // idempotent — skip the write
      this.d.updateMachineEndpoints(peerMachineId, next);
      this.log(`recorded ${next.length} endpoint(s) for ${peerMachineId} [${next.map((e) => e.kind).join(',')}]`);
      return true;
    } catch (err) {
      // @silent-fallback-ok: recording is best-effort enrichment. An unknown-machine write
      // (MACHINE_NOT_FOUND) or a registry race means the peer keeps its prior endpoint set and
      // the next lease RPC retries — strictly no worse than today's cloudflare-only behavior.
      this.log(`skip record for ${peerMachineId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Persist one locally-corroborated endpoint after the observation tracker has
   * completed its floor and signed dial-back. Peer-supplied `origin` is stripped
   * by record(); only this method can mint `origin: observed`. */
  promoteObservedEndpoint(peerMachineId: string, endpoint: MeshEndpoint): boolean {
    if (!this.d.meshTransportEnabled() || !peerMachineId) return false;
    const validated = validateMeshEndpoints([{ kind: endpoint.kind, url: endpoint.url }]);
    if (validated.length !== 1) return false;
    try {
      const current = this.d.getPeerEndpoints(peerMachineId) ?? [];
      const observed: MeshEndpoint = {
        ...validated[0],
        origin: 'observed',
        observedAt: endpoint.observedAt ?? new Date().toISOString(),
      };
      const next = [...current.filter((row) => !(row.kind === observed.kind && row.origin === 'observed')), observed];
      if (meshEndpointsEqual(current, next)) return false;
      this.d.updateMachineEndpoints(peerMachineId, next);
      this.log(`promoted observed ${observed.kind} endpoint for ${peerMachineId}`);
      return true;
    } catch (err) { // @silent-fallback-ok: promotion is evidence-only and the logged false result leaves existing routes untouched
      this.log(`skip observed promotion for ${peerMachineId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Retract an exact locally-observed endpoint when later evidence proves the
   * source is shared egress. Advertised endpoints are never touched here. */
  removeObservedEndpoint(peerMachineId: string, endpoint: Pick<MeshEndpoint, 'kind' | 'url'>): boolean {
    if (!this.d.meshTransportEnabled() || !peerMachineId) return false;
    try {
      const current = this.d.getPeerEndpoints(peerMachineId) ?? [];
      const next = current.filter((row) => !(row.origin === 'observed' && row.kind === endpoint.kind && row.url === endpoint.url));
      if (next.length === current.length) return false;
      this.d.updateMachineEndpoints(peerMachineId, next);
      this.log(`retracted shared-egress observed ${endpoint.kind} endpoint for ${peerMachineId}`);
      return true;
    } catch (err) {
      this.log(`skip observed retraction for ${peerMachineId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Invariant 2b — merge an omitted-but-PROVEN kind back into the advertised set.
   *
   * `advertised` wins for every kind it names (a peer re-advertising a kind with a NEW
   * url is still an upgrade, and must land). A kind present in `current` but absent from
   * `advertised` is retained ONLY when `isEndpointAlive` positively says it is alive; a
   * dead rope, an unknown rope, and a caller with no health source all fall through to
   * plain replace semantics.
   *
   * Pure over its inputs (no I/O, no throw) so the retain decision is unit-testable
   * without a registry or a resolver.
   */
  private retainProvenOmitted(
    peerMachineId: string,
    current: MeshEndpoint[] | undefined,
    advertised: MeshEndpoint[],
  ): MeshEndpoint[] {
    const alive = this.d.isEndpointAlive;
    if (!current || current.length === 0) return advertised;
    const advertisedKinds = new Set(advertised.map((e) => e.kind));
    const retained: MeshEndpoint[] = [];
    for (const ep of current) {
      if (ep.origin === 'observed') {
        // Observed and advertised endpoints of the same kind intentionally
        // coexist: URL-specific health decides advertised-alive vs observed
        // vs advertised-dead at dial time.
        retained.push(ep);
        continue;
      }
      if (advertisedKinds.has(ep.kind)) continue;
      if (!alive) continue;
      let verdict: boolean | undefined;
      try {
        verdict = alive(peerMachineId, ep.kind);
      } catch {
        // @silent-fallback-ok: an unreadable health source is NO evidence, which is the
        // same as "never dialed" — fall through to replace. Never retains on an error.
        verdict = undefined;
      }
      if (verdict === true) retained.push(ep);
    }
    if (retained.length > 0) {
      this.log(
        `retained ${retained.length} proven endpoint(s) for ${peerMachineId} omitted by its advertisement `
        + `[${retained.map((e) => e.kind).join(',')}] — health says alive`,
      );
    }
    return [...advertised, ...retained];
  }

}
