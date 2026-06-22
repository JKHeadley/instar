/**
 * Telegram Messaging Adapter — send/receive messages via Telegram Bot API.
 *
 * Uses long polling to receive messages. Supports forum topics
 * (each user gets a topic thread). Includes topic-session registry,
 * message logging, voice transcription, photo handling, stall detection,
 * auth gating, and delivery confirmation.
 *
 * No external dependencies — uses native fetch for Telegram API calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MessagingAdapter, Message, OutgoingMessage, UserChannel, IntelligenceProvider, IngressPosition } from '../core/types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { NotificationBatcher, NotificationTier } from './NotificationBatcher.js';
import type { ContentValidationConfig } from './TopicContentValidator.js';
import { validateTopicContent, getTopicPurpose, classifyContent } from './TopicContentValidator.js';
import { SHARED_INFRA_FLAGS } from './shared/FeatureFlags.js';
import { MessageLogger, type LogEntry as SharedLogEntry } from './shared/MessageLogger.js';
import { SessionChannelRegistry } from './shared/SessionChannelRegistry.js';
import { StallDetector, type StallEvent } from './shared/StallDetector.js';
import { CommandRouter } from './shared/CommandRouter.js';
import { AuthGate } from './shared/AuthGate.js';
import { MessagingEventBus } from './shared/MessagingEventBus.js';
import { CallbackRegistry, isAllowedButtonKey } from '../core/CallbackRegistry.js';
import type { DetectedPrompt } from '../monitoring/PromptGate.js';
import { sanitizeForPrompt } from '../monitoring/SessionRecovery.js';
import { formatForTelegram, type FormatMode } from './TelegramMarkdownFormatter.js';
import { readJsonlTailLastLines } from '../utils/jsonl-tail.js';
import {
  recordFormatApplied,
  recordFormatLintIssue,
  recordFormatFallbackPlainRetry,
} from './telegramFormatMetrics.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { stopAutonomousTopic, type AutonomousJournalSeam } from '../core/AutonomousSessions.js';
import { AttentionTopicGuard, TopicFloodBudgetError, type AttentionTopicGuardConfig } from './AttentionTopicGuard.js';

export interface TelegramConfig {
  /** Bot token from @BotFather */
  token: string;
  /** Forum chat ID (the supergroup where topics live) */
  chatId: string;
  /** Polling interval in ms */
  pollIntervalMs?: number;
  /** Authorized Telegram user IDs (only these users' messages are processed) */
  authorizedUserIds?: number[];
  /**
   * Owner principal — the single Telegram user id who controls
   * security-sensitive decisions for this instance (notably the
   * consent gate for Tier-2 relay tunnels — see
   * specs/dev-infrastructure/tunnel-failure-resilience.md).
   *
   * Why a separate field from `authorizedUserIds`: that set is the
   * "who may interact with the bot" allowlist (multiple users may
   * legitimately use the bot for routine interaction), while
   * `ownerUserId` is the principal who alone may approve actions
   * with cross-user security impact (relay activation, credential
   * exposure, etc.). The GPT external review on the tunnel spec
   * specifically flagged that the consent gate must NOT trust the
   * broader authorizedUserIds set.
   *
   * `sendToOwnerDM()` uses this id as the private-chat target.
   * Defaults to `promptGate?.ownerId` for back-compat when unset.
   */
  ownerUserId?: number;
  /** Voice transcription provider: 'groq' or 'openai' (auto-detects if not set) */
  voiceProvider?: string;
  /** Stall detection timeout in minutes (default: 5, 0 to disable) */
  stallTimeoutMinutes?: number;
  /** Promise follow-through timeout in minutes (default: 10, 0 to disable) */
  promiseTimeoutMinutes?: number;
  /** Lifeline topic thread ID — the always-available channel. Auto-recreated if deleted. */
  lifelineTopicId?: number;
  /** Dashboard topic thread ID — auto-broadcasts tunnel URL on startup. */
  dashboardTopicId?: number;
  /** Dashboard PIN (for including in broadcast messages). */
  dashboardPin?: string;
  /** Content validation configuration — validates outbound messages against topic purpose */
  contentValidation?: ContentValidationConfig;
  /** Prompt Gate configuration for Telegram relay */
  promptGate?: {
    /** Telegram user ID of the session owner (only this user can respond to prompts) */
    ownerId?: number;
    /** Timeout in seconds for relay responses (default: 300 = 5 min) */
    relayTimeoutSeconds?: number;
  };
  /**
   * Hot-reloadable accessor for the Telegram format mode. Returning a falsy
   * value or `'legacy-passthrough'` preserves pre-PR2 behavior (byte-for-byte
   * passthrough, caller-supplied parse_mode honored). See
   * docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md.
   */
  getFormatMode?: () => FormatMode | undefined;
  /** Hot-reloadable accessor for lint-strict mode. */
  getLintStrict?: () => boolean | undefined;
  /**
   * Per-source forum-topic circuit breaker. Caps how many NEW topics a single
   * attention `sourceContext` may spawn in a rolling window; past the budget,
   * items coalesce into one running notice topic instead of a wall of topics.
   * Defaults to DEFAULT_ATTENTION_TOPIC_GUARD (enabled) — the 2026-05-28
   * topic-flood lockdown. See AttentionTopicGuard.
   */
  attentionTopicGuard?: Partial<AttentionTopicGuardConfig>;
  /**
   * The LAST-RESORT ceiling on automatic forum-topic creation, enforced INSIDE
   * `createForumTopic` itself — the one place topics are born — so it covers
   * EVERY caller, current and future, regardless of what source labels they
   * pass (the 2026-06-05 flood dodged the attention guard's per-source budget
   * by giving every item a unique sourceContext; only the global ceiling
   * caught it after 8 leaked topics). Origins `user` and `system` are exempt
   * (operator-initiated topics and bounded create-once system topics);
   * everything else — including any caller that doesn't say — is counted.
   * Per-label budget + global ceiling, same engine as the attention guard.
   * Defaults are deliberately LOOSER than the attention guard (this is the
   * backstop, not the shaper): per-label 8, global 12, 10-min window.
   */
  topicCreationBudget?: Partial<AttentionTopicGuardConfig>;
  /**
   * The calm "Agent Health" lane. Routine self-health/housekeeping notices
   * (attention items with `lane:'agent-health'`) are collected into ONE named,
   * low-key topic that never spawns topic-after-topic — the antidote to a feature
   * hijacking Telegram with a wall of "stale but unkillable"-style notices. Only
   * items that explicitly opt in (`lane:'agent-health'`) are affected; every other
   * item is unchanged. Enabled by default; set `enabled:false` for pre-lane
   * behavior.
   */
  agentHealthLane?: {
    enabled?: boolean;
    /** Display name of the lane topic. Default '🩺 Agent Health'. */
    topicName?: string;
    /** Bounded ring of recently-seen entity keys (memory cap). Default 256. */
    maxTrackedKeys?: number;
    /** Suppress a same-key re-escalation posted within this window. Default 30 min. */
    dedupWindowMs?: number;
  };
}

/** Tracks a pending text reply for a Prompt Gate relay (no-button prompts) */
interface PendingPromptReply {
  prompt: DetectedPrompt;
  relayMessageId: number;
  createdAt: number;
  reminderSent?: boolean;
}

export interface SendResult {
  /** Telegram message ID */
  messageId: number;
  /** Topic the message was sent to */
  topicId?: number;
}

export interface DashboardBroadcastResult {
  /** Whether an existing pinned dashboard message was edited instead of posting a new one. */
  edited: boolean;
  /** Telegram message ID when a new dashboard message was posted. */
  messageId?: number;
  /** Non-fatal follow-up failures after the message was delivered. */
  warnings: string[];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    // `is_bot` distinguishes a bot-sent message from a human user typing the same text —
    // the structural half of the a2a spoof defense (a human typing an [a2a:…] marker has
    // is_bot:false). `sender_chat` is present for group bot-as-channel relays.
    from: { id: number; first_name: string; username?: string; is_bot?: boolean };
    sender_chat?: { id: number; type?: string; username?: string };
    chat: { id: number };
    message_thread_id?: number;
    text?: string;
    date: number;
    reply_to_message?: {
      message_id: number;
      forum_topic_created?: { name: string };
    };
    voice?: {
      file_id: string;
      file_unique_id: string;
      duration: number;
      mime_type?: string;
      file_size?: number;
    };
    photo?: Array<{
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    caption?: string;
    document?: {
      file_id: string;
      file_unique_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    forum_topic_created?: { name: string };
    forum_topic_edited?: { name?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      message_thread_id?: number;
    };
    data?: string;
  };
}

interface LogEntry {
  messageId: number;
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
  senderUsername?: string;
  telegramUserId?: number;
}

/**
 * Pre-dispatch hook for the agent-to-agent Telegram comms primitive. Adapter calls this
 * BEFORE normal onTopicMessage / this.handler dispatch on text messages. Returns
 * {handled:true} → dispatch is skipped (hook routed or dropped the a2a event);
 * {handled:false} → fall through to normal user flow. Spec: MENTOR-LIVE-READINESS §Fix 2b.
 */
export interface AgentMessageHookInput {
  /** Raw message text (the body the marker parser inspects). */
  text: string;
  /** Telegram topic id (or GENERAL_TOPIC_ID fallback). */
  topicId: number;
  /** msg.from.is_bot (per Telegram's update shape). False for human users — the structural
   *  half of the a2a spoof defense. */
  senderIsBot: boolean;
  /** msg.sender_chat.id (when present — group bot-as-channel relay). */
  senderChatId?: string;
  /** Effective bot identity: sender_chat.id ?? from.id, stringified. */
  senderBotId?: string;
  /** Wall-clock now (ms) — passed in for testability. */
  now: number;
}

export type AgentMessageHook = (input: AgentMessageHookInput) => Promise<{ handled: boolean }>;

export interface AttentionItem {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'DONE' | 'WONT_DO';
  sourceContext?: string;
  createdAt: string;
  updatedAt: string;
  topicId?: number;
  /**
   * True when the topic-flood guard coalesced this item into a shared "notices
   * coalesced" topic instead of giving it its own. Such items are NOT registered
   * in the per-item topic maps and are managed via /attention (PATCH / dashboard),
   * not per-topic /ack — so resolving one never closes the shared notice topic.
   */
  coalesced?: boolean;
  /**
   * Routing lane. When `'agent-health'`, this is a routine SELF-HEALTH /
   * housekeeping notice about the agent's OWN internal state (a stale-looking
   * session, a peer it can't reach, etc.) rather than something the USER must act
   * on. Such items are routed into ONE calm, persistently-named "🩺 Agent Health"
   * topic from the very first item — they never spawn their own per-item topic
   * (even under budget, even if mis-tagged HIGH), and same-entity re-escalations
   * are suppression-deduped so the lane stays quiet. Absent ⇒ today's behavior.
   */
  lane?: 'agent-health';
  /**
   * Stable per-entity key for Agent-Health-lane suppression dedup (e.g. a session
   * id). Decoupled from `id` (which may carry a per-episode suffix) so the same
   * entity re-escalating within the dedup window is suppressed rather than
   * reposted. Falls back to `sourceContext`, then `id`, when unset.
   */
  healthKey?: string;
  /** WS4.1 (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.1): the machine this item
   *  belongs to. Stamped at read time in GET /attention (the store stays
   *  machine-agnostic); absent on a single-machine install. */
  machineId?: string;
  /** Display nickname of `machineId`, resolved from the pool registry at read
   *  time. */
  machineNickname?: string;
}

/**
 * Telegram General topic convention:
 * - Incoming: messages in General have message_thread_id=1 (or undefined in older API)
 * - Internal: we use GENERAL_TOPIC_ID (1) as the sentinel
 * - Outgoing: we OMIT message_thread_id for General (don't send 1, don't send 0)
 *
 * The isGeneralTopic() helper should be used instead of raw `topicId === 1` checks
 * to keep the convention in one place.
 */
const GENERAL_TOPIC_ID = 1;

function isGeneralTopic(topicId: number): boolean {
  return topicId <= GENERAL_TOPIC_ID;
}

const PRIORITY_EMOJI: Record<string, string> = {
  URGENT: '\ud83d\udd34',  // 🔴
  HIGH: '\ud83d\udfe0',     // 🟠
  NORMAL: '\ud83d\udd35',   // 🔵
  LOW: '\u26aa',             // ⚪
};

const PRIORITY_COLOR: Record<string, number> = {
  URGENT: 16478047,   // red
  HIGH: 16749490,     // orange
  NORMAL: 7322096,    // blue
  LOW: 13338331,      // purple
};

/**
 * Standard topic styles for visual organization in Telegram forum.
 * Colors are the 6 values Telegram's Bot API accepts for icon_color.
 * Emojis prefix topic names for at-a-glance scanning.
 */
export const TOPIC_STYLE = {
  /** Green — core infrastructure (Lifeline) */
  SYSTEM:  { color: 9367192,  emoji: '🛡️' },
  /** Purple — automated recurring jobs */
  JOB:     { color: 13338331, emoji: '⚙️' },
  /** Green — interactive user sessions */
  SESSION: { color: 9367192,  emoji: '💬' },
  /** Blue — informational (Dashboard, Updates) */
  INFO:    { color: 7322096,  emoji: '📢' },
  /** Yellow — needs user attention */
  ALERT:   { color: 16766590, emoji: '🔔' },
} as const;

/**
 * Keyword → emoji mapping for smart topic emoji selection.
 * First match wins, so more specific patterns come first.
 * Falls back to 💬 for unmatched names.
 */
const TOPIC_EMOJI_KEYWORDS: Array<{ keywords: string[]; emoji: string }> = [
  { keywords: ['debug', 'bug', 'fix', 'issue', 'error'],   emoji: '🐛' },
  { keywords: ['deploy', 'release', 'ship', 'launch'],      emoji: '🚀' },
  { keywords: ['test', 'testing', 'qa', 'cypress', 'jest'], emoji: '🧪' },
  { keywords: ['review', 'pr', 'code review'],              emoji: '👀' },
  { keywords: ['research', 'explore', 'investigate'],        emoji: '🔍' },
  { keywords: ['design', 'ui', 'ux', 'frontend', 'css'],    emoji: '🎨' },
  { keywords: ['doc', 'docs', 'readme', 'write', 'draft'],  emoji: '📝' },
  { keywords: ['build', 'ci', 'pipeline', 'compile'],       emoji: '🏗️' },
  { keywords: ['security', 'auth', 'permission', 'access'], emoji: '🔒' },
  { keywords: ['perf', 'performance', 'speed', 'optimize'],  emoji: '⚡' },
  { keywords: ['data', 'database', 'db', 'sql', 'prisma'],  emoji: '🗄️' },
  { keywords: ['api', 'endpoint', 'route', 'server'],       emoji: '🔌' },
  { keywords: ['monitor', 'metric', 'observ', 'dashboard'], emoji: '📊' },
  { keywords: ['alert', 'incident', 'urgent', 'critical'],  emoji: '🚨' },
  { keywords: ['brainstorm', 'idea', 'think', 'plan'],      emoji: '💡' },
  { keywords: ['migrate', 'migration', 'upgrade'],          emoji: '🔄' },
  { keywords: ['config', 'setting', 'env'],                 emoji: '⚙️' },
  { keywords: ['email', 'mail', 'newsletter', 'outreach'],  emoji: '📧' },
  { keywords: ['chat', 'talk', 'conversation', 'discuss'],  emoji: '💬' },
  { keywords: ['learn', 'study', 'tutorial', 'course'],     emoji: '📚' },
  { keywords: ['money', 'payment', 'billing', 'cost'],      emoji: '💰' },
  { keywords: ['clean', 'cleanup', 'refactor', 'tidy'],     emoji: '🧹' },
];

/**
 * Select an appropriate emoji for a topic based on its name.
 * Matches keywords case-insensitively. Falls back to 💬 for unmatched names.
 */
export function selectTopicEmoji(topicName: string): string {
  const lower = topicName.toLowerCase();
  for (const entry of TOPIC_EMOJI_KEYWORDS) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return entry.emoji;
    }
  }
  return TOPIC_STYLE.SESSION.emoji; // 💬 default
}

/** Tracks a pending message for stall detection */
interface PendingMessage {
  topicId: number;
  sessionName: string;
  messageText: string;
  injectedAt: number; // Date.now()
  alerted: boolean;
}

/** Tracks an agent promise that expects follow-through */
interface PendingPromise {
  topicId: number;
  sessionName: string;
  promiseText: string;
  promisedAt: number;
  alerted: boolean;
}

export class TelegramAdapter implements MessagingAdapter {
  readonly platform = 'telegram';

  private config: TelegramConfig;
  private handler: ((message: Message) => Promise<void>) | null = null;
  private polling = false;

  /** True when this adapter is actively polling for messages (false in send-only mode). */
  get isPolling(): boolean { return this.polling; }
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;
  private startedAt: Date | null = null;
  private consecutivePollErrors = 0;
  // Diagnostics surfaced via getStatus() so health probes can explain WHY polling stopped.
  private lastPollError: string | null = null;
  private fatalPollReason: '401' | 'network' | 'no-usable-bot-token' | null = null;
  private pollStoppedAt: Date | null = null;
  private pending401Retry = false;

  // Forum detection — if the chat is not a forum, skip all topic operations
  private notAForum = false;
  private notAForumWarned = false;

  // Topic-session registry (persisted to disk)
  private topicToSession: Map<number, string> = new Map();
  private sessionToTopic: Map<string, number> = new Map();
  private topicToName: Map<number, string> = new Map();
  private topicToPurpose: Map<number, string> = new Map();
  private registryPath: string;
  private messageLogPath: string;
  private offsetPath: string;
  private stateDir: string;
  /** Per-bot state root. Equals stateDir for the primary bot; a namespaced sub-dir for
   *  non-primary adapters (multi-instance isolation — spec MENTOR-LIVE-READINESS §Fix 2b).
   *  Only the per-bot state files (registry/messages/offset/attention) live here; shared
   *  config lookups stay on stateDir. */
  private botStateDir: string;
  /** When true, start() skips ensureLifelineTopic() — a non-primary bot must not create a
   *  second Lifeline topic in the chat. */
  private suppressLifelineAutoCreate: boolean;
  /** Pre-dispatch hook for the agent-to-agent Telegram comms primitive (spec
   *  MENTOR-LIVE-READINESS §Fix 2b). When set, the text-dispatch path calls this BEFORE
   *  onTopicMessage / this.handler. If it returns {handled:true}, normal dispatch is
   *  skipped (the hook routed the message to a role-handler OR dropped it as an a2a
   *  security event). If {handled:false}, normal user flow continues. Other message types
   *  (voice/photo/document) cannot carry the [a2a:…] marker and bypass the hook.
   *  See installAgentMessageHook for the production binding. */
  private agentMessageHook?: AgentMessageHook;
  /** Optional coherence-journal seam (COHERENCE-JOURNAL-SPEC §3.3). The adapter
   *  holds no StateManager, so the emergency-stop path's stopAutonomousTopic call
   *  cannot reach the wired journal on its own. server.ts injects this seam so the
   *  sentinel emergency-stop emits the autonomous-run `stopped` event like every
   *  other stop funnel. Undefined → the stop stays silent (best-effort, never blocks). */
  private coherenceJournalSeam?: AutonomousJournalSeam;

  // Attention queue (persisted to disk)
  private attentionItemToTopic: Map<string, number> = new Map();
  private attentionTopicToItem: Map<number, string> = new Map();
  private attentionItems: Map<string, AttentionItem> = new Map();
  private attentionFilePath: string;
  // Per-source forum-topic circuit breaker (2026-05-28 topic-flood lockdown).
  private attentionTopicGuard!: AttentionTopicGuard;
  // LAST-RESORT auto-topic ceiling enforced inside createForumTopic itself
  // (2026-06-05 flood lesson — covers every caller, not just attention items).
  private topicCreationGuard!: AttentionTopicGuard;
  // bucket -> the single reused "notices coalesced" topic for that bucket.
  private floodNoticeTopicByBucket: Map<string, number> = new Map();
  // bucket -> in-flight createForumTopic promise, so concurrent coalesced items
  // for one bucket share ONE topic creation (no double-create race).
  private floodNoticePending: Map<string, Promise<number | null>> = new Map();
  private attentionSuppressedLogPath!: string;
  // ── Agent-Health lane (the calm self-health notice lane) ──────────────────
  /** Resolved lane config (defaults applied in the constructor). */
  private agentHealthLaneCfg!: { enabled: boolean; topicName: string; maxTrackedKeys: number; dedupWindowMs: number };
  /** The single reused lane topic id (created lazily, once). */
  private agentHealthTopicId: number | null = null;
  /** In-flight single creation guard (no double-create race). */
  private agentHealthPending: Promise<number | null> | null = null;
  /** entity key -> last-posted epoch ms (suppression-dedup ring, insertion-ordered). */
  private agentHealthKeyRing: Map<string, number> = new Map();

