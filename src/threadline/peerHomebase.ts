/**
 * peerHomebase — naming and binding decisions for a peer agent's homebase topic.
 *
 * Spec: docs/specs/peer-conversation-homebase-topic.md (the 80/20 version — the operator
 * stopped a 21-round draft for over-engineering; §6 there lists what is deliberately accepted).
 *
 * The two decisions a homebase needs are both small, both pure, and both easy to get
 * dangerously wrong, so they live here rather than inline at the callsite:
 *
 *  1. What is the topic called? A display name alone is not unique — two peers may choose the
 *     same one, and find-or-create keys on the name, so they would silently share one topic.
 *  2. May this conversation be bound to it? Getting this wrong in the permissive direction
 *     destroys an operator's deliberate choice, which is the one thing the feature promises
 *     not to do.
 */

/** The three transports of provenance; absent means a record predating the field. */
export type BoundTopicSource = 'operator' | 'origin-inherited' | 'peer-homebase';

export interface HomebaseBindCandidate {
  /** The topic currently bound, if any. */
  boundTopicId?: number;
  /** Who chose it. ABSENT is the legacy case and is deliberately NOT bindable. */
  boundTopicSource?: BoundTopicSource;
}

/** How much of the fingerprint goes in the name. Short enough to read, long enough to separate. */
export const HOMEBASE_FP_SUFFIX_LEN = 6;

/**
 * `"<peer> · Threadline · <fp6>"`.
 *
 * The suffix exists because the map keys by fingerprint while find-or-create keys by NAME: two
 * peers with the same display name would otherwise collide onto one topic. It REDUCES
 * accidental collisions rather than eliminating them — two peers sharing both a display name
 * and the first six fingerprint characters still collide, which §6 accepts rather than
 * engineers against.
 */
export function homebaseTopicName(peerName: string, peerFingerprint: string): string {
  const name = peerName.trim() || 'unknown peer';
  const fp = peerFingerprint.replace(/[^0-9a-zA-Z]/g, '').slice(0, HOMEBASE_FP_SUFFIX_LEN);
  return fp ? `${name} · Threadline · ${fp}` : `${name} · Threadline`;
}

export type BindVerdict =
  /** Nothing was chosen, or the record proves the binding was accidental. */
  | { bind: true; reason: 'no-binding' | 'origin-inherited' }
  /** A choice exists, or might exist. Left alone. */
  | { bind: false; reason: 'operator' | 'unknown-provenance' | 'already-homebase' };

/**
 * May this conversation be re-pointed at its peer's homebase?
 *
 * The load-bearing row is `unknown-provenance`. A binding with no provenance may be a
 * deliberate operator bind made before the field existed, so it is PRESERVED. An earlier draft
 * of the spec treated absent provenance as bindable, which would have overwritten exactly the
 * choices the feature promises to protect — the external reviewer caught it, and this function
 * is where that correction lives.
 *
 * `pp`'s own conversation is in that class, which is why re-homing it is the operator's explicit
 * request (already made) rather than something this code does on its own.
 */
export function decideHomebaseBind(c: HomebaseBindCandidate): BindVerdict {
  if (c.boundTopicSource === 'operator') return { bind: false, reason: 'operator' };
  if (c.boundTopicSource === 'peer-homebase') return { bind: false, reason: 'already-homebase' };
  if (typeof c.boundTopicId !== 'number') return { bind: true, reason: 'no-binding' };
  if (c.boundTopicSource === 'origin-inherited') return { bind: true, reason: 'origin-inherited' };
  return { bind: false, reason: 'unknown-provenance' };
}

/**
 * Which conversation gets bound when a homebase is created.
 *
 * Zero is the NORMAL case (pairing can precede any conversation) and many is the ambiguous one.
 * Binding none of several is deliberate: an unbound conversation already routes to the homebase,
 * and choosing between bound ones is the operator's call (§6 cuts per-conversation offers).
 */
export function selectConversationToBind<T extends HomebaseBindCandidate>(
  conversations: readonly T[],
): { conversation: T; verdict: BindVerdict } | { conversation: null; reason: 'none' | 'ambiguous' } {
  if (conversations.length === 0) return { conversation: null, reason: 'none' };
  if (conversations.length > 1) return { conversation: null, reason: 'ambiguous' };
  const only = conversations[0]!;
  return { conversation: only, verdict: decideHomebaseBind(only) };
}
