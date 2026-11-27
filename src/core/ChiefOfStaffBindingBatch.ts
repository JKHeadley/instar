import { canonicalHash } from './GraphWitnessTypes.js';
import { isValidConversationKey, validBindingDraftDetails, type BindingInput } from './ChiefOfStaffStore.js';

/** The immutable, owner-visible work in one project-binding approval. */
export type BindingBatchItem =
  | { kind: 'project-bind'; binding: Omit<BindingInput, 'confirmedBy' | 'confirmedAt'>; title: string }
  | { kind: 'parent-placement'; childConversationKey: string; parentConversationKey: string; sourceCardId: string; sourceFingerprint: string; audienceFingerprint: string; title: string };

export interface OwnerBindingBatchDraft {
  version: 1;
  id: string;
  createdAt: string;
  sourceMessageRefs: string[];
  items: BindingBatchItem[];
}

export const OWNER_BINDING_BATCH_MAX_ITEMS = 32;
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_CARD = /^wc_[a-f0-9]{16,64}$/;

/** Stable digest of exactly the data shown to the owner. */
export function ownerBindingBatchHash(draft: OwnerBindingBatchDraft): string {
  return canonicalHash(draft);
}

/** Shape and duplicate-target checks only. Callers must authenticate source, graph, access and currentness separately. */
export function validateOwnerBindingBatchDraft(value: unknown): value is OwnerBindingBatchDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if (Object.keys(d).sort().join(',') !== 'createdAt,id,items,sourceMessageRefs,version') return false;
  if (d.version !== 1 || typeof d.id !== 'string' || !/^[a-f0-9]{32}$/.test(d.id)) return false;
  if (typeof d.createdAt !== 'string' || !Number.isFinite(Date.parse(d.createdAt))) return false;
  if (!Array.isArray(d.sourceMessageRefs) || d.sourceMessageRefs.length < 1 || d.sourceMessageRefs.length > 8 ||
      !d.sourceMessageRefs.every((ref) => typeof ref === 'string' && ref.length > 0 && ref.length <= 180)) return false;
  if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > OWNER_BINDING_BATCH_MAX_ITEMS) return false;

  const targets = new Set<string>();
  for (const raw of d.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const item = raw as Record<string, unknown>;
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200) return false;
    if (item.kind === 'project-bind') {
      if (Object.keys(item).sort().join(',') !== 'binding,kind,title' || !item.binding || typeof item.binding !== 'object' || Array.isArray(item.binding)) return false;
      const b = item.binding as Record<string, unknown>;
      if (!isValidConversationKey(b.conversationKey) || targets.has(b.conversationKey)) return false;
      if (typeof b.goal !== 'string' || !b.goal.trim() || b.goal.length > 4000) return false;
      if (!Number.isFinite(b.checkCadenceHours) || (b.checkCadenceHours as number) <= 0) return false;
      if (!validBindingDraftDetails(b)) return false;
      targets.add(b.conversationKey);
    } else if (item.kind === 'parent-placement') {
      if (Object.keys(item).sort().join(',') !== 'audienceFingerprint,childConversationKey,kind,parentConversationKey,sourceCardId,sourceFingerprint,title') return false;
      if (!isValidConversationKey(item.childConversationKey) || !isValidConversationKey(item.parentConversationKey) || item.childConversationKey === item.parentConversationKey) return false;
      if (targets.has(item.childConversationKey) || typeof item.sourceCardId !== 'string' || !OPAQUE_CARD.test(item.sourceCardId)) return false;
      if (typeof item.sourceFingerprint !== 'string' || !SHA256.test(item.sourceFingerprint) || typeof item.audienceFingerprint !== 'string' || !SHA256.test(item.audienceFingerprint)) return false;
      targets.add(item.childConversationKey);
    } else return false;
  }
  return true;
}

/** Render every approved operation in full. This output is private and must not be sent to a shared group. */
export function renderOwnerBindingBatch(draft: OwnerBindingBatchDraft, sourceDisclosure: string[]): string {
  if (!validateOwnerBindingBatchDraft(draft) || sourceDisclosure.length !== draft.sourceMessageRefs.length) throw new Error('invalid-owner-binding-batch');
  const rows = draft.items.map((item, index) => item.kind === 'project-bind'
    ? `${index + 1}. Add project “${item.title}”\n   Goal: ${item.binding.goal}\n   Repository: ${item.binding.linked.repos?.join(', ') || 'None'}\n   Completion checks:\n${item.binding.doneDefinition.map((d) => `   - ${d.text}`).join('\n')}`
    : `${index + 1}. Place the app conversation “${item.title}” under its recorded project parent\n   Parent: ${item.parentConversationKey}\n   Work Board source: ${item.sourceCardId}`);
  return `Review ${draft.items.length} exact changes\n\n${rows.join('\n\n')}\n\nOwner request evidence:\n${sourceDisclosure.map((text) => `- ${text}`).join('\n')}\n\nNothing changes unless you approve this complete list. This approval applies only to the items shown here.`;
}

/** Compare a caller-supplied draft with the current project list for review.
 * Placement rows still need graph and Work Board source checks in the existing workflow.
 */
export function previewOwnerBindingBatch(value: unknown, bound: ReadonlySet<string>) {
  if (!validateOwnerBindingBatchDraft(value)) return null;
  let draftHash: string;
  try { draftHash = ownerBindingBatchHash(value); }
  catch { return null; } // JSON outside the canonical numeric domain is an invalid draft.
  return {
    mode: 'preview' as const,
    draftHash,
    items: value.items.map((item) => {
      if (item.kind === 'parent-placement') {
        return { item, disposition: 'placement-source-review-required' as const };
      }
      return {
        item,
        disposition: bound.has(item.binding.conversationKey) ? 'already-tracked' as const : 'proposed-binding' as const,
      };
    }),
  };
}
