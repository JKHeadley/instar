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

/** One row of the rope recovery prober's view (MultiMachineSyncStatus.ropeHealth). */
export interface RopeProbeSourceRow {
  peer: string;
  state: 'healthy' | 'dead' | 'exhausted';
  nextProbeDueAt: number | null;
}

/**
 * Is anything working to reconnect this machine? (CMT-1541: every "no answer
 * from X" notice says how long and whether something is fixing it.)
 *
 *   connected       — at least one connection to it works; the failed read was
 *                     something else (busy, an error), and the next read asks again.
 *   retrying        — every connection is down and this machine keeps re-dialing
 *                     on its normal back-off.
 *   retrying-slowly — every connection is down and the re-dial has failed so often
 *                     it now tries only at the slow floor rate.
 */
export interface ReconnectDecoration {
  reconnect?: { state: 'connected' | 'retrying' | 'retrying-slowly'; nextTryAt?: string };
}

/**
 * Decorate pool rows with the recovery prober's per-peer state. Absent prober
 * (dark on the fleet) or no row for a peer ⇒ no field: "not known", never a
 * fabricated "nothing is fixing it". Pure.
 */
export function decorateWithReconnect<T extends { machineId: string }>(
  machines: T[],
  rows: RopeProbeSourceRow[] | null | undefined,
): Array<T & ReconnectDecoration> {
  if (!rows || rows.length === 0) return machines;
  return machines.map((m) => {
    const mine = rows.filter((r) => r.peer === m.machineId);
    if (mine.length === 0) return m;
    if (mine.some((r) => r.state === 'healthy')) return { ...m, reconnect: { state: 'connected' as const } };
    const due = mine.map((r) => r.nextProbeDueAt).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
    const nextTryAt = due.length ? new Date(Math.min(...due)).toISOString() : undefined;
    const state = mine.some((r) => r.state === 'dead') ? 'retrying' as const : 'retrying-slowly' as const;
    return { ...m, reconnect: nextTryAt ? { state, nextTryAt } : { state } };
  });
}
