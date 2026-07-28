/**
 * F3 (Inbound Delivery Is Sacred) — pure routing plan for inbound-queue loss
 * notices. A lost inbound user message must reach the user who sent it (each
 * loss item's `sessionKey` IS the topic id they messaged from) OR, if it has no
 * resolvable destination, be surfaced LOUDLY — never silently expired. This pure
 * function decides the routing; server.ts does the actual notify()/loud-surface.
 * Constitution: "The User Experience Is the Product" → sub-standard #3 Inbound
 * Delivery Is Sacred. Spec: docs/specs/inbound-delivery-sacred.md.
 */

export interface InboundLossRoutePlan {
  /** Per-ORIGINATING-topic notice — each affected topic + how many of its
   *  messages were lost (delivered IN that topic, the proven path). */
  perTopic: Array<{ topicId: number; count: number }>;
  /** Count of lost items whose sessionKey is not a resolvable numeric topic.
   *  These fall back to the attention topic; if that is unset too, they MUST be
   *  surfaced loudly (the one seam where a loss could otherwise go silent). */
  unresolved: number;
}

/**
 * Group inbound loss items by their originating topic. Pure: same input → same
 * output. A sessionKey that is a positive finite number is a topic id; anything
 * else (empty, non-numeric, legacy single-file key) is counted as `unresolved`.
 */
export function planInboundLossNotices(
  items: ReadonlyArray<{ sessionKey: string }>,
): InboundLossRoutePlan {
  const byTopic = new Map<number, number>();
  let unresolved = 0;
  for (const it of items) {
    const tid = Number(it.sessionKey);
    if (Number.isFinite(tid) && tid > 0) {
      byTopic.set(tid, (byTopic.get(tid) ?? 0) + 1);
    } else {
      unresolved++;
    }
  }
  return {
    // Deterministic order (ascending topic id) for stable notices + tests.
    perTopic: [...byTopic.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([topicId, count]) => ({ topicId, count })),
    unresolved,
  };
}
