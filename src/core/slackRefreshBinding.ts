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
 * IDENTICAL hash to `server.ts:slackChannelToSyntheticId` and the inline copy
 * in `routes.ts` (build-event heartbeat) — sum-shift char hash, negated so it
 * can never collide with a (positive) Telegram topic id. RefreshResult keeps
 * a numeric `topicId` for back-compat consumers (e.g. the restart-all log
 * line reads result.topicId); Slack results carry this synthetic id so those
 * consumers stay type- and meaning-compatible with the rest of the system's
 * Slack↔numeric bridging (PresenceProxy, resume heartbeat).
 *
 * NOTE for the integrating session: this is now the THIRD copy of the hash —
 * consolidating server.ts + routes.ts onto this export is a wiring follow-up
 * (both files are owned by other builders in this round).
 */
export function slackRoutingKeySyntheticId(routingKey: string): number {
  let hash = 0;
  for (let i = 0; i < routingKey.length; i++) {
    hash = ((hash << 5) - hash + routingKey.charCodeAt(i)) | 0;
  }
  return -(Math.abs(hash) + 1); // always negative, never 0
}
