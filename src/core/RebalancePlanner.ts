/**
 * RebalancePlanner — the pure Stage-3 load-rebalance decision (Multi-Machine Session
 * Pool §L4 "Load-rebalance trigger conditions"). Given the machine capacities + the
 * current session→machine assignments, it proposes a BOUNDED set of transfers off
 * over-saturated machines. It is evaluated ONLY on the heartbeat interval by the
 * caller (never per message), and is deliberately conservative to avoid a cascade:
 *
 *  - A machine is a rebalance SOURCE only if its session ratio exceeds
 *    `rebalanceThresholdPercent` (default 0.85 of maxSessions).
 *  - Only NON-pinned, low-priority sessions that are off cool-down
 *    (`now - lastTransferredAt > placementCooldownMs`) are movable; a hard pin or a
 *    critical session is NEVER proactively rebalanced.
 *  - At most ONE move per source per cycle (capped overall by `maxMovesPerCycle`), and
 *    a working copy of capacities is updated as moves are proposed so the planner never
 *    piles every session onto one target.
 *  - The TARGET is chosen by the same `PlacementExecutor.decide(reason:'rebalance')`
 *    the router uses — a move is proposed only if it lands on a DIFFERENT, eligible
 *    machine. No move ⇒ empty result (rebalance never forces a churn).
 *
 * Pure over its inputs; the caller performs the actual transfers (TransferOrchestrator).
 */

import type { PlacementExecutor, PlacementRequest, TopicPlacement } from './PlacementExecutor.js';
import type { MachineCapacity } from './types.js';

export interface RebalanceSession {
  sessionKey: string;
  ownerMachineId: string;
  pinned?: boolean;
  lowPriority?: boolean; // default true — only low-priority sessions are rebalanced
  lastTransferredAt?: number;
  topicMetadata?: TopicPlacement;
  /** The session's channel scope, threaded to placement so a move never lands on a
   *  machine that cannot reach the conversation's platform/workspace (CMT-1568). */
  channel?: PlacementRequest['channel'];
}

export interface RebalanceInput {
  machines: MachineCapacity[];
  sessions: RebalanceSession[];
  rebalanceThresholdPercent: number;
  placementCooldownMs: number;
  now: number;
  /** Hard cap on moves proposed per cycle (default = number of saturated sources). */
  maxMovesPerCycle?: number;
  /**
   * Source override (trustworthy-machine-load D2): when set, a machine is a source iff
   * this returns true (e.g. "refusing work for 3 minutes"), replacing the session-ratio
   * threshold. Absent ⇒ the ratio rule (today's behavior).
   */
  isSource?: (m: MachineCapacity) => boolean;
  /**
   * Target restriction (trustworthy-machine-load D2): only machines passing this are
   * offered to placement as targets. Absent ⇒ every machine (today's behavior).
   */
  targetEligible?: (m: MachineCapacity) => boolean;
}

export interface RebalanceMove {
  sessionKey: string;
  fromMachine: string;
  toMachine: string;
  reason: string;
}

function sessionRatio(m: MachineCapacity): number {
  return m.maxSessions && m.maxSessions > 0 ? (m.activeSessionCount ?? 0) / m.maxSessions : 0;
}

export function planRebalance(input: RebalanceInput, placement: PlacementExecutor): RebalanceMove[] {
  // Working copy of capacities (mutated as moves are proposed → no pile-on).
  const caps = new Map<string, MachineCapacity>(input.machines.map((m) => [m.machineId, { ...m }]));
  const threshold = input.rebalanceThresholdPercent;

  const saturated = (id: string): boolean => {
    const m = caps.get(id);
    if (!m || !m.online) return false;
    return input.isSource ? input.isSource(m) : sessionRatio(m) > threshold;
  };
  const sources = input.machines.filter((m) => saturated(m.machineId)).sort((a, b) => sessionRatio(caps.get(b.machineId)!) - sessionRatio(caps.get(a.machineId)!));
  const cap = input.maxMovesPerCycle ?? sources.length;
  const moves: RebalanceMove[] = [];
  const movedSessions = new Set<string>();

  for (const src of sources) {
    if (moves.length >= cap) break;
    if (!saturated(src.machineId)) continue; // a prior move may have relieved it
    // Eligible movable sessions on this source.
    const candidates = input.sessions.filter((s) =>
      s.ownerMachineId === src.machineId &&
      !movedSessions.has(s.sessionKey) &&
      !s.pinned && !s.topicMetadata?.pinned &&
      (s.lowPriority ?? true) &&
      input.now - (s.lastTransferredAt ?? 0) > input.placementCooldownMs,
    );
    for (const s of candidates) {
      // One move per source per cycle (cascade guard). The session's channel scope is
      // threaded (CMT-1568, fixed with trustworthy-machine-load P3) so a move never lands
      // on a machine whose adapter cannot reach the conversation's platform/workspace.
      const registry = input.targetEligible
        ? [...caps.values()].filter((m) => m.machineId !== src.machineId && input.targetEligible!(m))
        : [...caps.values()];
      if (registry.length === 0) break;
      const decision = placement.decide({
        sessionKey: s.sessionKey,
        topicMetadata: s.topicMetadata ?? {},
        machineRegistry: registry,
        currentOwner: undefined, // rebalance ignores stickiness
        reason: 'rebalance',
        ...(s.channel ? { channel: s.channel } : {}),
      });
      if (decision.outcome === 'placed' && decision.chosenMachine && decision.chosenMachine !== src.machineId) {
        moves.push({ sessionKey: s.sessionKey, fromMachine: src.machineId, toMachine: decision.chosenMachine, reason: 'load-rebalance' });
        movedSessions.add(s.sessionKey);
        // Update the working copy: source −1, target +1.
        const from = caps.get(src.machineId)!;
        const to = caps.get(decision.chosenMachine)!;
        from.activeSessionCount = Math.max(0, (from.activeSessionCount ?? 0) - 1);
        to.activeSessionCount = (to.activeSessionCount ?? 0) + 1;
        break; // one move per source this cycle
      }
    }
  }
  return moves;
}
