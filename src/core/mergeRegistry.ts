/**
 * mergeRegistry — deterministic semantic merge of two MachineRegistry objects
 * when `machines/registry.json` hits a rebase/merge conflict.
 *
 * The 2026-05-27 divergence: machine A committed a lease-epoch bump while
 * machine B concurrently committed its own join (a new `machines` entry). When
 * both push, the loser's rebase conflicts on registry.json — and GitSync's
 * `tryAutoResolve` had no registry case, so it fell to LLM/manual and the
 * mesh stayed split (A saw 1 machine, B saw 2). This merge makes that conflict
 * resolve deterministically + losslessly:
 *
 *   - machines: UNION by machineId. Never drop a machine. On a same-id clash,
 *     keep the entry with the later `lastSeen` (the fresher view), but a
 *     `revoked` status on EITHER side is sticky (a revocation must not be
 *     resurrected by a stale active entry).
 *   - lease: the higher `epoch` wins (epoch is the fencing authority clock).
 *     A same-epoch tie is broken deterministically by signature-byte lexical
 *     order, so both machines compute the identical winner without coordination.
 *   - version: max of the two (forward-compatible).
 *
 * Pure + deterministic: mergeRegistry(a,b) === mergeRegistry(b,a) for the
 * fields that matter (machines union is symmetric; lease + version pick a
 * canonical winner regardless of argument order). No I/O, never throws on
 * well-formed input.
 */

import type { MachineRegistry, MachineRegistryEntry, LeaseRecord } from './types.js';

function parseTime(ts: string | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** Pick the surviving entry for a single machineId present on both sides. */
function mergeEntry(a: MachineRegistryEntry, b: MachineRegistryEntry): MachineRegistryEntry {
  // Revocation is sticky — a revoked entry on either side wins regardless of lastSeen,
  // so a stale "active" view can never resurrect a machine that was removed.
  const aRevoked = a.status === 'revoked' || !!a.revokedAt;
  const bRevoked = b.status === 'revoked' || !!b.revokedAt;
  if (aRevoked && !bRevoked) return a;
  if (bRevoked && !aRevoked) return b;
  if (aRevoked && bRevoked) {
    // Both revoked — keep the one with the earlier revocation timestamp (first revoke is canonical).
    return parseTime(a.revokedAt) <= parseTime(b.revokedAt) ? a : b;
  }
  // Neither revoked — the fresher view (later lastSeen) wins; tie → higher syncSequence.
  const at = parseTime(a.lastSeen);
  const bt = parseTime(b.lastSeen);
  if (at !== bt) return at > bt ? a : b;
  return (a.syncSequence ?? 0) >= (b.syncSequence ?? 0) ? a : b;
}

/** Pick the surviving lease. Higher epoch wins; tie → signature lexical order. */
function mergeLease(a: LeaseRecord | undefined, b: LeaseRecord | undefined): LeaseRecord | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? a : b;
  // Same epoch — should be rare; break the tie deterministically so both
  // machines converge on the identical lease without further coordination.
  return (a.signature ?? '') >= (b.signature ?? '') ? a : b;
}

export function mergeRegistry(ours: MachineRegistry, theirs: MachineRegistry): MachineRegistry {
  const machines: Record<string, MachineRegistryEntry> = {};

  // Union all machineIds from both sides.
  const ids = new Set<string>([
    ...Object.keys(ours.machines ?? {}),
    ...Object.keys(theirs.machines ?? {}),
  ]);
  for (const id of ids) {
    const a = ours.machines?.[id];
    const b = theirs.machines?.[id];
    if (a && b) machines[id] = mergeEntry(a, b);
    else machines[id] = (a ?? b)!;
  }

  return {
    version: Math.max(ours.version ?? 1, theirs.version ?? 1),
    machines,
    lease: mergeLease(ours.lease, theirs.lease),
  };
}