  // Stall detection
  private pendingMessages: Map<string, PendingMessage> = new Map(); // key = topicId-timestamp
  private stallCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Promise tracking (agent said "give me a minute" but hasn't followed up)
  private pendingPromises: Map<number, PendingPromise> = new Map(); // key = topicId

  // Topic message callback — fires on every incoming topic message
  public onTopicMessage: ((message: Message) => void | Promise<void>) | null = null;

  // Session management callbacks (wired by server.ts)
  public onInterruptSession: ((sessionName: string) => Promise<boolean>) | null = null;
  public onRestartSession: ((sessionName: string, topicId: number) => Promise<void>) | null = null;
  public onListSessions: (() => Array<{ name: string; tmuxSession: string; status: string; alive: boolean }>) | null = null;
  public onIsSessionAlive: ((tmuxSession: string) => boolean) | null = null;
  public onIsSessionActive: ((tmuxSession: string) => Promise<boolean>) | null = null;

  /**
   * Route-command handler. Called when a user posts `/route <framework>`
   * in a topic. The handler is responsible for persisting the new
   * framework binding and triggering a respawn of the topic's session.
   * Returns a short status string for the adapter to echo back to the
   * topic, or null on failure.
   */
  public onRouteCommand: (
    // TOPIC-PROFILE-SPEC §10.1: the authenticated sender uid is FORWARDED to
    // the handler (the legacy dispatch dropped it) — the profile store stamps
    // updatedBy from it and refuses a non-bound-operator.
    (topicId: number, framework: string | null, userId?: number) => Promise<{ ok: boolean; message: string }>
  ) | null = null;

  /**
   * Topic Profile command handler (TOPIC-PROFILE-SPEC §10.1 — the /topic
   * power-user surface; the conversational surface is PRIMARY). Receives the
   * raw argument text plus the AUTHENTICATED sender uid (`msg.from.id`).
   */
  public onTopicProfileCommand: (
    (topicId: number, argText: string, userId: number) => Promise<{ ok: boolean; message: string }>
  ) | null = null;

  /**
   * Local-model command handler. Called when a user posts
   * `/local-model <provider> [model]` (or `/local-model off`) in a
   * topic. The handler validates the provider/model is reachable,
   * persists the per-topic local-model binding, and triggers a
   * respawn so the new session spawns under Codex --oss
   * --local-provider <provider>.
   *
   * Conversational counterpart of editing config.json — Justin's
   * "every config change reachable via Telegram" rule.
   *
   * - provider = null + model = null → "show status" (no mutation).
   * - provider = 'off' / 'none' → clear the topic's override (revert
   *   to cloud Codex).
   */
  public onLocalModelCommand: (
    (topicId: number, provider: string | null, model: string | null) => Promise<{ ok: boolean; message: string }>
  ) | null = null;

  // Message log callback — fires on every message logged (inbound and outbound).
  // Used by TopicMemory to dual-write to SQLite for search and summarization.
  // Includes sender identity fields (Phase 1C/1D — User-Agent Topology Spec).
  public onMessageLogged: ((entry: { messageId: number; topicId: number | null; text: string; fromUser: boolean; timestamp: string; sessionName: string | null; senderName?: string; senderUsername?: string; telegramUserId?: number }) => void) | null = null;
  /**
   * Outbound relay for a TOKENLESS standby (bug #7). When this adapter has no bot
   * token — a multi-machine pool standby serving a session moved to it — it cannot
   * call the Telegram API directly. If this is wired, sendToTopic routes the send
   * through it (the server wires it to POST the Telegram-OWNING router's
   * /telegram/reply/:topicId), so a moved session's replies reach the user without
   * the standby ever polling/sending on the shared bot (preserving the single-owner
   * invariant that avoids the 409-poller-conflict incident). Returns the sent
   * message's SendResult, or null if the relay could not deliver.
   */
  public outboundRelay: ((topicId: number, text: string, options?: { silent?: boolean; kindMetadata?: Record<string, unknown> }) => Promise<SendResult | null>) | null = null;

  /**
   * True when a `sendToTopic` will RELAY through the lease holder rather than
   * send directly — i.e. this is a tokenless pool standby with `outboundRelay`
   * wired. Mirrors the exact `sendToTopic` branch condition (no usable string
   * bot token + a relay available). Callers use this to skip work the HOLDER
   * will do anyway: e.g. the `/telegram/reply` route skips its LOCAL tone gate
   * for a relayed reply, because (a) the reply is already the agent's finalized
   * output, (b) the Telegram-owning holder runs ITS tone gate on receipt, and
   * (c) running the standby's tone gate adds a serial LLM call to every
   * cross-machine reply — which, under a rate-limited circuit, waits up to
   * `MessagingToneGate` rateLimitWaitMs (120s) BEFORE the relay even starts.
   * That double-gate + pre-relay stall is a real robustness defect on the
   * standby reply path.
   */
  willRelay(): boolean {
    const hasUsableBotToken = typeof this.config.token === 'string' && this.config.token.length > 0;
    return !hasUsableBotToken && this.outboundRelay !== null;
  }

  // Sentinel interceptor — fires BEFORE the message handler for real-time interrupt detection.
  // Returns the sentinel classification. If category is 'emergency-stop' or 'pause',
  // the adapter will handle the session action and skip the normal handler.
  public onSentinelIntercept: ((message: string, topicId: number) => Promise<{
    category: 'emergency-stop' | 'pause' | 'redirect' | 'normal';
    action: { type: string; message?: string };
    reason?: string;
  } | null>) | null = null;

  // Session kill/pause callbacks — used by sentinel to take immediate action
  public onSentinelKillSession: ((sessionName: string) => boolean) | null = null;
  /** Durable Inbound Message Queue §3.6: settle a stopped topic's queued
   *  custody (terminal operator-stop + PIS cleanup + loss report). Wired by
   *  the server when the queue engine is live; null = no queue, no-op. */
  public onSentinelStopCustody: ((topicId: number) => void) | null = null;
  public onSentinelPauseSession: ((sessionName: string) => void) | null = null;

  // Attention queue callbacks
  public onAttentionStatusChange: ((itemId: string, status: string) => Promise<void>) | null = null;

  // Quota management callbacks
  public onSwitchAccountRequest: ((target: string, replyTopicId: number) => Promise<void>) | null = null;
  public onQuotaStatusRequest: ((replyTopicId: number) => Promise<void>) | null = null;
  public onLoginRequest: ((email: string | null, replyTopicId: number) => Promise<void>) | null = null;
  public onClassifySessionDeath: ((sessionName: string) => Promise<{ cause: string; detail: string } | null>) | null = null;
  /** LLM-powered stall triage — called instead of generic stall alert when set */
  public onStallDetected: ((topicId: number, sessionName: string, messageText: string, injectedAt: number) => Promise<{ resolved: boolean }>) | null = null;
  /** Get triage status for a topic — returns null if no active triage, or status summary */
  public onGetTriageStatus: ((topicId: number) => { active: boolean; classification?: string; checkCount: number; lastCheck?: string } | null) | null = null;

  // Unknown user handling callbacks (Multi-User Setup Wizard Phase 4.5)
  // Returns the registration policy and optional contact hint for the gated message
  public onGetRegistrationPolicy: (() => { policy: string; contactHint?: string; agentName?: string }) | null = null;
  // Called when an admin-only join request is created (notify admin via lifeline/admin topic)
  public onNotifyAdminJoinRequest: ((request: { name: string; username?: string; telegramUserId: number }) => Promise<void>) | null = null;
  // Called to validate an invite code for invite-only policy
  public onValidateInviteCode: ((code: string, telegramUserId: number) => Promise<{ valid: boolean; error?: string }>) | null = null;
  // Called to start mini-onboarding for open policy
  public onStartMiniOnboarding: ((telegramUserId: number, firstName: string, username?: string) => Promise<void>) | null = null;

  // Rate limiting for unknown user responses (prevent spam)
  private unknownUserRateLimit: Map<number, number> = new Map(); // telegramUserId -> last response timestamp
  private static readonly UNKNOWN_USER_COOLDOWN_MS = 60_000; // 1 minute between responses to same unknown user

  // Notification batching
  private batcher: NotificationBatcher | null = null;

  // Intelligence provider — gates fallback stall/promise alerts behind LLM confirmation.
  // Without this, fallback alerts fire purely from timers when StallTriageNurse is unavailable.
  public intelligence: IntelligenceProvider | null = null;

  // Flush notifications callback — fires when user sends /flush
  public onFlushNotifications: ((replyTopicId: number) => Promise<void>) | null = null;

  // Prompt Gate — relay prompts to Telegram and handle responses
  private callbackRegistry: CallbackRegistry;
  private pendingPromptReply = new Map<number, PendingPromptReply>(); // topicId → pending
  private promptGateDisclosureSent = new Set<number>(); // topicIds that have seen the disclosure

  /**
   * Tunnel-consent callback handler. Registered by TunnelManager via
   * `setTunnelConsentHandler`. Receives the parsed action ('grant' |
   * 'decline') + the nonce; returns a short status string for the
   * answerCallbackQuery toast. The owner-principal check happens in
   * processCallbackQuery BEFORE this is invoked, so the handler can
   * trust the click came from the owner.
   */
  private tunnelConsentHandler: ((action: 'grant' | 'decline', nonce: string) => Promise<string>) | null = null;
  /**
   * UNIFIED-SESSION-LIFECYCLE bonus — fired when a Telegram forum topic is
   * renamed. Wired in server.ts to update the bound session's display name
   * (display `name` only — never the tmuxSession key or id). Fire-and-forget.
   */
  private topicRenamedHandler: ((topicId: number, newName: string) => void | Promise<void>) | null = null;

  /** Wire the tunnel-consent callback handler (called by TunnelManager). */
  setTunnelConsentHandler(fn: ((action: 'grant' | 'decline', nonce: string) => Promise<string>) | null): void {
    this.tunnelConsentHandler = fn;
  }

  /**
   * Wire the topic-renamed callback (UNIFIED-SESSION-LIFECYCLE bonus). Fires
   * fire-and-forget when a Telegram forum topic is renamed; consumers update
   * the bound session's display `name` only (never the tmuxSession key or id).
   */
  setTopicRenamedHandler(fn: ((topicId: number, newName: string) => void | Promise<void>) | null): void {
    this.topicRenamedHandler = fn;
  }

  /**
   * Send a consent prompt to the owner DM with two inline buttons
   * (approve / decline). The buttons carry callback_data of the form
   * `tc:g:<nonce>` / `tc:d:<nonce>` (well under Telegram's 64-byte
   * callback_data limit — `tc:g:` is 5 chars + a 32-hex nonce = 37).
   * Returns the message id on success, null on failure (no owner,
   * owner hasn't DM'd the bot, network error) — fire-and-forget.
   */
  async sendOwnerConsentPrompt(text: string, nonce: string): Promise<number | null> {
    const owner = this.getOwnerUserId();
    if (!owner) {
      console.warn('[telegram] sendOwnerConsentPrompt called but no ownerUserId is configured');
      return null;
    }
    try {
      const result = await this.apiCall('sendMessage', {
        chat_id: owner,
        text,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Yes, use a backup', callback_data: `tc:g:${nonce}` },
            { text: 'No, keep waiting', callback_data: `tc:d:${nonce}` },
          ]],
        },
      }) as { message_id: number };
      return result.message_id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[telegram] sendOwnerConsentPrompt failed: ${msg}`);
      return null;
    }
  }

  /** Callback to inject a response into a tmux session. Wired by server.ts. */
  public onPromptResponse: ((sessionName: string, key: string) => boolean) | null = null;
  /** Callback to inject text input into a tmux session. Wired by server.ts. */
  public onPromptTextResponse: ((sessionName: string, text: string) => boolean) | null = null;
  /** Callback when relay lease should extend idle timeout for a session */
  public onRelayLeaseStart: ((sessionName: string) => void) | null = null;
  /** Callback when relay lease is released (response received or timeout) */
  public onRelayLeaseEnd: ((sessionName: string) => void) | null = null;

  /**
   * Per-topic monotonic content version — bumped on every message logged for the
   * topic. The live-tail streamer polls this (getTopicContentVersion) as its
   * cheap change-detector: an unchanged version means the topic's tail content
   * is byte-identical, so the streamer skips serializing it entirely (the
   * 2026-06-05 event-loop-stall fix — building every topic's history every tick
   * blocked the loop for seconds).
   */
  private topicContentVersion = new Map<number, number>();
  /**
   * In-memory recent-tail cache backing getTopicHistory — seeded lazily from the
   * JSONL on a topic's first read, then maintained on every append. Bounds the
   * cost of repeated history reads to O(limit) instead of a full synchronous
   * re-read of the (up to 75k-line) message log per call. Holds the most recent
   * TAIL_CACHE_LIMIT entries per topic, which covers every production caller
   * (live-tail + handoff hash use 500, respawn history far less). Log rotation
   * is irrelevant to it — rotation only drops OLD lines, and the cache only
   * holds the newest.
   */
  private topicTailCache = new Map<number, LogEntry[]>();
  /** One-time batch seed done (all live topics seeded in a single file pass). */
  private tailCacheSeeded = false;
  private static readonly TAIL_CACHE_LIMIT = 500;

  // Shared infrastructure modules (Phase 1 extraction)
  private sharedLogger: MessageLogger | null = null;
  private sharedRegistry: SessionChannelRegistry | null = null;
  private sharedStallDetector: StallDetector | null = null;
  private sharedCommandRouter: CommandRouter | null = null;
  private sharedAuthGate: AuthGate | null = null;
  private eventBus: MessagingEventBus | null = null;

  /** Get the event bus for external subscribers (Phase 1e). Returns null if flag is off. */
  getEventBus(): MessagingEventBus | null {
    return this.eventBus;
  }

  constructor(
    config: TelegramConfig,
    stateDir: string,
    opts?: { subDir?: string; suppressLifelineAutoCreate?: boolean },
  ) {
    if (config.chatId && !/^-?\d+$/.test(String(config.chatId))) {
      throw new Error(
        `Invalid Telegram chatId "${config.chatId}". Chat IDs must be numeric (e.g., -1001234567890). ` +
        `Update messaging.config.chatId in your instar.config.json with a valid numeric ID.`,
      );
    }
    // HARDENED (v1.3.270 boot-crash incident): when the secrets merge fails, the
    // externalized token arrives as the truthy `{ secret: true }` placeholder OBJECT.
    // Polling with it stringified into the bot URL 404-zombies forever. Normalize a
    // non-string token to '' — the well-defined TOKENLESS state every guard in this
    // adapter already handles (standby/relay) — and say so loudly.
    if (config.token != null && typeof config.token !== 'string') {
      console.warn(
        '[telegram] Bot token is not a string (unresolved secret placeholder — secret store unavailable at boot?). ' +
        'Running TOKENLESS this boot: no polling, sends only via relay if available. A restart after the secret store recovers restores full service.',
      );
      config = { ...config, token: '' };
    }
    this.config = config;
    this.stateDir = stateDir;
    this.suppressLifelineAutoCreate = opts?.suppressLifelineAutoCreate ?? false;
    // Multi-instance isolation: a non-primary adapter (e.g. the mentor bot) namespaces its
    // per-bot state under {stateDir}/{subDir}/ so two adapters never clobber each other's
    // poll-offset / registry / message-log / attention files (the reviewer-flagged
    // collision that makes poll()'s cross-token detection fire continuously). The PRIMARY
    // bot passes no subDir → botStateDir === stateDir → paths are byte-for-byte unchanged.
    this.botStateDir = opts?.subDir ? path.join(stateDir, opts.subDir) : stateDir;
    if (opts?.subDir) {
      fs.mkdirSync(this.botStateDir, { recursive: true });
    }
    this.registryPath = path.join(this.botStateDir, 'topic-session-registry.json');
    this.messageLogPath = path.join(this.botStateDir, 'telegram-messages.jsonl');
    this.offsetPath = path.join(this.botStateDir, 'telegram-poll-offset.json');
    this.attentionFilePath = path.join(this.botStateDir, 'state', 'attention-items.json');
    this.attentionSuppressedLogPath = path.join(this.botStateDir, 'state', 'attention-suppressed.jsonl');
    this.attentionTopicGuard = new AttentionTopicGuard(config.attentionTopicGuard ?? {});
    // Backstop ceiling: looser than the attention guard by design (the
    // attention guard SHAPES politely per-source; this is the absolute bound
    // a mis-wired or future caller cannot dodge). Config can tighten/loosen.
    this.topicCreationGuard = new AttentionTopicGuard({
      windowMs: 10 * 60 * 1000,
      maxTopicsPerSource: 8,
      maxTopicsGlobal: 12,
      ...(config.topicCreationBudget ?? {}),
    });
    const alc = config.agentHealthLane ?? {};
    this.agentHealthLaneCfg = {
      enabled: alc.enabled !== false,
      topicName: (typeof alc.topicName === 'string' && alc.topicName.trim()) ? alc.topicName : '🩺 Agent Health',
      maxTrackedKeys: Number.isFinite(alc.maxTrackedKeys) && (alc.maxTrackedKeys as number) > 0 ? Math.floor(alc.maxTrackedKeys as number) : 256,
      dedupWindowMs: Number.isFinite(alc.dedupWindowMs) && (alc.dedupWindowMs as number) > 0 ? (alc.dedupWindowMs as number) : 30 * 60 * 1000,
    };
    this.loadRegistry();
    this.loadOffset();
    this.loadAttentionItems();

    // Initialize Prompt Gate callback registry
    const relayTimeoutMs = (config.promptGate?.relayTimeoutSeconds ?? 300) * 1000;
    this.callbackRegistry = new CallbackRegistry({
      maxEntries: 500,
      maxAgeMs: relayTimeoutMs,
      pruneIntervalMs: 60_000,
    });
    this.callbackRegistry.start();

    // Initialize shared modules when feature flags are enabled
    if (SHARED_INFRA_FLAGS.useSharedMessageLogger) {
      this.sharedLogger = new MessageLogger({ logPath: this.messageLogPath });
    }
    if (SHARED_INFRA_FLAGS.useSharedStallDetector) {
      this.sharedStallDetector = new StallDetector({
        stallTimeoutMinutes: config.stallTimeoutMinutes,
        promiseTimeoutMinutes: config.promiseTimeoutMinutes,
      });
    }
    if (SHARED_INFRA_FLAGS.useSharedCommandRouter) {
      this.sharedCommandRouter = new CommandRouter('telegram');
      this.registerSharedCommands();
    }
    if (SHARED_INFRA_FLAGS.useSharedAuthGate) {
      this.sharedAuthGate = new AuthGate({
        authorizedUsers: (config.authorizedUserIds ?? []).map(id => id.toString()),
      });
    }
    if (SHARED_INFRA_FLAGS.useEventEmitterPattern) {
      this.eventBus = new MessagingEventBus('telegram');
    }
  }

  /**
   * Register all Telegram commands with the shared CommandRouter (Phase 1a).
   * Each command delegates back to the existing handler logic.
   */
  private registerSharedCommands(): void {
    if (!this.sharedCommandRouter) return;

    // Attention topic interceptor
    this.sharedCommandRouter.addInterceptor(async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      if (this.isAttentionTopic(topicId)) {
        return this.handleAttentionCommand(topicId, ctx.rawText);
      }
      return false;
    });

    this.sharedCommandRouter.register('flush', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      if (this.batcher && this.batcher.isEnabled()) {
        const flushed = await this.batcher.flushAll();
        if (flushed > 0) {
          await this.sendToTopic(topicId, `Flushed ${flushed} batched notification${flushed === 1 ? '' : 's'}.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, 'No batched notifications to flush.').catch(() => {});
        }
      } else if (this.onFlushNotifications) {
        this.onFlushNotifications(topicId).catch(err => {
          console.error('[telegram] Flush notifications failed:', err);
          this.sendToTopic(topicId, 'Failed to flush notifications.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Notification batching is not enabled.').catch(() => {});
      }
      return true;
    }, { description: 'Flush batched notifications' });

    this.sharedCommandRouter.register('sessions', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const filterUnclaimed = ctx.args.includes('unclaimed');
      if (!this.onListSessions) {
        await this.sendToTopic(topicId, 'Session listing not available.').catch(() => {});
        return true;
      }
      const sessions = this.onListSessions();
      if (sessions.length === 0) {
        await this.sendToTopic(topicId, 'No sessions running.').catch(() => {});
        return true;
      }
      const lines: string[] = [];
      for (const s of sessions) {
        const linkedTopic = this.getTopicForSession(s.tmuxSession);
        const claimed = linkedTopic !== null;
        if (filterUnclaimed && claimed) continue;
        const status = s.alive ? '\u2705' : '\u274c';
        const claimTag = claimed ? ` (topic ${linkedTopic})` : ' \u{1f7e1} unclaimed';
        lines.push(`${status} ${s.name}${claimTag}`);
      }
      if (lines.length === 0) {
        await this.sendToTopic(topicId, filterUnclaimed ? 'No unclaimed sessions.' : 'No sessions.').catch(() => {});
      } else {
        await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      }
      return true;
    }, { description: 'List sessions', platforms: ['telegram'] });

    this.sharedCommandRouter.register(['claim', 'link'], async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const sessionName = ctx.args;
      if (!sessionName) {
        await this.sendToTopic(topicId, `Please include a session name — e.g. /${ctx.command} my-session`).catch(() => {});
        return true;
      }
      const existingSession = this.getSessionForTopic(topicId);
      if (existingSession) {
        await this.sendToTopic(topicId, `This topic is already linked to "${existingSession}". Use /unlink first.`).catch(() => {});
        return true;
      }
      this.registerTopicSession(topicId, sessionName);
      const verb = ctx.command === 'claim' ? 'Claimed' : 'Linked';
      await this.sendToTopic(topicId, `${verb} session "${sessionName}" ${ctx.command === 'claim' ? 'into' : 'to'} this topic.`).catch(() => {});
      return true;
    }, { description: 'Link a session to this topic', platforms: ['telegram'] });

    this.sharedCommandRouter.register('unlink', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }
      this.unregisterTopic(topicId);
      await this.sendToTopic(topicId, `Unlinked session "${sessionName}" from this topic.`).catch(() => {});
      return true;
    }, { description: 'Unlink session from topic', platforms: ['telegram'] });

    this.sharedCommandRouter.register('interrupt', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }
      if (!this.onInterruptSession) {
        await this.sendToTopic(topicId, 'Interrupt not available (no handler registered).').catch(() => {});
        return true;
      }
      try {
        const success = await this.onInterruptSession(sessionName);
        this.clearStallForTopic(topicId);
        if (success) {
          await this.sendToTopic(topicId, `Nudged "${sessionName}" \u2014 it should resume shortly.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, `Failed to interrupt "${sessionName}" \u2014 session may not exist.`).catch(() => {});
        }
      } catch (err) {
        console.error(`[telegram] Interrupt failed:`, err);
        await this.sendToTopic(topicId, 'Couldn\'t interrupt the session. It may have already ended.').catch(() => {});
      }
      return true;
    }, { description: 'Send Escape to unstick a stalled session' });

    this.sharedCommandRouter.register('restart', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }
      if (!this.onRestartSession) {
        await this.sendToTopic(topicId, 'Restart not available (no handler registered).').catch(() => {});
        return true;
      }
      this.clearStallForTopic(topicId);
      await this.sendToTopic(topicId, `Restarting "${sessionName}"...`).catch(() => {});
      try {
        await this.onRestartSession(sessionName, topicId);
        await this.sendToTopic(topicId, 'Session restarted.').catch(() => {});
      } catch (err) {
        console.error(`[telegram] Restart failed:`, err);
        await this.sendToTopic(topicId, 'Restart didn\'t work. The session may need to be recreated — try sending a new message.').catch(() => {});
      }
      return true;
    }, { description: 'Kill and respawn session' });

    this.sharedCommandRouter.register('status', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const s = this.getStatus();
      const lines = [
        `Telegram adapter: ${s.started ? '\u2705 running' : '\u274c stopped'}`,
        `Uptime: ${s.uptime ? Math.round(s.uptime / 60000) + 'm' : 'n/a'}`,
        `Topic mappings: ${s.topicMappings}`,
        `Pending stall alerts: ${s.pendingStalls}`,
      ];
      await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      return true;
    }, { description: 'Show adapter status' });

    this.sharedCommandRouter.register(['switch-account', 'sa'], async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      if (!ctx.args) return false;
      if (this.onSwitchAccountRequest) {
        this.onSwitchAccountRequest(ctx.args, topicId).catch(err => {
          console.error('[telegram] Switch account failed:', err);
          this.sendToTopic(topicId, 'Account switch didn\'t work. Try again or use /quota to check status.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Account switching not available.').catch(() => {});
      }
      return true;
    }, { description: 'Switch active Claude account' });

    this.sharedCommandRouter.register(['quota', 'q'], async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      if (this.onQuotaStatusRequest) {
        this.onQuotaStatusRequest(topicId).catch(err => {
          console.error('[telegram] Quota status failed:', err);
          this.sendToTopic(topicId, 'Couldn\'t check quota right now. Try again in a moment.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Quota status not available.').catch(() => {});
      }
      return true;
    }, { description: 'Show multi-account quota summary' });

    this.sharedCommandRouter.register('login', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const email = ctx.args || null;
      if (this.onLoginRequest) {
        this.onLoginRequest(email, topicId).catch(err => {
          console.error('[telegram] Login flow failed:', err);
          this.sendToTopic(topicId, 'Login didn\'t complete. Try again, or the auth service may be temporarily unavailable.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Login not available.').catch(() => {});
      }
      return true;
    }, { description: 'Seamless OAuth login from Telegram' });
  }

  async start(): Promise<void> {
    if (this.polling) return;
    // HARDENED (v1.3.270 incident): without a usable bot token (empty/normalized
    // placeholder), getUpdates 404s forever — a zombie poll loop that looks alive
    // but never serves a message. Refuse to start polling and say why; send-only
    // paths (relay) keep working, and the supervisor's next restart recovers full
    // service once the secret store is readable again.
    if (typeof this.config.token !== 'string' || this.config.token.length === 0) {
      this.fatalPollReason = 'no-usable-bot-token';
      console.error(
        '[telegram] NOT starting long-polling: no usable bot token (unresolved secret placeholder or empty token). ' +
        'The secret store was likely unavailable at boot — restart after it recovers to restore polling.',
      );
      return;
    }
    this.polling = true;
    this.startedAt = new Date();
    this.consecutivePollErrors = 0;
    this.lastPollError = null;
    this.fatalPollReason = null;
    this.pollStoppedAt = null;
    this.pending401Retry = false;

    // Ensure Lifeline topic exists (auto-recreate if deleted). A non-primary adapter
    // (e.g. the mentor bot) must NOT create a second Lifeline topic in the chat.
    if (!this.suppressLifelineAutoCreate) {
      await this.ensureLifelineTopic();
    }

    console.log(`[telegram] Starting long-polling...`);
    this.poll();

    // Resolve any topic names still using the fallback "topic-NNNN" pattern
    this.resolveUnknownTopicNames().catch(err => {
      console.warn(`[telegram] Topic name resolution failed: ${err}`);
    });

    // Start notification batcher if configured
    if (this.batcher) {
      this.batcher.start();
      console.log('[telegram] Notification batcher started');
    }

    // Start stall detection if configured
    if (this.sharedStallDetector) {
      // Phase 1c: Wire shared stall detector callbacks and start
      this.sharedStallDetector.setIsSessionAlive(this.onIsSessionAlive ? (name) => this.onIsSessionAlive!(name) : null);
      this.sharedStallDetector.setIsSessionActive(this.onIsSessionActive ? (name) => this.onIsSessionActive!(name) : null);
      this.sharedStallDetector.setOnStall(async (event, alive) => {
        await this.handleSharedStallEvent(event, alive);
      });
      this.sharedStallDetector.start();
    } else {
      const stallMinutes = this.config.stallTimeoutMinutes ?? 5;
      if (stallMinutes > 0) {
        this.stallCheckInterval = setInterval(() => this.checkForStalls(), 30_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    if (this.sharedStallDetector) {
      this.sharedStallDetector.stop();
    }
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
    }
    // Flush and stop the batcher on shutdown
    if (this.batcher) {
      try {
        await this.batcher.flushAll();
      } catch (err) {
        console.error('[telegram] Failed to flush batcher on stop:', err);
      }
      this.batcher.stop();
    }
  }

  // ── Channel Seamlessness Contract (spec §) — Telegram reference impl ──

  /**
   * Stable provider-level identity for an inbound update — the Telegram
   * update_id. Used by the message-processing ledger so a redelivered update
   * (retry / reconnect / transfer-window overlap) is recognized and not
   * re-acted-on.
   */
  dedupeKey(rawEvent: unknown): string {
    const u = rawEvent as { update_id?: number } | undefined;
    if (u && typeof u.update_id === 'number') return `telegram:${u.update_id}`;
    // Fallback for already-normalized Message objects carrying the id in metadata.
    const m = rawEvent as { metadata?: { update_id?: number }; id?: string } | undefined;
    if (m?.metadata?.update_id != null) return `telegram:${m.metadata.update_id}`;
    return `telegram:${m?.id ?? 'unknown'}`;
  }

  /** The durable resumable position — the long-poll update_id offset. */
  getIngressPosition(): IngressPosition {
    return { platform: 'telegram', cursor: this.lastUpdateId, capturedAt: new Date().toISOString() };
  }

  /**
   * Stop the inbound loop deterministically and return the durable position
   * AFTER the stop (the persisted offset), so a handoff resumes from exactly
   * where this machine left off — never replaying or skipping.
   */
  async stopConsuming(): Promise<IngressPosition> {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    this.saveOffset(); // durable — the position is the persisted offset, not the in-memory cursor
    return this.getIngressPosition();
  }

  /** Resume the inbound loop from exactly the given position. */
  async resumeConsuming(position: IngressPosition): Promise<void> {
    if (position.platform !== 'telegram') {
      throw new Error(`resumeConsuming: wrong platform ${position.platform} for telegram adapter`);
    }
    const cursor = typeof position.cursor === 'number' ? position.cursor : Number(position.cursor);
    if (Number.isFinite(cursor) && cursor >= 0) {
      // Resume from exactly this offset (never lower than what we know, to avoid replay).
      this.lastUpdateId = Math.max(this.lastUpdateId, cursor);
      this.saveOffset();
    }
    if (!this.polling) {
      await this.start();
    }
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const topicId = message.channel?.identifier;
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text: message.content,
      parse_mode: 'Markdown',
    };

    if (topicId && !isGeneralTopic(parseInt(topicId, 10))) {
      params.message_thread_id = parseInt(topicId, 10);
    }

    try {
      const result = await this.apiCall('sendMessage', params) as { message_id: number };
      return { messageId: result.message_id, topicId: topicId ? parseInt(topicId, 10) : undefined };
    } catch (err) {
      // Only retry without parse_mode on 400 errors (likely Markdown parse failures)
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('(400)') && params.parse_mode) {
        delete params.parse_mode;
        const result = await this.apiCall('sendMessage', params) as { message_id: number };
        return { messageId: result.message_id, topicId: topicId ? parseInt(topicId, 10) : undefined };
      }
      throw err;
    }
  }

  /**
   * Log an inbound user message that arrived via an external path (e.g. Lifeline
   * forwarding through /internal/telegram-forward). This ensures the message
   * appears in both JSONL and TopicMemory even when the normal polling handler
   * didn't receive it.
   */
  logInboundMessage(entry: {
    messageId: number;
    topicId: number;
    text: string;
    timestamp: string;
    senderName?: string;
    senderUsername?: string;
    telegramUserId?: number;
  }): void {
    this.appendToLog({
      messageId: entry.messageId,
      topicId: entry.topicId,
      text: entry.text,
      fromUser: true,
      timestamp: entry.timestamp,
      sessionName: this.topicToSession.get(entry.topicId) ?? null,
      senderName: entry.senderName,
      senderUsername: entry.senderUsername,
      telegramUserId: entry.telegramUserId,
    });
  }

  /**
   * Send a message to a specific forum topic.
   * Returns the Telegram message ID for delivery confirmation.
   */
  async sendToTopic(
    topicId: number,
    text: string,
    options?: {
      silent?: boolean;
      skipStallClear?: boolean;
      /** Kind metadata (messageKind/senderClass/advisoryAck…) forwarded to
       *  the holder on a RELAYED send so the kind survives the cross-machine
       *  hop (spec outbound-jargon-filepath-gap §2.5). Direct sends ignore it
       *  — the local route already consumed it. */
      kindMetadata?: Record<string, unknown>;
    },
  ): Promise<SendResult> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text,
    };
    if (!isGeneralTopic(topicId)) {
      params.message_thread_id = topicId;
    }
    if (options?.silent) {
      params.disable_notification = true;
    }

    let result: { message_id: number };
    // A pool standby's bot token is externalized and arrives UNRESOLVED as a non-string
    // placeholder (e.g. `{ secret: true }`), not null — which is truthy, so the old
    // `!this.config.token` check thought a token existed and attempted a doomed direct API
    // send (the moved session's reply 200'd internally but never reached Telegram). The only
    // usable token is a non-empty string; anything else (placeholder/null/empty) means
    // "no usable token" → relay through the Telegram-owning router (bug #7).
    const hasUsableBotToken = typeof this.config.token === 'string' && this.config.token.length > 0;
    if (!hasUsableBotToken && this.outboundRelay) {
      // Tokenless standby (bug #7): relay the send through the Telegram-owning router
      // instead of calling the API with no token. The rest of this method's bookkeeping
      // (log, stall-clear, promise-tracking) then runs identically on the relayed id.
      const relayed = await this.outboundRelay(topicId, text, {
        silent: options?.silent,
        kindMetadata: options?.kindMetadata,
      });
      if (!relayed) {
        throw new Error('telegram outbound relay failed (tokenless standby, router unreachable)');
      }
      result = { message_id: relayed.messageId };
    } else {
      try {
        result = await this.apiCall('sendMessage', { ...params, parse_mode: 'Markdown' }) as { message_id: number };
      } catch {
        result = await this.apiCall('sendMessage', params) as { message_id: number };
      }
    }

    // Log outbound messages too
    this.appendToLog({
      messageId: result.message_id,
      topicId,
      text,
      fromUser: false,
      timestamp: new Date().toISOString(),
      sessionName: this.topicToSession.get(topicId) ?? null,
    });

    // Clear stall tracking for this topic (agent responded)
    // Skip for proxy messages — PresenceProxy messages should NOT reset stall timers
    if (!options?.skipStallClear) {
      this.clearStallForTopic(topicId);
    }

    // Promise tracking — detect agent "working on it" messages that need follow-through
    const sessionName = this.topicToSession.get(topicId);
    if (sessionName) {
      // Phase 1c: Delegate to shared StallDetector when flag is enabled
      if (this.sharedStallDetector) {
        this.sharedStallDetector.trackOutboundMessage(topicId.toString(), sessionName, text);
      } else {
        if (this.isPromiseMessage(text)) {
          this.pendingPromises.set(topicId, {
            topicId,
            sessionName,
            promiseText: text.slice(0, 100),
            promisedAt: Date.now(),
            alerted: false,
          });
        } else if (this.pendingPromises.has(topicId) && this.isFollowThroughMessage(text)) {
          this.pendingPromises.delete(topicId);
        }
      }
    }

    return { messageId: result.message_id, topicId };
  }

  /**
   * Send a notification through the batcher, falling back to direct send.
   * Use this for internal system notifications that should be batched.
   */
  async notifyTopic(topicId: number, text: string, tier: NotificationTier, category: string): Promise<void> {
    if (this.batcher && this.batcher.isEnabled()) {
      await this.batcher.enqueue({
        tier,
        category,
        message: text,
        timestamp: new Date(),
        topicId,
      });
    } else {
      // No batcher or disabled — send directly
      await this.sendToTopic(topicId, text);
    }
  }

  /**
   * Configure the notification batcher. Call before start() to enable batching.
   * The batcher's send function is wired to sendToTopic automatically.
   */
  configureBatcher(config?: { summaryIntervalMinutes?: number; digestIntervalMinutes?: number; quietHours?: { enabled: boolean; start: string; end: string } }): NotificationBatcher {
    this.batcher = new NotificationBatcher({
      enabled: true,
      ...config,
    });
    this.batcher.setSendFunction((topicId, text) => this.sendToTopic(topicId, text));
    return this.batcher;
  }

  /**
   * Get the notification batcher (if configured).
   */
  getBatcher(): NotificationBatcher | null {
    return this.batcher;
  }

  /**
   * Create a forum topic in the supergroup.
   *
   * THE TOPIC-CREATION CHOKEPOINT. Every topic this process creates is born
   * here, so the last-resort flood ceiling lives here (see
   * `topicCreationBudget` on the config). `opts.origin` declares who is
   * asking:
   *   - 'user'   — a human asked for this topic (operator command, inbound
   *                conversation). Exempt: humans are self-rate-limiting.
   *   - 'system' — a bounded, create-once-then-reuse infrastructure topic
   *                (Lifeline, Dashboard, Updates, the flood-notice topic
   *                itself). Exempt: cardinality is fixed by design.
   *   - 'auto'   — anything a feature decided to create on its own. Counted.
   *                THIS IS THE DEFAULT — a caller that doesn't declare an
   *                origin is budgeted, so a future mis-wired feature is
   *                bounded without having to know this mechanism exists.
   * Past the budget this throws TopicFloodBudgetError — the same failure
   * shape as a Telegram 429, which every caller already survives.
   */
  async createForumTopic(
    name: string,
    iconColor?: number,
    opts?: { origin?: 'user' | 'system' | 'auto'; label?: string },
  ): Promise<{ topicId: number; name: string }> {
    if (this.notAForum) {
      throw new Error('Chat is not a forum — topic creation skipped');
    }

    const origin = opts?.origin ?? 'auto';
    if (origin === 'auto') {
      const label = opts?.label ?? 'unlabeled-auto';
      const decision = this.topicCreationGuard.decide(label, undefined);
      if (decision.action === 'coalesce') {
        console.warn(
          `[telegram] topic-creation budget: REFUSED auto topic "${name}" ` +
          `(label=${label}, bucket=${decision.bucket}, #${decision.suppressedCount} in episode) — ` +
          `the last-resort flood ceiling. If this label is legitimate at this volume, ` +
          `raise messaging[].config.topicCreationBudget; if it is operator/system-driven, ` +
          `pass an explicit origin.`,
        );
        throw new TopicFloodBudgetError(name, label, decision.bucket);
      }
    }

    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      name,
    };
    if (iconColor !== undefined) {
      params.icon_color = iconColor;
    }

    try {
      const result = await this.apiCall('createForumTopic', params) as {
        message_thread_id: number;
        name: string;
      };

      this.topicToName.set(result.message_thread_id, name);
      this.saveRegistry();

      console.log(`[telegram] Created forum topic: "${name}" (ID: ${result.message_thread_id})`);
      return { topicId: result.message_thread_id, name: result.name };
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('not a forum') || errStr.includes('FORUM_REQUIRED')) {
        this.notAForum = true;
        if (!this.notAForumWarned) {
          this.notAForumWarned = true;
          console.warn('[telegram] ⚠️ Chat is not a forum-enabled supergroup. Forum topics (Lifeline, Dashboard, per-session) will not be created. Messaging will use the General Topic. To enable topics, convert your Telegram group to a supergroup with Topics enabled in group settings.');
        }
      }
      throw err;
    }
  }

  /**
   * Edit a forum topic's name and/or icon color.
   * Best-effort — silently ignores failures (topic may not exist).
   */
  async editForumTopic(topicId: number, name?: string, iconColor?: number): Promise<boolean> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      message_thread_id: topicId,
    };
    if (name !== undefined) params.name = name;
    if (iconColor !== undefined) params.icon_color = iconColor;

    try {
      await this.apiCall('editForumTopic', params);
      if (name) {
        this.topicToName.set(topicId, name);
        this.saveRegistry();
      }
      console.log(`[telegram] Renamed topic ${topicId} → "${name}"`);
      return true;
    } catch {
      // @silent-fallback-ok — best-effort rename
      return false;
    }
  }

  /**
   * Find an existing topic by name, or create a new one if none exists.
   * Prevents duplicate topics when sessions respawn or the server restarts.
   */
  async findOrCreateForumTopic(
    name: string,
    iconColor?: number,
    opts?: { origin?: 'user' | 'system' | 'auto'; label?: string },
  ): Promise<{ topicId: number; name: string; reused: boolean }> {
    const normalizedName = name.toLowerCase().trim();
    for (const [topicId, existingName] of this.topicToName) {
      if (existingName.toLowerCase().trim() === normalizedName) {
        console.log(`[telegram] Reusing existing topic ${topicId} for "${name}"`);
        return { topicId, name: existingName, reused: true };
      }
    }
    const result = await this.createForumTopic(name, iconColor, opts);
    return { ...result, reused: false };
  }

  /**
   * Get the Lifeline topic ID (if configured).
   */
  getLifelineTopicId(): number | undefined {
    return this.config.lifelineTopicId;
  }

  /**
   * Owner principal — the single Telegram user id who controls
   * security-sensitive decisions for this instance. Falls back to the
   * promptGate.ownerId for back-compat when ownerUserId isn't
   * explicitly configured.
   */
  getOwnerUserId(): number | undefined {
    return this.config.ownerUserId ?? this.config.promptGate?.ownerId;
  }

  /**
   * Send a private DM to the owner principal. Telegram's bot API
   * permits the bot to initiate a DM only after the user has messaged
   * the bot at least once; if the user has never DM'd the bot, the
   * send will fail with HTTP 403 ("forbidden: bot can't initiate
   * conversation with a user"). Callers should treat a null return
   * as a non-fatal degradation, NOT a fatal error.
   *
   * Per the tunnel-failure-resilience spec (Part 3 — two-channel
   * notification), this is the ONLY channel that ever carries the
   * URL + PIN + signed view links. Group topics get status text
   * only.
   *
   * Returns the SendResult on success; null on any failure (no
   * owner configured, owner never DM'd the bot, network error,
   * etc.). All failure paths are logged-not-thrown to preserve the
   * fire-and-forget contract callers expect for outbound messaging.
   */
  async sendToOwnerDM(text: string): Promise<SendResult | null> {
    const owner = this.getOwnerUserId();
    if (!owner) {
      console.warn('[telegram] sendToOwnerDM called but no ownerUserId is configured');
      return null;
    }
    try {
      const params: Record<string, unknown> = {
        chat_id: owner,
        text,
      };
      const result = await this.apiCall('sendMessage', params) as { message_id: number };
      return { messageId: result.message_id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('forbidden') || msg.includes('403')) {
        console.warn(`[telegram] sendToOwnerDM forbidden — owner ${owner} hasn't messaged the bot yet`);
      } else {
        console.warn(`[telegram] sendToOwnerDM failed: ${msg}`);
      }
      return null;
    }
  }

  /**
   * Ensure the Lifeline topic exists. If it was deleted, recreate it.
   * Called on startup and can be called periodically.
   */
  async ensureLifelineTopic(): Promise<number | null> {
    if (this.notAForum) return null;
    const styledName = `${TOPIC_STYLE.SYSTEM.emoji} Lifeline`;
    if (!this.config.lifelineTopicId) {
      // No lifeline topic configured — create one
      try {
        const topic = await this.createForumTopic(styledName, TOPIC_STYLE.SYSTEM.color, { origin: 'system' });
        this.config.lifelineTopicId = topic.topicId;
        this.persistLifelineTopicId(topic.topicId);
        console.log(`[telegram] Created Lifeline topic: ${topic.topicId}`);
        return topic.topicId;
      } catch (err) {
        // @silent-fallback-ok — lifeline topic creation, logged
        console.error(`[telegram] Failed to create Lifeline topic: ${err}`);
        return null;
      }
    }

    // Lifeline topic ID exists — verify it's still valid silently.
    // Don't send a visible message — it spams the user on every server restart.
    try {
      await this.apiCall('sendChatAction', {
        chat_id: this.config.chatId,
        message_thread_id: this.config.lifelineTopicId,
        action: 'typing',
      });
      // Best-effort rename to styled name if it doesn't match
      const currentName = this.topicToName.get(this.config.lifelineTopicId);
      if (currentName && !currentName.includes(TOPIC_STYLE.SYSTEM.emoji)) {
        await this.editForumTopic(this.config.lifelineTopicId, styledName, TOPIC_STYLE.SYSTEM.color);
      }
      console.log(`[telegram] Lifeline topic verified: ${this.config.lifelineTopicId}`);
      return this.config.lifelineTopicId;
    } catch (err) {
      const errStr = String(err);
      // Topic was deleted — "message thread not found" or "TOPIC_CLOSED" or similar
      if (errStr.includes('thread not found') || errStr.includes('TOPIC_DELETED') ||
          errStr.includes('TOPIC_CLOSED') || errStr.includes('not found')) {
        console.log(`[telegram] Lifeline topic ${this.config.lifelineTopicId} was deleted — recreating`);
        try {
          const topic = await this.createForumTopic(styledName, TOPIC_STYLE.SYSTEM.color, { origin: 'system' });
          this.config.lifelineTopicId = topic.topicId;
          this.persistLifelineTopicId(topic.topicId);
          console.log(`[telegram] Recreated Lifeline topic: ${topic.topicId}`);
          return topic.topicId;
        } catch (recreateErr) {
          DegradationReporter.getInstance().report({
            feature: 'Telegram.Lifeline',
            primary: 'Verified lifeline topic for emergency agent communication',
            fallback: 'No lifeline topic — agent unreachable in emergencies',
            reason: `Lifeline topic deleted and recreation failed: ${recreateErr instanceof Error ? recreateErr.message : String(recreateErr)}`,
            impact: 'Agent cannot receive emergency commands or stall recovery signals.',
          });
          return null;
        }
      }
      // Some other error (network, etc.) — retry once before reporting degradation.
      // Transient errors like "This operation was aborted" (15s fetch timeout) should
      // not trigger degradation on the first attempt — a brief retry on startup resolves them.
      let retryErr: unknown = err;
      try {
        await new Promise<void>(resolve => setTimeout(resolve, 3000));
        await this.apiCall('sendChatAction', {
          chat_id: this.config.chatId,
          message_thread_id: this.config.lifelineTopicId,
          action: 'typing',
        });
        console.log(`[telegram] Lifeline topic verified (retry succeeded): ${this.config.lifelineTopicId}`);
        return this.config.lifelineTopicId;
      } catch (e) {
        // @silent-fallback-ok — error assigned to retryErr, reported to DegradationReporter below
        retryErr = e;
      }
      DegradationReporter.getInstance().report({
        feature: 'Telegram.Lifeline',
        primary: 'Verified lifeline topic for emergency agent communication',
        fallback: 'Using unverified (possibly stale) lifeline topic ID',
        reason: `Lifeline topic check failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        impact: 'Lifeline may be unreachable — messages to agent could fail silently.',
      });
      return this.config.lifelineTopicId;
    }
  }

  /**
   * Persist the Lifeline topic ID back to config.json so it survives restarts.
   */
  private persistLifelineTopicId(topicId: number): void {
    try {
      // Find config.json in state dir's parent (stateDir is .instar/state or .instar)
      const candidates = [
        path.join(this.stateDir, '..', 'config.json'),
        path.join(this.stateDir, 'config.json'),
      ];
      for (const configPath of candidates) {
        if (fs.existsSync(configPath)) {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(raw);
          // Find the telegram messaging config and update it
          if (Array.isArray(config.messaging)) {
            const telegramEntry = config.messaging.find(
              (m: { type: string }) => m.type === 'telegram'
            );
            if (telegramEntry?.config) {
              telegramEntry.config.lifelineTopicId = topicId;
              const tmpPath = `${configPath}.${process.pid}.tmp`;
              fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
              fs.renameSync(tmpPath, configPath);
              console.log(`[telegram] Saved lifelineTopicId=${topicId} to config`);
              return;
            }
          }
        }
      }
    } catch (err) {
      // @silent-fallback-ok — config persistence, in-memory ok
      console.warn(`[telegram] Failed to persist lifelineTopicId: ${err}`);
    }
  }

  // ── Dashboard Topic ──────────────────────────────────────────────────

  /**
   * Get the Dashboard topic ID (if configured).
   */
  getDashboardTopicId(): number | undefined {
    return this.config.dashboardTopicId;
  }

  /**
   * Whether the chat supports forum topics. False if we detected
   * "the chat is not a forum" from the Telegram API.
   */
  get isForumChat(): boolean {
    return !this.notAForum;
  }

  /**
   * Ensure the Dashboard topic exists. Creates it on first run, verifies on restart.
   * Same resilience pattern as the lifeline topic.
   */
  async ensureDashboardTopic(): Promise<number | null> {
    if (this.notAForum) return null;
    const styledName = `${TOPIC_STYLE.INFO.emoji} Dashboard`;
    if (!this.config.dashboardTopicId) {
      try {
        const topic = await this.createForumTopic(styledName, TOPIC_STYLE.INFO.color, { origin: 'system' });
        this.config.dashboardTopicId = topic.topicId;
        this.persistDashboardTopicId(topic.topicId);
        console.log(`[telegram] Created Dashboard topic: ${topic.topicId}`);

        // Send a one-time setup hint: mute this topic to avoid unread badges.
        // The bot can't mute topics for users (client-side setting), so we guide them.
        try {
          await this.sendToTopic(topic.topicId, [
            '💡 *Tip*: Mute this topic to avoid notification badges.',
            '',
            'Long-press this topic → Mute → Forever.',
            '',
            '_The latest dashboard link will always be pinned here._',
          ].join('\n'), { silent: true });
        } catch {
          // @silent-fallback-ok — guidance message is nice-to-have
        }

        return topic.topicId;
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'TelegramAdapter.ensureDashboardTopic',
          primary: 'Create Dashboard forum topic for status messages',
          fallback: 'Dashboard topic unavailable, status messages have no destination',
          reason: `Failed to create Dashboard topic: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'Dashboard status messages and pinned URLs will not be delivered',
        });
        return null;
      }
    }

    // Dashboard topic ID exists — verify it's still valid
    try {
      await this.apiCall('sendChatAction', {
        chat_id: this.config.chatId,
        message_thread_id: this.config.dashboardTopicId,
        action: 'typing',
      });
      // Best-effort rename to styled name
      const currentName = this.topicToName.get(this.config.dashboardTopicId);
      if (currentName && !currentName.includes(TOPIC_STYLE.INFO.emoji)) {
        await this.editForumTopic(this.config.dashboardTopicId, styledName, TOPIC_STYLE.INFO.color);
      }
      return this.config.dashboardTopicId;
    } catch (err) {
      // @silent-fallback-ok — self-healing: attempts topic recreation on deletion, returns existing ID for transient errors
      const errStr = String(err);
      if (errStr.includes('thread not found') || errStr.includes('TOPIC_DELETED') ||
          errStr.includes('TOPIC_CLOSED') || errStr.includes('not found')) {
        console.log(`[telegram] Dashboard topic ${this.config.dashboardTopicId} was deleted — recreating`);
        try {
          const topic = await this.createForumTopic(styledName, TOPIC_STYLE.INFO.color, { origin: 'system' });
          this.config.dashboardTopicId = topic.topicId;
          this.persistDashboardTopicId(topic.topicId);
          return topic.topicId;
        } catch (recreateErr) {
          DegradationReporter.getInstance().report({
            feature: 'TelegramAdapter.ensureDashboardTopic',
            primary: 'Recreate deleted Dashboard forum topic',
            fallback: 'No dashboard topic available, returning null',
            reason: `Recreation failed: ${recreateErr instanceof Error ? recreateErr.message : String(recreateErr)}`,
            impact: 'Dashboard status messages and pinned URLs will not be delivered until next restart',
          });
          return null;
        }
      }
      return this.config.dashboardTopicId;
    }
  }

  /**
   * Broadcast the dashboard URL to the Dashboard topic.
   *
   * Edit-in-place pattern: instead of posting a new message each restart (which
   * creates unread badges), we edit the existing pinned message. This means the
   * Dashboard topic never shows as "unread" — it's a quiet reference the user
   * checks when they need the link.
   *
   * Fallback: if the pinned message was deleted or doesn't exist yet, we send
   * a new one, pin it, and save its ID for future edits.
   */
  async broadcastDashboardUrl(url: string, tunnelType: 'quick' | 'named'): Promise<DashboardBroadcastResult> {
    const topicId = this.config.dashboardTopicId;
    if (!topicId) {
      throw new Error('Dashboard topic is not configured; create or repair the Dashboard forum topic before refreshing the pinned link');
    }

    const pin = this.config.dashboardPin || '(check your config)';
    const isNamed = tunnelType === 'named';
    const warnings: string[] = [];

    const message = this.formatDashboardMessage(url, pin, isNamed);

    // Try to edit the existing pinned message (no new message = no unread badge)
    const existingMessageId = this.loadDashboardMessageId();
    if (existingMessageId) {
      try {
        await this.apiCall('editMessageText', {
          chat_id: this.config.chatId,
          message_id: existingMessageId,
          text: message,
          parse_mode: 'Markdown',
        });
        console.log(`[telegram] Edited dashboard message ${existingMessageId} in-place`);
        return { edited: true, messageId: existingMessageId, warnings }; // Success — no new message, no unread badge
      } catch (err) {
        // Edit failed — message was deleted, or content unchanged. Fall through to send new.
        const errStr = String(err);
        if (errStr.includes('message is not modified')) {
          console.log(`[telegram] Dashboard message unchanged — skipping`);
          return { edited: true, messageId: existingMessageId, warnings };
        }
        console.log(`[telegram] Dashboard message ${existingMessageId} edit failed, sending new: ${errStr}`);
        warnings.push(`existing pinned message edit failed: ${errStr}`);
      }
    }

    // Fallback: send a new message, pin it, and save for future edits
    try {
      const result = await this.sendToTopic(topicId, message, { silent: true });

      if (result.messageId) {
        // Unpin old pins, then pin the new message
        try {
          await this.apiCall('unpinAllForumTopicMessages', {
            chat_id: this.config.chatId,
            message_thread_id: topicId,
          });
        } catch {
          // @silent-fallback-ok — unpinning old messages is best-effort
        }

        try {
          await this.apiCall('pinChatMessage', {
            chat_id: this.config.chatId,
            message_id: result.messageId,
            disable_notification: true,
          });
        } catch (err) {
          warnings.push(`pinChatMessage failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Save message ID for future edit-in-place
        this.saveDashboardMessageId(result.messageId);
      }
      return { edited: false, messageId: result.messageId, warnings };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Failed to broadcast dashboard URL: ${detail}`);
      throw new Error(`Telegram dashboard broadcast failed: ${detail}`);
    }
  }

  private formatDashboardMessage(url: string, pin: string, isNamed: boolean): string {
    const dashboardUrl = url + '/dashboard';
    const quickLinks = [
      `Sessions: ${dashboardUrl}?tab=sessions`,
      `Files: ${dashboardUrl}?tab=files`,
    ];

    if (isNamed) {
      return [
        '*Dashboard*',
        '',
        `Your permanent dashboard link:`,
        dashboardUrl,
        '',
        `PIN: \`${pin}\``,
        '',
        `Quick links:`,
        ...quickLinks.map(l => `  ${l}`),
        '',
        `_This link is permanent — it won't change on restart._`,
      ].join('\n');
    }
    return [
      '*Dashboard*',
      '',
      `Your dashboard is live:`,
      dashboardUrl,
      '',
      `PIN: \`${pin}\``,
      '',
      `Quick links:`,
      ...quickLinks.map(l => `  ${l}`),
      '',
      `_This link changes when the server restarts._`,
      `_For a permanent link, ask me to set up a named tunnel._`,
    ].join('\n');
  }

  private loadDashboardMessageId(): number | null {
    try {
      const statePath = path.join(this.stateDir, 'state', 'dashboard-message.json');
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        return data.messageId ?? null;
      }
    } catch {
      // @silent-fallback-ok — missing state file means first run
    }
    return null;
  }

  private saveDashboardMessageId(messageId: number): void {
    try {
      const stateSubdir = path.join(this.stateDir, 'state');
      fs.mkdirSync(stateSubdir, { recursive: true });
      const statePath = path.join(stateSubdir, 'dashboard-message.json');
      const tmpPath = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ messageId, savedAt: new Date().toISOString() }));
      fs.renameSync(tmpPath, statePath);
    } catch (err) {
      console.warn(`[telegram] Failed to save dashboard message ID: ${err}`);
    }
  }

  /**
   * Persist the Dashboard topic ID back to config.json.
   */
  private persistDashboardTopicId(topicId: number): void {
    try {
      const candidates = [
        path.join(this.stateDir, '..', 'config.json'),
        path.join(this.stateDir, 'config.json'),
      ];
      for (const configPath of candidates) {
        if (fs.existsSync(configPath)) {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(raw);
          if (Array.isArray(config.messaging)) {
            const telegramEntry = config.messaging.find(
              (m: { type: string }) => m.type === 'telegram'
            );
            if (telegramEntry?.config) {
              telegramEntry.config.dashboardTopicId = topicId;
              const tmpPath = `${configPath}.${process.pid}.tmp`;
              fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
              fs.renameSync(tmpPath, configPath);
              console.log(`[telegram] Saved dashboardTopicId=${topicId} to config`);
              return;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[telegram] Failed to persist dashboardTopicId: ${err}`);
    }
  }

  /**
   * Close a forum topic.
   */
  async closeForumTopic(topicId: number): Promise<boolean> {
    try {
      await this.apiCall('closeForumTopic', {
        chat_id: this.config.chatId,
        message_thread_id: topicId,
      });
      return true;
    } catch {
      // @silent-fallback-ok — forum close boolean return
      return false;
    }
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Install the agent-to-agent Telegram comms pre-dispatch hook. The hook fires on text
   * messages BEFORE onTopicMessage / this.handler dispatch — see AgentMessageHook docs
   * above. Setting to undefined disables the hook (falls back to pure user-message flow).
   */
  setAgentMessageHook(hook: AgentMessageHook | undefined): void {
    this.agentMessageHook = hook;
  }

  /**
   * Inject the coherence-journal seam (COHERENCE-JOURNAL-SPEC §3.3). The adapter
   * has no StateManager, so its emergency-stop path threads this seam into
   * stopAutonomousTopic so the autonomous-run `stopped` event is emitted on a
   * sentinel-driven stop. server.ts wires this right after state.setCoherenceJournal.
   */
  setCoherenceJournalSeam(seam: AutonomousJournalSeam | undefined): void {
    this.coherenceJournalSeam = seam;
  }

  /**
   * Dispatch an inbound text to the installed agent-message hook (if any) BEFORE
   * normal user-message routing. Returns true iff the hook claimed the message
   * (`{handled: true}`); the caller MUST then short-circuit and NOT route the
   * message to the user-message flow.
   *
   * Why this is public: in send-only mode the primary adapter doesn't poll —
   * the lifeline polls and forwards via `/internal/telegram-forward`. The
   * forwarded path calls `onTopicMessage` directly, bypassing the polling
   * text-dispatch site where the hook lives. Exposing this dispatcher lets the
   * forward handler invoke the same gate before falling through, so the
   * mentee receiver wiring fires regardless of message origin.
   *
   * Spoof defense: the hook needs `senderIsBot` AND `senderChatId` to decide
   * whether a marker-bearing message is from a real bot or a user typing a
   * marker-shaped string (spec §Routing matrix:
   * `agent-marker-spoofed-by-user`). The caller passes through what it has;
   * `senderBotId` is derived as `senderChatId` (group bot-as-channel) or the
   * passed `rawFromId` when `senderIsBot` is true (DM / topic post by a bot).
   */
  async dispatchAgentMessageHook(ctx: {
    text: string;
    topicId: number;
    senderIsBot: boolean;
    senderChatId?: string;
    senderBotId?: string;
    rawFromId?: string;
    now?: number;
  }): Promise<boolean> {
    if (!this.agentMessageHook) return false;
    try {
      const senderBotId =
        ctx.senderBotId ?? ctx.senderChatId ?? (ctx.senderIsBot ? ctx.rawFromId : undefined);
      const result = await this.agentMessageHook({
        text: ctx.text,
        topicId: ctx.topicId,
        senderIsBot: ctx.senderIsBot,
        senderChatId: ctx.senderChatId,
        senderBotId,
        now: ctx.now ?? Date.now(),
      });
      return result.handled === true;
    } catch (err) {
      // Hook must never crash the dispatch loop — log + fall through to normal user flow.
      // (A broken hook is preferable to a frozen message pipeline.)
      console.error(`[telegram] agentMessageHook error (falling through): ${err}`);
      return false;
    }
  }

  async resolveUser(channelIdentifier: string): Promise<string | null> {
    return null;
  }

  // ── Auth Gating ──────────────────────────────────────────

  /**
   * Check if a message is from an authorized user.
   * If no authorizedUserIds configured, all messages are accepted.
   */
  private isAuthorized(userId: number): boolean {
    // Phase 1d: Delegate to shared AuthGate when flag is enabled
    if (this.sharedAuthGate) {
      return this.sharedAuthGate.isAuthorized(userId.toString());
    }

    const authorized = this.config.authorizedUserIds;
    if (!authorized || authorized.length === 0) return true;
    // Type-tolerant comparison: the field is typed `number[]` but config JSON is
    // untyped at runtime, so an operator (or an onboarding agent) can write an id
    // as a string ("7812716706"). `Array.prototype.includes` uses SameValueZero
    // (no coercion), so a string-configured id would NOT match the numeric userId
    // and the authorized user would be silently treated as unknown (hitting the
    // registration gate). Compare as strings so number- and string-configured ids
    // both authorize. Mirrors the shared-AuthGate path above, which is string-based.
    const target = String(userId);
    return authorized.some(id => String(id) === target);
  }

  /**
   * Public read-only authorization check for a sender id (Know Your Principal #898,
   * increment 2d). Wraps the private `isAuthorized` so the lifeline-forward route can
   * decide whether an inbound sender is an authorized operator BEFORE binding them as
   * the topic operator — an UNAUTHORIZED sender must never become the operator
   * (that would re-open the "Caroline" cross-principal bug). Accepts number|string
   * (the route carries the id as a string); a blank/non-numeric id returns false.
   * Same trust model as `isAuthorized`: with no `authorizedUserIds` allowlist, every
   * authenticated sender is accepted (the agent already serves everyone there).
   */
  isAuthorizedSender(userId: number | string): boolean {
    const n = typeof userId === 'number' ? userId : Number(String(userId).trim());
    if (!Number.isFinite(n)) return false;
    return this.isAuthorized(n);
  }

  /**
   * Handle a message from an unknown/unauthorized Telegram user.
   * Checks the registration policy and responds appropriately:
   * - admin-only: Gated message + notify admin
   * - invite-only: Ask for invite code
   * - open: Start mini-onboarding (rate limited)
   *
   * Rate-limited to prevent spam from the same unknown user.
   */
  private async handleUnknownUser(
    telegramUserId: number,
    firstName: string,
    username: string | undefined,
    messageText: string | undefined,
  ): Promise<void> {
    // Rate limit: don't spam responses to the same unknown user
    const lastResponse = this.unknownUserRateLimit.get(telegramUserId);
    if (lastResponse && (Date.now() - lastResponse) < TelegramAdapter.UNKNOWN_USER_COOLDOWN_MS) {
      console.log(`[telegram] Rate-limited response to unknown user ${telegramUserId} (${username ?? firstName})`);
      return;
    }

    // Get registration policy from callback
    const policyInfo = this.onGetRegistrationPolicy?.();
    if (!policyInfo) {
      // No policy callback wired — fall back to silent ignore (legacy behavior)
      console.log(`[telegram] Ignoring message from unauthorized user ${telegramUserId} (${username ?? firstName}) — no registration policy configured`);
      return;
    }

    const { policy, contactHint, agentName } = policyInfo;
    const displayName = agentName || 'This agent';

    // Mark that we responded to this user
    this.unknownUserRateLimit.set(telegramUserId, Date.now());

    // Clean up old rate limit entries periodically (keep map from growing unbounded)
    if (this.unknownUserRateLimit.size > 100) {
      const cutoff = Date.now() - TelegramAdapter.UNKNOWN_USER_COOLDOWN_MS * 10;
      for (const [uid, ts] of this.unknownUserRateLimit) {
        if (ts < cutoff) this.unknownUserRateLimit.delete(uid);
      }
    }

    console.log(`[telegram] Unknown user ${telegramUserId} (${username ?? firstName}) — policy: ${policy}`);

    try {
      switch (policy) {
        case 'admin-only': {
          // Send gated message to the user
          let gatedMessage = `Hi ${firstName}! ${displayName} is not open for public registration. Access is managed by an administrator.`;
          if (contactHint) {
            gatedMessage += `\n\n${contactHint}`;
          }
          gatedMessage += `\n\nYour request has been noted and forwarded to the admin.`;

          // Reply in the group's General topic (since unknown users don't have their own topic)
          await this.sendToTopic(GENERAL_TOPIC_ID, gatedMessage).catch(() => {});

          // Notify admin via callback
          if (this.onNotifyAdminJoinRequest) {
            await this.onNotifyAdminJoinRequest({
              name: firstName,
              username,
              telegramUserId,
            }).catch(err => {
              console.error(`[telegram] Failed to notify admin of join request: ${err}`);
            });
          }
          break;
        }

        case 'invite-only': {
          // Check if the message contains an invite code
          const trimmedText = messageText?.trim();
          if (trimmedText && this.onValidateInviteCode) {
            const result = await this.onValidateInviteCode(trimmedText, telegramUserId);
            if (result.valid) {
              await this.sendToTopic(GENERAL_TOPIC_ID,
                `Welcome, ${firstName}! Your invite code has been accepted. Setting up your account...`,
              ).catch(() => {});
              // Trigger mini-onboarding after successful invite validation
              if (this.onStartMiniOnboarding) {
                await this.onStartMiniOnboarding(telegramUserId, firstName, username).catch(err => {
                  console.error(`[telegram] Failed to start onboarding after invite: ${err}`);
                });
              }
              return;
            } else if (result.error) {
              await this.sendToTopic(GENERAL_TOPIC_ID, result.error).catch(() => {});
              return;
            }
          }

          // Default invite-only prompt
          let inviteMessage = `Hi ${firstName}! ${displayName} requires an invite code to join. Please reply with your invite code.`;
          if (contactHint) {
            inviteMessage += `\n\n${contactHint}`;
          }
          await this.sendToTopic(GENERAL_TOPIC_ID, inviteMessage).catch(() => {});
          break;
        }

        case 'open': {
          // Start mini-onboarding via callback
          if (this.onStartMiniOnboarding) {
            await this.sendToTopic(GENERAL_TOPIC_ID,
              `Hi ${firstName}! Welcome! Setting up your account...`,
            ).catch(() => { /* @silent-fallback-ok — supplementary notification */ });
            await this.onStartMiniOnboarding(telegramUserId, firstName, username).catch(err => {
              // @silent-fallback-ok — supplementary notification
              console.error(`[telegram] Failed to start mini-onboarding: ${err}`);
              this.sendToTopic(GENERAL_TOPIC_ID,
                `Sorry ${firstName}, there was an issue setting up your account. Please try again later.`,
              ).catch(() => { /* @silent-fallback-ok — error notification, primary logged */ });
            });
          } else {
            await this.sendToTopic(GENERAL_TOPIC_ID,
              `Hi ${firstName}! Registration is currently being set up. Please try again later.`,
            ).catch(() => { /* @silent-fallback-ok — unavailable notification */ });
          }
          break;
        }

        default: {
          // Unknown policy — fall back to gated message
          console.warn(`[telegram] Unknown registration policy: ${policy}`);
          await this.sendToTopic(GENERAL_TOPIC_ID,
            `Hi ${firstName}! ${displayName} is not currently accepting new users.`,
          ).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[telegram] Error handling unknown user ${telegramUserId}: ${err}`);
    }
  }

  // ── Topic-Session Registry ─────────────────────────────────

  registerTopicSession(topicId: number, sessionName: string, topicName?: string): void {
    this.topicToSession.set(topicId, sessionName);
    this.sessionToTopic.set(sessionName, topicId);
    if (topicName) {
      this.topicToName.set(topicId, topicName);
    }
    this.saveRegistry();
    console.log(`[telegram] Registered topic ${topicId} <-> session "${sessionName}"${topicName ? ` (name: "${topicName}")` : ''}`);
  }

  unregisterTopic(topicId: number): void {
    const sessionName = this.topicToSession.get(topicId);
    this.topicToSession.delete(topicId);
    if (sessionName) this.sessionToTopic.delete(sessionName);
    // Reclaim the topic's tail cache — a long-lived server churning through
    // many topics must not retain ≤500 entries per topic-ever-seen forever
    // (second-pass reviewer finding). A later read simply re-seeds via the
    // lazy per-topic path. The version COUNTER is deliberately kept: it is
    // ~8 bytes, and resetting it on a re-registered topic could collide with
    // a LiveTailSource.lastSeenVersion snapshot and silently gate a real change.
    this.topicTailCache.delete(topicId);
    this.saveRegistry();
  }

  getSessionForTopic(topicId: number): string | null {
    return this.topicToSession.get(topicId) ?? null;
  }

  /**
   * Get all active topic→session mappings.
   * Used by TopicResumeMap heartbeat to proactively persist UUIDs.
   */
  getAllTopicSessions(): Map<number, string> {
    return new Map(this.topicToSession);
  }

  getTopicForSession(sessionName: string): number | null {
    return this.sessionToTopic.get(sessionName) ?? null;
  }

  /**
   * Disk-backed reverse lookup: re-reads the persisted topic-session registry
   * and returns the topic bound to `sessionName`, or null. This is the fallback
   * for {@link getTopicForSession} when the in-memory map misses because the
   * binding was registered AFTER this process loaded the registry.
   *
   * The concrete gap (2026-05-28): a `--no-telegram` server's in-memory
   * `sessionToTopic` reflects only its boot-time registry snapshot, while the
   * lifeline keeps writing new topic↔session bindings to the file as long-lived
   * dev sessions come up. A session bound after the server booted therefore
   * resolves to null in-memory — which made ContextWedgeSentinel recovery bail
   * with `not_telegram_bound` and leave the wedged session dead. A fresh disk
   * read closes that hole on the (rare) recovery path without changing the
   * hot-path semantics of getTopicForSession.
   *
   * Pure read: does NOT mutate the in-memory maps (the respawn path re-registers
   * the new session for the topic anyway).
   */
  resolveTopicForSessionFromDisk(sessionName: string): number | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      const t2s = data?.topicToSession;
      if (t2s && typeof t2s === 'object') {
        for (const [k, v] of Object.entries(t2s)) {
          if (v === sessionName) {
            const n = Number(k);
            return Number.isFinite(n) ? n : null;
          }
        }
      }
    } catch {
      // Registry file missing or corrupt — no fallback available.
    }
    return null;
  }

  getTopicName(topicId: number): string | null {
    return this.topicToName.get(topicId) ?? null;
  }

  /**
   * The topic IDs this adapter has registered a session for — the set of "live"
   * conversations. Used by the live-tail streamer (spec §8 G3b) to enumerate the
   * active topics whose tail should be pushed to the standby.
   */
  getKnownTopicIds(): number[] {
    return [...this.topicToSession.keys()];
  }

  /**
   * Actively resolve a topic's name from Telegram by sending a temporary probe message
   * that replies to the topic's service message (whose message_id = topic_id).
   * The API response includes reply_to_message.forum_topic_created.name.
   * The probe message is deleted immediately after.
   */
  async resolveTopicName(topicId: number): Promise<string | null> {
    if (this.notAForum) return null;
    try {
      // Send a temp message replying to the topic creation service message
      const result = await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        text: '.', // minimal probe message — deleted immediately after
        message_thread_id: topicId,
        reply_to_message_id: topicId,
      }) as { message_id: number; reply_to_message?: { forum_topic_created?: { name: string } } };

      // Extract topic name from the reply target
      const name = result.reply_to_message?.forum_topic_created?.name;

      // Delete the probe message immediately
      try {
        await this.apiCall('deleteMessage', {
          chat_id: this.config.chatId,
          message_id: result.message_id,
        });
      } catch {
        // @silent-fallback-ok — best-effort cleanup
      }

      if (name) {
        this.topicToName.set(topicId, name);
        this.saveRegistry();
        console.log(`[telegram] Resolved topic name: ${topicId} → "${name}"`);
        return name;
      }
    } catch (err) {
      const errStr = String(err);
      console.log(`[telegram] Could not resolve topic name for ${topicId}: ${err}`);
      // If the topic was deleted, mark it so we don't retry resolution on every startup
      if (errStr.includes('message thread not found') || errStr.includes('TOPIC_DELETED')) {
        this.topicToName.set(topicId, `[deleted] topic-${topicId}`);
        this.saveRegistry();
      }
    }
    return null;
  }

  /**
   * Resolve all topic names that are still using the fallback "topic-NNNN" pattern.
   * Called on startup to backfill names for topics created before name tracking.
   */
  async resolveUnknownTopicNames(): Promise<void> {
    const unknowns: number[] = [];
    for (const [topicId, name] of this.topicToName) {
      if (/^topic-\d+$/.test(name)) {
        unknowns.push(topicId);
      }
    }
    if (unknowns.length === 0) return;
    console.log(`[telegram] Resolving ${unknowns.length} unknown topic names...`);
    for (const topicId of unknowns) {
      await this.resolveTopicName(topicId);
      // Small delay to avoid hitting rate limits
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // ── Topic Purpose Management ─────────────────────────────────

  /**
   * Set the purpose for a topic (e.g., "billing", "technical").
   * Purpose is used for outbound content validation.
   */
  setTopicPurpose(topicId: number, purpose: string): void {
    this.topicToPurpose.set(topicId, purpose.toLowerCase());
    this.saveRegistry();
  }

  /**
   * Get the purpose for a topic. Checks runtime map first, then config.
   * Returns null if no purpose is set (permissive — all content allowed).
   */
  getTopicPurpose(topicId: number): string | null {
    // Runtime map takes precedence over config
    const runtimePurpose = this.topicToPurpose.get(topicId);
    if (runtimePurpose) return runtimePurpose;

    // Fall back to config
    const validationConfig = this.config.contentValidation;
    if (validationConfig) {
      return getTopicPurpose(topicId, validationConfig);
    }
    return null;
  }

  /**
   * Get all topic purposes (runtime + config merged).
   */
  getAllTopicPurposes(): Record<number, string> {
    const result: Record<number, string> = {};
    // Config purposes first
    const validationConfig = this.config.contentValidation;
    if (validationConfig) {
      for (const [id, purpose] of Object.entries(validationConfig.topicPurposes)) {
        result[Number(id)] = purpose.toLowerCase();
      }
    }
    // Runtime overrides
    for (const [topicId, purpose] of this.topicToPurpose) {
      result[topicId] = purpose;
    }
    return result;
  }

  /**
   * Validate outbound content against topic purpose.
   * Returns the validation result. Callers decide how to handle rejection.
   */
  validateOutboundContent(
    topicId: number,
    text: string,
    options?: { bypass?: boolean },
  ): { allowed: boolean; reason: string | null; detectedCategory: string | null; topicPurpose: string | null; suggestion: string | null } {
    const validationConfig = this.config.contentValidation;
    if (!validationConfig?.enabled) {
      return { allowed: true, reason: null, detectedCategory: null, topicPurpose: null, suggestion: null };
    }

    const purpose = this.getTopicPurpose(topicId);
    return validateTopicContent(text, purpose, validationConfig, options);
  }

  /**
   * Classify content using the configured categories.
   * Useful for debugging and API endpoints.
   */
  classifyContent(text: string): { category: string | null; confidence: string; matchedKeywords: string[] } {
    const validationConfig = this.config.contentValidation;
    if (!validationConfig) {
      return { category: null, confidence: 'low', matchedKeywords: [] };
    }
    return classifyContent(text, validationConfig.categories);
  }

  /**
   * Get all topic-session mappings (for admin/debug UIs).
   */
  getAllTopicMappings(): Array<{ topicId: number; sessionName: string; topicName: string | null }> {
    const result: Array<{ topicId: number; sessionName: string; topicName: string | null }> = [];
    for (const [topicId, sessionName] of this.topicToSession) {
      result.push({
        topicId,
        sessionName,
        topicName: this.topicToName.get(topicId) ?? null,
      });
    }
    return result;
  }

  // ── Stall Detection ──────────────────────────────────────

  /**
   * Track that a message was injected into a session.
   * Used by stall detection to alert if no response comes back.
   */
  trackMessageInjection(topicId: number, sessionName: string, messageText: string): void {
    // Phase 1c: Delegate to shared StallDetector when flag is enabled
    if (this.sharedStallDetector) {
      this.sharedStallDetector.trackMessageInjection(topicId.toString(), sessionName, messageText);
      return;
    }

    const key = `${topicId}-${Date.now()}`;
    this.pendingMessages.set(key, {
      topicId,
      sessionName,
      messageText: messageText.slice(0, 100),
      injectedAt: Date.now(),
      alerted: false,
    });
  }

  private clearStallForTopic(topicId: number): void {
    // Phase 1c: Delegate to shared StallDetector when flag is enabled
    if (this.sharedStallDetector) {
      this.sharedStallDetector.clearStallForChannel(topicId.toString());
      return;
    }

    for (const [key, pending] of this.pendingMessages) {
      if (pending.topicId === topicId) {
        this.pendingMessages.delete(key);
      }
    }
  }

  /**
   * Public interface for external callers (e.g., StallTriageNurse) to clear
   * stall tracking for a topic after successful recovery.
   */
  clearStallTracking(topicId: number): void {
    this.clearStallForTopic(topicId);
  }

  /** Clear promise tracking for a topic (e.g., after successful recovery) */
  clearPromiseTracking(topicId: number): void {
    if (this.sharedStallDetector) {
      this.sharedStallDetector.clearPromiseForChannel(topicId.toString());
      return;
    }
    this.pendingPromises.delete(topicId);
  }

  /** Detect "work-in-progress" messages that imply the agent will follow up */
  private isPromiseMessage(text: string): boolean {
    const promisePatterns = [
      /give me (?:a )?(?:couple|few|some) (?:more )?minutes/i,
      /give me (?:a )?(?:minute|moment|second|sec)/i,
      /working on (?:it|this|that)/i,
      /looking into (?:it|this|that)/i,
      /let me (?:check|look|investigate|dig|research)/i,
      /investigating/i,
      /still (?:on it|working|looking)/i,
      /one moment/i,
      /be right back/i,
      /hang on/i,
      /bear with me/i,
      /i'll (?:get back|follow up|check|look into)/i,
      /narrowing (?:it |this |that )?down/i,
    ];
    return promisePatterns.some(p => p.test(text));
  }

  /** Detect messages that indicate the agent delivered on its promise */
  private isFollowThroughMessage(text: string): boolean {
    // Messages that indicate the agent is delivering results (not just status updates)
    // Must be substantially longer than a typical status update
    if (text.length > 200) return true;

    // Explicit completion signals
    const completionPatterns = [
      /here(?:'s| is| are) (?:what|the)/i,
      /i found/i,
      /the (?:issue|problem|bug|fix|solution|answer|result)/i,
      /done|completed|finished|resolved/i,
      /summary|overview|analysis/i,
    ];
    return completionPatterns.some(p => p.test(text));
  }

  /**
   * LLM gate for fallback stall/promise alerts.
   *
   * Before sending a user-facing alert about a stall or expired promise,
   * check with the intelligence provider whether the alert is warranted.
   * This prevents false positives when the StallTriageNurse is unavailable.
   *
   * Returns true if the alert should be sent, false to suppress.
   * If no intelligence provider is available, returns true (fail-open for safety).
   */
  private async confirmStallAlert(context: {
    type: 'stall' | 'promise-expired';
    sessionName: string;
    messageText: string;
    minutesElapsed: number;
    sessionAlive: boolean;
  }): Promise<boolean> {
    if (!this.intelligence) return true; // No LLM available → fail-open

    const prompt = [
      'You are evaluating whether to send an alert to a user about an AI agent session.',
      '',
      `Alert type: ${context.type}`,
      `Session: "${context.sessionName}" (${context.sessionAlive ? 'still running' : 'stopped'})`,
      `Time elapsed: ${context.minutesElapsed} minutes`,
      `Context: "${context.messageText}"`,
      '',
      'Should we send a user-facing alert about this? Consider:',
      '- If the session stopped, the user needs to know',
      '- If the session is still running, it might just be working on a complex task',
      `- ${context.minutesElapsed} minutes is ${context.minutesElapsed > 15 ? 'a long time' : 'moderate'} for an AI task`,
      '',
      'Respond with exactly one word: yes or no.',
    ].join('\n');

    try {
      const response = await this.intelligence.evaluate(prompt, {
        maxTokens: 5,
        temperature: 0,
        attribution: { component: 'TelegramAdapter' }, // attribution for /metrics/features
      });
      const answer = response.trim().toLowerCase();
      if (answer === 'no') {
        console.log(`[telegram] LLM suppressed ${context.type} alert for "${context.sessionName}" (${context.minutesElapsed}m)`);
        return false;
      }
      return true;
    } catch (err) {
      // @silent-fallback-ok — LLM intelligence is optional; fail-open to alert user about stalls
      console.warn(`[telegram] LLM stall confirmation failed, allowing alert:`, err);
      return true; // Fail-open
    }
  }

  /** Get all active topic-session mappings (used by SessionMonitor) */
  getActiveTopicSessions(): Map<number, string> {
    return new Map(this.topicToSession);
  }

  /** Get recent message log entries for analysis */
  getMessageLog(limit = 100): Array<{ topicId: number; text: string; fromUser: boolean; timestamp: string }> {
    try {
      if (!fs.existsSync(this.messageLogPath)) return [];
      // Bounded TAIL read — never the whole file. This only returns the last
      // `limit` entries (default 100), so loading the full multi-MB
      // telegram-messages.jsonl was a needless event-loop blocker (2026-06-22
      // batch). The 512KB window holds ~2,600 recent lines, well over any limit.
      const lines = readJsonlTailLastLines(this.messageLogPath, limit);
      return lines.map(line => {
        try {
          const entry = JSON.parse(line);
          return {
            topicId: entry.topicId,
            text: entry.text || '',
            fromUser: entry.fromUser ?? true,
            timestamp: entry.timestamp || new Date().toISOString(),
          };
        } catch {
          // @silent-fallback-ok — JSONL parse, skip corrupted
          return null;
        }
      }).filter(Boolean) as Array<{ topicId: number; text: string; fromUser: boolean; timestamp: string }>;
    } catch {
      // @silent-fallback-ok — log read, empty array safe
      return [];
    }
  }

  private async checkForStalls(): Promise<void> {
    const stallMinutes = this.config.stallTimeoutMinutes ?? 5;
    const stallThresholdMs = stallMinutes * 60 * 1000;
    const now = Date.now();

    for (const [key, pending] of this.pendingMessages) {
      if (pending.alerted) continue;
      if (now - pending.injectedAt < stallThresholdMs) continue;

      // Check if session is still alive
      const alive = this.onIsSessionAlive
        ? this.onIsSessionAlive(pending.sessionName)
        : true; // assume alive if no checker

      // If alive, verify the session is truly stalled (not just responding through a different path)
      if (alive && this.onIsSessionActive) {
        try {
          const active = await this.onIsSessionActive(pending.sessionName);
          if (active) {
            // Session is producing output — false alarm, clear it
            console.log(`[telegram] Session "${pending.sessionName}" verified active, clearing stall`);
            this.pendingMessages.delete(key);
            continue;
          }
        } catch {
          // Verifier failed — fall through to alert
        }
      }

      pending.alerted = true;

      // Try LLM-powered triage first if available
      if (this.onStallDetected) {
        try {
          const triageResult = await this.onStallDetected(
            pending.topicId, pending.sessionName, pending.messageText, pending.injectedAt,
          );
          if (triageResult.resolved) {
            this.pendingMessages.delete(key);
            continue; // Nurse handled it
          }
          // Nurse couldn't resolve — fall through to quota check / generic alert
        } catch (err) {
          console.warn(`[telegram] Triage nurse error:`, err);
        }
      }

      // Classify the stall — check if it's a quota death
      let isQuotaDeath = false;
      if (this.onClassifySessionDeath) {
        try {
          const classification = await this.onClassifySessionDeath(pending.sessionName);
          if (classification && classification.cause === 'quota_exhaustion') {
            isQuotaDeath = true;
            this.sendToTopic(
              pending.topicId,
              `\ud83d\udd34 Session hit quota limit \u2014 "${pending.sessionName}" can't respond.\n\n` +
              `${classification.detail}\n\n` +
              `Use /quota to check accounts, /switch-account to switch, or /login to authenticate a new account.`,
            ).catch(err => {
              console.error(`[telegram] Quota stall alert failed: ${err}`);
            });
          }
        } catch {
          // Classification failed — fall through to generic
        }
      }

      if (!isQuotaDeath) {
        const minutesAgo = Math.round((now - pending.injectedAt) / 60000);

        // LLM gate: confirm alert is warranted before sending user-facing message
        const shouldAlert = await this.confirmStallAlert({
          type: 'stall',
          sessionName: pending.sessionName,
          messageText: pending.messageText,
          minutesElapsed: minutesAgo,
          sessionAlive: alive,
        });

        if (shouldAlert) {
          const status = alive ? 'running but not responding' : 'no longer running';
          this.sendToTopic(
            pending.topicId,
            `\u26a0\ufe0f No response after ${minutesAgo} minutes. "${pending.sessionName}" is ${status}.\n\nYour message: "${pending.messageText}..."${alive ? '\n\nTry /interrupt to nudge it, or /restart to start fresh.' : '\n\nSend another message and a new session will start automatically.'}`,
          ).catch(err => {
            console.error(`[telegram] Stall alert failed: ${err}`);
          });
        }
      }
    }

    // Check for expired promises (agent said "give me a minute" but never followed up)
    const promiseMinutes = this.config.promiseTimeoutMinutes ?? 10;
    const promiseThresholdMs = promiseMinutes * 60 * 1000;

    if (promiseMinutes > 0) {
      for (const [topicId, promise] of this.pendingPromises) {
        if (promise.alerted) continue;
        if (now - promise.promisedAt < promiseThresholdMs) continue;

        promise.alerted = true;
        console.log(`[telegram] Promise expired for topic ${topicId}: "${promise.promiseText}" (${Math.round((now - promise.promisedAt) / 60000)} min ago)`);

        // Check if session is still alive
        const alive = this.onIsSessionAlive
          ? this.onIsSessionAlive(promise.sessionName)
          : true;

        // Delegate to triage nurse if available
        if (this.onStallDetected) {
          try {
            const triageResult = await this.onStallDetected(
              promise.topicId, promise.sessionName,
              `[promise expired] ${promise.promiseText}`, promise.promisedAt,
            );
            if (triageResult.resolved) {
              this.pendingPromises.delete(topicId);
              continue;
            }
          } catch (err) {
            console.warn(`[telegram] Promise triage error:`, err);
            DegradationReporter.getInstance().report({
              feature: 'TelegramAdapter.onStallDetected',
              primary: 'LLM-based stall triage diagnosis',
              fallback: 'Stall goes undiagnosed',
              reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
              impact: 'Stalled session persists without recovery attempt',
            });
          }
        }

        // Fallback: LLM-gated user-facing alert
        const promiseMinutesAgo = Math.round((now - promise.promisedAt) / 60000);
        const shouldAlertPromise = await this.confirmStallAlert({
          type: 'promise-expired',
          sessionName: promise.sessionName,
          messageText: promise.promiseText,
          minutesElapsed: promiseMinutesAgo,
          sessionAlive: alive,
        });

        if (shouldAlertPromise) {
          if (!alive) {
            await this.sendToTopic(topicId,
              `The session stopped unexpectedly after saying "${promise.promiseText}". Sending a new message will auto-spawn a fresh session.`
            ).catch(() => {});
          } else {
            await this.sendToTopic(topicId,
              `It's been ${promiseMinutesAgo} minutes since the session said "${promise.promiseText}" — checking on it now...`
            ).catch(() => {});
          }
        }
      }

      // Clean up old promise entries
      for (const [topicId, promise] of this.pendingPromises) {
        if (promise.alerted && now - promise.promisedAt > 60 * 60 * 1000) {
          this.pendingPromises.delete(topicId);
        }
      }
    }

    // Clean up old entries (older than 30 minutes, already alerted)
    for (const [key, pending] of this.pendingMessages) {
      if (pending.alerted && now - pending.injectedAt > 30 * 60 * 1000) {
        this.pendingMessages.delete(key);
      }
    }
  }

  /**
   * Handle stall events from the shared StallDetector (Phase 1c).
   * Bridges shared events back to Telegram-specific alert logic
   * (triage nurse, quota classification, LLM gate, user notifications).
   */
  private async handleSharedStallEvent(event: StallEvent, alive: boolean): Promise<void> {
    const topicId = parseInt(event.channelId, 10);

    // Phase 1e: Emit to event bus
    if (this.eventBus) {
      if (event.type === 'stall') {
        this.eventBus.emit('stall:detected', {
          channelId: event.channelId,
          sessionName: event.sessionName,
          messageText: event.messageText,
          injectedAt: event.injectedAt,
          minutesElapsed: event.minutesElapsed,
          alive,
        }).catch(err => console.error(`[telegram] EventBus stall:detected error: ${err}`));
      } else {
        this.eventBus.emit('stall:promise-expired', {
          channelId: event.channelId,
          sessionName: event.sessionName,
          promiseText: event.messageText,
          promisedAt: event.injectedAt,
          minutesElapsed: event.minutesElapsed,
          alive,
        }).catch(err => console.error(`[telegram] EventBus stall:promise-expired error: ${err}`));
      }
    }

    if (event.type === 'stall') {
      // Try LLM-powered triage first
      if (this.onStallDetected) {
        try {
          const triageResult = await this.onStallDetected(
            topicId, event.sessionName, event.messageText, event.injectedAt,
          );
          if (triageResult.resolved) return;
        } catch (err) {
          console.warn(`[telegram] Triage nurse error:`, err);
        }
      }

      // Classify — check if it's a quota death
      let isQuotaDeath = false;
      if (this.onClassifySessionDeath) {
        try {
          const classification = await this.onClassifySessionDeath(event.sessionName);
          if (classification && classification.cause === 'quota_exhaustion') {
            isQuotaDeath = true;
            this.sendToTopic(
              topicId,
              `\ud83d\udd34 Session hit quota limit \u2014 "${event.sessionName}" can't respond.\n\n` +
              `${classification.detail}\n\n` +
              `Use /quota to check accounts, /switch-account to switch, or /login to authenticate a new account.`,
            ).catch(err => console.error(`[telegram] Quota stall alert failed: ${err}`));
          }
        } catch { /* Classification failed — fall through */ }
      }

      if (!isQuotaDeath) {
        const shouldAlert = await this.confirmStallAlert({
          type: 'stall',
          sessionName: event.sessionName,
          messageText: event.messageText,
          minutesElapsed: event.minutesElapsed,
          sessionAlive: alive,
        });

        if (shouldAlert) {
          const status = alive ? 'running but not responding' : 'no longer running';
          this.sendToTopic(
            topicId,
            `\u26a0\ufe0f No response after ${event.minutesElapsed} minutes. Session "${event.sessionName}" is ${status}.\n\nMessage: "${event.messageText}..."${alive ? '\n\nTry /interrupt to unstick, or /restart to respawn.' : '\n\nSend another message to auto-respawn.'}`,
          ).catch(err => console.error(`[telegram] Stall alert failed: ${err}`));
        }
      }
    } else if (event.type === 'promise-expired') {
      // Try triage nurse first
      if (this.onStallDetected) {
        try {
          const triageResult = await this.onStallDetected(
            topicId, event.sessionName, `[promise expired] ${event.messageText}`, event.injectedAt,
          );
          if (triageResult.resolved) return;
        } catch (err) {
          console.warn(`[telegram] Promise triage error:`, err);
        }
      }

      const shouldAlert = await this.confirmStallAlert({
        type: 'promise-expired',
        sessionName: event.sessionName,
        messageText: event.messageText,
        minutesElapsed: event.minutesElapsed,
        sessionAlive: alive,
      });

      if (shouldAlert) {
        if (!alive) {
          await this.sendToTopic(topicId,
            `The session stopped unexpectedly after saying "${event.messageText}". Sending a new message will auto-spawn a fresh session.`
          ).catch(() => {});
        } else {
          await this.sendToTopic(topicId,
            `It's been ${event.minutesElapsed} minutes since the session said "${event.messageText}" — checking on it now...`
          ).catch(() => {});
        }
      }
    }
  }

  // ── Health Status ────────────────────────────────────────

  getStatus(): {
    started: boolean;
    uptime: number | null;
    pendingStalls: number;
    pendingPromises: number;
    topicMappings: number;
    lastError: string | null;
    consecutivePollErrors: number;
    fatalReason: '401' | 'network' | 'no-usable-bot-token' | null;
    stoppedAt: string | null;
  } {
    const stallStatus = this.sharedStallDetector
      ? this.sharedStallDetector.getStatus()
      : { pendingStalls: this.pendingMessages.size, pendingPromises: this.pendingPromises.size };

    return {
      started: this.polling,
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : null,
      pendingStalls: stallStatus.pendingStalls,
      pendingPromises: stallStatus.pendingPromises,
      topicMappings: this.topicToSession.size,
      lastError: this.lastPollError,
      consecutivePollErrors: this.consecutivePollErrors,
      fatalReason: this.fatalPollReason,
      stoppedAt: this.pollStoppedAt ? this.pollStoppedAt.toISOString() : null,
    };
  }

  // ── Voice Transcription ──────────────────────────────────

  /**
   * Download a file from Telegram by file_id.
   */
  private async downloadFile(fileId: string, destPath: string): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const fileInfo = await this.apiCall('getFile', { file_id: fileId }) as { file_path: string };
        const fileUrl = `https://api.telegram.org/file/bot${this.config.token}/${fileInfo.file_path}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        try {
          const response = await fetch(fileUrl, { signal: controller.signal });
          if (!response.ok) throw new Error(`Download failed: ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(destPath, buffer);
          return; // Success
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = attempt * 1000;
          console.warn(`[telegram] File download attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  /**
   * Resolve voice transcription provider from config or environment.
   * Checks explicit config, then env vars, then auto-detects.
   */
  private resolveTranscriptionProvider(): { apiKey: string; baseUrl: string; model: string } | null {
    const providers: Record<string, { envKey: string; baseUrl: string; model: string }> = {
      groq: {
        envKey: 'GROQ_API_KEY',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'whisper-large-v3',
      },
      openai: {
        envKey: 'OPENAI_API_KEY',
        baseUrl: 'https://api.openai.com/v1',
        model: 'whisper-1',
      },
    };

    // Check explicit config
    const explicit = this.config.voiceProvider?.toLowerCase();
    if (explicit && providers[explicit]) {
      const p = providers[explicit];
      const apiKey = process.env[p.envKey];
      if (!apiKey) {
        console.warn(`[telegram] ${p.envKey} not set — required for ${explicit} voice transcription`);
        return null;
      }
      return { apiKey, baseUrl: p.baseUrl, model: p.model };
    }

    // Auto-detect: try Groq first (cheaper), then OpenAI
    for (const [name, p] of Object.entries(providers)) {
      const apiKey = process.env[p.envKey];
      if (apiKey) {
        console.log(`[telegram] Auto-detected voice transcription provider: ${name}`);
        return { apiKey, baseUrl: p.baseUrl, model: p.model };
      }
    }

    return null;
  }

  /**
   * Transcribe a voice message using the configured provider.
   */
  private async transcribeVoice(filePath: string): Promise<string> {
    const provider = this.resolveTranscriptionProvider();
    if (!provider) {
      throw new Error('No voice transcription provider configured. Set GROQ_API_KEY or OPENAI_API_KEY.');
    }

    const formData = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'audio/ogg' });
    formData.append('file', blob, path.basename(filePath));
    formData.append('model', provider.model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Transcription API error (${response.status}): ${errText}`);
      }

      const data = await response.json() as { text: string };
      return data.text;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Photo Handling ───────────────────────────────────────

  /**
   * Download a photo from Telegram and save it locally.
   * Returns the local file path.
   */
  private async downloadPhoto(fileId: string, messageId: number): Promise<string> {
    const photoDir = path.join(this.stateDir, 'telegram-images');
    fs.mkdirSync(photoDir, { recursive: true });
    const filename = `photo-${Date.now()}-${messageId}.jpg`;
    const filepath = path.join(photoDir, filename);
    await this.downloadFile(fileId, filepath);
    return filepath;
  }

  // ── Document Handling ───────────────────────────────────

  /**
   * Download a document from Telegram and save it locally.
   * Preserves the original filename when available.
   * Returns the local file path.
   */
  private async downloadDocument(fileId: string, messageId: number, originalName?: string): Promise<string> {
    const docDir = path.join(this.stateDir, 'telegram-documents');
    fs.mkdirSync(docDir, { recursive: true });
    const ext = originalName ? path.extname(originalName) : '';
    const baseName = originalName
      ? originalName.replace(/[^a-zA-Z0-9._-]/g, '_')
      : `document-${messageId}${ext}`;
    const filename = `${Date.now()}-${baseName}`;
    const filepath = path.join(docDir, filename);
    await this.downloadFile(fileId, filepath);
    return filepath;
  }

  // ── Command Handling ─────────────────────────────────────

  /**
   * Process Telegram commands. Returns true if the message was a command.
   */
  public async handleCommand(text: string, topicId: number, userId: number): Promise<boolean> {
    // Phase 1a: Delegate to shared CommandRouter when flag is enabled
    if (this.sharedCommandRouter) {
      return this.sharedCommandRouter.route(
        text,
        topicId.toString(),
        userId.toString(),
        { telegramUserId: userId, topicId },
      );
    }

    const cmd = text.trim().toLowerCase();

    // Attention topic commands — intercept before general commands
    if (this.isAttentionTopic(topicId)) {
      const handled = await this.handleAttentionCommand(topicId, text);
      if (handled) return true;
    }

    // /flush — flush all batched notifications immediately
    if (cmd === '/flush') {
      if (this.batcher && this.batcher.isEnabled()) {
        const flushed = await this.batcher.flushAll();
        if (flushed > 0) {
          await this.sendToTopic(topicId, `Flushed ${flushed} batched notification${flushed === 1 ? '' : 's'}.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, 'No batched notifications to flush.').catch(() => {});
        }
      } else if (this.onFlushNotifications) {
        this.onFlushNotifications(topicId).catch(err => {
          console.error('[telegram] Flush notifications failed:', err);
          this.sendToTopic(topicId, 'Failed to flush notifications.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Notification batching is not enabled.').catch(() => {});
      }
      return true;
    }

    // /sessions — list all sessions with claim status
    if (cmd === '/sessions' || cmd.startsWith('/sessions ')) {
      const filterUnclaimed = cmd.includes('unclaimed');
      if (!this.onListSessions) {
        await this.sendToTopic(topicId, 'Session listing not available.').catch(() => {});
        return true;
      }

      const sessions = this.onListSessions();
      if (sessions.length === 0) {
        await this.sendToTopic(topicId, 'No sessions running.').catch(() => {});
        return true;
      }

      const lines: string[] = [];
      for (const s of sessions) {
        const linkedTopic = this.getTopicForSession(s.tmuxSession);
        const claimed = linkedTopic !== null;
        if (filterUnclaimed && claimed) continue;

        const status = s.alive ? '\u2705' : '\u274c';
        const claimTag = claimed ? ` (topic ${linkedTopic})` : ' \u{1f7e1} unclaimed';
        lines.push(`${status} ${s.name}${claimTag}`);
      }

      if (lines.length === 0) {
        await this.sendToTopic(topicId, filterUnclaimed ? 'No unclaimed sessions.' : 'No sessions.').catch(() => {});
      } else {
        await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      }
      return true;
    }

    // /local-model — get or set the local-model provider for this topic.
    // Requires the topic to already be on codex-cli (use /route codex-cli
    // first). Local-model dispatch goes through Codex CLI's --oss
    // --local-provider passthrough; the server validates the provider is
    // reachable before flipping the binding.
    //
    // Usage:
    //   /local-model                       → show current binding
    //   /local-model status                → same as above
    //   /local-model ollama                → switch to ollama (default model)
    //   /local-model ollama llama3.2:latest
    //                                      → switch to ollama + specific model
    //   /local-model lmstudio <model>      → switch to LM Studio
    //   /local-model off / none            → revert to cloud Codex
    if (cmd === '/local-model' || cmd.startsWith('/local-model ')) {
      if (!this.onLocalModelCommand) {
        await this.sendToTopic(topicId, 'Local-model routing not available — server did not wire the /local-model handler.').catch(() => {});
        return true;
      }
      const argText = cmd === '/local-model' ? '' : text.trim().slice('/local-model '.length).trim();
      let provider: string | null = null;
      let model: string | null = null;
      if (argText !== '' && argText.toLowerCase() !== 'status') {
        const parts = argText.split(/\s+/);
        provider = parts[0]!.toLowerCase();
        if (parts.length > 1) model = parts.slice(1).join(' ');
      }
      try {
        const result = await this.onLocalModelCommand(topicId, provider, model);
        await this.sendToTopic(topicId, result.message).catch(() => {});
      } catch (err) {
        await this.sendToTopic(topicId, `Local-model switch failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
      return true;
    }

    // /route — get or set the framework adapter for this topic.
    // Usage:
    //   /route             → show current adapter
    //   /route status      → same as /route
    //   /route claude-code → switch this topic to Claude Code
    //   /route codex-cli   → switch this topic to Codex
    if (cmd === '/route' || cmd.startsWith('/route ')) {
      if (!this.onRouteCommand) {
        await this.sendToTopic(topicId, 'Routing not available — server did not wire the /route handler.').catch(() => {});
        return true;
      }
      const arg = cmd === '/route' ? '' : text.trim().slice('/route '.length).trim().toLowerCase();
      const requested = arg === '' || arg === 'status' ? null : arg;
      try {
        // §10.1: forward the authenticated sender uid down to the write.
        const result = await this.onRouteCommand(topicId, requested, userId);
        await this.sendToTopic(topicId, result.message).catch(() => {});
      } catch (err) {
        await this.sendToTopic(topicId, `Routing failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
      return true;
    }

    // /topic — get or set this topic's full execution profile (framework /
    // model / thinking-mode / escalation), TOPIC-PROFILE-SPEC §10.1.
    // Usage:
    //   /topic                          → show the resolved profile
    //   /topic <framework>              → pin the framework
    //   /topic model <id>               → pin an explicit baseline model
    //   /topic tier default|escalated   → pin the baseline tier
    //   /topic thinking off|low|medium|high|max
    //   /topic escalation inherit|suppress
    //   /topic clear · /topic undo · /topic re-apply
    if (cmd === '/topic' || cmd.startsWith('/topic ')) {
      if (!this.onTopicProfileCommand) {
        await this.sendToTopic(topicId, 'Topic profiles not available — server did not wire the /topic handler.').catch(() => {});
        return true;
      }
      const argText = cmd === '/topic' ? '' : text.trim().slice('/topic '.length).trim();
      try {
        const result = await this.onTopicProfileCommand(topicId, argText, userId);
        await this.sendToTopic(topicId, result.message).catch(() => {});
      } catch (err) {
        await this.sendToTopic(topicId, `Topic profile change failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
      return true;
    }

    // /claim <session> — claim a session into this topic
    if (cmd.startsWith('/claim ')) {
      const sessionName = text.trim().slice(7).trim();
      if (!sessionName) {
        await this.sendToTopic(topicId, 'Please include a session name — e.g. /claim my-session').catch(() => {});
        return true;
      }

      // Check if already claimed
      const existingSession = this.getSessionForTopic(topicId);
      if (existingSession) {
        await this.sendToTopic(topicId, `This topic is already linked to "${existingSession}". Use /unlink first.`).catch(() => {});
        return true;
      }

      this.registerTopicSession(topicId, sessionName);
      await this.sendToTopic(topicId, `Claimed session "${sessionName}" into this topic.`).catch(() => {});
      return true;
    }

    // /link <session> — alias for /claim
    if (cmd.startsWith('/link ')) {
      const sessionName = text.trim().slice(6).trim();
      if (!sessionName) {
        await this.sendToTopic(topicId, 'Please include a session name — e.g. /link my-session').catch(() => {});
        return true;
      }

      const existingSession = this.getSessionForTopic(topicId);
      if (existingSession) {
        await this.sendToTopic(topicId, `This topic is already linked to "${existingSession}". Use /unlink first.`).catch(() => {});
        return true;
      }

      this.registerTopicSession(topicId, sessionName);
      await this.sendToTopic(topicId, `Linked session "${sessionName}" to this topic.`).catch(() => {});
      return true;
    }

    // /unlink — unlink session from this topic
    if (cmd === '/unlink') {
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }

      this.unregisterTopic(topicId);
      await this.sendToTopic(topicId, `Unlinked session "${sessionName}" from this topic.`).catch(() => {});
      return true;
    }

    // /interrupt — send Escape to unstick a stalled session
    if (cmd === '/interrupt') {
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }

      if (!this.onInterruptSession) {
        await this.sendToTopic(topicId, 'Interrupt not available (no handler registered).').catch(() => {});
        return true;
      }

      try {
        const success = await this.onInterruptSession(sessionName);
        // Clear stall tracking — user is actively intervening
        this.clearStallForTopic(topicId);
        if (success) {
          await this.sendToTopic(topicId, `Nudged "${sessionName}" \u2014 it should resume shortly.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, `Failed to interrupt "${sessionName}" \u2014 session may not exist.`).catch(() => {});
        }
      } catch (err) {
        console.error(`[telegram] Interrupt failed:`, err);
        await this.sendToTopic(topicId, 'Couldn\'t interrupt the session. It may have already ended.').catch(() => {});
      }
      return true;
    }

    // /restart — kill and respawn the session for this topic
    if (cmd === '/restart') {
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }

      if (!this.onRestartSession) {
        await this.sendToTopic(topicId, 'Restart not available (no handler registered).').catch(() => {});
        return true;
      }

      // Clear stall tracking — user is actively intervening
      this.clearStallForTopic(topicId);
      await this.sendToTopic(topicId, `Restarting "${sessionName}"...`).catch(() => {});
      try {
        await this.onRestartSession(sessionName, topicId);
        await this.sendToTopic(topicId, 'Session restarted.').catch(() => {});
      } catch (err) {
        console.error(`[telegram] Restart failed:`, err);
        await this.sendToTopic(topicId, 'Restart didn\'t work. The session may need to be recreated — try sending a new message.').catch(() => {});
      }
      return true;
    }

    // /status — show Telegram adapter status
    if (cmd === '/status') {
      const s = this.getStatus();
      const lines = [
        `Telegram adapter: ${s.started ? '\u2705 running' : '\u274c stopped'}`,
        `Uptime: ${s.uptime ? Math.round(s.uptime / 60000) + 'm' : 'n/a'}`,
        `Topic mappings: ${s.topicMappings}`,
        `Pending stall alerts: ${s.pendingStalls}`,
      ];
      await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      return true;
    }

    // /triage — show triage status for this topic
    if (cmd === '/triage') {
      if (!this.onGetTriageStatus) {
        await this.sendToTopic(topicId, 'Triage system not available.').catch(() => {});
        return true;
      }
      const status = this.onGetTriageStatus(topicId);
      if (!status || !status.active) {
        await this.sendToTopic(topicId, '🔍 No active triage for this topic. Session appears to be operating normally.').catch(() => {});
      } else {
        const lines = [
          `🔍 Active triage for this topic:`,
          `Classification: ${status.classification || 'pending'}`,
          `Checks: ${status.checkCount}`,
          status.lastCheck ? `Last check: ${status.lastCheck}` : '',
        ].filter(Boolean);
        await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      }
      return true;
    }

    // /switch-account (or /sa) <target> — switch active Claude account
    const switchMatch = text.match(/^\/(?:switch[-_]?account|sa)\s+(.+)$/i);
    if (switchMatch) {
      const target = switchMatch[1].trim();
      if (this.onSwitchAccountRequest) {
        this.onSwitchAccountRequest(target, topicId).catch(err => {
          console.error('[telegram] Switch account failed:', err);
          this.sendToTopic(topicId, 'Account switch didn\'t work. Try again or use /quota to check status.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Account switching not available.').catch(() => {});
      }
      return true;
    }

    // /quota (or /q) — show multi-account quota summary
    if (cmd === '/quota' || cmd === '/q') {
      if (this.onQuotaStatusRequest) {
        this.onQuotaStatusRequest(topicId).catch(err => {
          console.error('[telegram] Quota status failed:', err);
          this.sendToTopic(topicId, 'Couldn\'t check quota right now. Try again in a moment.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Quota status not available.').catch(() => {});
      }
      return true;
    }

    // /login [email] — seamless OAuth login from Telegram
    const loginMatch = text.match(/^\/login(?:\s+(.+))?$/i);
    if (loginMatch) {
      const email = loginMatch[1]?.trim() || null;
      if (this.onLoginRequest) {
        this.onLoginRequest(email, topicId).catch(err => {
          // @silent-fallback-ok — login error, user notified
          console.error('[telegram] Login flow failed:', err);
          this.sendToTopic(topicId, 'Login didn\'t complete. Try again, or the auth service may be temporarily unavailable.').catch(() => { /* @silent-fallback-ok — secondary notification */ });
        });
      } else {
        await this.sendToTopic(topicId, 'Login not available.').catch(() => { /* @silent-fallback-ok — secondary notification */ });
      }
      return true;
    }

    // /new is handled in server.ts onTopicMessage — it needs sessionManager
    // access to spawn a session in the new topic. Don't intercept it here.

    return false;
  }

  // ── Message Log ────────────────────────────────────────────

  /**
   * Search the message log with flexible filters.
   * Supports text query, topicId filter, date range, and pagination.
   */
  searchLog(opts: {
    query?: string;
    topicId?: number;
    since?: Date;
    limit?: number;
  } = {}): LogEntry[] {
    if (!fs.existsSync(this.messageLogPath)) return [];

    const limit = Math.min(opts.limit ?? 50, 500);
    const queryLower = opts.query?.toLowerCase();
    const sinceMs = opts.since?.getTime();

    const content = fs.readFileSync(this.messageLogPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    // Scan from end for efficiency (most queries want recent messages)
    const matches: LogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && matches.length < limit; i--) {
      try {
        const entry: LogEntry = JSON.parse(lines[i]);

        if (opts.topicId !== undefined && entry.topicId !== opts.topicId) continue;
        if (sinceMs && new Date(entry.timestamp).getTime() < sinceMs) continue;
        if (queryLower && !entry.text.toLowerCase().includes(queryLower)) continue;

        matches.unshift(entry); // Maintain chronological order
      } catch { /* skip malformed */ }
    }

    return matches;
  }

  /**
   * Get message log statistics.
   */
  getLogStats(): { totalMessages: number; logSizeBytes: number; logPath: string } {
    if (!fs.existsSync(this.messageLogPath)) {
      return { totalMessages: 0, logSizeBytes: 0, logPath: this.messageLogPath };
    }
    const stat = fs.statSync(this.messageLogPath);
    const content = fs.readFileSync(this.messageLogPath, 'utf-8');
    const lineCount = content.split('\n').filter(Boolean).length;
    return { totalMessages: lineCount, logSizeBytes: stat.size, logPath: this.messageLogPath };
  }

  /**
   * Get recent messages for a topic (for thread history on respawn, the live-tail
   * streamer, and the handoff hash).
   *
   * Served from the in-memory tail cache after a one-time lazy seed from the
   * JSONL — the file is NOT re-read per call. (Pre-fix, the live-tail streamer
   * called this for every known topic every 5s, each call synchronously reading
   * the full multi-MB log: the measured cause of the 2026-06-05 event-loop
   * stalls.) Requests beyond the cache window fall through to a direct file scan.
   */
  getTopicHistory(topicId: number, limit: number = 20): LogEntry[] {
    if (limit <= TelegramAdapter.TAIL_CACHE_LIMIT) {
      const cached = this.topicTailCache.get(topicId);
      if (cached) return cached.slice(-limit);
      // First miss: batch-seed every LIVE topic (topicToSession) in ONE file
      // pass — the live-tail streamer enumerates exactly that set, so without
      // this its first tick would trigger one full-file scan PER topic.
      if (!this.tailCacheSeeded) {
        this.seedTailCacheFromLog();
        this.tailCacheSeeded = true;
        const justSeeded = this.topicTailCache.get(topicId);
        if (justSeeded) return justSeeded.slice(-limit);
      }
      // Not a live topic (e.g. respawn history for an unregistered topic) —
      // per-topic scan once, then cache it.
      const seeded = this.scanLogForTopic(topicId, TelegramAdapter.TAIL_CACHE_LIMIT);
      this.topicTailCache.set(topicId, seeded);
      return seeded.slice(-limit);
    }
    // Oversized request (no production caller) — direct scan, leave the cache's
    // "most recent TAIL_CACHE_LIMIT entries" invariant untouched.
    return this.scanLogForTopic(topicId, limit);
  }

  /**
   * Single-pass cache seed: parse the JSONL once and build the recent tail for
   * every topic with a registered session (the set the live-tail streamer
   * enumerates). Topics with no entries get an empty array so they never
   * trigger a per-topic file scan of their own.
   */
  private seedTailCacheFromLog(): void {
    for (const id of this.topicToSession.keys()) {
      if (!this.topicTailCache.has(id)) this.topicTailCache.set(id, []);
    }
    if (!fs.existsSync(this.messageLogPath)) return;
    let lines: string[];
    try {
      lines = fs.readFileSync(this.messageLogPath, 'utf-8').split('\n').filter(Boolean);
    } catch (err) {
      // @silent-fallback-ok — a transiently unreadable log just means the seed
      // is empty this boot; per-topic reads still work and appends repopulate.
      console.error(`[telegram] tail-cache seed failed to read message log: ${err}`);
      return;
    }
    for (const line of lines) {
      try {
        const entry: LogEntry = JSON.parse(line);
        const entryTopicId = entry.topicId ?? (entry as unknown as { channelId?: number }).channelId;
        if (typeof entryTopicId !== 'number') continue;
        const tail = this.topicTailCache.get(entryTopicId);
        if (!tail) continue; // not a live topic — lazy per-topic path covers it
        tail.push(entry);
        if (tail.length > TelegramAdapter.TAIL_CACHE_LIMIT) tail.shift();
      } catch { /* @silent-fallback-ok — skip a malformed JSONL line, identical to the scan path's long-standing behavior */ }
    }
  }

  /** Full JSONL scan for a topic's most recent entries (the cache seed / fallback path). */
  private scanLogForTopic(topicId: number, limit: number): LogEntry[] {
    if (!fs.existsSync(this.messageLogPath)) return [];

    // Read the file to find matching entries.
    // Log rotation caps at 75,000 lines, so this is bounded.
    const content = fs.readFileSync(this.messageLogPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    // Scan from end to find matching entries (most recent first).
    // Lines written via the shared MessageLogger carry `channelId` instead of
    // `topicId` (same compat dance as MessageLogger.search) — accept both so the
    // scan (and the tail-cache seed built from it) sees every writer's entries.
    const matching: LogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && matching.length < limit; i--) {
      try {
        const entry: LogEntry = JSON.parse(lines[i]);
        const entryTopicId = entry.topicId ?? (entry as unknown as { channelId?: number }).channelId;
        if (entryTopicId === topicId) {
          matching.unshift(entry); // Maintain chronological order
        }
      } catch { /* skip malformed */ }
    }

    return matching;
  }

  /**
   * Cheap, monotonic per-topic change signal for the live-tail streamer: bumped
   * on every message logged for the topic. Equal versions ⇒ identical tail
   * content, so the streamer can skip serializing unchanged topics.
   */
  getTopicContentVersion(topicId: number): number {
    return this.topicContentVersion.get(topicId) ?? 0;
  }

  private appendToLog(entry: LogEntry): void {
    // Maintain the per-topic change signal + tail cache FIRST — both paths below
    // (shared logger / legacy file) persist the same entry, and every logged
    // message must be visible to getTopicHistory/getTopicContentVersion callers
    // regardless of which writer is active. Only a topic already seeded gets a
    // cache append (an unseeded topic seeds lazily from the file on first read).
    if (typeof entry.topicId === 'number') {
      this.topicContentVersion.set(entry.topicId, (this.topicContentVersion.get(entry.topicId) ?? 0) + 1);
      const tail = this.topicTailCache.get(entry.topicId);
      if (tail) {
        tail.push(entry);
        if (tail.length > TelegramAdapter.TAIL_CACHE_LIMIT) tail.shift();
      }
    }

    // Phase 1b: Delegate to shared MessageLogger when flag is enabled
    if (this.sharedLogger) {
      this.sharedLogger.append({
        messageId: entry.messageId,
        channelId: entry.topicId,
        text: entry.text,
        fromUser: entry.fromUser,
        timestamp: entry.timestamp,
        sessionName: entry.sessionName,
        senderName: entry.senderName,
        senderUsername: entry.senderUsername,
        platformUserId: entry.telegramUserId,
        platform: 'telegram',
      });
      // Also notify the Telegram-specific callback for backward compatibility
      if (this.onMessageLogged) {
        try {
          this.onMessageLogged(entry);
        } catch (err) {
          DegradationReporter.getInstance().report({
            feature: 'TopicMemory.dualWrite',
            primary: 'SQLite dual-write of messages for search and summaries',
            fallback: 'Message only in JSONL log (no search, no summary updates)',
            reason: `onMessageLogged callback failed: ${err instanceof Error ? err.message : String(err)}`,
            impact: 'Message may be missing from topic search and context summaries.',
          });
        }
      }
      // Phase 1e: Emit to event bus
      if (this.eventBus) {
        this.eventBus.emit('message:logged', {
          messageId: entry.messageId,
          channelId: entry.topicId?.toString() ?? '',
          text: entry.text,
          fromUser: entry.fromUser,
          timestamp: entry.timestamp,
          sessionName: entry.sessionName,
          senderName: entry.senderName,
          senderUsername: entry.senderUsername,
          platformUserId: entry.telegramUserId?.toString(),
        }).catch(err => console.error(`[telegram] EventBus message:logged error: ${err}`));
      }
      return;
    }

    // Legacy path (flag disabled)
    try {
      fs.appendFileSync(this.messageLogPath, JSON.stringify(entry) + '\n');
      this.maybeRotateLog();
    } catch (err) {
      console.error(`[telegram] Failed to append to message log: ${err}`);
      DegradationReporter.getInstance().report({
        feature: 'Telegram.messageLog',
        primary: 'JSONL message log for conversation history and recovery',
        fallback: 'Message lost from persistent log (only in memory)',
        reason: `Failed to write message log: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Conversation history gap — message may be missing from JSONL backup.',
      });
    }

    // Notify subscribers (TopicMemory for SQLite dual-write)
    if (this.onMessageLogged) {
      try {
        this.onMessageLogged(entry);
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'TopicMemory.dualWrite',
          primary: 'SQLite dual-write of messages for search and summaries',
          fallback: 'Message only in JSONL log (no search, no summary updates)',
          reason: `onMessageLogged callback failed: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'Message may be missing from topic search and context summaries.',
        });
      }
    }
    // Phase 1e: Emit to event bus
    if (this.eventBus) {
      this.eventBus.emit('message:logged', {
        messageId: entry.messageId,
        channelId: entry.topicId?.toString() ?? '',
        text: entry.text,
        fromUser: entry.fromUser,
        timestamp: entry.timestamp,
        sessionName: entry.sessionName,
        senderName: entry.senderName,
        senderUsername: entry.senderUsername,
        platformUserId: entry.telegramUserId?.toString(),
      }).catch(err => console.error(`[telegram] EventBus message:logged error: ${err}`));
    }
  }

  /** Keep only the last 75,000 lines when log exceeds 100,000 lines.
   *  High limits because message history is core agent memory.
   *  At ~200 bytes/line average, 100k lines ~ 20MB — fine for a dedicated machine. */
  private maybeRotateLog(): void {
    try {
      const stat = fs.statSync(this.messageLogPath);
      // Only check rotation when file exceeds ~20MB
      if (stat.size < 20 * 1024 * 1024) return;

      const content = fs.readFileSync(this.messageLogPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > 100_000) {
        const kept = lines.slice(-75_000);
        const tmpPath = `${this.messageLogPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          fs.writeFileSync(tmpPath, kept.join('\n') + '\n');
          fs.renameSync(tmpPath, this.messageLogPath);
        } catch (rotateErr) {
          try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/messaging/TelegramAdapter.ts:2844' }); } catch { /* ignore */ }
          throw rotateErr;
        }
        console.log(`[telegram] Rotated message log: ${lines.length} -> ${kept.length} lines`);
      }
    } catch {
      // @silent-fallback-ok — log rotation non-critical
    }
  }

  // ── Attention Queue ────────────────────────────────────────

  /**
   * Create an attention item and its Telegram topic.
   */
  async createAttentionItem(item: Omit<AttentionItem, 'createdAt' | 'updatedAt' | 'status' | 'topicId'>): Promise<AttentionItem> {
    // Check for existing
    if (this.attentionItems.has(item.id)) {
      return this.attentionItems.get(item.id)!;
    }

    const now = new Date().toISOString();
    const attention: AttentionItem = {
      ...item,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
    };

    // ── Agent-Health lane (calm self-health notices) ─────────────────────
    // A routine self-health/housekeeping notice routes into ONE named "🩺 Agent
    // Health" topic from the very first item — it never spawns its own topic
    // (even under budget, even if mis-tagged HIGH) and same-entity re-escalations
    // are suppression-deduped. This runs BEFORE the flood guard and bypasses it
    // entirely, so a stale-session/peer-unreachable feature can never flood
    // topic-after-topic. Only items that explicitly opt in are affected.
    if (this.agentHealthLaneCfg.enabled && item.lane === 'agent-health') {
      const laneTopicId = await this.routeToAgentHealthLane(attention);
      attention.coalesced = true;
      if (laneTopicId !== null) attention.topicId = laneTopicId;
      this.attentionItems.set(item.id, attention);
      this.saveAttentionItems();
      return attention;
    }

    // ── Topic-flood circuit breaker (2026-05-28 lockdown) ──────────────
    // Before spawning a per-item forum topic, consult the per-source guard.
    // HIGH/URGENT always pass (critical items must always be visible). A
    // non-critical source that exceeds its topic budget within the window has
    // its items COALESCED into one running notice topic + logged — never a
    // wall of new topics. No item is dropped; only the per-item topic is held.
    const guardSource = item.sourceContext || item.category || 'unknown';
    const decision = this.attentionTopicGuard.decide(guardSource, item.priority);
    if (decision.action === 'coalesce') {
      this.writeSuppressedAttentionLog(attention, decision.bucket, decision.suppressedCount);
      const noticeTopicId = await this.routeToFloodNotice(decision.bucket, attention, decision);
      // Mark coalesced and record the (shared) notice topic for reference ONLY.
      // Deliberately do NOT register the per-item topic maps: many items share one
      // notice topic, so registering them would (a) make `loadAttentionItems`
      // last-writer-win-corrupt the reverse map on restart and (b) make
      // `updateAttentionStatus` close the shared topic when ONE sibling resolves.
      // Coalesced items are managed via /attention (PATCH / dashboard), not /ack.
      attention.coalesced = true;
      if (noticeTopicId !== null) attention.topicId = noticeTopicId;
      this.attentionItems.set(item.id, attention);
      this.saveAttentionItems();
      return attention;
    }

    // Create Telegram topic (uses the centralized method for forum detection)
    try {
      const emoji = PRIORITY_EMOJI[item.priority] || PRIORITY_EMOJI.NORMAL;
      const color = PRIORITY_COLOR[item.priority] || PRIORITY_COLOR.NORMAL;
      const topicTitle = `${emoji} ${item.title}`.slice(0, 128);

      // HIGH/URGENT are 'system' (the guard's critical-never-coalesced
      // invariant holds at both layers); everything else is budgeted 'auto'.
      const critical = item.priority === 'HIGH' || item.priority === 'URGENT';
      const topic = await this.createForumTopic(topicTitle, color, {
        origin: critical ? 'system' : 'auto',
        label: 'attention-item',
      });

      const topicId = topic.topicId;
      attention.topicId = topicId;

      // Register mappings
      this.attentionItemToTopic.set(item.id, topicId);
      this.attentionTopicToItem.set(topicId, item.id);
      this.topicToName.set(topicId, item.title);
      // Registry already saved by createForumTopic

      // Post details as first message
      const detail = [
        `<b>${this.escapeHtml(item.category)}</b> | Priority: ${item.priority}`,
        ``,
        this.escapeHtml(item.summary),
        item.description ? `\n${this.escapeHtml(item.description.slice(0, 1000))}` : '',
        item.sourceContext ? `\n<i>Source: ${this.escapeHtml(item.sourceContext)}</i>` : '',
        ``,
        `Commands: /ack, /done, /wontdo, /reopen`,
      ].filter(Boolean).join('\n');

      // Send as HTML by calling API directly. `_formatMode: 'html'` tells the
      // formatter wireup that this text is already Telegram HTML (escaped via
      // this.escapeHtml above) so the markdown converter must not re-process it.
      const sendParams: Record<string, unknown> = {
        chat_id: this.config.chatId,
        text: detail,
        parse_mode: 'HTML',
        _formatMode: 'html',
      };
      if (!isGeneralTopic(topicId)) sendParams.message_thread_id = topicId;
      await this.apiCall('sendMessage', sendParams);
    } catch (err) {
      console.error(`[telegram] Failed to create attention topic for "${item.title}": ${err}`);
      DegradationReporter.getInstance().report({
        feature: 'TelegramAdapter.createAttentionItem',
        primary: 'Send attention/escalation notification',
        fallback: 'Attention item never delivered',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'User not notified of important escalation',
      });
    }

    this.attentionItems.set(item.id, attention);
    this.saveAttentionItems();
    return attention;
  }

  /**
   * Build a calm, named, actionable self-health notice. Resolves a session's
   * topic id to its HUMAN topic name (never emits a bare `topic-<n>`), and ends
   * with a plain-language next step the user can just reply to. Used by the
   * self-health escalators so every Agent-Health notice reads like
   * "Heads-up on the 'EXO 3.0' session — … reply 'check EXO 3.0' …".
   */
  buildHealthNotice(opts: { sessionName: string; topicId?: number; what: string; nextStep: string }):
    { title: string; summary: string } {
    const resolved = (typeof opts.topicId === 'number' ? this.getTopicName(opts.topicId) : null);
    // Prefer a real human name; fall back to the session name only if it isn't the
    // useless `topic-<n>` form.
    const display = (resolved && !/^topic-\d+$/.test(resolved))
      ? resolved
      : (!/^topic-\d+$/.test(opts.sessionName) ? opts.sessionName : (resolved ?? opts.sessionName));
    return {
      title: `Heads-up on the "${display}" session`,
      summary: `${opts.what}. It's still running — reply "${opts.nextStep}" and I'll take a look, or ignore this if you know it's fine.`,
    };
  }

  /** Derive the suppression-dedup entity key for an Agent-Health-lane item. */
  private healthKeyFor(item: AttentionItem): string {
    if (item.healthKey && item.healthKey.trim()) return item.healthKey.trim();
    if (item.sourceContext && item.sourceContext.trim()) return item.sourceContext.trim();
    // Strip a trailing -<n> episode suffix from the id so episodes of one entity
    // share a key (e.g. "stale-abc123-2" -> "stale-abc123").
    return item.id.replace(/-\d+$/, '');
  }

  /**
   * Route a self-health notice into the ONE calm "🩺 Agent Health" lane topic.
   * Per-entity suppression dedup: a same-key re-escalation within the dedup
   * window is logged + suppressed (not reposted) so the lane stays quiet. The
   * lane topic is created lazily once and reused. Returns the lane topic id, or
   * null if Telegram is unavailable (the item is still recorded in the store).
   */
  private async routeToAgentHealthLane(item: AttentionItem): Promise<number | null> {
    const key = this.healthKeyFor(item);
    const now = Date.now();
    const last = this.agentHealthKeyRing.get(key);
    const suppressed = last !== undefined && (now - last) < this.agentHealthLaneCfg.dedupWindowMs;

    // Refresh recency + maintain insertion order (delete then set moves to newest).
    this.agentHealthKeyRing.delete(key);
    this.agentHealthKeyRing.set(key, now);
    while (this.agentHealthKeyRing.size > this.agentHealthLaneCfg.maxTrackedKeys) {
      const oldest = this.agentHealthKeyRing.keys().next().value;
      if (oldest === undefined) break;
      this.agentHealthKeyRing.delete(oldest);
    }

    if (suppressed) {
      // Same entity re-escalating while its prior notice is still fresh — keep the
      // lane calm: record it to the audit trail, do not repost.
      this.writeSuppressedAttentionLog(item, `agent-health:${key}`, 0);
      console.log(`[telegram] agent-health lane: suppressed duplicate "${item.title}" (key=${key}) — within dedup window`);
      return this.agentHealthTopicId;
    }

    let topicId: number | null;
    try {
      topicId = await this.ensureAgentHealthLaneTopic();
    } catch (err) {
      console.error(`[telegram] agent-health lane topic creation failed: ${err}`);
      topicId = this.agentHealthTopicId;
    }
    if (topicId === null) return null;

    const line = [
      `<b>${this.escapeHtml(item.title)}</b>`,
      this.escapeHtml(String(item.summary ?? '').slice(0, 400)),
    ].filter(Boolean).join('\n');
    // @silent-fallback-ok — best-effort lane post; the item is already recorded in
    // the attention store, so a transient send failure is non-fatal. If the topic
    // was deleted out from under us, drop the cached id so it's recreated next time.
    await this.sendToTopic(topicId, line).catch(() => { this.agentHealthTopicId = null; });
    return topicId;
  }

  /** Lazily create (once) and return the reused "🩺 Agent Health" lane topic id. */
  private async ensureAgentHealthLaneTopic(): Promise<number | null> {
    if (this.agentHealthTopicId !== null) return this.agentHealthTopicId;
    if (this.agentHealthPending) return this.agentHealthPending;

    this.agentHealthPending = (async (): Promise<number | null> => {
      const name = this.agentHealthLaneCfg.topicName;
      // 'system': single named lane topic, create-once-then-reuse by design.
      const topic = await this.findOrCreateForumTopic(name, TOPIC_STYLE.SYSTEM.color, { origin: 'system' });
      this.agentHealthTopicId = topic.topicId;
      if (!topic.reused) {
        const intro = [
          `This is your <b>calm agent-health lane</b>. When I notice something about my OWN sessions — one that looks stuck, a peer I can't reach — the routine heads-up lands HERE instead of spawning a new topic each time.`,
          ``,
          `These are low-key and never urgent. Each names the session and ends with a plain next step you can just reply to. Nothing here blocks anything; ignore what you know is fine.`,
        ].join('\n');
        const introParams: Record<string, unknown> = {
          chat_id: this.config.chatId,
          text: intro,
          parse_mode: 'HTML',
          _formatMode: 'html',
        };
        if (!isGeneralTopic(topic.topicId)) introParams.message_thread_id = topic.topicId;
        await this.apiCall('sendMessage', introParams);
      }
      return this.agentHealthTopicId;
    })();

    try {
      return await this.agentHealthPending;
    } finally {
      this.agentHealthPending = null;
    }
  }

  /**
   * Append a suppressed attention item to the audit trail. This is the
   * "housekeeping goes to the logs" path for the topic-flood guard — the item
   * is preserved, just not given its own forum topic. Size-capped with a single
   * rotation (the flood is exactly the failure mode that grows this fastest).
   */
  private writeSuppressedAttentionLog(item: AttentionItem, bucket: string, episodeCount: number): void {
    const entry = {
      ts: new Date().toISOString(),
      bucket,
      episodeCount,
      id: item.id,
      priority: item.priority,
      category: item.category,
      title: item.title,
      summary: item.summary,
    };
    try {
      fs.mkdirSync(path.dirname(this.attentionSuppressedLogPath), { recursive: true });
      // Rotate at ~2MB so a sustained flood can't grow the audit log unbounded.
      try {
        const st = fs.statSync(this.attentionSuppressedLogPath);
        if (st.size > 2 * 1024 * 1024) {
          fs.renameSync(this.attentionSuppressedLogPath, `${this.attentionSuppressedLogPath}.1`);
        }
      } catch { /* no existing file — nothing to rotate */ }
      fs.appendFileSync(this.attentionSuppressedLogPath, JSON.stringify(entry) + '\n');
    } catch {
      // @silent-fallback-ok — an audit-log write failure must never crash the
      // attention path; the item is still recorded in the in-memory store.
    }
    console.log(`[telegram] attention topic-flood guard: coalesced "${item.title}" (bucket=${bucket}, #${episodeCount}) — logged, no new topic`);
  }

  /**
   * Route a coalesced attention item into ONE reused notice topic for its bucket
   * (the source key, or the shared global bucket when the global cap tripped).
   * The topic is created lazily once per bucket and reused thereafter (so a
   * flapping source does not churn a new topic per episode). Concurrent coalesced
   * items for one bucket share a single in-flight creation (no double-create
   * race). Returns the notice topicId, or null if Telegram is unavailable (the
   * item is still recorded + logged).
   */
  private async routeToFloodNotice(
    bucket: string,
    item: AttentionItem,
    decision: { suppressedCount: number },
  ): Promise<number | null> {
    let topicId: number | null;
    try {
      topicId = await this.ensureFloodNoticeTopic(bucket);
    } catch (err) {
      console.error(`[telegram] flood-notice topic creation failed for bucket "${bucket}": ${err}`);
      topicId = this.floodNoticeTopicByBucket.get(bucket) ?? null;
    }
    if (topicId === null) return null;
    const line = `• [#${decision.suppressedCount}] ${this.escapeHtml(item.title)} — ${this.escapeHtml(String(item.summary ?? '').slice(0, 200))}`;
    // @silent-fallback-ok — best-effort coalesce line; the item is already
    // recorded + audit-logged, so a transient send failure is non-fatal. If the
    // topic was deleted out from under us, drop the mapping so it's recreated.
    await this.sendToTopic(topicId, line).catch(() => {
      this.floodNoticeTopicByBucket.delete(bucket);
    });
    return topicId;
  }

  /** Lazily create (once) and return the reused notice topic id for a bucket. */
  private async ensureFloodNoticeTopic(bucket: string): Promise<number | null> {
    const existing = this.floodNoticeTopicByBucket.get(bucket);
    if (existing !== undefined) return existing;
    const inFlight = this.floodNoticePending.get(bucket);
    if (inFlight) return inFlight;

    const creation = (async (): Promise<number | null> => {
      const label = bucket === '*' ? 'multiple sources' : bucket;
      const title = `🔁 ${label}: notices coalesced (flood guard)`.slice(0, 128);
      // 'system': the coalesce surface itself must never be refused by the
      // budget it exists to absorb (one topic per bucket, create-once-reuse).
      const topic = await this.createForumTopic(title, PRIORITY_COLOR.LOW ?? PRIORITY_COLOR.NORMAL, { origin: 'system' });
      const topicId = topic.topicId;
      this.floodNoticeTopicByBucket.set(bucket, topicId);
      this.topicToName.set(topicId, title);
      const intro = [
        `<b>${this.escapeHtml(label)}</b> raised more than its topic budget in a short window, so I'm collecting these notices HERE instead of spawning a new topic per item (housekeeping flood guard, 2026-05-28).`,
        ``,
        `Each item is also recorded in <code>state/attention-suppressed.jsonl</code> and in the attention list — manage them via the dashboard / <code>/attention</code>, not per-item /ack here. Critical (HIGH/URGENT) items are never coalesced — they still get their own topic.`,
      ].join('\n');
      const introParams: Record<string, unknown> = {
        chat_id: this.config.chatId,
        text: intro,
        parse_mode: 'HTML',
        _formatMode: 'html',
      };
      if (!isGeneralTopic(topicId)) introParams.message_thread_id = topicId;
      await this.apiCall('sendMessage', introParams);
      return topicId;
    })();

    this.floodNoticePending.set(bucket, creation);
    try {
      return await creation;
    } finally {
      this.floodNoticePending.delete(bucket);
    }
  }

  /**
   * Update attention item status. Called by /ack, /done, /wontdo, /reopen commands.
   */
  async updateAttentionStatus(itemId: string, status: AttentionItem['status']): Promise<boolean> {
    const item = this.attentionItems.get(itemId);
    if (!item) return false;

    item.status = status;
    item.updatedAt = new Date().toISOString();
    this.saveAttentionItems();

    const topicId = this.attentionItemToTopic.get(itemId);
    if (topicId) {
      const labels: Record<string, string> = {
        'ACKNOWLEDGED': '\ud83d\udc40 Acknowledged',
        'IN_PROGRESS': '\ud83d\udd28 In Progress',
        'DONE': '\u2705 Done',
        'WONT_DO': '\u23ed Won\'t Do',
        'OPEN': '\ud83d\udccb Reopened',
      };
      await this.sendToTopic(topicId, `Status \u2192 ${labels[status] || status}`).catch(() => {});

      // Auto-close/reopen topic
      try {
        if (status === 'DONE' || status === 'WONT_DO') {
          await this.apiCall('closeForumTopic', { chat_id: this.config.chatId, message_thread_id: topicId });
        } else if (status === 'OPEN') {
          await this.apiCall('reopenForumTopic', { chat_id: this.config.chatId, message_thread_id: topicId });
        }
      } catch { /* topic operations may fail if already in desired state */ }
    }

    // Fire callback for external integrations
    if (this.onAttentionStatusChange) {
      await this.onAttentionStatusChange(itemId, status).catch(err => {
        console.error(`[telegram] Attention status callback failed: ${err}`);
      });
    }

    return true;
  }

  /**
   * Get all attention items, optionally filtered by status.
   */
  getAttentionItems(status?: string): AttentionItem[] {
    const items = Array.from(this.attentionItems.values());
    if (status) return items.filter(i => i.status === status);
    return items;
  }

  /**
   * Get a specific attention item.
   */
  getAttentionItem(itemId: string): AttentionItem | undefined {
    return this.attentionItems.get(itemId);
  }

  /**
   * Check if a topic is an attention topic.
   */
  isAttentionTopic(topicId: number): boolean {
    return this.attentionTopicToItem.has(topicId);
  }

  /**
   * Handle commands in attention topics (/ack, /done, /wontdo, /reopen).
   * Returns true if handled, false if not an attention command.
   */
  async handleAttentionCommand(topicId: number, text: string): Promise<boolean> {
    const itemId = this.attentionTopicToItem.get(topicId);
    if (!itemId) return false;

    const cmd = text.trim().toLowerCase();
    const statusMap: Record<string, AttentionItem['status']> = {
      '/ack': 'ACKNOWLEDGED',
      '/acknowledge': 'ACKNOWLEDGED',
      '/done': 'DONE',
      '/wontdo': 'WONT_DO',
      '/reopen': 'OPEN',
    };

    if (cmd in statusMap) {
      await this.updateAttentionStatus(itemId, statusMap[cmd]);
      return true;
    }

    return false;
  }

  private loadAttentionItems(): void {
    try {
      if (!fs.existsSync(this.attentionFilePath)) return;
      const data = JSON.parse(fs.readFileSync(this.attentionFilePath, 'utf-8'));
      if (data.items) {
        for (const item of data.items) {
          this.attentionItems.set(item.id, item);
          // Coalesced items share ONE notice topic; registering them in the
          // per-item maps would last-writer-win-corrupt the reverse map and make
          // resolving one close the shared topic. They are managed via /attention.
          if (item.topicId && !item.coalesced) {
            this.attentionItemToTopic.set(item.id, item.topicId);
            this.attentionTopicToItem.set(item.topicId, item.id);
          }
        }
        console.log(`[telegram] Loaded ${this.attentionItems.size} attention items`);
      }
    } catch { /* file doesn't exist yet */ }
  }

  private saveAttentionItems(): void {
    try {
      const dir = path.dirname(this.attentionFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const data = { items: Array.from(this.attentionItems.values()) };
      const tmpPath = `${this.attentionFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.attentionFilePath);
    } catch (err) {
      console.error(`[telegram] Failed to save attention items: ${err}`);
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Registry Persistence ───────────────────────────────────

  private loadRegistry(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      if (data.topicToSession) {
        for (const [k, v] of Object.entries(data.topicToSession)) {
          this.topicToSession.set(Number(k), v as string);
          this.sessionToTopic.set(v as string, Number(k));
        }
      }
      if (data.topicToName) {
        for (const [k, v] of Object.entries(data.topicToName)) {
          this.topicToName.set(Number(k), v as string);
        }
      }
      if (data.topicToPurpose) {
        for (const [k, v] of Object.entries(data.topicToPurpose)) {
          this.topicToPurpose.set(Number(k), v as string);
        }
      }
      console.log(`[telegram] Loaded ${this.topicToSession.size} topic-session mappings from disk`);
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  private saveRegistry(): void {
    try {
      const data = {
        topicToSession: Object.fromEntries(this.topicToSession),
        topicToName: Object.fromEntries(this.topicToName),
        topicToPurpose: Object.fromEntries(this.topicToPurpose),
      };
      // Atomic write: unique temp filename to prevent concurrent corruption
      const tmpPath = this.registryPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
        fs.renameSync(tmpPath, this.registryPath);
      } catch (writeErr) {
        try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/messaging/TelegramAdapter.ts:3090' }); } catch { /* ignore */ }
        throw writeErr;
      }
    } catch (err) {
      console.error(`[telegram] Failed to save registry: ${err}`);
    }
  }

  // ── Polling Offset Persistence ────────────────────────────

  private loadOffset(): void {
    try {
      const raw = fs.readFileSync(this.offsetPath, 'utf-8');
      const data = JSON.parse(raw);
      // Support both 'lastUpdateId' (canonical) and 'offset' (legacy/external)
      const candidate = data.lastUpdateId ?? data.offset;
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        this.lastUpdateId = candidate;
        console.log(`[telegram] Restored poll offset: ${this.lastUpdateId}`);
      } else if (data.lastUpdateId !== undefined || data.offset !== undefined) {
        console.warn(`[telegram] Poll offset file has invalid value: ${raw.trim().substring(0, 100)}. Starting from 0.`);
      }
    } catch (err) {
      // Distinguish missing file from corrupted file
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[telegram] Poll offset file corrupted, starting from 0: ${err}`);
      }
    }
  }

  private saveOffset(): void {
    try {
      const tmpPath = `${this.offsetPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify({ lastUpdateId: this.lastUpdateId }));
        fs.renameSync(tmpPath, this.offsetPath);
      } catch (writeErr) {
        try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/messaging/TelegramAdapter.ts:3128' }); } catch { /* ignore */ }
        throw writeErr;
      }
    } catch (err) {
      console.error(`[telegram] Failed to save poll offset: ${err}`);
    }
  }

  // ── Polling ────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      const updates = await this.getUpdates();
      this.consecutivePollErrors = 0; // Reset on success

      // Offset range sanity check: if received update_ids are significantly lower
      // than our stored offset, the offset is likely from a different bot token or
      // was corrupted during a migration. Auto-correct to prevent infinite replay.
      if (updates.length > 0 && this.lastUpdateId > 0) {
        const maxReceivedId = Math.max(...updates.map(u => u.update_id));
        const OFFSET_RANGE_THRESHOLD = 10_000_000; // 10M delta = cross-token corruption
        if (maxReceivedId < this.lastUpdateId - OFFSET_RANGE_THRESHOLD) {
          console.warn(
            `[telegram] Offset range mismatch: stored=${this.lastUpdateId}, ` +
            `received max=${maxReceivedId} (delta=${this.lastUpdateId - maxReceivedId}). ` +
            `Auto-correcting offset to prevent infinite replay loop.`
          );
          this.lastUpdateId = maxReceivedId;
          this.saveOffset();
        }
      }

      for (const update of updates) {
        await this.processUpdate(update);
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
        // Save offset after each update so a crash mid-batch doesn't re-deliver
        // messages that were already processed (mirrors TelegramLifeline fix).
        this.saveOffset();
      }
    } catch (err) {
      this.consecutivePollErrors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.lastPollError = errMsg;

      // Check for fatal errors that require restart
      if (errMsg.includes('401') || errMsg.includes('Unauthorized')) {
        // Single retry after 30s — distinguishes transient 401s from genuine token revocation.
        // Without this, a one-off auth blip permanently kills polling until the agent restarts.
        if (!this.pending401Retry) {
          this.pending401Retry = true;
          const tokenPrefix = this.config.token ? this.config.token.slice(0, 6) : 'unknown';
          console.warn(`[telegram] 401 Unauthorized (token=${tokenPrefix}…). Retrying once in 30s before declaring fatal.`);
          await new Promise(r => setTimeout(r, 30_000));
          // Fall through — schedule next poll. If second attempt also 401, the !this.pending401Retry
          // check will be false and we'll go fatal.
        } else {
          const tokenPrefix = this.config.token ? this.config.token.slice(0, 6) : 'unknown';
          console.error(`[telegram] FATAL: Bot token is invalid (token=${tokenPrefix}…). Stopping polling.`);
          this.polling = false;
          this.fatalPollReason = '401';
          this.pollStoppedAt = new Date();
          return;
        }
      } else {
        // Non-401 errors clear any pending 401 retry state
        this.pending401Retry = false;
      }

      // Exponential backoff on consecutive errors
      if (this.consecutivePollErrors > 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, this.consecutivePollErrors - 1), 60_000);
        console.error(`[telegram] Poll error (attempt ${this.consecutivePollErrors}), backing off ${backoffMs}ms: ${errMsg}`);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        console.error(`[telegram] Poll error: ${errMsg}`);
      }
    }

    // Successful loop iteration (or non-fatal error): if we were in 401 retry and got here
    // without re-entering the 401 branch, the retry succeeded.
    if (this.consecutivePollErrors === 0) {
      this.pending401Retry = false;
      this.lastPollError = null;
    }

    // Schedule next poll
    const interval = this.config.pollIntervalMs ?? 2000;
    this.pollTimeout = setTimeout(() => this.poll(), interval);
  }

  /**
   * Process a single Telegram update (text, voice, photo, or callback query).
   */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    // Handle callback queries from inline keyboard buttons (Prompt Gate)
    if (update.callback_query) {
      await this.processCallbackQuery(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    // Auth gating — handle messages from unauthorized/unknown users
    if (!this.isAuthorized(msg.from.id)) {
      await this.handleUnknownUser(msg.from.id, msg.from.first_name, msg.from.username, msg.text);
      return;
    }

    const numericTopicId = msg.message_thread_id ?? GENERAL_TOPIC_ID;
    const topicId = numericTopicId.toString();

    // Auto-capture topic name from multiple sources:
    // 1. Service message when topic is created (msg.forum_topic_created)
    // 2. Service message when topic is renamed (msg.forum_topic_edited)
    // 3. Reply to the topic creation service message (msg.reply_to_message.forum_topic_created)
    const detectedName =
      msg.forum_topic_created?.name ??
      msg.forum_topic_edited?.name ??
      msg.reply_to_message?.forum_topic_created?.name;
    if (detectedName) {
      const currentName = this.topicToName.get(numericTopicId);
      if (!currentName || /^topic-\d+$/.test(currentName) || msg.forum_topic_edited?.name) {
        const isRename = !!msg.forum_topic_edited?.name && currentName !== detectedName;
        this.topicToName.set(numericTopicId, detectedName);
        this.saveRegistry();
        console.log(`[telegram] Captured topic name: ${numericTopicId} → "${detectedName}"`);
        // UNIFIED-SESSION-LIFECYCLE bonus — fire on TRUE rename only (not on
        // initial capture or topic creation). The handler updates the bound
        // session's display `name` so the dashboard label tracks the user's
        // rename. Fire-and-forget: rename-display is non-critical.
        if (isRename && this.topicRenamedHandler) {
          try {
            void Promise.resolve(this.topicRenamedHandler(numericTopicId, detectedName)).catch((err) => {
              console.error(`[telegram] topicRenamedHandler failed for ${numericTopicId}:`, err);
            });
          } catch (err) {
            console.error(`[telegram] topicRenamedHandler threw for ${numericTopicId}:`, err);
          }
        }
      }
    }

    // Service messages (topic created/edited) have no user content — skip further processing
    if (msg.forum_topic_created || msg.forum_topic_edited) {
      return;
    }

    // Handle voice messages
    if (msg.voice) {
      await this.handleVoiceMessage(msg, numericTopicId);
      return;
    }

    // Handle photo messages
    if (msg.photo && msg.photo.length > 0) {
      await this.handlePhotoMessage(msg, numericTopicId);
      return;
    }

    // Handle document/file messages
    if (msg.document) {
      await this.handleDocumentMessage(msg, numericTopicId);
      return;
    }

    // Handle text messages
    if (!msg.text) return;

    const text = msg.text;

    // Check for commands first
    if (text.startsWith('/')) {
      const handled = await this.handleCommand(text, numericTopicId, msg.from.id);
      if (handled) return;
    }

    const message: Message = {
      id: `tg-${msg.message_id}`,
      userId: msg.from.id.toString(),
      content: text,
      channel: { type: 'telegram', identifier: topicId },
      receivedAt: new Date(msg.date * 1000).toISOString(),
      metadata: {
        telegramUserId: msg.from.id,
        username: msg.from.username,
        firstName: msg.from.first_name,
        messageThreadId: numericTopicId,
        // TOPIC-PROFILE-SPEC §10.1 round-5: forwarded content never matches
        // ANY profile-ingress recognition — carry the platform forward
        // metadata so the server-side parse can reject it deterministically.
        ...(((msg as unknown as Record<string, unknown>).forward_origin
          || (msg as unknown as Record<string, unknown>).forward_from
          || (msg as unknown as Record<string, unknown>).forward_date)
          ? { forwarded: true }
          : {}),
      },
    };

    // Log the message (including sender identity for multi-user topics)
    this.appendToLog({
      messageId: msg.message_id,
      topicId: numericTopicId,
      text,
      fromUser: true,
      timestamp: new Date(msg.date * 1000).toISOString(),
      sessionName: this.topicToSession.get(numericTopicId) ?? null,
      senderName: msg.from.first_name,
      senderUsername: msg.from.username,
      telegramUserId: msg.from.id,
    });

    // Sentinel intercept — fires BEFORE routing to detect emergency stop/pause.
    // This runs in the server process, separate from the session, so it can
    // kill/pause the session even when the session is mid-tool-call.
    if (this.onSentinelIntercept) {
      try {
        const classification = await this.onSentinelIntercept(text, numericTopicId);
        if (classification && (classification.category === 'emergency-stop' || classification.category === 'pause')) {
          const sessionName = this.topicToSession.get(numericTopicId);
          if (classification.category === 'emergency-stop' && sessionName) {
            console.log(`[sentinel] Emergency stop for session "${sessionName}" in topic ${numericTopicId}`);
            if (this.onSentinelKillSession) {
              this.onSentinelKillSession(sessionName);
            }
            // Durable Inbound Message Queue §3.6: the stop reaches custody —
            // queued rows for this topic settle terminal (operator-stop),
            // loss-reported, PIS records cleared. Without this the drain would
            // re-inject pre-stop work after the operator said stop.
            try { this.onSentinelStopCustody?.(numericTopicId); } catch { /* best-effort */ }
            // Also clear this topic's autonomous job so it doesn't zombie-resume
            // when a fresh session spawns. (Multi-session: per-topic state file.)
            try {
              if (stopAutonomousTopic(this.stateDir, String(numericTopicId), this.coherenceJournalSeam)) {
                console.log(`[sentinel] Cleared autonomous job for topic ${numericTopicId}`);
              }
            } catch { /* best-effort */ }
            // Never include raw sentinel reasons in user-facing messages.
            // Log the full reason server-side, show only clean messages to users.
            if (classification.reason) {
              console.log(`[sentinel] Stop reason: ${classification.reason}`);
            }
            await this.sendToTopic(numericTopicId,
              `Session terminated.\n\nSend a new message to start a fresh session.`
            ).catch(() => {});
          } else if (classification.category === 'pause' && sessionName) {
            console.log(`[sentinel] Pause for session "${sessionName}" in topic ${numericTopicId}`);
            if (this.onSentinelPauseSession) {
              this.onSentinelPauseSession(sessionName);
            }
            // Never include raw sentinel reasons in user-facing messages.
            if (classification.reason) {
              console.log(`[sentinel] Pause reason: ${classification.reason}`);
            }
            await this.sendToTopic(numericTopicId,
              `Session paused.\n\nSend a message to resume.`
            ).catch(() => {});
          } else if (!sessionName) {
            // No active session — just acknowledge the stop/pause signal
            await this.sendToTopic(numericTopicId,
              `No active session to ${classification.category === 'emergency-stop' ? 'stop' : 'pause'}.`
            ).catch(() => {});
          }
          return; // Don't route to session — sentinel handled it
        }
      } catch (err) {
        console.error(`[sentinel] Intercept error: ${err}`);
        // On sentinel error, fall through to normal routing (fail-open for message delivery)
      }
    }

    // Prompt Gate — intercept replies to relay messages (text-input prompts)
    if (this.pendingPromptReply.has(numericTopicId) && text) {
      const handled = this.handlePendingPromptReply(numericTopicId, msg);
      if (handled) return;
    }

    // Agent-to-agent Telegram comms hook (spec MENTOR-LIVE-READINESS §Fix 2b). Runs BEFORE
    // normal user-message dispatch on text messages so an a2a marker is intercepted as an
    // agent event (route or drop), never falling through to topic-session spawning. Other
    // message types can't carry markers — bypass entirely.
    if (typeof text === 'string') {
      const handled = await this.dispatchAgentMessageHook({
        text,
        topicId: numericTopicId,
        senderIsBot: msg.from?.is_bot === true,
        senderChatId: msg.sender_chat?.id !== undefined ? String(msg.sender_chat.id) : undefined,
        senderBotId: undefined, // computed inside dispatch — see method docs
        rawFromId: msg.from?.id !== undefined ? String(msg.from.id) : undefined,
      });
      if (handled) return;
    }

    // Fire topic message callback (always fires — General topic falls back to ID 1)
    if (this.onTopicMessage) {
      try {
        Promise.resolve(this.onTopicMessage(message)).catch(err => {
          console.error(`[telegram] Topic message handler error: ${err}`);
        });
      } catch (err) {
        console.error(`[telegram] Topic message handler sync error: ${err}`);
      }
    }

    // Fire general handler
    if (this.handler) {
      try {
        await this.handler(message);
      } catch (err) {
        console.error(`[telegram] Handler error: ${err}`);
      }
    }
  }

  /**
   * Handle an incoming voice message: download, transcribe, route as text.
   */
  private async handleVoiceMessage(
    msg: NonNullable<TelegramUpdate['message']>,
    topicId: number,
  ): Promise<void> {
    const voice = msg.voice!;

    // Download the voice file
    const voiceDir = path.join(this.stateDir, 'telegram-voice');
    fs.mkdirSync(voiceDir, { recursive: true });
    const filename = `voice-${Date.now()}-${msg.message_id}.ogg`;
    const filepath = path.join(voiceDir, filename);

    try {
      await this.downloadFile(voice.file_id, filepath);
    } catch (err) {
      console.error(`[telegram] Failed to download voice: ${err}`);
      await this.sendToTopic(topicId, `(Voice message received but download failed)`).catch(() => {});
      return;
    }

    // Transcribe
    try {
      const transcript = await this.transcribeVoice(filepath);
      console.log(`[telegram] Transcribed voice (${voice.duration}s): "${transcript.slice(0, 80)}"`);

      // Create a message with the transcription
      const message: Message = {
        id: `tg-${msg.message_id}`,
        userId: msg.from.id.toString(),
        content: `[voice] ${transcript}`,
        channel: { type: 'telegram', identifier: topicId.toString() },
        receivedAt: new Date(msg.date * 1000).toISOString(),
        metadata: {
          telegramUserId: msg.from.id,
          username: msg.from.username,
          firstName: msg.from.first_name,
          messageThreadId: topicId,
          voiceFile: filepath,
          voiceDuration: voice.duration,
        },
      };

      // Log it (including sender identity for multi-user topics)
      this.appendToLog({
        messageId: msg.message_id,
        topicId,
        text: `[voice] ${transcript}`,
        fromUser: true,
        timestamp: new Date(msg.date * 1000).toISOString(),
        sessionName: this.topicToSession.get(topicId) ?? null,
        senderName: msg.from.first_name,
        senderUsername: msg.from.username,
        telegramUserId: msg.from.id,
      });

      // Fire callbacks
      if (this.onTopicMessage) {
        try {
          this.onTopicMessage(message);
        } catch (err) {
          console.error(`[telegram] Topic message handler error: ${err}`);
        }
      }
      if (this.handler) {
        try {
          await this.handler(message);
        } catch (err) {
          console.error(`[telegram] Handler error: ${err}`);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isNotConfigured = errMsg.includes('No voice transcription provider configured');
      const replyText = isNotConfigured
        ? '\ud83c\udfa4 Voice transcription is not configured. To enable it, set GROQ_API_KEY or OPENAI_API_KEY in your environment.'
        : `(Voice message received but transcription failed: ${errMsg})`;
      await this.sendToTopic(topicId, replyText).catch(() => {});
    } finally {
      // Clean up voice file after processing
      try { SafeFsExecutor.safeUnlinkSync(filepath, { operation: 'src/messaging/TelegramAdapter.ts:3477' }); } catch { /* ignore */ }
    }
  }

  /**
   * Handle an incoming photo message: download, save, route with path.
   */
  private async handlePhotoMessage(
    msg: NonNullable<TelegramUpdate['message']>,
    topicId: number,
  ): Promise<void> {
    const photos = msg.photo!;
    // Get highest resolution (last in array)
    const photo = photos[photos.length - 1];
    const caption = msg.caption || '';

    try {
      const filepath = await this.downloadPhoto(photo.file_id, msg.message_id);
      console.log(`[telegram] Downloaded photo: ${filepath}`);

      const content = caption
        ? `[image:${filepath}] ${caption}`
        : `[image:${filepath}]`;

      const message: Message = {
        id: `tg-${msg.message_id}`,
        userId: msg.from.id.toString(),
        content,
        channel: { type: 'telegram', identifier: topicId.toString() },
        receivedAt: new Date(msg.date * 1000).toISOString(),
        metadata: {
          telegramUserId: msg.from.id,
          username: msg.from.username,
          firstName: msg.from.first_name,
          messageThreadId: topicId,
          photoPath: filepath,
        },
      };

      // Log it (including sender identity for multi-user topics)
      this.appendToLog({
        messageId: msg.message_id,
        topicId,
        text: content,
        fromUser: true,
        timestamp: new Date(msg.date * 1000).toISOString(),
        sessionName: this.topicToSession.get(topicId) ?? null,
        senderName: msg.from.first_name,
        senderUsername: msg.from.username,
        telegramUserId: msg.from.id,
      });

      // Fire callbacks
      if (this.onTopicMessage) {
        try {
          this.onTopicMessage(message);
        } catch (err) {
          console.error(`[telegram] Topic message handler error: ${err}`);
        }
      }
      if (this.handler) {
        try {
          await this.handler(message);
        } catch (err) {
          console.error(`[telegram] Handler error: ${err}`);
        }
      }
    } catch (err) {
      console.error(`[telegram] Failed to download photo: ${err}`);
      await this.sendToTopic(topicId, '(Photo received but I couldn\'t process it. Try sending it again.)').catch(() => {});
    }
  }

  /**
   * Handle an incoming document message: download, save, route with path.
   */
  private async handleDocumentMessage(
    msg: NonNullable<TelegramUpdate['message']>,
    topicId: number,
  ): Promise<void> {
    const doc = msg.document!;
    const caption = msg.caption || '';

    try {
      const filepath = await this.downloadDocument(doc.file_id, msg.message_id, doc.file_name);
      console.log(`[telegram] Downloaded document: ${filepath}`);

      const content = caption
        ? `[document:${filepath}] ${caption}`
        : `[document:${filepath}]`;

      const message: Message = {
        id: `tg-${msg.message_id}`,
        userId: msg.from.id.toString(),
        content,
        channel: { type: 'telegram', identifier: topicId.toString() },
        receivedAt: new Date(msg.date * 1000).toISOString(),
        metadata: {
          telegramUserId: msg.from.id,
          username: msg.from.username,
          firstName: msg.from.first_name,
          messageThreadId: topicId,
          documentPath: filepath,
          documentName: doc.file_name,
          documentMimeType: doc.mime_type,
        },
      };

      // Log it
      this.appendToLog({
        messageId: msg.message_id,
        topicId,
        text: content,
        fromUser: true,
        timestamp: new Date(msg.date * 1000).toISOString(),
        sessionName: this.topicToSession.get(topicId) ?? null,
        senderName: msg.from.first_name,
        senderUsername: msg.from.username,
        telegramUserId: msg.from.id,
      });

      // Fire callbacks
      if (this.onTopicMessage) {
        try {
          this.onTopicMessage(message);
        } catch (err) {
          console.error(`[telegram] Topic message handler error: ${err}`);
        }
      }
      if (this.handler) {
        try {
          await this.handler(message);
        } catch (err) {
          console.error(`[telegram] Handler error: ${err}`);
        }
      }
    } catch (err) {
      console.error(`[telegram] Failed to download document: ${err}`);
      await this.sendToTopic(topicId, '(Document received but I couldn\'t process it. Try sending it again.)').catch(() => {});
    }
  }

  // ── Prompt Gate: Telegram Relay ───────────────────────────────────

  /**
   * Relay a detected prompt to a Telegram topic with inline keyboard buttons.
   * For prompts with options: sends buttons. For questions: sends text asking for reply.
   * Returns the Telegram message ID of the relay message.
   */
  async relayPrompt(topicId: number, prompt: DetectedPrompt): Promise<number> {
    // First-use disclosure (once per topic)
    if (!this.promptGateDisclosureSent.has(topicId)) {
      await this.sendToTopic(topicId,
        'Prompt Gate is now active for this topic. Session prompts will appear here ' +
        'for you to respond to. Note: prompt text is sent through Telegram\'s servers. ' +
        'Avoid including credentials or sensitive data in your replies.'
      ).catch(() => {});
      this.promptGateDisclosureSent.add(topicId);
    }

    const text = this.formatPromptMessage(prompt);

    let result: { message_id: number };

    if (prompt.options && prompt.options.length > 0) {
      // Add numbered options to the message body so full text is visible.
      // Labels are user content — HTML-escape since this whole message goes
      // through `_formatMode: 'html'` (formatPromptMessage emits HTML).
      const optionLines = prompt.options
        .map((opt, i) => `${i + 1}. ${this.escapeHtml(opt.label)}`)
        .join('\n');
      const fullText = `${text}\n\n${optionLines}`;

      // Build inline keyboard buttons with just the number/key (compact)
      const keyboard = prompt.options.map((opt, i) => {
        const token = this.callbackRegistry.register({
          sessionName: prompt.sessionName,
          promptId: prompt.id,
          key: opt.key,
        });
        return {
          text: String(i + 1),
          callback_data: JSON.stringify({ id: token }),
        };
      });

      // All buttons in a single row (they're just numbers now)
      result = await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        message_thread_id: isGeneralTopic(topicId) ? undefined : topicId,
        text: fullText,
        reply_markup: { inline_keyboard: [keyboard] },
        parse_mode: 'HTML',
        _formatMode: 'html',
      }) as { message_id: number };
    } else {
      // No options — text reply expected (clarifying question)
      result = await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        message_thread_id: isGeneralTopic(topicId) ? undefined : topicId,
        text,
        parse_mode: 'HTML',
        _formatMode: 'html',
      }) as { message_id: number };
    }

    // Track pending reply for text-input prompts
    this.pendingPromptReply.set(topicId, {
      prompt,
      relayMessageId: result.message_id,
      createdAt: Date.now(),
    });

    // Notify session manager to extend idle timeout (relay lease)
    if (this.onRelayLeaseStart) {
      this.onRelayLeaseStart(prompt.sessionName);
    }

    console.log(`[prompt-gate] Relayed ${prompt.type} prompt to topic ${topicId} (msg ${result.message_id})`);
    return result.message_id;
  }

  /**
   * Format a detected prompt into a Telegram HTML message body.
   */
  private formatPromptMessage(prompt: DetectedPrompt): string {
    // HTML output — caller sets `_formatMode: 'html'` so the markdown converter
    // does not re-process this. Summary is HTML-escaped to neutralize any user-
    // supplied `<`, `&`, etc.; markdown tokens in the summary stay literal.
    const escapedSummary = this.escapeHtml(prompt.summary);

    switch (prompt.type) {
      case 'permission':
        return `\u{23F3} <b>Your agent is waiting — approve or decline:</b>\n\n"${escapedSummary}"`;
      case 'plan':
        return `\u{23F3} <b>Agent plan ready — do you want to proceed?</b>\n\n"${escapedSummary}"`;
      case 'question':
        return `\u{23F3} <b>Your agent has a question:</b>\n\n"${escapedSummary}"\n\nReply to this message with your answer.`;
      case 'confirmation':
        return `\u{23F3} <b>Your agent needs confirmation:</b>\n\n"${escapedSummary}"`;
      case 'selection':
        return `\u{23F3} <b>Your agent needs you to choose:</b>\n\n"${escapedSummary}"`;
      default:
        return `\u{23F3} <b>Session needs your input:</b>\n\n"${escapedSummary}"`;
    }
  }

  /**
   * Handle a forwarded callback query from the Lifeline process.
   * In send-only mode the server doesn't poll for callbacks, so the
   * Lifeline forwards them via /internal/telegram-callback.
   */
  async handleForwardedCallback(query: any): Promise<void> {
    await this.processCallbackQuery(query);
  }

  /**
   * Handle a Telegram callback query from an inline keyboard button press.
   */
  private async processCallbackQuery(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    if (!query.data) {
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Invalid button data',
      }).catch(() => {});
      return;
    }

    // ── Tunnel-consent buttons (separate, security-sensitive path) ────
    // callback_data shape: `tc:g:<nonce>` (grant) | `tc:d:<nonce>`
    // (decline). The owner-principal check is MANDATORY here — the
    // GPT external review's CRITICAL finding is that only the owner
    // may approve routing private traffic through a third-party relay.
    // We use getOwnerUserId() (the explicit owner principal), NOT the
    // broader authorizedUserIds set.
    if (query.data.startsWith('tc:')) {
      const owner = this.getOwnerUserId();
      if (owner && query.from.id !== owner) {
        await this.apiCall('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'Only the owner can approve this',
        }).catch(() => {});
        return; // do NOT consume — preserve for the real owner
      }
      const m = /^tc:([gd]):([0-9a-f]{32})$/.exec(query.data);
      if (!m) {
        await this.apiCall('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'Invalid consent button',
        }).catch(() => {});
        return;
      }
      const action: 'grant' | 'decline' = m[1] === 'g' ? 'grant' : 'decline';
      const nonce = m[2]!;
      let statusText = 'Got it';
      if (this.tunnelConsentHandler) {
        try {
          statusText = await this.tunnelConsentHandler(action, nonce);
        } catch {
          statusText = 'Could not process — try the dashboard';
        }
      }
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: statusText,
      }).catch(() => {});
      // Clear the inline keyboard so the (now-consumed) button can't be
      // tapped again — the consent nonce is single-use on the manager
      // side, but removing the keyboard is the visible confirmation.
      // The prompt lives in the owner's private DM, so the edit must
      // target that chat — NOT config.chatId (the group/supergroup).
      if (query.message) {
        await this.editMessageWithRetry(
          query.message.message_id,
          action === 'grant' ? '✅ Backup approved.' : '❌ Backup declined.',
          3,
          query.message.chat?.id,
        ).catch(() => {});
      }
      return;
    }

    // Authorization check: verify sender is the configured owner
    const ownerId = this.config.promptGate?.ownerId;
    if (ownerId && query.from.id !== ownerId) {
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Only the session owner can respond to prompts',
      }).catch(() => {});
      // Do NOT resolve the token — preserve it for the real owner
      return;
    }

    // Parse callback data
    let tokenId: string;
    try {
      const data = JSON.parse(query.data);
      tokenId = data.id;
      if (!tokenId || typeof tokenId !== 'string') throw new Error('missing id');
    } catch {
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Invalid callback data',
      }).catch(() => {});
      return;
    }

    // Resolve the token
    const context = this.callbackRegistry.resolve(tokenId);

    if (!context) {
      // Stale button (server restarted, or entry pruned)
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Session expired \u2014 check the dashboard',
      }).catch(() => {});
      if (query.message) {
        await this.editMessageWithRetry(
          query.message.message_id,
          '\u274C Session expired before response received'
        );
      }
      return;
    }

    // Validate the key against the allowlist
    if (!isAllowedButtonKey(context.key)) {
      console.warn(`[prompt-gate] Rejected non-allowlisted button key: ${context.key}`);
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Invalid response key',
      }).catch(() => {});
      return;
    }

    // Answer the callback (removes loading spinner on button)
    await this.apiCall('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Sent to session',
    }).catch(() => {});

    // Update the message to show which option was chosen
    if (query.message) {
      await this.editMessageWithRetry(
        query.message.message_id,
        `\u2705 Responded: ${context.key}`
      );
    }

    // Clear pending reply for this topic (if any)
    const topicId = query.message?.message_thread_id;
    if (topicId) {
      this.pendingPromptReply.delete(topicId);
    }

    // Release relay lease
    if (this.onRelayLeaseEnd) {
      this.onRelayLeaseEnd(context.sessionName);
    }

    // Inject the response into the session
    if (this.onPromptResponse) {
      const sent = this.onPromptResponse(context.sessionName, context.key);
      if (!sent) {
        console.warn(`[prompt-gate] Failed to send key "${context.key}" to session "${context.sessionName}"`);
      }
    } else {
      console.warn(`[prompt-gate] No onPromptResponse handler — cannot inject response`);
    }

    console.log(`[prompt-gate] Callback resolved: session="${context.sessionName}" key="${context.key}"`);
  }

  /**
   * Handle a text reply to a Prompt Gate relay message (for text-input prompts).
   * Returns true if the message was intercepted, false to fall through to normal routing.
   */
  private handlePendingPromptReply(
    topicId: number,
    msg: NonNullable<TelegramUpdate['message']>,
  ): boolean {
    const pending = this.pendingPromptReply.get(topicId);
    if (!pending) return false;

    // Check timeout (2x relay timeout)
    const relayTimeoutMs = (this.config.promptGate?.relayTimeoutSeconds ?? 300) * 2000;
    if (Date.now() - pending.createdAt > relayTimeoutMs) {
      this.pendingPromptReply.delete(topicId);
      // Release relay lease
      if (this.onRelayLeaseEnd) {
        this.onRelayLeaseEnd(pending.prompt.sessionName);
      }
      return false; // Expired — fall through to normal routing
    }

    // Reject forwarded messages — prevents forwarding attack
    if ((msg as any).forward_origin || (msg as any).forward_from || (msg as any).forward_date) {
      return false; // Forwarded message — reject silently
    }

    // Verify sender is the authorized owner
    const ownerId = this.config.promptGate?.ownerId;
    if (ownerId && msg.from.id !== ownerId) {
      return false; // Not the owner — fall through to normal routing
    }

    // Verify this is a reply-to the relay message
    if (msg.reply_to_message?.message_id !== pending.relayMessageId) {
      return false; // Not replying to the prompt — fall through
    }

    // Intercept the reply
    this.pendingPromptReply.delete(topicId);

    // Release relay lease
    if (this.onRelayLeaseEnd) {
      this.onRelayLeaseEnd(pending.prompt.sessionName);
    }

    // Sanitize the input
    const sanitized = sanitizeForPrompt(msg.text ?? '', 512);
    if (!sanitized) {
      console.warn(`[prompt-gate] Empty text reply after sanitization, topic ${topicId}`);
      return true; // Still consume the message — don't route it as a new message
    }

    // Inject the text into the session
    if (this.onPromptTextResponse) {
      const sent = this.onPromptTextResponse(pending.prompt.sessionName, sanitized);
      if (!sent) {
        console.warn(`[prompt-gate] Failed to send text to session "${pending.prompt.sessionName}"`);
      }
    } else {
      console.warn(`[prompt-gate] No onPromptTextResponse handler — cannot inject text`);
    }

    // Update the relay message to show it was answered
    this.editMessageWithRetry(
      pending.relayMessageId,
      `\u2705 Answered: "${sanitized.slice(0, 100)}${sanitized.length > 100 ? '...' : ''}"`
    ).catch(() => {});

    console.log(`[prompt-gate] Text reply intercepted: session="${pending.prompt.sessionName}" text="${sanitized.slice(0, 50)}"`);
    return true;
  }

  /**
   * Edit a Telegram message with retry on failure.
   * Uses exponential backoff (1s, 2s, 4s) for up to 3 attempts.
   */
  private async editMessageWithRetry(messageId: number, text: string, retries = 3, chatId?: number | string): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.apiCall('editMessageText', {
          chat_id: chatId ?? this.config.chatId,
          message_id: messageId,
          text,
        });
        return;
      } catch (err) {
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        } else {
          console.warn(`[prompt-gate] Failed to edit message ${messageId} after ${retries} attempts: ${err}`);
        }
      }
    }
  }

  /**
   * Clean up Prompt Gate state for a session (call when session ends).
   */
  cleanupPromptGate(sessionName: string): void {
    // Remove all callback registry entries for this session
    this.callbackRegistry.removeForSession(sessionName);

    // Clear any pending replies for topics bound to this session
    for (const [topicId, pending] of this.pendingPromptReply) {
      if (pending.prompt.sessionName === sessionName) {
        this.pendingPromptReply.delete(topicId);
        // Update the relay message
        this.editMessageWithRetry(
          pending.relayMessageId,
          '\u274C Session ended before response received'
        ).catch(() => {});
      }
    }
  }

  /**
   * Proactively prune expired relay prompts and send timeout messages.
   * Call periodically (e.g. every 60s) to handle cases where no new message
   * arrives to trigger the expiry check in handlePendingPromptReply.
   */
  async pruneExpiredRelays(): Promise<void> {
    const relayTimeoutMs = (this.config.promptGate?.relayTimeoutSeconds ?? 300) * 1000;
    const reminderMs = relayTimeoutMs; // Send reminder at 1x timeout
    const expiryMs = relayTimeoutMs * 2; // Expire at 2x timeout
    const now = Date.now();

    for (const [topicId, pending] of this.pendingPromptReply) {
      const age = now - pending.createdAt;

      if (age > expiryMs) {
        // Expired — update message and clean up
        this.pendingPromptReply.delete(topicId);
        this.editMessageWithRetry(
          pending.relayMessageId,
          '\u23f0 Prompt expired — no response received. Check the dashboard to respond manually.'
        ).catch(() => {});

        // Release relay lease
        if (this.onRelayLeaseEnd) {
          this.onRelayLeaseEnd(pending.prompt.sessionName);
        }

        // Clean up callback registry entries for this prompt
        this.callbackRegistry.removeForSession(pending.prompt.sessionName);

        console.log(`[prompt-gate] Relay expired for topic ${topicId} (${Math.round(age / 1000)}s)`);
      } else if (age > reminderMs && !pending.reminderSent) {
        // Send reminder
        await this.sendToTopic(topicId,
          '\u23f3 Still waiting for your response on the prompt above.'
        ).catch(() => {});
        pending.reminderSent = true;
      }
    }
  }

  /**
   * Stop the callback registry (call on adapter shutdown).
   */
  stopPromptGate(): void {
    this.callbackRegistry.stop();
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.apiCall('getUpdates', {
      offset: this.lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message', 'callback_query'],
    });

    return (result as TelegramUpdate[]) ?? [];
  }

  private async apiCall(method: string, params: Record<string, unknown>, retryCount: number = 0): Promise<unknown> {
    // PR2: run the formatter on sendMessage / editMessageText when a non-legacy
    // mode is configured. Legacy-passthrough (default) preserves the caller's
    // parse_mode byte-for-byte. See docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md.
    const sendParams = applyTelegramFormatter(
      method,
      params,
      this.config.getFormatMode?.(),
    );
    const url = `https://api.telegram.org/bot${this.config.token}/${method}`;
    const safeUrl = `https://api.telegram.org/bot[REDACTED]/${method}`;

    // Long polling uses 30s timeout in params — give extra headroom
    const timeoutMs = method === 'getUpdates' ? 60_000 : 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendParams.outgoingParams),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Handle 429 Too Many Requests — respect Telegram's retry_after
      if (response.status === 429) {
        if (retryCount >= 3) {
          throw new Error(`Telegram API rate limited ${safeUrl} (429) after ${retryCount} retries`);
        }
        try {
          const errorData = await response.json() as { parameters?: { retry_after?: number } };
          const retryAfter = errorData?.parameters?.retry_after ?? 5;
          console.warn(`[telegram] Rate limited on ${method}, waiting ${retryAfter}s (retry ${retryCount + 1}/3)...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return this.apiCall(method, params, retryCount + 1);
        } catch (retryErr) {
          if (retryErr instanceof Error && retryErr.message.includes('after')) throw retryErr;
          throw new Error(`Telegram API rate limited ${safeUrl} (429)`);
        }
      }
      const text = await response.text();
      // Plain-retry fallback on 400 for formatted sends. See spec
      // "Plain-retry fallback". Only applies to sendMessage — editMessageText
      // cannot be split/retried identically (TELEGRAM_EDIT_TOO_LONG).
      if (
        response.status === 400 &&
        method === 'sendMessage' &&
        sendParams.didFormat &&
        !sendParams.isPlainRetry
      ) {
        recordFormatFallbackPlainRetry();
        const retryParams: Record<string, unknown> = {
          ...sendParams.originalParams,
          parse_mode: undefined,
        };
        // Suffix idempotency key so downstream dedup treats this as fresh.
        if (typeof retryParams._idempotencyKey === 'string') {
          retryParams._idempotencyKey = `${retryParams._idempotencyKey}:fallback-plain`;
        }
        // Mark so we don't recurse.
        (retryParams as { _isPlainRetry?: boolean })._isPlainRetry = true;
        delete retryParams.parse_mode;
        return this.apiCall(method, retryParams, retryCount);
      }
      throw new Error(`Telegram API error ${safeUrl} (${response.status}): ${text}`);
    }

    const data = await response.json() as { ok: boolean; result: unknown };
    if (!data.ok) {
      throw new Error(`Telegram API returned not ok: ${JSON.stringify(data)}`);
    }

    return data.result;
  }
}

/**
 * Shared formatter wire-up used by both TelegramAdapter.apiCall and
 * TelegramLifeline.apiCall. Pure function for testability.
 *
 * For non-send methods, or when mode is undefined / `'legacy-passthrough'`,
 * returns params unchanged. For `sendMessage` / `editMessageText` in a
 * formatting mode, runs the formatter on `params.text` and overrides
 * `params.parse_mode` with the formatter's output.
 *
 * Callers may opt out per-call by passing `params._isPlainRetry = true`
 * (internal flag for the 400 retry path).
 */
export function applyTelegramFormatter(
  method: string,
  params: Record<string, unknown>,
  configMode: FormatMode | undefined,
): {
  outgoingParams: Record<string, unknown>;
  originalParams: Record<string, unknown>;
  didFormat: boolean;
  isPlainRetry: boolean;
} {
  const isPlainRetry = (params as { _isPlainRetry?: boolean })._isPlainRetry === true;
  // Per-call mode override — internal callers that already produce Telegram
  // HTML (e.g. the attention-queue creator) tag their send with
  // `_formatMode: 'html'` so the formatter's markdown converter does not
  // re-process their bytes. Spec: trusted-internal-callers list.
  const callerMode = (params as { _formatMode?: FormatMode })._formatMode;
  // Strip internal flags before sending to Bot API.
  const stripped: Record<string, unknown> = { ...params };
  delete (stripped as { _isPlainRetry?: boolean })._isPlainRetry;
  delete (stripped as { _idempotencyKey?: unknown })._idempotencyKey;
  delete (stripped as { _formatMode?: FormatMode })._formatMode;

  const isSendMethod = method === 'sendMessage' || method === 'editMessageText';
  // Default 'markdown' (post-cutover): unformatted GitHub-flavored markdown
  // → Telegram HTML on every outbound send. Agents that need to roll back
  // set `telegramFormatMode: 'legacy-passthrough'` in `.instar/config.json`.
  const mode: FormatMode = callerMode ?? configMode ?? 'markdown';

  if (
    !isSendMethod ||
    mode === 'legacy-passthrough' ||
    isPlainRetry ||
    typeof stripped.text !== 'string'
  ) {
    return {
      outgoingParams: stripped,
      originalParams: params,
      didFormat: false,
      isPlainRetry,
    };
  }

  const result = formatForTelegram(stripped.text as string, mode);
  recordFormatApplied(result.modeApplied);
  for (const issue of result.lintIssues) {
    recordFormatLintIssue(issue);
  }
  const outgoing: Record<string, unknown> = { ...stripped, text: result.text };
  if (result.parseMode !== undefined) {
    outgoing.parse_mode = result.parseMode;
  } else {
    // legacy-passthrough returns parseMode undefined; fall back to caller's
    // explicit parse_mode if any (preserved above via ...stripped).
  }
  return {
    outgoingParams: outgoing,
    originalParams: params,
    didFormat: true,
    isPlainRetry: false,
  };
}
