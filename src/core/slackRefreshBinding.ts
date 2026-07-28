/**
 * slackRefreshBinding — the §10.5 (TOPIC-PROFILE-SPEC) Slack arm of
 * SessionRefresh: binding-resolution surface + conversation-key scheme.
 *
 * SessionRefresh was Telegram-only by construction (its binding lookup
 * returned `not_telegram_bound` for everything else). The kill-time half of
 * Slack continuity already exists in server bootstrap (`beforeSessionKill` →
 * `slackAdapter.saveChannelResume(routingKey, uuid, sessionName)`), so the
 * narrow gap is (a) resolving WHICH Slack conversation a session is bound to
 * and (b) a Slack-capable respawner callback. This module defines the
 * structural interfaces + key helpers; SessionRefresh consumes them.
 *
 * Conversation-key scheme (spec §10.5): the platform-agnostic key space is
 *   bare numeric            → Telegram topic id (back-compat)
 *   slack:<channel>[:<thread>] → Slack conversation
 * SlackAdapter's own routing key is `<channelId>` or `<channelId>:<thread_ts>`
 * — the slack:* conversation key is exactly that routing key behind the
 * `slack:` prefix.
 */

/**
 * The minimal structural surface SessionRefresh needs from a Slack adapter.
 * `SlackAdapter` satisfies this as-is (registerChannelSession keys the
 * registry on the ROUTING KEY — `<channelId>` or `<channelId>:<thread_ts>` —
 * and the channel-resume map is keyed the same way, including the entry the
 * beforeSessionKill listener writes during the kill).
 *
 * Defined locally (not imported from SlackAdapter) so SessionRefresh stays
 * decoupled from the messaging layer the same way it is for the respawner
 * callback — and so tests can supply a plain object.
 */
export interface SlackRefreshBinding {
  /** Routing key (`<channelId>` or `<channelId>:<thread_ts>`) bound to this
   *  tmux session, or null when the session is not Slack-bound. */
  getChannelForSession(sessionName: string): string | null;
  /** Optional disk-backed fallback, mirroring TelegramAdapter's
   *  resolveTopicForSessionFromDisk — a binding registered after this
   *  process loaded the registry is still recoverable. Adapters without it
   *  simply skip the fallback. */
  resolveChannelForSessionFromDisk?(sessionName: string): string | null;
  /** Remove the channel-resume entry for a routing key. Used by `fresh`
   *  respawns: beforeSessionKill just saved the UUID; clearing it makes the
   *  respawner spawn a brand-new conversation instead of `--resume`-ing a
   *  poisoned transcript. */
  removeChannelResume(routingKey: string): void;
}

/**
 * Slack respawner callback — the Slack analogue of SessionRefreshDeps.respawner.
 * Wired by server bootstrap to mirror the Slack message-handler spawn path:
 * read getChannelResume(routingKey) → removeChannelResume →
 * spawnInteractiveSession(prompt, undefined, { resumeSessionId,
 * slackChannelId, slackThreadTs }) → registerChannelSession(routingKey, name).
 *
 * Same contract as the Telegram respawner: it does NOT kill the old tmux
 * session (SessionRefresh already did, which fired beforeSessionKill and
 * persisted the resume UUID into the channel-resume map). Resolves to the new
 * tmux session name.
 */
export type SlackRespawner = (
  sessionName: string,
  routingKey: string,
  followUpPrompt: string | undefined,
  accountSwap?: { configHome?: string; accountId?: string },
) => Promise<string>;

export const SLACK_CONVERSATION_KEY_PREFIX = 'slack:';

/** `<channelId>[:<thread_ts>]` routing key → `slack:<channel>[:<thread>]` (§10.5). */
export function slackConversationKey(routingKey: string): string {
  return `${SLACK_CONVERSATION_KEY_PREFIX}${routingKey}`;
}

/** `slack:<channel>[:<thread>]` → routing key, or null when not a Slack key. */
export function parseSlackConversationKey(key: string): string | null {
  if (!key.startsWith(SLACK_CONVERSATION_KEY_PREFIX)) return null;
  const routingKey = key.slice(SLACK_CONVERSATION_KEY_PREFIX.length);
  return routingKey.length > 0 ? routingKey : null;
}

/**
 * Stable negative synthetic topic id for a Slack routing key.
 *
 * §4 (durable-conversation-identity, increment 2): the hash copy this module
 * carried is RETIRED — this is a re-export of `candidateIdForRoutingKey` from
 * the ONE consolidated identity surface, value-identical by golden parity
 * (§10). It is the mint CANDIDATE, no longer an identity authority (the
 * ConversationRegistry is the collision authority). RefreshResult keeps a
 * numeric `topicId` for back-compat consumers (e.g. the restart-all log line
 * reads result.topicId); Slack results carry this candidate id so those
 * consumers stay type- and meaning-compatible with the rest of the system's
 * Slack↔numeric bridging (PresenceProxy, resume heartbeat).
 */
export { candidateIdForRoutingKey as slackRoutingKeySyntheticId } from './conversationIdentity.js';

/**
 * slack-respawn-bind-token fix: resolve the `bootstrapConversationIds` for a Slack
 * session RESPAWN (the /sessions/refresh, quota-swap, restart, restart-all paths, all
 * funneling through SessionRefresh → slackRespawner) from its `routingKey`.
 *
 * A FRESH Slack spawn passes `bootstrapConversationIds: [conversationId]` so the session
 * mints `INSTAR_BIND_TOKEN` + `INSTAR_CONVERSATION_ID` (durable-conversation-identity §7)
 * and can open durable state (a commitment) bound to its minted conversation id. The
 * respawn path previously OMITTED it, so a refreshed/quota-swapped Slack session came up
 * token-less and its durable binds were refused (fail-closed) → the follow-through fell
 * back to a fragile session-local timer that dies on the next restart (the live-proven
 * S7 gap). This restores parity. `mintForInbound` is an idempotent get-or-create, so it
 * returns the SAME id the fresh dispatch resolved for this key.
 *
 * Fail-toward-respawn: any resolution error → `undefined` (the prior token-less
 * behavior), NEVER throws — a refresh must never be blocked by id resolution.
 */
export function slackRespawnBootstrapIds(
  routingKey: string,
  mintForInbound: (key: string) => { id: number | null },
): number[] | undefined {
  try {
    const id = mintForInbound(routingKey).id;
    return typeof id === 'number' ? [id] : undefined;
  } catch {
    /* @silent-fallback-ok: fail-toward-respawn — id resolution must NEVER block a Slack
       session refresh/quota-swap/restart; a resolution error degrades to `undefined`
       (the prior token-less behavior), exactly the safe direction. The absence of a bind
       token only means this respawned session can't open durable state until its next
       clean spawn — never a lost refresh. */
    return undefined;
  }
}
