/**
 * Operator-channel-sacred (outbound) recipient classifier for the tone-gate seam.
 * Spec: outbound-gate-tiered-fail-direction.
 *
 * Returns 'operator' ONLY when BOTH hold:
 *  - the topic has a VERIFIED, locally-auth-bound operator (`asVerifiedOperator`
 *    is local-auth-only by the TopicOperatorStore invariant — NEVER a replicated
 *    record or a content name; Know Your Principal), AND
 *  - the agent has a SINGLE distinct human operator across all topics, so no
 *    OTHER human could read a topic thread (all topics live in one forum
 *    supergroup; there is no per-topic membership API).
 *
 * Returns 'external' (fail-closed — the safe side) on ANY ambiguity: no topicId,
 * no store, no verified binding, a resolution error, or >1 distinct operator (a
 * multi-user agent). The deliver-on-availability-failure direction is only ever
 * the verified operator's own private channel.
 */
export interface ToneOperatorStoreLike {
  asVerifiedOperator: (t: number | string) => unknown;
  all: () => Record<string, { uid?: string }>;
}

export function resolveToneRecipientClass(
  topicOperatorStore: ToneOperatorStoreLike | null | undefined,
  topicId: number | string | null | undefined,
): 'operator' | 'external' {
  if (topicId == null || !topicOperatorStore) return 'external';
  let verified: unknown;
  try {
    verified = topicOperatorStore.asVerifiedOperator(topicId);
  } catch {
    return 'external';
  }
  if (!verified) return 'external';
  try {
    const uids = new Set(
      Object.values(topicOperatorStore.all())
        .map((o) => o?.uid)
        .filter((u): u is string => typeof u === 'string' && u.length > 0),
    );
    if (uids.size > 1) return 'external'; // multi-operator agent → fail-closed
  } catch {
    return 'external';
  }
  return 'operator';
}
