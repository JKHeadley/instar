/**
 * Slack adapter types — configuration, messages, events, and rate limit tiers.
 */

// ── Configuration ──

/**
 * Workspace mode determines default behaviors:
 * - "dedicated": Workspace created for the agent. Auto-join channels, respond to all messages.
 * - "shared": Pre-existing workspace. Don't auto-join, only respond when @mentioned.
 */
export type SlackWorkspaceMode = 'dedicated' | 'shared';

/**
 * When the agent responds to messages:
 * - "all": Respond to every message in channels the agent is in.
 * - "mention-only": Only respond when @mentioned (or in DMs).
 */
export type SlackRespondMode = 'all' | 'mention-only';

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
  /**
   * Workspace mode — sets defaults for autoJoinChannels and respondMode.
   * "dedicated" (default): auto-join on, respond to all.
   * "shared": no auto-join, mention-only.
   */
  workspaceMode?: SlackWorkspaceMode;
  /**
   * Whether the bot automatically joins new public channels.
   * Default depends on workspaceMode: true for dedicated, false for shared.
   * Requires the channels:join scope.
   */
  autoJoinChannels?: boolean;
  /**
   * When the agent responds to messages in channels.
   * Default depends on workspaceMode: "all" for dedicated, "mention-only" for shared.
   * DMs always use "all" mode regardless of this setting.
   */
  respondMode?: SlackRespondMode;
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
  /**
   * Slack org permission gate (Slice 0). DARK by default — when unset, no gate is
   * attached. `observeOnly: true` logs what the gate WOULD decide for every
   * authorized message without blocking (for FP-rate measurement). `enforce: true`
   * is reserved for a later phase (do not enable before the observed FP-rate is good).
   * See docs/specs/SLACK-ORG-INTEGRATION-SPEC.md.
   */
  permissionGate?: {
    observeOnly?: boolean;
    enforce?: boolean;
  };
  /**
   * Conservative ambient "should I speak?" gate (Slack considered/ambient mode,
   * §5.2). DARK by default — when unset OR `enabledChannelIds` is empty, NO gate is
   * attached and undirected messages are dropped exactly as today (mention-only).
   * The gate runs ONLY for an explicitly-opted-in channel and can only ever make the
   * agent quieter (fail-to-silence). See docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §5.2.
   */
  ambientContribution?: {
    /** Channel IDs (C…) explicitly opted into proactive contribution. Default: none. */
    enabledChannelIds?: string[];
    /** Hard cap on unsolicited messages per channel per window. Conservative default: 1. */
    maxProactivePerChannel?: number;
    /** Rolling rate-limit window in ms. Default: 1800000 (30 min). */
    windowMs?: number;
    /** Conservative confidence floor (0-1) for an LLM "speak" verdict. Default: 0.85. */
    minConfidence?: number;
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
  sessionName?: string;
}
