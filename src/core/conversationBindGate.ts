/**
 * conversationBindGate — the ONE shared implementation of the
 * durable-conversation-identity §7 bind-time authority (B7/R3-M5/R4-M3).
 *
 * A durable-state open on a conversation id is scoped to the session's OWN
 * authenticated bootstrap context, enforced through the per-session bind token
 * (delivered ONLY via the spawn env — never over a route). The server verifies
 * the MAC and reads the bootstrap set FROM the token; it NEVER trusts a
 * caller-supplied session name.
 *
 * This is factored out of the `POST /commitments` route so that
 * `POST /action-claim/observe` (slack-followthrough-generalization §4.3) runs
 * the SAME verification — a second copy would be exactly the drift the §7 golden
 * test forbids. Both routes call `verifyConversationBind` and act on its typed
 * verdict.
 *
 * The helper never writes an HTTP response — the caller owns status codes. On a
 * refusal (or the R7-minor-2 tokenless-straggler backstop) it raises the SAME
 * deduped attention item the route used to raise inline (fail-closed for a
 * minted id; fail-open for a legacy token-less positive id).
 */
import type { ConversationBindAuth } from './conversationBindToken.js';
import { TOKENLESS_BIND_GRACE_DAYS } from './conversationBindToken.js';

/** The minimal attention surface the gate needs (TelegramAdapter.createAttentionItem).
 *  `priority` mirrors AttentionItem's union so TelegramAdapter is assignable here
 *  under strict function types. */
export interface BindGateAttentionSink {
  createAttentionItem: (item: {
    id: string;
    title: string;
    summary: string;
    category: string;
    priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
    sourceContext: string;
  }) => unknown;
}

export type ConversationBindVerdict =
  | { ok: true; boundBy?: string }
  | { ok: false; detail: string };

/**
 * Verify the caller's authority to open durable state on `numericTopicId`.
 *
 * - `bindAuth` absent OR `numericTopicId` undefined → `{ ok: true }` (no gate;
 *   the in-process / no-topic path is unchanged).
 * - NEGATIVE (minted) id → HARD-GATED, fail-closed: requires a valid token whose
 *   bootstrap set includes the id; else `{ ok:false }` + the deduped refusal item.
 * - POSITIVE id WITH a token → validated against the token's bootstrap set
 *   (R6-minor-4); a bad token refuses.
 * - POSITIVE id WITHOUT a token → legacy fail-OPEN `{ ok:true }`; past the
 *   deploy-stamp grace window the R7-minor-2 straggler backstop raises ONE
 *   deduped LOW item (the bind still succeeds).
 */
export function verifyConversationBind(params: {
  bindAuth: ConversationBindAuth | null | undefined;
  numericTopicId: number | undefined;
  rawToken: string | undefined;
  attention?: BindGateAttentionSink | null;
}): ConversationBindVerdict {
  const { bindAuth, numericTopicId, rawToken, attention } = params;
  if (!bindAuth || numericTopicId === undefined) {
    return { ok: true };
  }

  const refuse = (detail: string): ConversationBindVerdict => {
    try {
      void attention?.createAttentionItem({
        id: `conversation-bind-refused:${numericTopicId}`,
        title: 'A durable bind on a conversation id was refused',
        summary: `A durable-state open targeting topicId ${numericTopicId} was refused: ${detail} (durable-conversation-identity §7 — never silently delivered into a foreign conversation).`,
        category: 'conversation-identity',
        priority: 'NORMAL',
        sourceContext: 'conversation-identity',
      });
    } catch {
      /* attention is observability */
    }
    return { ok: false, detail };
  };

  if (numericTopicId < 0) {
    // Minted-id bind: hard-gated, fail-closed.
    if (!rawToken) {
      return refuse('minted-id bind requires the session bind token (missing X-Instar-Bind-Token)');
    }
    const payload = bindAuth.verify(rawToken);
    if (!payload) {
      return refuse('bind token missing/invalid (MAC verification failed)');
    }
    if (!payload.bootstrapConversationIds.includes(numericTopicId)) {
      return refuse(`conversation ${numericTopicId} is not in the session's authenticated bootstrap context`);
    }
    return { ok: true, boundBy: `session:${payload.sessionName}` };
  }

  if (rawToken) {
    // R6-minor-4: a TOKEN-BEARING session's positive-id bind validates against
    // the token's bootstrap set.
    const payload = bindAuth.verify(rawToken);
    if (!payload) {
      return refuse('bind token invalid (MAC verification failed)');
    }
    if (!payload.bootstrapConversationIds.includes(numericTopicId)) {
      return refuse(`topic ${numericTopicId} is not in the session's authenticated bootstrap context`);
    }
    return { ok: true, boundBy: `session:${payload.sessionName}` };
  }

  // Token-less LEGACY positive-id bind: keeps today's ungated fail-OPEN behavior.
  // Past the deploy-stamp grace window, the straggler backstop raises ONE deduped
  // item so a long-lived ungated session is a visible operator decision (R7-minor-2).
  const ageDays = bindAuth.deployStampAgeDays();
  if (ageDays !== null && ageDays >= TOKENLESS_BIND_GRACE_DAYS) {
    try {
      void attention?.createAttentionItem({
        id: 'conversation-bind-tokenless-straggler',
        title: 'A token-less session is still opening durable state',
        summary: `A durable-state open (topicId ${numericTopicId}) arrived without a bind token ${ageDays} days after the bind-token increment deployed (grace ${TOKENLESS_BIND_GRACE_DAYS}d). The bind SUCCEEDED (legacy behavior); respawn long-lived sessions to close the window (durable-conversation-identity §7 R7-minor-2).`,
        category: 'conversation-identity',
        priority: 'LOW',
        sourceContext: 'conversation-identity',
      });
    } catch {
      /* attention is observability */
    }
  }
  return { ok: true };
}
