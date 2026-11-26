/** Exact source-conversation reads, independent of the board's presentation limits. */
import type { WorkBoardService, CardView } from './WorkBoardService.js';
import { cardJson, type Viewer } from './workBoardViews.js';
import { isAgentInternalCard, sha256Hex } from './WorkCardStore.js';

export const SOURCE_CARD_PAGE_SIZE = 50;

export function sourceCardQuery(query: Record<string, unknown>):
  | { kind: 'board' } | { kind: 'invalid' } | { kind: 'source'; key: string; page: number } {
  if (query.sourceConversationKey === undefined && query.sourcePage === undefined) return { kind: 'board' };
  const key = query.sourceConversationKey;
  const rawPage = query.sourcePage ?? '0';
  if (typeof key !== 'string' || !key.trim() || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)
    || typeof rawPage !== 'string' || !/^(0|[1-9]\d*)$/.test(rawPage)) return { kind: 'invalid' };
  const page = Number(rawPage);
  if (!Number.isSafeInteger(page) || page > Math.floor(Number.MAX_SAFE_INTEGER / SOURCE_CARD_PAGE_SIZE) - 1) return { kind: 'invalid' };
  return { kind: 'source', key, page };
}

export function sourceCardsJson(svc: WorkBoardService, viewer: Viewer, key: string, page: number,
  name: (key: string) => string, extraFor?: (v: CardView) => Parameters<typeof cardJson>[4]) {
  if (!viewer.isOwner && !viewer.isAgent) throw new Error('source-cards-owner-required');
  const matches: CardView[] = [];
  for (const id of svc.cardIds()) {
    const view = svc.view(id);
    if (view?.card.created && !view.card.redacted && !isAgentInternalCard(view.card) && view.card.source?.conversationKey === key) matches.push(view);
  }
  // All open lanes share one group: clock-driven quiet/capacity changes must not reorder pages.
  const closed = (v: CardView) => Number(v.status === 'done' || v.status === 'archived');
  matches.sort((a, b) => closed(a) - closed(b) || b.card.newestRecordAt - a.card.newestRecordAt
    || (a.card.cardId < b.card.cardId ? -1 : a.card.cardId > b.card.cardId ? 1 : 0));
  const offset = page * SOURCE_CARD_PAGE_SIZE;
  // A delayed peer record may change the fold without increasing the journal's maximum HLC.
  // Hash matching record identities and effective statuses in display order, not just the maximum.
  const sourceRevision = sha256Hex(JSON.stringify([svc.policyRecords().map(r => [r.id, r.hlc.physical, r.hlc.logical, r.hlc.node, r.origin]),
    matches.map(v => [v.card.cardId, v.status, svc.recordsOf(v.card.cardId).map(r => [r.id, r.hlc.physical, r.hlc.logical, r.hlc.node, r.origin])])]));
  return {
    cards: matches.slice(offset, offset + SOURCE_CARD_PAGE_SIZE).map(v => cardJson(svc, v, viewer, name, extraFor?.(v))),
    total: matches.length,
    nextPage: offset + SOURCE_CARD_PAGE_SIZE < matches.length ? page + 1 : null,
    newestHlc: svc.newestHlc(),
    sourceRevision,
  };
}
