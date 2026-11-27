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
      // The walk reached a visible top-level conversation without passing a confirmed project, so
      // the chat is in no project: an explicit root (parent null, such as the Chief of Staff topic
      // or an unconfirmed project), or a Telegram topic present in the covered inventory with no
      // Chief placement record. This holds at any depth, not only for the chat itself. An
      // invisible or unknown ancestor still ends the loop above without an entry, so placement is
      // withheld. Certified group membership is checked separately.
      if (parent === null || (parent === undefined && key.startsWith('telegram:'))) {
        membership.set(nodeKey(ref), null);
        break;
      }
      key = parent ?? null;
    }
  }
  return membership;
}
