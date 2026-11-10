/**
 * The fold hold on the Durable Inbound Message Queue as a fold carrier
 * (context-budget-layered-summaries §9.3 "Held inbound").
 *
 * Rows a fold holds stay frozen (invisible to the drain, TTL not running)
 * until the fold record is terminal. Two release paths, both record-gated:
 *  - the coordinator's terminal transition, through `inboundHoldCarrier`;
 *  - `releaseSettledInboundHolds`, run right after the inbound boot sweep opens
 *    the queue: the fold boot sweep runs BEFORE that sweep (and so before the
 *    queue store exists), so a fold it aborted at this boot has its rows
 *    released here. A row whose record is open (or quarantined) stays held.
 *
 * Inbound session keys are the Telegram topic id or `app:<conversationKey>`;
 * they map to the channel-neutral fold key with foldKeyForConversation.
 */
import type { FoldCarrier } from './FoldCoordinator.js';
import { foldKeyForConversation } from './FoldHoldStore.js';
import type { PendingInboundStore } from '../core/PendingInboundStore.js';

/** The fold key for an inbound queue session key (null when it has none). */
export function foldKeyForInboundSession(sessionKey: string): string | null {
  if (/^\d{1,20}$/.test(sessionKey)) return foldKeyForConversation('telegram', sessionKey);
  if (sessionKey.startsWith('app:')) return foldKeyForConversation('app', sessionKey.slice(4));
  return null;
}

export function inboundHoldCarrier(getStore: () => PendingInboundStore | null, now: () => number = Date.now): FoldCarrier {
  return {
    kind: 'inbound-hold',
    list: () => {
      const store = getStore();
      if (!store) return [];
      return store.foldHeldSessions().flatMap((h) => {
        const topicKey = foldKeyForInboundSession(h.sessionKey);
        return topicKey ? [{ topicKey, foldId: h.foldId }] : [];
      });
    },
    release: (_topicKey, foldId) => {
      getStore()?.releaseFold(foldId, new Date(now()).toISOString());
    },
  };
}

/**
 * Release every fold-held row whose fold record is NOT open (terminal, or
 * missing). Returns the released fold ids. `recordOpen` answers true for a
 * non-terminal record (quarantined included), false for terminal, null for
 * missing/torn.
 */
export function releaseSettledInboundHolds(
  store: PendingInboundStore,
  recordOpen: (topicKey: string, foldId: string) => boolean | null,
  nowIso: string,
): string[] {
  const released: string[] = [];
  for (const h of store.foldHeldSessions()) {
    const topicKey = foldKeyForInboundSession(h.sessionKey);
    const open = topicKey ? recordOpen(topicKey, h.foldId) : null;
    if (open === true) continue; // the record still owns its rows
    if (released.includes(h.foldId)) continue;
    store.releaseFold(h.foldId, nowIso);
    released.push(h.foldId);
  }
  return released;
}
