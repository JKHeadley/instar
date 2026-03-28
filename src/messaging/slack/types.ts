/**
 * Slack adapter types — configuration, messages, events, and rate limit tiers.
 */

// ── Configuration ──

export interface SlackConfig {
  /** Bot token (xoxb-...) from OAuth installation */
  botToken: string;
  /** App-level token (xapp-...) for Socket Mode connection */
  appToken: string;
  /** Workspace ID (T...) */
  workspaceId?: string;
  /** Workspace name for display */
  workspaceName?: string;
  /**
   * Authorized Slack user IDs (U...).
   * REQUIRED — fail-closed. Empty array = reject all messages.
   */
  authorizedUserIds: string[];
  /** Audio file transcription provider */
  audioTranscriptionProvider?: 'groq' | 'openai';
  /** Stall detection timeout in minutes (default: 5) */
  stallTimeoutMinutes?: number;
  /** Promise follow-through timeout in minutes (default: 10) */
  promiseTimeoutMinutes?: number;
  /** System channel IDs */
  lifelineChannelId?: string;
  dashboardChannelId?: string;
  /**
   * Message log retention in days (default: 90).
   * Set to 0 for unlimited (not recommended for GDPR compliance).
   */
  logRetentionDays?: number;
  /** Prompt Gate config */
  promptGate?: {
    ownerId?: string;
    relayTimeoutSeconds?: number;
  };
}

// ── Slack API Types ──

export interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  channel: string;
  thread_ts?: string;
  files?: SlackFileInfo[];
  reactions?: Array<{ name: string; users: string[] }>;
  subtype?: string;
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    email?: string;
    image_48?: string;
  };
  tz?: string;
  is_bot?: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_archived: boolean;
  is_private: boolean;
  is_im?: boolean;
  num_members?: number;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  size: number;
  filetype?: string;
}

// ── Socket Mode Types ──

export interface SocketModeEnvelope {
  envelope_id: string;
  type: 'events_api' | 'interactive' | 'slash_commands' | 'disconnect';
  payload: Record<string, unknown>;
  retry_attempt?: number;
  retry_reason?: string;
  accepts_response_payload?: boolean;
}

export interface SocketModeDisconnect {
  type: 'disconnect';
  reason: 'too_many_websockets' | 'refresh_requested' | 'link_disabled' | 'warning';
  debug_info?: Record<string, unknown>;
}

export interface SocketModeConnectionInfo {
  ok: boolean;
  url: string;
  /** Approximate time in seconds the connection has been open */
  approximate_connection_time?: number;
}

// ── Interaction Types ──

export interface InteractionPayload {
  type: 'block_actions' | 'message_action' | 'view_submission';
  user: { id: string; name: string };
  channel?: { id: string; name: string };
  message?: { ts: string; text: string };
  actions?: InteractionAction[];
  trigger_id?: string;
}

export interface InteractionAction {
  action_id: string;
  type: string;
  value?: string;
  text?: { type: string; text: string };
  block_id?: string;
}

// ── Rate Limit Tiers ──

/** Slack API rate limit tiers (requests per minute). */
export enum RateLimitTier {
  /** ~1 req/min — conversations.create, conversations.archive */
  Tier1 = 1,
  /** ~20 req/min — reactions.add, reactions.remove */
  Tier2 = 20,
  /** ~50 req/min — chat.postMessage, conversations.history */
  Tier3 = 50,
  /** ~100 req/min — users.info, auth.test */
  Tier4 = 100,
}

/**
 * Rate limit tier assignment per Slack API method.
 * Methods not listed default to Tier3.
 */
export const SLACK_API_TIERS: Record<string, RateLimitTier> = {
  // Tier 1 — very restricted
  'conversations.create': RateLimitTier.Tier1,
  'conversations.archive': RateLimitTier.Tier1,
  'conversations.unarchive': RateLimitTier.Tier1,
  'conversations.rename': RateLimitTier.Tier1,
  'conversations.setTopic': RateLimitTier.Tier1,
  'conversations.setPurpose': RateLimitTier.Tier1,

  // Tier 2 — moderate
  'reactions.add': RateLimitTier.Tier2,
  'reactions.remove': RateLimitTier.Tier2,
  'pins.add': RateLimitTier.Tier2,
  'pins.remove': RateLimitTier.Tier2,
  'chat.update': RateLimitTier.Tier2,

  // Tier 3 — standard (also the default)
  'chat.postMessage': RateLimitTier.Tier3,
  'chat.postEphemeral': RateLimitTier.Tier3,
  'conversations.history': RateLimitTier.Tier3,
  'conversations.list': RateLimitTier.Tier3,
  'conversations.info': RateLimitTier.Tier3,
  'conversations.members': RateLimitTier.Tier3,
  'files.getUploadURLExternal': RateLimitTier.Tier3,
  'files.completeUploadExternal': RateLimitTier.Tier3,

  // Tier 4 — generous
  'auth.test': RateLimitTier.Tier4,
  'users.info': RateLimitTier.Tier4,
  'users.list': RateLimitTier.Tier4,
  'apps.connections.open': RateLimitTier.Tier4,
};

/** Get the rate limit tier for a Slack API method. Defaults to Tier3. */
export function getTier(method: string): RateLimitTier {
  return SLACK_API_TIERS[method] ?? RateLimitTier.Tier3;
}

// ── Pending Prompt ──

export interface PendingPrompt {
  promptId: string;
  channelId: string;
  messageTs: string;
  createdAt: number;
}
