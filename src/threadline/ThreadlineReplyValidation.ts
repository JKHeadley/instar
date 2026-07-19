import type { ListenerSessionManager } from './ListenerSessionManager.js';
import type { ThreadLog } from './ThreadLog.js';

// canonical-migration-consumer: threadline-inbound-canonical-store@1

export interface ThreadlineReplyValidationSources {
  listenerManager?: Pick<ListenerSessionManager, 'readCanonicalInboxEntry'> | null;
  threadLog?: Pick<ThreadLog, 'has' | 'isPathConfined'> | null;
}

/**
 * Prove that `inReplyTo` names an authenticated inbound leg on the claimed
 * thread. During the canonical-log migration, legacy listener traffic lives in
 * the HMAC inbox while every modern relay funnel writes the hash-chained
 * per-thread log. Authorization accepts the union of those two authorities.
 *
 * Fail closed on malformed input, mismatches, unconfined paths, absent stores,
 * or read failures.
 */
export function isAuthenticatedThreadlineInbound(
  sources: ThreadlineReplyValidationSources,
  threadId: unknown,
  messageId: unknown,
): boolean {
  if (typeof threadId !== 'string' || !threadId || typeof messageId !== 'string' || !messageId) return false;
  // Reply authorization and at-most-once claiming are one invariant. The
  // ListenerSessionManager currently owns the durable claim ledger, so modern
  // ThreadLog evidence must not authorize a reply when that claim authority is
  // unavailable.
  if (!sources.listenerManager) return false;

  try {
    const legacy = sources.listenerManager.readCanonicalInboxEntry(messageId);
    if (legacy?.threadId === threadId) return true;
  } catch {
    // One canonical source failing never erases valid evidence from the other.
  }

  try {
    return sources.threadLog?.isPathConfined(threadId) === true
      && sources.threadLog.has(threadId, messageId, 'inbound');
  } catch {
    return false;
  }
}
