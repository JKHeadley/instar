/**
 * Pool rope-condition decoration — surface transport-level reachability on the
 * pool view within one rope-health evaluation instead of the registry's
 * failover threshold.
 *
 * The blind spot this closes (2026-07-23 laptop-offline test finding): when a
 * machine dropped off the network, GET /mesh/rope-health classified it
 * `peer-offline` in under a minute, but the /pool row's `online` flag stayed
 * true for ~15 minutes — the registry ages liveness out via
 * `failoverThresholdMs`, which is deliberately conservative because `online`
 * feeds PLACEMENT eligibility. The operator watching the Machines view saw a
 * dark machine rendered as online.
 *
 * This module keeps both truths visible without coupling them: `online`
 * (placement semantics, conservative by design) is untouched; each row
 * additionally carries the rope-health monitor's live per-peer classification
 * (`ropeCondition` + `ropeAllDownSince`) when the monitor is running. Consumers
 * that render reachability (dashboard Machines tab, `emptyState` renderers)
 * can show "unreachable (ropes down since <t>)" within a minute while
 * placement keeps its flap-resistant threshold.
 *
 * Absent-monitor honesty: on installs where the rope-health monitor is dark
 * (fleet default — `monitoring.ropeHealth` is dev-gated) the fields are simply
 * ABSENT, never fabricated. A machine the monitor doesn't track (e.g. self —
 * ropes are peer-directed) also carries no fields.
 *
 * Pure: no I/O, no clock reads — decoration over caller-supplied rows.
 */

/** The subset of a rope-health peer row this decoration consumes. */
export interface RopeConditionSource {
  machineId: string;
  condition: string;
  /** All-transports-down onset (epoch-ms), null when not all-down. */
  allDownSince: number | null;
}

/** The fields attached to a pool machine row when rope health is known. */
export interface RopeConditionDecoration {
  /** Live rope-health classification: ok | degraded | peer-offline | urgent | unknown. */
  ropeCondition?: string;
  /** ISO onset of the all-transports-down condition, when in effect. */
  ropeAllDownSince?: string;
}

/**
 * Decorate pool machine rows with the rope-health monitor's per-peer
 * classification. Rows without a matching peer entry pass through untouched
 * (identity — the same object, so absent stays absent, never `undefined`-keyed).
 */
export function decorateWithRopeCondition<T extends { machineId: string }>(
  machines: T[],
  peers: RopeConditionSource[] | null | undefined,
): Array<T & RopeConditionDecoration> {
  if (!peers || peers.length === 0) return machines;
  const byId = new Map(peers.map((p) => [p.machineId, p]));
  return machines.map((m) => {
    const peer = byId.get(m.machineId);
    if (!peer) return m;
    const decorated: T & RopeConditionDecoration = { ...m, ropeCondition: peer.condition };
    if (peer.allDownSince !== null && Number.isFinite(peer.allDownSince)) {
      decorated.ropeAllDownSince = new Date(peer.allDownSince).toISOString();
    }
    return decorated;
  });
}
