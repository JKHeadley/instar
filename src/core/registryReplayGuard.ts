/**
 * registryReplayGuard — G2 replay/freshness + unknown-key constraint (spec §8 G2).
 *
 * Validates an incoming (pulled) registry entry before it is applied locally.
 * Signed-commit verification (v3) already rejects unsigned/revoked commits;
 * this guard adds the content-level checks a signature alone cannot give:
 *
 *  1. Replay/freshness — a pulled entry whose per-author `syncSequence` is not
 *     strictly greater than the last applied for its author is discarded.
 *  2. Epoch floor — a pulled entry whose `authoredUnderEpoch` is below the
 *     current committed epoch is discarded. This catches the case a per-author
 *     sequence cannot: a machine that wiped/restored local state (sequence
 *     resets to 0) or re-keyed cannot smuggle in an authority-bearing write,
 *     because its stale leaseEpoch is rejected regardless of a locally-monotonic
 *     sequence.
 *  3. Unknown-key first commit — the FIRST commit from a previously-unseen
 *     machineId is accepted ONLY if it is role:standby + rejoined:true (or a
 *     pairing-join record). Any unknown-key first commit asserting an awake
 *     role or a lease claim is rejected — a rejoining machine must pull-and-read
 *     before writing, never assert its stale prior role.
 *
 * Pure logic, unit-tested on both sides of every boundary.
 */

import type { MachineRegistryEntry } from './types.js';

export interface ReplayGuardInput {
  machineId: string;
  /** The incoming (pulled) entry for this machine. */
  incoming: MachineRegistryEntry;
  /** The locally-known entry for this machine (undefined = previously unseen). */
  local?: MachineRegistryEntry;
  /** The current committed lease epoch (registry.lease?.epoch ?? 0). */
  currentCommittedEpoch: number;
  /** Whether this incoming entry carries a valid pairing-join record (allows an awake-less first write). */
  hasValidJoinRecord?: boolean;
}

export interface ReplayDecision {
  accept: boolean;
  reason: string;
}

export function evaluateRegistryEntry(input: ReplayGuardInput): ReplayDecision {
  const { incoming, local, currentCommittedEpoch, hasValidJoinRecord } = input;

  // ── Unknown-key first commit constraint ───────────────────────────
  if (!local) {
    if (hasValidJoinRecord) {
      return { accept: true, reason: 'unknown-key-with-valid-join-record' };
    }
    const isStandby = incoming.role === 'standby';
    const isRejoin = incoming.rejoined === true;
    if (isStandby && isRejoin) {
      return { accept: true, reason: 'unknown-key-standby-rejoin' };
    }
    return {
      accept: false,
      reason: `unknown-key-first-commit must be standby+rejoined (got role=${incoming.role}, rejoined=${incoming.rejoined})`,
    };
  }

  // ── Replay/freshness (per-author monotonic sequence) ──────────────
  const localSeq = local.syncSequence ?? -1;
  const incomingSeq = incoming.syncSequence ?? -1;
  if (incomingSeq <= localSeq) {
    return {
      accept: false,
      reason: `stale-sync-sequence (incoming ${incomingSeq} <= local ${localSeq})`,
    };
  }

  // ── Epoch floor (catches wiped/re-keyed sequence reset) ───────────
  const authoredUnder = incoming.authoredUnderEpoch ?? 0;
  if (authoredUnder < currentCommittedEpoch) {
    return {
      accept: false,
      reason: `below-epoch-floor (authoredUnderEpoch ${authoredUnder} < committed ${currentCommittedEpoch})`,
    };
  }

  return { accept: true, reason: 'fresh' };
}

/**
 * Reconcile a full incoming registry against the local one, entry by entry.
 * Returns the entries to apply (accepted) and the rejected ones with reasons
 * (logged, never applied). The lease object is reconciled separately by the
 * FencedLease layer (epoch CAS), not here.
 */
export function reconcileRegistryEntries(opts: {
  localEntries: Record<string, MachineRegistryEntry>;
  incomingEntries: Record<string, MachineRegistryEntry>;
  currentCommittedEpoch: number;
  joinRecords?: ReadonlySet<string>;
}): {
  accepted: Record<string, MachineRegistryEntry>;
  rejected: Array<{ machineId: string; reason: string }>;
} {
  const accepted: Record<string, MachineRegistryEntry> = {};
  const rejected: Array<{ machineId: string; reason: string }> = [];

  for (const [machineId, incoming] of Object.entries(opts.incomingEntries)) {
    const decision = evaluateRegistryEntry({
      machineId,
      incoming,
      local: opts.localEntries[machineId],
      currentCommittedEpoch: opts.currentCommittedEpoch,
      hasValidJoinRecord: opts.joinRecords?.has(machineId) ?? false,
    });
    if (decision.accept) {
      accepted[machineId] = incoming;
    } else {
      rejected.push({ machineId, reason: decision.reason });
    }
  }

  return { accepted, rejected };
}
