/**
 * RelocationNicknameSet — the pure resolver behind the "move this to <nickname>"
 * recognizer's known-machine set (Multi-Machine Session Pool §L4).
 *
 * THE BUG THIS CLOSES (2026-06-04, topic-transfer robustness): the recognizer was
 * fed `knownNicknames` straight from `MachinePoolRegistry.getCapacities()`. That
 * view can omit a machine's OWN nickname (a self identity entry whose `nickname`
 * field hasn't propagated). Because the lifeline always forwards an inbound message
 * to the HOLDER's server, the relocation check runs on the machine the user is
 * trying to move *back to* — so "move to <peer>" resolved and fired while "move to
 * <self/holder>" found no match, silently fell through, and got injected into the
 * session as a normal message. Forward worked; back-transfer silently failed.
 *
 * The fix: this helper UNIONS the local machine's own nickname into the set even
 * when the capacities view omits it, so a topic can always be moved back to the
 * machine currently handling it. Pure over its inputs — no I/O, fully unit-tested.
 */

/** The minimal shape this resolver needs from a MachineCapacity. */
export interface RelocationCapacity {
  machineId: string;
  nickname?: string;
}

export interface RelocationNicknameSet {
  /** Display-cased nicknames, in resolution order, for the recognizer + reject listing. */
  knownNicknames: string[];
  /** lowercased(nickname) → machineId, for resolveNickname(). */
  nickToMachine: Map<string, string>;
}

/**
 * Build the recognizer's known-nickname set + resolution map. The local machine's
 * own nickname (`selfNickname` for `selfMachineId`) is unioned in even if it's
 * absent from `capacities`, guaranteeing "move this to <the current machine>"
 * always resolves. De-duplicated case-insensitively; the first mapping for a given
 * nickname wins (capacities are added before the self fallback, so an explicit
 * capacities entry is never overridden by the fallback).
 */
export function buildRelocationNicknameSet(opts: {
  capacities: readonly RelocationCapacity[];
  selfMachineId?: string | null;
  selfNickname?: string | null;
}): RelocationNicknameSet {
  const nickToMachine = new Map<string, string>();
  const knownNicknames: string[] = [];
  const add = (nickname: string | undefined | null, machineId: string | undefined | null): void => {
    if (!nickname || !machineId) return;
    const key = nickname.trim().toLowerCase();
    if (!key) return;
    if (nickToMachine.has(key)) return;
    nickToMachine.set(key, machineId);
    knownNicknames.push(nickname);
  };
  for (const c of opts.capacities) add(c.nickname, c.machineId);
  // Union the local machine's own nickname last — never overrides a capacities entry,
  // but rescues the case where capacities omitted it (the back-transfer bug).
  add(opts.selfNickname, opts.selfMachineId);
  return { knownNicknames, nickToMachine };
}
