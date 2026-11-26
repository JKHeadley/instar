import type { CreationPlacementView } from './CreationPlacementSnapshot.js';
import { nodeKey, type ConversationRef } from './conversationGraph.js';

export function ownerTreeProjectMembership(
  refs: readonly ConversationRef[], snapshot: CreationPlacementView | null,
): ReadonlyMap<string, string | null> | null {
  if (!snapshot?.complete) return null;
  const keys = refs.map((ref) => ref.platform === 'telegram' ? `telegram:${ref.topicId}`
    : ref.platform === 'app' ? `app:${ref.conversationKey}` : null);
  const visible = new Set(keys);
  const membership = new Map<string, string | null>();
  for (const [index, ref] of refs.entries()) {
    let key = keys[index];
    const seen = new Set<string>();
    while (key && visible.has(key) && !seen.has(key)) {
      if (snapshot.confirmedProjects.has(key)) {
        // The current section renderer can represent a project and immediate
        // children. Leave deeper paths unresolved until it preserves the edges.
        if (seen.size <= 1) membership.set(nodeKey(ref), key);
        break;
      }
      seen.add(key);
      const parent = snapshot.parents.get(key);
      if (parent === null) {
        if (seen.size === 1) membership.set(nodeKey(ref), null);
        break;
      }
      key = parent ?? null;
    }
  }
  return membership;
}
