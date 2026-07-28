/**
 * SelfNicknameResolver — resolve THIS machine's own user-facing nickname robustly
 * (Multi-Machine Session Pool §L4).
 *
 * THE BUG THIS CLOSES (2026-06-04, live-caught on the real laptop+mini pair):
 * a machine's local capacity view (`MachinePoolRegistry.getCapacities()`) can carry
 * its PEERS' nicknames but NOT its own — because `updateNickname` (the rename behind
 * the dashboard / PATCH /pool/machines) is local-only and was applied on a DIFFERENT
 * machine's registry, so it never reached the owning machine. Net: the laptop's own
 * entry is `nickname=None`, so "move it back to the laptop" can't resolve "Laptop"
 * on the very machine (the holder) that runs the relocation check.
 *
 * The prior `RelocationNicknameSet` fix unions a self-nickname IF one is provided —
 * but the bug is that the self-nickname could not be RESOLVED at all. This resolver
 * fixes that: it falls back to what PEERS call this machine (their capacity view names
 * it correctly), then to a deterministic derive. Pure over its inputs; the server
 * supplies the local + peer capacity views.
 */

export interface NicknameCapacity {
  machineId: string;
  nickname?: string;
}

/**
 * Resolve `selfMachineId`'s nickname. Priority:
 *   1. The local capacity view (the common, already-symmetric case).
 *   2. Any PEER's capacity view that names this machine (covers the drift bug — a
 *      peer renamed us and the rename never propagated to our own registry).
 *   3. A deterministic derive (last resort; reconstructs an auto-assigned name).
 * Returns null when nothing resolves (caller then simply omits the self nickname,
 * exactly the pre-existing behavior — never throws, never mis-resolves).
 */
export function resolveSelfNickname(opts: {
  selfMachineId: string | null | undefined;
  localCapacities: readonly NicknameCapacity[];
  /** Capacity views obtained from peers (e.g. via mesh capacity-report). */
  peerCapacities?: readonly (readonly NicknameCapacity[])[];
  /** Deterministic derive fallback (e.g. deriveBaseNickname(identityName, platform)). */
  derive?: () => string | null | undefined;
}): string | null {
  const self = opts.selfMachineId;
  if (!self) return opts.derive?.() ?? null;
  const pick = (caps: readonly NicknameCapacity[]): string | null => {
    const n = caps.find((c) => c.machineId === self)?.nickname;
    return n && n.trim() ? n : null;
  };
  // 1. Local view.
  const local = pick(opts.localCapacities);
  if (local) return local;
  // 2. Peer views — the drift backstop.
  for (const peerCaps of opts.peerCapacities ?? []) {
    const fromPeer = pick(peerCaps);
    if (fromPeer) return fromPeer;
  }
  // 3. Derive.
  const derived = opts.derive?.();
  return derived && derived.trim() ? derived : null;
}
