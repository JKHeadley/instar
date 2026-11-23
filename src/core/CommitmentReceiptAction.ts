import { createHash } from 'node:crypto';
import type { ActionItem } from './types.js';

export type ReceiptActionIntent = Pick<ActionItem, 'title' | 'description'> & Partial<Pick<ActionItem,
  'priority' | 'commitTo' | 'dueBy' | 'followThroughOptOutReason' | 'source' | 'tags'>>;

/** Reserved, opt-in registration identity; ordinary evolution actions are unchanged. */
export function isCommitmentReceiptAction(source: ActionItem['source']): boolean {
  return source?.platform === 'commitment-detection'
    && /^cf1:[a-f0-9]{64}:(0|[1-9][0-9]{0,2})$/.test(source.contentId ?? '');
}

export function commitmentActionIntentHash(action: ReceiptActionIntent): string {
  return createHash('sha256').update(JSON.stringify({
    title: action.title, description: action.description, priority: action.priority || 'medium',
    commitTo: action.commitTo ?? null, dueBy: action.dueBy ?? null,
    followThroughOptOutReason: action.followThroughOptOutReason ?? null,
    source: { platform: action.source?.platform ?? null, contentId: action.source?.contentId ?? null,
      context: action.source?.context ?? null },
    tags: [...(action.tags ?? [])].sort(),
  })).digest('hex');
}

/** Status is mutable; cancellation/completion does not erase an actual registration. */
export function commitmentActionProof(action: ActionItem): string {
  return createHash('sha256').update(JSON.stringify({ id: action.id, createdAt: action.createdAt,
    intent: commitmentActionIntentHash(action) })).digest('hex');
}
