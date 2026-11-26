import type { TreeProjectMembership } from './conversationGraphRead.js';
import type { CreationPlacementView } from './CreationPlacementSnapshot.js';
import { nodeKey, type ConversationRef } from './conversationGraph.js';

export function ownerTreeProjectMembership(
  refs: readonly ConversationRef[], snapshot: CreationPlacementView | null,
): ReadonlyMap<string, TreeProjectMembership> | null {
  if (!snapshot?.complete) return null;
  const keys = refs.map((ref) => ref.platform === 'telegram' ? `telegram:${ref.topicId}`
    : ref.platform === 'app' ? `app:${ref.conversationKey}` : null);
  const visible = new Map(keys.map((key, index) => [key, nodeKey(refs[index])]));
  const membership = new Map<string, TreeProjectMembership>();
  for (const [index, ref] of refs.entries()) {
    let key = keys[index];
    const seen = new Set<string>();
    while (key && visible.has(key) && !seen.has(key)) {
      if (snapshot.confirmedProjects.has(key)) {
        const directParent = snapshot.parents.get(keys[index] ?? '');
        const parentNodeKey = directParent ? visible.get(directParent) : undefined;
        if (!seen.size) membership.set(nodeKey(ref), key);
        else if (parentNodeKey) membership.set(nodeKey(ref), { projectConversationKey: key, parentNodeKey });
        break;
      }
      seen.add(key);
      const parent = snapshot.parents.get(key);
      // A Telegram topic present in the covered inventory can have no
      // Chief placement record. Certified group membership is checked separately.
      if (parent === null || (parent === undefined && ref.platform === 'telegram' && seen.size === 1)) {
        if (seen.size === 1) membership.set(nodeKey(ref), null);
        break;
      }
      key = parent ?? null;
    }
  }
  return membership;
}
