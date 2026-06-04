/**
 * TopicPlacementDescription — the pure resolver behind `GET /pool/placement?topic=N`
 * (Multi-Machine Session Pool observability). Answers the question a session could
 * not previously answer about itself: "which machine is this topic running on, and
 * WHY — was it deliberately pinned there, or just load-placed?"
 *
 * THE GAP THIS CLOSES (2026-06-04): from a standby session there was no way to read
 * the pin/route state (it lives on the lease-holder), so an agent would *infer* its
 * placement and narrate a guess as fact. This makes placement an explicit, queryable
 * answer. Pure over its inputs — the route supplies live state + a nickname resolver.
 */

export type TopicPlacementReason = 'pinned' | 'placed' | 'unowned';

export interface TopicPlacementDescription {
  topicId: string;
  /** machineId currently owning (running) the topic's session, or null if unowned. */
  owner: string | null;
  ownerNickname: string | null;
  /**
   * pinned  — a hard placement pin exists (deliberate move); `pinnedTo` is the target.
   * placed  — owned but unpinned (the router load-placed it; NOT a deliberate move).
   * unowned — no machine currently owns it.
   */
  reason: TopicPlacementReason;
  pinnedTo: string | null;
  pinnedToNickname: string | null;
  /** The machine that holds the lease (owns Telegram polling / routing) right now. */
  leaseHolder: string | null;
  leaseHolderNickname: string | null;
  /** Is the topic owned by the machine answering this query? */
  isThisMachine: boolean;
  thisMachine: string | null;
}

/**
 * Describe a topic's placement from already-resolved live state. `pinnedTo` is the
 * pin's target machine ONLY when a hard pin is set (the route passes null for an
 * absent/soft pin). `nicknameOf` maps a machineId → its user-facing nickname.
 */
export function describeTopicPlacement(opts: {
  topicId: string;
  owner: string | null;
  pinnedTo: string | null;
  leaseHolder: string | null;
  selfMachineId: string | null;
  nicknameOf: (machineId: string | null) => string | null;
}): TopicPlacementDescription {
  const reason: TopicPlacementReason = opts.pinnedTo ? 'pinned' : opts.owner ? 'placed' : 'unowned';
  return {
    topicId: opts.topicId,
    owner: opts.owner,
    ownerNickname: opts.nicknameOf(opts.owner),
    reason,
    pinnedTo: opts.pinnedTo,
    pinnedToNickname: opts.nicknameOf(opts.pinnedTo),
    leaseHolder: opts.leaseHolder,
    leaseHolderNickname: opts.nicknameOf(opts.leaseHolder),
    isThisMachine: opts.owner != null && opts.owner === opts.selfMachineId,
    thisMachine: opts.selfMachineId,
  };
}
