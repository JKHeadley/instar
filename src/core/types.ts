/**
 * Core type definitions for instar.
 *
 * These types define the contracts between all modules.
 * Everything flows from these — sessions, jobs, users, messaging.
 */

// ── Provider Credentials ────────────────────────────────────────────

/**
 * The kind of credential a provider accepts. Influences which env var
 * the SessionManager injects when spawning a subprocess.
 *
 *   - `oauth-token`: subscription path (Anthropic CLAUDE_CODE_OAUTH_TOKEN,
 *     OpenAI sub OAuth, Google ADC).
 *   - `api-key`: pay-per-call path (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.).
 */
export type ProviderCredentialKind = 'oauth-token' | 'api-key';

/**
 * A credential for a single provider. Carries enough information for
 * SessionManager to inject the correct env vars at spawn time.
 *
 * Provider-portability v1.0.0: replaces the single `anthropicApiKey`
 * field on SessionManagerConfig. Keys in the parent `credentials` map
 * are provider ids (e.g. 'anthropic', 'openai', 'google').
 */
export interface ProviderCredential {
  /** Which auth mode this credential represents. */
  kind: ProviderCredentialKind;
  /** The credential string (token or API key). */
  value: string;
  /**
   * Optional API base URL override. Used by translation-proxy installs
   * (e.g. ANTHROPIC_BASE_URL pointed at a local proxy) and OSS deployments.
   */
  baseUrl?: string;
}

// ── Session Management ──────────────────────────────────────────────

export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  /** The job that spawned this session, if any */
  jobSlug?: string;
  /** tmux session name */
  tmuxSession: string;
  /** When the session was created */
  startedAt: string;
  /** When the session ended (if completed) */
  endedAt?: string;
  /** User who triggered the session, if any */
  triggeredBy?: string;
  /** Model tier (or raw model id) requested for this session.
   *  May be a Claude tier ('opus'|'sonnet'|'haiku'), a generic
   *  cross-framework tier ('fast'|'balanced'|'capable'), or a raw
   *  model id. Per-framework resolution happens in the headless/
   *  interactive launch builders, not at the session-state level. */
  model?: ModelTier | string;
  /** The AI framework/engine powering this session. Carried so the dashboard
   *  renders engine-aware (a Codex session must not display as a Claude one).
   *  Populated at spawn from the resolved framework; undefined on legacy records. */
  framework?: 'claude-code' | 'codex-cli';
  /** The initial prompt/instruction sent to the framework's CLI */
  prompt?: string;
  /** Maximum duration in minutes before the session is killed */
  maxDurationMinutes?: number;
  /** Claude Code's own session UUID (from hook events). Populated lazily on first hook event. */
  claudeSessionId?: string;
  /** Why the session ended. Set by the single-writer terminateSession() path
   *  (e.g. 'idle-zombie', 'reaped-idle', 'manual-kill'). Undefined on records
   *  ended before this field existed. */
  endedReason?: string;
}

export type SessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'killed';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface SessionManagerConfig {
  /** Path to tmux binary */
  tmuxPath: string;
  /**
   * Override for Claude Code's own internal retry count
   * (CLAUDE_CODE_MAX_RETRIES env), injected at spawn. When set, raises how
   * long Claude rides out a transient throttle/overload before surfacing the
   * error to the RateLimitSentinel. Unset by default (Claude's default of 10
   * stands) so genuine outages aren't masked. Future-spawn only.
   */
  claudeCodeMaxRetries?: number;
  /** Path to the framework CLI binary for the agent's primary framework.
   *  Misnamed for v0.x compat — actually holds whichever framework binary
   *  was selected (claude OR codex OR …). New code should consult
   *  `frameworkBinaryPaths` for per-framework lookups.
   *  @deprecated naming — value semantics correct; prefer `frameworkBinaryPaths`. */
  claudePath: string;
  /**
   * Per-agent Codex threadline MCP override `{command, args}`. When set, codex
   * spawns receive `-c mcp_servers.threadline.{command,args}=...` so this
   * agent's codex sessions use THEIR OWN threadline MCP rather than whichever
   * agent last wrote the shared `~/.codex/config.toml`
   * (`[mcp_servers."threadline"]`, last-writer-wins). Computed once at server
   * boot via resolveThreadlineMcpEntry when the agent has threadline + codex.
   * Ignored by non-codex launches. See CODEX-MULTIAGENT-THREADLINE-SPEC. */
  codexThreadlineMcp?: { command: string; args: string[] };
  /**
   * Per-framework binary path map. Populated from detection at load
   * time so spawnInteractiveSession can dispatch to any framework
   * without re-running detection. Missing keys mean that framework
   * isn't installed.
   */
  frameworkBinaryPaths?: { 'claude-code'?: string; 'codex-cli'?: string };
  /**
   * Per-framework default model override. Lets the agent's
   * `instar.config.json` choose a specific Codex / Claude model id
   * without code changes. Accepts generic tier names
   * ('fast'|'balanced'|'capable'), framework-specific tier names, or
   * raw model ids. Missing keys fall back to each builder's hardcoded
   * subscription-safe default.
   */
  frameworkDefaultModels?: { 'claude-code'?: string; 'codex-cli'?: string };
  /**
   * The agent's resolved runtime framework — the single source of
   * truth for which CLI a spawned session uses when no per-call
   * override is given. Derived at config-load time from
   * (sessions.framework | enabledFrameworks[0] | INSTAR_FRAMEWORK |
   * 'claude-code'). Both spawnSession and spawnInteractiveSession
   * consult this so a codex-cli-only agent spawns Codex sessions on
   * EVERY path — scheduled jobs AND user messages. Before this
   * field existed, spawnInteractiveSession hardcoded 'claude-code',
   * so messaging a Codex-only agent spawned a Claude session. */
  framework?: 'claude-code' | 'codex-cli';
  /** Project directory (where CLAUDE.md lives) */
  projectDir: string;
  /** Maximum concurrent sessions */
  maxSessions: number;
  /** Protected session names that should never be reaped */
  protectedSessions: string[];
  /** Patterns in tmux output that indicate session completion */
  completionPatterns: string[];
  /** Auth token for the Instar server — passed to sessions as INSTAR_AUTH_TOKEN
   *  so HTTP hooks can authenticate when posting events back to the server. */
  authToken?: string;
  /** Server port — used to construct INSTAR_SERVER_URL for HTTP hooks */
  port?: number;
  /**
   * Per-provider credentials. Keys are provider ids
   * (e.g. 'anthropic', 'openai', 'google'). Values declare the
   * credential kind and value, plus an optional base-URL override
   * (used for translation-proxy / OSS routing).
   *
   * Replaces the v0.x single-provider `anthropicApiKey` field. When
   * `credentials` is unset, the legacy fields are read at load time
   * and migrated into `credentials.anthropic` for backwards-compat.
   */
  credentials?: Record<string, ProviderCredential>;
  /**
   * @deprecated v1.0.0 — use `credentials.anthropic` instead.
   * Anthropic API key for spawned sessions (e.g., 'x' for meridian proxy).
   * Still readable for backwards-compat; new code should consult
   * `credentials` via `getProviderCredential()`.
   */
  anthropicApiKey?: string;
  /**
   * @deprecated v1.0.0 — use `credentials.anthropic.baseUrl` instead.
   * Anthropic base URL for spawned sessions.
   */
  anthropicBaseUrl?: string;
  /** Minutes of idle-at-prompt before a non-protected session is killed (default: 15) */
  idlePromptKillMinutes?: number;
  /** Minutes of idle-at-prompt before killing a session bound to a live Telegram/Slack/iMessage
   *  topic. Topic-bound sessions are agents *waiting* for the next user message — "idle at
   *  prompt" is the healthy state, not a zombie. Default: 240 (4h) — long enough that
   *  conversational pauses through a workday don't kill the session, short enough to release
   *  resources from sessions the user has truly abandoned. The bridge will detect truly-dead
   *  Claude processes via isSessionAlive on the next message and respawn cleanly. */
  idlePromptKillMinutesBoundToTopic?: number;
  /** Absolute maximum session duration in minutes — safety net for sessions
   *  without an explicit timeout (default: 240) */
  defaultMaxDurationMinutes?: number;
  /** Tri-state liveness-oracle tuning (UNIFIED-SESSION-LIFECYCLE §P1). Partial —
   *  unset fields fall back to DEFAULT_LIVENESS_CONFIG. Validated at startup so a
   *  sub-floor probe timeout (which would re-create the 2026-05-27 false-purge)
   *  is rejected loudly. */
  liveness?: Partial<import('./SessionLivenessOracle.js').SessionLivenessOracleConfig>;
}

// ── Job Scheduling ──────────────────────────────────────────────────

export interface JobDefinition {
  slug: string;
  name: string;
  description: string;
  /** Cron expression (e.g., "0 0/4 * * *" for every 4 hours) */
  schedule: string;
  /** Priority level — higher priority jobs run first and survive quota pressure */
  priority: JobPriority;
  /** Expected duration in minutes (for scheduling decisions) */
  expectedDurationMinutes: number;
  /** Model tier to use */
  model: ModelTier;
  /** Whether this job is currently enabled */
  enabled: boolean;
  /** The skill or prompt to execute */
  execute: JobExecution;
  /** Pre-flight gate command — runs before spawning a session.
   *  If the command exits non-zero, the job is skipped (nothing to do).
   *  Zero-token pre-screening that prevents unnecessary Claude sessions.
   *  Example: `curl -sf http://localhost:3000/updates | python3 -c "import sys,json; exit(0 if json.load(sys.stdin).get('updateAvailable') else 1)"`
   */
  gate?: string;
  /** Tags for filtering/grouping */
  tags?: string[];
  /** Telegram topic ID this job reports to (auto-created if not set) */
  topicId?: number;
  /** Controls when this job sends Telegram notifications.
   *  - true: always notify on completion (legacy behavior)
   *  - false: never notify (no topic created)
   *  - 'on-alert': only notify on failure or when session signals [ATTENTION] (DEFAULT)
   *  When undefined, defaults to 'on-alert' — jobs are quiet unless they have
   *  something that needs the user's attention. */
  telegramNotify?: boolean | 'on-alert';
  /** Grounding configuration — what context this job needs at session start */
  grounding?: JobGrounding;
  /** LLM supervision tier — see docs/LLM-SUPERVISED-EXECUTION.md */
  supervision?: SupervisionTier;
  /** Living Skills — opt-in execution journaling and pattern detection (PROP-229) */
  livingSkills?: LivingSkillsConfig;
  /** Machine scope — restrict this job to specific machines.
   *  Values can be machine IDs (m_...) or machine names (case-insensitive).
   *  If omitted or empty, the job runs on ALL machines (default behavior).
   *  Example: ["m_abc123...", "justins-macbook"] */
  machines?: string[];
  /** Common blockers — pre-confirmed resolution patterns for this job.
   *  Injected into working memory at session start and used by the
   *  EscalationResolutionReviewer to catch unnecessary human escalations. */
  commonBlockers?: Record<string, CommonBlocker>;
  /** Origin marker — distinguishes instar-default jobs from user-authored.
   *  Populated by the JobLoader from per-slug manifest entries. Legacy
   *  jobs.json entries do NOT carry this field (left undefined). See
   *  docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §"Two namespaces". */
  origin?: 'instar' | 'user';
  /** Cached markdown body for execute.type === "agentmd" entries.
   *  Populated once at load time so buildPrompt never opens a file. */
  body?: string;
  /** Parsed YAML frontmatter for execute.type === "agentmd" entries.
   *  Closed-set whitelist of keys, validated via Zod preprocessors. */
  frontmatter?: Record<string, unknown>;
  /** Paired flag for toolAllowlist: "*" — see spec §5. Phase 1a stores
   *  the value but does not act on it (scheduler dispatch lands in 1b).
   *  Phase 1b enforces: `toolAllowlist === "*"` requires this to be `true`
   *  or the allowlist is clamped to `["Read"]`. */
  unrestrictedTools?: boolean;
  /** Monotonic counter for optimistic concurrency on save and
   *  observability. Sourced from the per-slug manifest. Absent for
   *  legacy jobs.json entries. */
  manifestVersion?: number;
  /** Absolute path that the agentmd body was resolved from. Populated
   *  by the loader for `execute.type === "agentmd"` entries; absent for
   *  legacy entries. Surfaced into the run-record. */
  resolvedPath?: string;
  /** Lock-file trust outcome for instar-origin agentmd entries. Set by the
   *  Phase 1c loader after the lock-file consumer hash-checks `body` +
   *  `frontmatter` against the signed lock-file. Possible values:
   *
   *  - 'trusted' — origin:instar AND lock-file present AND signature OK AND
   *    body/frontmatter hash matches the locked entry. Full trust elevation
   *    applies: grounding-audit exemption, allowlist default lookup, etc.
   *  - 'untrusted-no-lockfile' — origin:instar but no lock-file shipped yet
   *    (pre-Phase-1c-build state). Treat as user-origin for trust decisions.
   *  - 'untrusted-bad-signature' — lock-file is present but its signature
   *    failed Ed25519 verification. Degraded mode; alert the operator.
   *  - 'untrusted-not-in-lockfile' — origin:instar but the slug is not in
   *    the locked default set. This is the "forged default" attack — the
   *    runtime refuses to elevate trust.
   *  - 'untrusted-hash-mismatch' — slug IS in the lock-file but the
   *    on-disk body/frontmatter hash does not match. Skip-until-ack.
   *
   *  Absent for legacy entries and for origin:user entries. */
  lockTrust?:
    | 'trusted'
    | 'untrusted-no-lockfile'
    | 'untrusted-bad-signature'
    | 'untrusted-not-in-lockfile'
    | 'untrusted-hash-mismatch';
}

/** A pre-confirmed resolution for a common blocker pattern. */
export interface CommonBlocker {
  /** Human-readable description of the blocker pattern */
  description: string;
  /** How to resolve this blocker without human intervention */
  resolution: string;
  /** Confirmation status: 'confirmed' means tested and working */
  status?: 'confirmed' | 'pending' | 'expired';
  /** Tools needed to execute the resolution */
  toolsNeeded?: string[];
  /** Credential sources needed (string or array) */
  credentials?: string | string[];
  /** ISO timestamp when this blocker resolution was last confirmed */
  confirmedAt?: string;
  /** ISO timestamp after which this resolution should be re-verified */
  expiresAt?: string;
  /** ISO timestamp when this blocker was last used */
  lastUsedAt?: string;
  /** Number of times this resolution has been successfully applied */
  successCount?: number;
  /** Who resolved this blocker ('agent' | 'research-agent' | 'human') */
  resolvedBy?: string;
  /** Session ID that added this blocker (for learning loop provenance) */
  addedFrom?: string;
  /** ISO timestamp when this blocker was added */
  addedAt?: string;
}

/** Machine-readable description of what an agent CAN do. */
export interface CapabilityRegistry {
  /** Authentication methods available, keyed by service name */
  authentication?: Record<string, { tool: string; platforms: string[] }>;
  /** Tools available to the agent, keyed by tool category */
  tools?: Record<string, { tool: string; capabilities: string[] }>;
  /** Accounts/platforms the agent has access to, keyed by platform */
  accountsOwned?: Record<string, { handle?: string; authMethod: string }>;
  /** Credential infrastructure availability */
  credentials?: { hasEnvFile?: boolean; hasSecretStore?: boolean; hasBitwarden?: boolean };
}

export interface JobGrounding {
  /** Whether this job requires identity grounding before execution */
  requiresIdentity: boolean;
  /** Whether this job processes external/untrusted input (requires security screening) */
  processesExternalInput?: boolean;
  /** Additional context files to inject at job start (relative to .instar/) */
  contextFiles?: string[];
  /** Custom grounding questions the agent must answer before proceeding */
  questions?: string[];
}

/**
 * LLM-Supervised Execution Standard — supervision tier for jobs.
 *
 * Every critical pipeline should have at minimum Tier 1 supervision.
 * See docs/LLM-SUPERVISED-EXECUTION.md for the full standard.
 *
 * - tier0: Raw programmatic — no LLM validation. Fast, cheap, silent failures.
 * - tier1: LLM-supervised — lightweight model (Haiku) validates each step. Observed failures.
 * - tier2: Full intelligent — capable model (Sonnet/Opus) handles reasoning. Handled failures.
 */
export type SupervisionTier = 'tier0' | 'tier1' | 'tier2';

export type JobPriority = 'critical' | 'high' | 'medium' | 'low';

export interface JobExecution {
  /** Type of execution.
   *  - "skill" / "prompt" / "script": legacy inline forms.
   *  - "agentmd": resolves to .instar/jobs/<origin>/<slug>.md whose body
   *    is the prompt. The execution block carries no `value` — the body
   *    lives in the markdown file and is cached on JobDefinition.body.
   *    See docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md. */
  type: 'skill' | 'prompt' | 'script' | 'agentmd';
  /** The skill name, prompt text, or script path.
   *  Required for legacy types; absent for "agentmd". */
  value?: string;
  /** Additional arguments */
  args?: string;
}

/** Execute block for the new agentmd format. The markdown body and its
 *  parsed frontmatter are loaded from disk into JobDefinition.body and
 *  JobDefinition.frontmatter — they are NOT stored on the execute block. */
export interface AgentMdExecute {
  type: 'agentmd';
}

export interface JobState {
  slug: string;
  lastRun?: string;
  lastResult?: 'success' | 'failure' | 'timeout' | 'pending';
  /** Error message from the last failure (cleared on success) */
  lastError?: string;
  /** Handoff notes from the last successful run — claims to verify, not facts */
  lastHandoff?: string;
  nextScheduled?: string;
  consecutiveFailures: number;
}

export interface JobSchedulerConfig {
  /** Path to jobs definition file */
  jobsFile: string;
  /** Whether the scheduler is active */
  enabled: boolean;
  /** Maximum parallel job sessions */
  maxParallelJobs: number;
  /** Quota thresholds for load shedding */
  quotaThresholds: {
    /** Below this: all jobs run */
    normal: number;
    /** Above this: only high+ priority */
    elevated: number;
    /** Above this: only critical */
    critical: number;
    /** Above this: no jobs */
    shutdown: number;
  };
  /** Grace period (ms) before first missed-job evaluation, allowing HTTP server to start.
   *  Defaults to 5000ms. Set to 0 to disable. */
  startupGraceMs?: number;
  /** Number of gate retry attempts before skipping. Defaults to 3. */
  gateRetries?: number;
  /** Delay between gate retries in ms. Defaults to 5000. */
  gateRetryDelayMs?: number;
  /** Auth token exposed to gate shell commands as $INSTAR_AUTH_TOKEN so gates can call authenticated localhost endpoints. */
  authToken?: string;
  /** Wake-time job reaper — closes runs left pending after the host wakes from sleep. */
  wakeReaper?: {
    /** Minimum sleep duration (seconds) to trigger a reap pass. Defaults to 60. */
    minSleepSeconds?: number;
    /** Multiple of `expectedDurationMinutes` past which a pending run is considered stuck. Defaults to 2 — same threshold the scheduler already uses for claim TTL. */
    thresholdMultiplier?: number;
  };
}

// ── User Management ─────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  name: string;
  /** Communication channels this user is reachable on */
  channels: UserChannel[];
  /** What this user is allowed to do */
  permissions: string[];
  /** How the agent should interact with this user */
  preferences: UserPreferences;
  /** Interaction history summary (auto-generated from conversations) */
  context?: string;
  /** Short bio or description provided during onboarding */
  bio?: string;
  /** User's interests or topics they care about */
  interests?: string[];
  /** How this user relates to the agent/project (e.g., "project lead", "beta tester") */
  relationshipContext?: string;
  /** Custom profile fields defined by agent's onboarding config */
  customFields?: Record<string, string>;
  /** Consent record (GDPR compliance) */
  consent?: ConsentRecord;
  /** What data categories are stored for this user */
  dataCollected?: DataCollectedManifest;
  /** Whether this user's Telegram topic is pending creation */
  pendingTelegramTopic?: boolean;
  /** ISO timestamp of when the user was created */
  createdAt?: string;
  /** Telegram numeric user ID (canonical identifier for identity binding) */
  telegramUserId?: number;
}

export interface UserChannel {
  /** Channel type (telegram, slack, discord, email, etc.) */
  type: string;
  /** Channel-specific identifier (topic ID, Slack user ID, email address, etc.) */
  identifier: string;
}

export interface UserPreferences {
  /** Communication style (e.g., "technical and direct", "prefers explanations") */
  style?: string;
  /** Whether to auto-execute or confirm with this user */
  autonomyLevel?: 'full' | 'confirm-destructive' | 'confirm-all';
  /** Timezone for scheduling */
  timezone?: string;
}

/**
 * Structured user context block for session injection.
 * This is what gets injected into the session prompt so the agent
 * knows who it's talking to. Bounded by maxContextTokens.
 *
 * CRITICAL: permissions are injected as structured data that the
 * LLM cannot override via social engineering (Gap 8 requirement).
 */
export interface UserContextBlock {
  /** User's display name */
  name: string;
  /** User's unique ID */
  userId: string;
  /** Structured permissions (NOT natural language — cannot be overridden) */
  permissions: string[];
  /** Communication preferences */
  preferences?: {
    style?: string;
    autonomyLevel?: string;
    timezone?: string;
  };
  /** Short bio */
  bio?: string;
  /** Interests */
  interests?: string[];
  /** Relationship to agent/project */
  relationshipContext?: string;
  /** Interaction history summary */
  context?: string;
  /** Custom fields from agent-specific onboarding */
  customFields?: Record<string, string>;
}

// ── Messaging ───────────────────────────────────────────────────────

export interface Message {
  /** Unique message ID */
  id: string;
  /** User who sent the message */
  userId: string;
  /** The message content */
  content: string;
  /** Channel the message came from */
  channel: UserChannel;
  /** When the message was received */
  receivedAt: string;
  /** Message metadata (platform-specific) */
  metadata?: Record<string, unknown>;
}

export interface OutgoingMessage {
  /** User to send to */
  userId: string;
  /** Message content */
  content: string;
  /** Specific channel to use (optional — uses default if omitted) */
  channel?: UserChannel;
}

/**
 * Messaging adapter interface.
 * Implement this for each platform (Telegram, Slack, Discord, etc.)
 */
/**
 * An adapter's durable "where I left off" marker (spec §Channel Seamlessness
 * Contract). Telegram = the long-poll update_id offset; Slack = the
 * per-conversation lastTs cursor. Serializable into synced state.
 */
export interface IngressPosition {
  platform: string;
  /** Opaque, adapter-specific resumable cursor (e.g. update_id offset, lastTs). */
  cursor: string | number | null;
  /** When this position was captured (ISO). */
  capturedAt: string;
  /** Optional per-conversation cursors (Slack channelResumeMap). */
  perConversation?: Record<string, string | number>;
}

export interface MessagingAdapter {
  /** Platform name (e.g., "telegram", "slack") */
  platform: string;
  /** Start listening for messages */
  start(): Promise<void>;
  /** Stop listening */
  stop(): Promise<void>;
  /** Send a message to a user. Returns platform-specific delivery info. */
  send(message: OutgoingMessage): Promise<void | unknown>;
  /** Register a handler for incoming messages */
  onMessage(handler: (message: Message) => Promise<void>): void;
  /** Resolve a platform-specific identifier to a user ID */
  resolveUser(channelIdentifier: string): Promise<string | null>;

  // ── Channel Seamlessness Contract (spec §, optional — opt-in per adapter) ──
  // An adapter is "seamless-ready" only once it implements these AND passes the
  // §10 contract-conformance suite. Optional so existing adapters compile
  // unchanged; the seamless handoff path checks for their presence.
  /** The adapter's durable resumable position, serializable into synced state. */
  getIngressPosition?(): IngressPosition;
  /** Stop the inbound loop, drain/discard in-flight deterministically, return the durable position AFTER stop. */
  stopConsuming?(): Promise<IngressPosition>;
  /** Resume the inbound loop from exactly the given position. */
  resumeConsuming?(position: IngressPosition): Promise<void>;
  /**
   * A stable provider-level identity for an inbound raw event (Telegram
   * update_id; Slack event_id/client_msg_id), used by the message-processing
   * ledger so a redelivered event is recognized and not re-acted-on.
   */
  dedupeKey?(rawEvent: unknown): string;
}

// ── Monitoring ──────────────────────────────────────────────────────

export interface QuotaState {
  /** Current weekly usage percentage (0-100) */
  usagePercent: number;
  /** 5-hour rolling rate limit utilization (0-100), if available */
  fiveHourPercent?: number;
  /** When usage data was last updated */
  lastUpdated: string;
  /** Per-account breakdown if multi-account */
  accounts?: AccountQuota[];
  /** Recommended action based on usage */
  recommendation?: 'normal' | 'reduce' | 'critical' | 'stop';
}

export interface AccountQuota {
  email: string;
  usagePercent: number;
  /** 5-hour rolling rate limit utilization for this account */
  fiveHourPercent?: number;
  isActive: boolean;
  lastUpdated: string;
}

/** Cause of a session's death, as classified by QuotaExhaustionDetector */
export type SessionDeathCause =
  | 'quota_exhaustion'   // Ran into rate limit or quota cap
  | 'context_exhausted'  // Context window full
  | 'crash'              // Unexpected error/crash
  | 'timeout'            // Killed by session timeout
  | 'normal_exit'        // Completed normally
  | 'unknown';           // Could not determine

export interface SessionDeathClassification {
  cause: SessionDeathCause;
  confidence: 'high' | 'medium' | 'low';
  detail: string;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: Record<string, ComponentHealth>;
  timestamp: string;
}

export interface ComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  lastCheck: string;
}

// ── Intelligence Provider ───────────────────────────────────────────

/**
 * Optional LLM intelligence for judgment calls.
 *
 * Any module that makes decisions beyond simple lookups can declare
 * `intelligence?: IntelligenceProvider` in its config. This is the
 * structural pattern that prevents defaulting to brittle heuristics.
 *
 * The contract: heuristics narrow candidates, the provider decides.
 * When no provider is configured, modules fall back to heuristic-only
 * behavior — functional but less accurate.
 *
 * Born from the "heuristics are pre-filters, not decision-makers" lesson.
 */
export interface IntelligenceProvider {
  /**
   * Ask the LLM to evaluate a judgment call.
   * Returns a structured response that the caller parses.
   *
   * @param prompt - The judgment to make, with full context
   * @param options - Optional configuration for this call
   * @returns The LLM's response text
   */
  evaluate(prompt: string, options?: IntelligenceOptions): Promise<string>;
}

export interface IntelligenceOptions {
  /** Model tier preference (implementations may override based on availability) */
  model?: 'fast' | 'balanced' | 'capable';
  /** Maximum tokens for the response */
  maxTokens?: number;
  /** Temperature (0-1, lower = more deterministic) */
  temperature?: number;
  /** Per-call timeout in milliseconds; provider should honor or surface as throw. */
  timeoutMs?: number;
  /**
   * Attribution context for the burn-detection-and-self-heal system (Phase 1
   * of docs/specs/token-burn-detection-and-self-heal.md). Optional; missing
   * attribution lands under the `unknown::*` fallback keys so existing
   * callers keep working unchanged. New callers should set it.
   */
  attribution?: {
    /** Stable source-side component label, e.g. "InputDetector", "MessagingToneGate". */
    component: string;
  };
}

// ── Drift Checker ───────────────────────────────────────────────────
//
// PROJECT-SCOPE-SPEC Phase 1.4. The drift checker emits a *signal* only —
// authority for round-start lives in ProjectRoundRunner. Verdicts are
// recorded on the round (lastDriftVerdict) and surfaced in the digest.

/**
 * A verified excerpt from a referenced file at the time of the drift check.
 * The LLM proposes citations; the checker re-opens the file, confirms the
 * byteRange is in bounds, and renders the slice itself — the LLM-claimed
 * text is never displayed. Citations that fail verification are dropped.
 */
export interface VerifiedCitation {
  /** Path relative to targetRepoPath. */
  file: string;
  /** [start, end] byte offsets into the file, validated server-side. */
  byteRange: [number, number];
  /** Verified slice (truncated to 240 chars for digest display). */
  excerpt: string;
}

/**
 * The verdict returned by ProjectDriftChecker.run().
 * `manual-review-required` is the catch-all for any failure mode that
 * means the verdict cannot be trusted — over-budget, deleted files,
 * timeout, schema-fail, citation-verification-fail. Callers route it
 * to user attention rather than treating it as a soft pass.
 */
export type DriftVerdict =
  | { verdict: 'no-drift'; rationale: string; evidenceCitations: VerifiedCitation[] }
  | { verdict: 'minor-drift'; rationale: string; evidenceCitations: VerifiedCitation[] }
  | { verdict: 'premise-violated'; rationale: string; evidenceCitations: VerifiedCitation[] }
  | {
      verdict: 'manual-review-required';
      reason:
        | 'over-budget'
        | 'deleted-files'
        | 'empty-spec'
        | 'missing-frontmatter'
        | 'timeout'
        | 'failed-citation-verification'
        | 'schema-fail'
        | 'no-provider'
        | 'path-jail-fail';
      rationale?: string;
    };

// ── Relationship Tracking ───────────────────────────────────────────

export interface RelationshipRecord {
  /** Unique identifier for this person */
  id: string;
  /** Display name */
  name: string;
  /** Known identifiers across platforms */
  channels: UserChannel[];
  /** When the agent first interacted with this person */
  firstInteraction: string;
  /** When the agent last interacted with this person */
  lastInteraction: string;
  /** Total number of interactions */
  interactionCount: number;
  /** Key topics discussed across conversations */
  themes: string[];
  /** Agent's notes about this person — observations, preferences, context */
  notes: string;
  /** Communication style preferences the agent has observed */
  communicationStyle?: string;
  /** How significant this relationship is (0-10, auto-derived from frequency and depth) */
  significance: number;
  /** Brief summary of the relationship arc */
  arcSummary?: string;
  /** Relationship category (e.g., 'collaborator', 'community_member', 'kindred_ai') */
  category?: string;
  /** Freeform tags for flexible categorization */
  tags?: string[];
  /** Per-interaction log (last N interactions, kept compact) */
  recentInteractions: InteractionSummary[];
}

export interface InteractionSummary {
  /** When this interaction happened */
  timestamp: string;
  /** Which platform/channel */
  channel: string;
  /** Brief summary of what was discussed */
  summary: string;
  /** Topics touched on */
  topics?: string[];
}

export interface RelationshipManagerConfig {
  /** Directory to store relationship files */
  relationshipsDir: string;
  /** Maximum recent interactions to keep per relationship */
  maxRecentInteractions: number;
  /**
   * Optional LLM intelligence for judgment calls (identity resolution,
   * duplicate detection, merge decisions). When absent, falls back to
   * string-based heuristics. When present, heuristics narrow candidates
   * and the LLM makes the final call.
   */
  intelligence?: IntelligenceProvider;
}

// ── Skip Ledger & Auto-Tune ─────────────────────────────────────────

export type SkipReason =
  | 'disabled'        // Job has enabled: false
  | 'paused'          // Scheduler is paused
  | 'quota'           // Quota constraints
  | 'memory-pressure' // Memory gate blocked the job (distinct from quota)
  | 'capacity'        // No available session slots (queued instead of skipped, but tracked)
  | 'claimed'         // Another machine already claimed this job (Phase 4C — Gap 5)
  | 'machine-scope'   // Job is scoped to a different machine
  | 'gate';           // Gate command returned non-zero (nothing to do)

/**
 * Result of a canRunJob gate check. The callback may return a plain boolean
 * (legacy) or this richer form so the scheduler can log/track the actual
 * gating reason instead of always reporting 'quota'.
 */
export interface CanRunJobResult {
  allowed: boolean;
  reason?: SkipReason;
  detail?: string;
}

export interface SkipEvent {
  slug: string;
  timestamp: string;       // ISO timestamp
  reason: SkipReason;
  scheduledAt?: string;    // When this run was scheduled
}

export interface WorkloadSignal {
  slug: string;
  timestamp: string;       // ISO timestamp — when the run completed
  duration: number;        // Seconds the job actually ran
  skipFast: boolean;       // Did the job exit early with nothing to do?
  itemsFound: number;      // How many work items were discovered
  itemsProcessed: number;  // How many were actually processed
  saturation: number;      // itemsProcessed / itemsFound (0-1, or 0 if none found)
  notes?: string;          // Optional context from the job
}

export interface AutoTuneState {
  slug: string;
  baseSchedule: string;         // Original cron expression
  effectiveSchedule: string;    // Current (possibly adjusted) cron expression
  tuneFactor: number;           // Multiplier: <1 = faster, >1 = slower
  lastTuned: string;            // ISO timestamp
  recentSkipFastRate: number;   // % of recent runs that skip-fasted (0-1)
  recentSaturation: number;     // Average saturation of recent runs (0-1)
  windowSize: number;           // How many recent runs to consider
}

// ── Activity Tracking ───────────────────────────────────────────────

export interface ActivityEvent {
  type: string;
  summary: string;
  /** Which session generated this event */
  sessionId?: string;
  /** Which user triggered this, if any */
  userId?: string;
  /** Originating machine ID (Phase 4D — Gap 6: machine-prefixed state) */
  machineId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ── Feedback Loop ───────────────────────────────────────────────────

export interface FeedbackItem {
  /** Unique feedback ID */
  id: string;
  /** Feedback type */
  type: 'bug' | 'feature' | 'improvement' | 'question' | 'hallucination' | 'other';
  /** Short title/summary */
  title: string;
  /** Detailed description */
  description: string;
  /** Agent name that submitted this */
  agentName: string;
  /** Pseudonymized agent identifier — stable hash, not reversible without shared secret */
  agentPseudonym?: string;
  /** Instar version the agent is running */
  instarVersion: string;
  /** Node.js version */
  nodeVersion: string;
  /** Operating system */
  os: string;
  /** When this feedback was submitted */
  submittedAt: string;
  /** Whether this has been forwarded to the webhook */
  forwarded: boolean;
  /** Additional context (error messages, config snippets, etc.) */
  context?: string;
}

export interface FeedbackConfig {
  /** Whether feedback is enabled */
  enabled: boolean;
  /** Webhook URL to forward feedback to (default: https://dawn.bot-me.ai/api/instar/feedback) */
  webhookUrl: string;
  /** Local feedback storage file */
  feedbackFile: string;
  /** Instar version — sent in User-Agent and X-Instar-Version headers for endpoint auth */
  version?: string;
  /** Shared secret for HMAC-SHA256 request signing. Generated during init. */
  sharedSecret?: string;
}

export interface UpdateInfo {
  /** Currently installed version */
  currentVersion: string;
  /** Latest available version on npm */
  latestVersion: string;
  /** Whether an update is available */
  updateAvailable: boolean;
  /** When this check was performed */
  checkedAt: string;
  /** Changelog URL if available */
  changelogUrl?: string;
  /** Human-readable summary of what changed (fetched from GitHub releases) */
  changeSummary?: string;
}

export interface UpdateResult {
  /** Whether the update was successfully applied */
  success: boolean;
  /** Version before the update */
  previousVersion: string;
  /** Version after the update */
  newVersion: string;
  /** Human-readable description of what happened */
  message: string;
  /** Whether a restart is needed to use the new version */
  restartNeeded: boolean;
  /** Health check result after update */
  healthCheck?: 'healthy' | 'degraded' | 'unhealthy' | 'skipped';
}

// ── Evolution System ────────────────────────────────────────────────

/**
 * Evolution proposal — a staged self-improvement suggestion.
 *
 * Unlike direct self-modification (editing jobs.json, creating skills),
 * proposals are staged for review before implementation. This gives
 * the agent (and optionally the user) a chance to evaluate whether
 * the change is wise before it takes effect.
 *
 * Born from Portal's EVOLUTION_QUEUE pattern (100+ completed proposals).
 */
export interface EvolutionProposal {
  /** Unique ID (e.g., "EVO-001") */
  id: string;
  /** Short title describing the proposed change */
  title: string;
  /** Where this proposal came from */
  source: string;
  /** Full description of what to change and why */
  description: string;
  /** Category of change */
  type: EvolutionType;
  /** Expected impact if implemented */
  impact: 'high' | 'medium' | 'low';
  /** Estimated effort to implement */
  effort: 'high' | 'medium' | 'low';
  /** Current status */
  status: EvolutionStatus;
  /** Who or what proposed this */
  proposedBy: string;
  /** When proposed */
  proposedAt: string;
  /** When implemented (if status is 'implemented') */
  implementedAt?: string;
  /** Implementation notes */
  resolution?: string;
  /** Tags for categorization */
  tags?: string[];
  /**
   * Optional MemoryEntity id for the cluster's pattern entity.
   * Populated by Phase 2 WikiClaim evidence integration when SemanticMemory is
   * wired into EvolutionManager. Stable across the proposal's lifetime; older
   * proposals (created before Phase 2 wiring) leave this undefined.
   *
   * See docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md § Producers.
   */
  entityId?: string;
}

export type EvolutionType =
  | 'capability'     // New ability the agent should have
  | 'infrastructure' // Change to jobs, hooks, scripts
  | 'voice'          // Communication style improvement
  | 'workflow'       // Process/pipeline improvement
  | 'philosophy'     // Deeper understanding or principle
  | 'integration'    // New platform or service connection
  | 'performance';   // Efficiency improvement

export type EvolutionStatus =
  | 'proposed'       // Identified but not yet evaluated
  | 'approved'       // Evaluated and approved for implementation
  | 'in_progress'    // Currently being implemented
  | 'implemented'    // Done
  | 'rejected'       // Evaluated and decided against
  | 'deferred';      // Good idea but not now

/**
 * Structured learning entry — an insight captured from interaction.
 *
 * Unlike freeform MEMORY.md entries, these are structured, searchable,
 * cross-referenceable, and trackable (applied vs unapplied).
 */
export interface LearningEntry {
  /** Unique ID (e.g., "LRN-001") */
  id: string;
  /** Short title */
  title: string;
  /** Category of learning */
  category: string;
  /** Full description of the insight */
  description: string;
  /** Where this learning came from */
  source: LearningSource;
  /** Tags for cross-referencing */
  tags: string[];
  /** Has this learning been applied to improve the agent? */
  applied: boolean;
  /** What it was applied to (e.g., "EVO-003", "MEMORY.md") */
  appliedTo?: string;
  /** How relevant this is to agent evolution (freeform) */
  evolutionRelevance?: string;
}

export interface LearningSource {
  /** Who/what taught this */
  agent?: string;
  /** Platform where discovered */
  platform?: string;
  /** Content reference (post ID, thread ID, etc.) */
  contentId?: string;
  /** When discovered */
  discoveredAt: string;
  /** Session that captured this */
  session?: string;
}

/**
 * Capability gap — something the agent can't do but should.
 *
 * Extends self-diagnosis from "is my infrastructure broken?" to
 * "is my infrastructure sufficient?"
 */
export interface CapabilityGap {
  /** Unique ID (e.g., "GAP-001") */
  id: string;
  /** Short title */
  title: string;
  /** Category of gap */
  category: GapCategory;
  /** How critical this gap is */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Full description of the gap */
  description: string;
  /** How the gap was discovered */
  discoveredFrom: {
    context: string;
    platform?: string;
    discoveredAt: string;
    session?: string;
  };
  /** What the agent currently does (or doesn't) */
  currentState: string;
  /** What should be built to close the gap */
  proposedSolution?: string;
  /** Current status */
  status: 'identified' | 'addressed' | 'wont_fix';
  /** How it was resolved */
  resolution?: string;
  /** When addressed */
  addressedAt?: string;
}

export type GapCategory =
  | 'skill'          // Missing skill or capability
  | 'knowledge'      // Missing knowledge or context
  | 'integration'    // Missing platform or service connection
  | 'workflow'       // Inefficient or missing workflow
  | 'communication'  // Communication limitation
  | 'monitoring'     // Missing observability
  | 'custom';        // Agent-defined category

/**
 * Action/commitment item — something the agent promised to do.
 *
 * Tracks commitments made during interactions so they don't get lost.
 * Stale commitments are escalated automatically.
 */
export interface ActionItem {
  /** Unique ID (e.g., "ACT-001") */
  id: string;
  /** What was committed */
  title: string;
  /** Full description */
  description: string;
  /** Priority level */
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Current status */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  /** Who this commitment was made to */
  commitTo?: string;
  /** When this was created */
  createdAt: string;
  /** When this should be done by (ISO date) */
  dueBy?: string;
  /** When completed */
  completedAt?: string;
  /** How it was resolved */
  resolution?: string;
  /** Where this commitment was made */
  source?: {
    platform?: string;
    contentId?: string;
    context?: string;
  };
  /** Tags for categorization */
  tags?: string[];
}

/**
 * Evolution manager configuration.
 */
export interface EvolutionManagerConfig {
  /** Directory for evolution state files */
  stateDir: string;
  /** Whether auto-implementation of approved proposals is enabled */
  autoImplement?: boolean;
  /** Maximum proposals before oldest get archived */
  maxProposals?: number;
  /** Maximum learning entries before oldest get archived */
  maxLearnings?: number;
  /** Maximum gaps before oldest addressed get archived */
  maxGaps?: number;
  /** Maximum action items before oldest completed get archived */
  maxActions?: number;
}

// ── Soul.md — Self-Authored Identity ─────────────────────────────────

/** Sections of soul.md that can be individually updated. */
export type SoulSection =
  | 'core-values'
  | 'growth-edge'
  | 'convictions'
  | 'open-questions'
  | 'integrations'
  | 'evolution-history';

/** Conviction confidence categories (not floats — discrete, auditable). */
export type ConvictionConfidence = 'strong' | 'growing' | 'uncertain' | 'questioning';

/** Source of a soul.md write — used for audit trail and trust decisions. */
export type SoulWriteSource = 'reflect-skill' | 'evolution-job' | 'inline' | 'threadline';

/** Operation type for PATCH /identity/soul. */
export type SoulWriteOperation = 'replace' | 'append' | 'remove';

/** Request body for PATCH /identity/soul. */
export interface SoulPatchRequest {
  section: SoulSection;
  operation: SoulWriteOperation;
  content: string;
  source: SoulWriteSource;
}

/** Response for a successful soul.md patch. */
export interface SoulPatchResponse {
  status: 'applied' | 'pending';
  section: SoulSection;
  trustLevel: AutonomyProfileLevel;
  pendingId?: string;
}

/** A pending soul.md change awaiting user approval. */
export interface SoulPendingChange {
  id: string;
  section: SoulSection;
  operation: SoulWriteOperation;
  content: string;
  source: SoulWriteSource;
  trustLevel: AutonomyProfileLevel;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  resolvedAt?: string;
  rejectionReason?: string;
}

/** Audit event emitted on every soul.md write. */
export interface SoulWriteEvent {
  event: 'soul.write';
  timestamp: string;
  section: SoulSection;
  operation: SoulWriteOperation;
  trustLevel: AutonomyProfileLevel;
  source: SoulWriteSource;
  diffSummary: string;
  threadlineSource: string | null;
}

/** Drift analysis for a single section. */
export interface SoulDriftSection {
  section: SoulSection;
  divergencePercent: number;
  aboveThreshold: boolean;
}

/** Full drift analysis result. */
export interface SoulDriftReport {
  sections: SoulDriftSection[];
  anyAboveThreshold: boolean;
  lastReviewedAt: string | null;
  initSnapshotExists: boolean;
}

/**
 * Minimum trust level required to DIRECTLY write to each soul.md section.
 * At lower levels, writes are routed to the pending queue (not rejected).
 * Collaborative+ can write to all sections directly.
 */
export const SOUL_SECTION_TRUST: Record<SoulSection, AutonomyProfileLevel> = {
  'integrations': 'cautious',
  'open-questions': 'collaborative',
  'evolution-history': 'cautious',
  'convictions': 'collaborative',
  'core-values': 'collaborative',
  'growth-edge': 'collaborative',
};

// ── Living Skills (PROP-229) ─────────────────────────────────────────

/**
 * Configuration for Living Skills on a job.
 * Opt-in only — no journaling occurs unless explicitly enabled.
 */
export interface LivingSkillsConfig {
  /** Whether execution journaling is enabled for this job */
  enabled: boolean;
  /** Named steps the job definition says should be executed */
  definedSteps?: Array<string | DefinedStepConfig>;
  /** Run per-job LLM reflection after each run. Default: true (set false to disable) */
  perJobReflection?: boolean;
  /** Model for per-job reflection. Default: opus */
  reflectionModel?: ModelTier | null;
  /** Frequency threshold for pattern proposals (0.0-1.0). Default: 0.6 */
  patternThreshold?: number;
  /** Enable IntegrationGate (blocks queue drain until learning captured). Default: true when livingSkills enabled */
  integrationGate?: boolean;
  /** Timeout in ms for IntegrationGate evaluation. Default: 30000 */
  integrationGateTimeoutMs?: number;
}

export interface DefinedStepConfig {
  step: string;
  /** If true, this step is protected from omission-detection removal proposals */
  required?: boolean;
}

/** A single captured execution step within a job run */
export interface ExecutionStep {
  /** Human-readable step identifier (e.g., "check-redis", "deploy-staging") */
  step: string;
  /** ISO timestamp when this step was captured */
  timestamp: string;
  /** Whether captured by hook (authoritative) or reported by agent (advisory) */
  source: ExecutionStepSource;
  /** Optional notes about what happened */
  notes?: string;
  /** The raw command that triggered capture (sanitized) */
  command?: string;
  /** Whether this step was in the job's definedSteps */
  inDefinition?: boolean;
}

export type ExecutionStepSource = 'hook' | 'agent' | 'reconciled';

/** A deviation from the expected job definition */
export interface ExecutionDeviation {
  type: 'addition' | 'omission' | 'modification';
  step: string;
  reason?: string;
}

/**
 * A single execution record in the journal.
 * One entry per job run, written to JSONL on session finalization.
 */
export interface ExecutionRecord {
  /** Unique execution ID (e.g., "exec-20260304-abc123") */
  executionId: string;
  /** Job slug this belongs to */
  jobSlug: string;
  /** Session ID that ran this job */
  sessionId: string;
  /** Agent identity for multi-agent namespacing */
  agentId: string;
  /** ISO timestamp of job start */
  timestamp: string;
  /** Steps the job definition says should run */
  definedSteps: string[];
  /** Steps actually captured during the run */
  actualSteps: ExecutionStep[];
  /** Deviations from defined steps */
  deviations: ExecutionDeviation[];
  /** How the job ended */
  outcome: 'success' | 'failure' | 'timeout' | 'unknown';
  /** Actual duration in minutes */
  durationMinutes?: number;
  /** Whether this record has been finalized */
  finalized: boolean;
}

/**
 * A pending step captured during execution.
 * Accumulated by the hook in _pending.{sessionId}.jsonl,
 * then merged into a full ExecutionRecord on finalization.
 */
export interface PendingStep {
  sessionId: string;
  jobSlug: string;
  timestamp: string;
  command: string;
  source: 'hook';
  stepLabel?: string;
}

// ── Decision Journal ────────────────────────────────────────────────

/**
 * Decision journal entry — records intent-relevant decisions for alignment analysis.
 *
 * The decision journal is the measurement foundation for intent engineering.
 * Without observing real agent decisions, intent definitions are speculation.
 * Zero-config: logging activates automatically when an Intent section exists in AGENT.md.
 *
 * Storage: per-agent JSONL file (.instar/decision-journal.jsonl)
 */
export interface DecisionJournalEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Session ID that made the decision */
  sessionId: string;
  /** Telegram topic ID if applicable */
  topicId?: number;
  /** Job slug if this decision was made during a job */
  jobSlug?: string;
  /** What was decided */
  decision: string;
  /** What alternatives were considered */
  alternatives?: string[];
  /** Which AGENT.md principle or intent guided the choice */
  principle?: string;
  /** Agent's confidence in alignment with stated intent (0-1) */
  confidence?: number;
  /** Relevant context at decision time */
  context?: string;
  /** Whether this decision conflicted with an org-level constraint */
  conflict?: boolean;
  /** Tags for categorization */
  tags?: string[];
  /**
   * Evidence supporting this decision (WikiClaim Phase 3).
   *
   * REQUIRED at write time when DecisionJournal is wired with SemanticMemory
   * (the producer bridge promotes the entry to a `decision` MemoryEntity).
   * Spec § Producers line 227 allows DecisionJournal to write evidence kinds:
   *   `message` | `commit` | `ledger-entry` | `session`
   * Mismatched kinds reject with `EvidencePolicyError`.
   *
   * On read, this field is read-through from the JSONL row — entries written
   * before Phase 3 have `evidence: undefined` (legacy), entries written after
   * with SemanticMemory unwired retain whatever the caller passed (defaults
   * to `[]`).
   *
   * See docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md § Producers
   * line 258 (Decision journal) and line 339 (Phase 3).
   */
  evidence?: MemoryEvidence[];
  /**
   * MemoryEntity id of the `decision` entity promoted from this journal row
   * by the DecisionJournal→SemanticMemory bridge (Phase 3). Present when
   * SemanticMemory was wired at log time; absent otherwise. Acts as the
   * back-reference for inverse-traceability queries.
   */
  entityId?: string;
}

/**
 * Dispatch-specific decision journal entry.
 * Extends the base DecisionJournalEntry with dispatch integration fields.
 * This is the foundation for the Discernment Layer — logging every dispatch
 * integration decision for observability, harvesting, and identity formation.
 *
 * In Milestone 1, all entries are `{ dispatchDecision: 'accept', reasoning: 'auto-applied' }`.
 * Intelligence comes in Milestone 4 (LLM evaluation).
 */
export interface DispatchDecisionEntry extends DecisionJournalEntry {
  /** Discriminator tag for dispatch decisions */
  type: 'dispatch';
  /** The dispatch ID this decision applies to */
  dispatchId: string;
  /** Dispatch type (lesson, strategy, configuration, etc.) */
  dispatchType: string;
  /** Dispatch priority */
  dispatchPriority: string;
  /** The integration decision */
  dispatchDecision: 'accept' | 'adapt' | 'defer' | 'reject';
  /** Why this decision was made */
  reasoning: string;
  /** Whether this was auto-evaluated (structural only) or LLM-evaluated */
  evaluationMethod: 'structural' | 'contextual';
  /** Adaptation summary if decision was 'adapt' */
  adaptationSummary?: string;
  /** Post-adaptation scope validation result */
  adaptationScopeResult?: 'passed' | 'failed' | 'skipped';
  /** Evaluator prompt version (for tracking drift) */
  promptVersion?: string;
  /** Whether the dispatch was successfully applied after acceptance */
  applied?: boolean;
  /** Error message if application failed */
  applicationError?: string;
}

// ── Agent Context Snapshot (Discernment Layer) ──────────────────────

/**
 * Structured snapshot of agent state for contextual dispatch evaluation.
 * Used by the Discernment Layer to provide the LLM evaluator with
 * agent context. Designed with data minimization — only structural
 * metadata, no sensitive operational details.
 *
 * Hard truncation rules (from spec v3):
 * - identity.intent: max 200 tokens (~800 chars), truncated with [truncated]
 * - recentDecisions: max 20 entries, each decision string max 100 chars
 * - activeJobs: max 20 entries
 * - appliedDispatchSummary: counts only, no content
 * - Total snapshot MUST fit in 800 tokens
 */
export interface AgentContextSnapshot {
  /** Agent name and description */
  identity: {
    name: string;
    description: string;
    intent?: string;
  };
  /** Enabled features and platform bindings */
  capabilities: {
    platforms: string[];
    features: string[];
    disabledFeatures: string[];
  };
  /** Active job slugs and descriptions */
  activeJobs: Array<{ slug: string; description: string }>;
  /** Recent decision patterns (last 20 entries, summarized) */
  recentDecisions: Array<{ decision: string; principle?: string; tags?: string[] }>;
  /** Current autonomy profile level */
  autonomyLevel: AutonomyProfileLevel;
  /** Count and types of already-applied dispatches */
  appliedDispatchSummary: { count: number; byType: Record<string, number> };
  /** Self-knowledge tree metadata (if tree is configured) */
  selfKnowledge?: {
    treeVersion: string;
    totalNodes: number;
    lastSearchQuery?: string;
    lastSearchTimestamp?: string;
  };
  /** Snapshot generation timestamp */
  generatedAt: string;
}

// ── Multi-Machine ───────────────────────────────────────────────────

export interface MachineIdentity {
  /** Unique machine ID: "m_" + 32 random hex chars (128 bits) */
  machineId: string;
  /** Base64-encoded Ed25519 public key (for signing commits, API requests) */
  signingPublicKey: string;
  /** Base64-encoded X25519 public key (for encryption, ECDH key agreement) */
  encryptionPublicKey: string;
  /** Human-friendly machine name (auto-detected or user-provided) */
  name: string;
  /** Platform identifier, e.g. "darwin-arm64", "linux-x64" */
  platform: string;
  /** ISO timestamp of identity creation */
  createdAt: string;
  /** What this machine can do */
  capabilities: MachineCapability[];
}

export type MachineCapability = 'telegram' | 'jobs' | 'tunnel' | 'sessions';

export type MachineStatus = 'active' | 'revoked' | 'pending';
export type MachineRole = 'awake' | 'standby';

/**
 * Coordination mode for multi-machine setups.
 * - 'primary-standby': One awake, others standby with failover (default)
 * - 'independent': Both machines active with separate Telegram groups (Gap 1)
 */
export type CoordinationMode = 'primary-standby' | 'independent';

export interface MachineRegistryEntry {
  /** Human-friendly machine name (auto-detected hostname at pairing; static). */
  name: string;
  /**
   * User-facing, EDITABLE nickname — the handle a user types in "run this on
   * <nickname>" / "move this to <nickname>" (Multi-Machine Session Pool §L2).
   * Auto-assigned at registration via NicknameAssigner (idempotent — kept if
   * already set), editable via PATCH /pool/machines/:id, unique within the pool.
   * Optional for backward-compat with registries written before §L2.
   */
  nickname?: string;
  /**
   * Self-attested static hardware properties (Session Pool §L2) — captured by
   * the machine from `os` and recorded into ITS OWN registry entry, then synced
   * to peers via the registry. Surfaced on the Machines dashboard tab + GET /pool.
   * Optional (absent until the machine records it).
   */
  hardware?: MachineHardware;
  /** Current trust status */
  status: MachineStatus;
  /** Current operational role */
  role: MachineRole;
  /** ISO timestamp of when this machine was paired */
  pairedAt: string;
  /** ISO timestamp of last heartbeat or activity */
  lastSeen: string;
  /** Last known reachable URL (tunnel URL) — for cross-machine relay */
  lastKnownUrl?: string;
  /** ISO timestamp of revocation (if revoked) */
  revokedAt?: string;
  /** Machine ID that revoked this one */
  revokedBy?: string;
  /** Human-readable revocation reason */
  revokeReason?: string;
  // ── Cross-Machine Seamlessness (spec v1) ──────────────────────────
  /**
   * Per-author monotonic sequence. Each authority-bearing registry write
   * by this machine increments it. A pulled commit whose syncSequence is
   * not strictly greater than the last applied for its author is discarded
   * (replay/freshness guard, spec §8 G2).
   */
  syncSequence?: number;
  /**
   * leaseEpoch this entry was authored under. A pulled commit whose
   * leaseEpoch is lower than the current committed epoch is discarded —
   * catches a wiped/re-keyed machine whose per-author sequence reset to 0.
   */
  authoredUnderEpoch?: number;
  /**
   * Mesh protocol version this machine speaks. A machine below the
   * fenced-lease protocol version is ineligible for the awake lease
   * during a seamless handoff (partial-migration safety, spec §11).
   */
  protocolVersion?: number;
  /**
   * Set true on the FIRST commit from a re-keyed / freshly-joined machine.
   * Such a first commit is accepted only if role is 'standby' + rejoined
   * (spec §8 G2 unknown-key-first-commit constraint).
   */
  rejoined?: boolean;
}

/**
 * Fenced lease — the single coordination primitive for "exactly one holder,
 * safe under clock skew and partition" (spec §6). awake = holds the lease.
 */
export interface LeaseRecord {
  /** machineId of the current holder */
  holder: string;
  /** Fencing token: monotonically increasing integer, the authority clock */
  epoch: number;
  /** ISO timestamp of acquisition (display/audit only — never election authority) */
  acquiredAt: string;
  /**
   * Holder-local expiry (acquiredAt + leaseTtlMs). Used for the liveness
   * heuristic and display; authority is the epoch, not this clock.
   */
  expiresAt: string;
  /** Ed25519 signature over the canonical {holder,epoch,acquiredAt,expiresAt,nonce} */
  signature: string;
  /**
   * Per-holder monotonic nonce. A tunnel lease message replaying a
   * previously-seen nonce for the same holder is detected and ignored
   * (spec §6 replay protection).
   */
  nonce: number;
}

export interface MachineRegistry {
  /** Schema version for future migrations */
  version: number;
  /** Map of machineId -> registry entry */
  machines: Record<string, MachineRegistryEntry>;
  /**
   * The current fenced lease (spec §6). Authority-bearing — only the lease
   * holder may advance it via CAS. Absent on a fresh single-machine mesh.
   */
  lease?: LeaseRecord;
}

// ── Machine-Pool Registry (Multi-Machine Session Pool §L2) ───────────

/**
 * Static hardware properties of a machine, captured once at registration (cheap,
 * stable `os` reads) and surfaced on the Machines dashboard tab + as placement
 * signal (§L2). Self-reported → advisory for display, never authority.
 */
export interface MachineHardware {
  /** os.platform() — e.g. "darwin", "linux", "win32". */
  platform: string;
  /** os.arch() — e.g. "arm64", "x64". */
  arch: string;
  /** os.cpus()[0].model — e.g. "Apple M2". */
  cpuModel: string;
  /** os.cpus().length. */
  cpuCores: number;
  /** os.totalmem() in bytes. */
  totalMemBytes: number;
  /** os.hostname(). */
  hostname: string;
  /** The instar version this machine reported. */
  instarVersion?: string;
}

/**
 * Clock-skew quarantine state (§L2). An explicit three-value FSM so every
 * implementation + recovery path is identical. A SINGLE divergent heartbeat
 * never removes a machine; removal requires 2 consecutive divergent beats;
 * re-admission requires 2 consecutive in-tolerance beats.
 */
export type ClockSkewStatus = 'ok' | 'divergence-detected-once' | 'suspect-clock-removed';

/**
 * Live per-machine capacity record (§L2) — the input to placement and the
 * Machines dashboard tab. Assembled by MachinePoolRegistry from the machine
 * registry (nickname), MachineHeartbeat (liveness), `os` (hardware/load), and
 * SessionManager diagnostics (sessions/memPressure). Liveness + freshness key
 * on `routerReceivedAt` (the router's own clock), NEVER the machine's
 * self-reported timestamp (clock-skew safety).
 */
export interface MachineCapacity {
  machineId: string;
  /** User-facing nickname (§L2), mirrored from the registry entry. */
  nickname?: string;
  /** Liveness, computed as (now(router) − routerReceivedAt) < failoverThreshold. */
  online: boolean;
  /** The machine's own last-heartbeat timestamp (ISO) — debugging only. */
  selfReportedLastSeen?: string;
  /** When the router last observed this machine, on the ROUTER's clock (ISO). */
  routerReceivedAt?: string;
  /** 1-minute OS load average from the machine (os.loadavg()[0]). */
  loadAvg?: number;
  /** Memory pressure bucket from SessionManager diagnostics. */
  memPressure?: 'low' | 'moderate' | 'high' | 'critical';
  /** Active session count on the machine. */
  activeSessionCount?: number;
  /** Configured max sessions. */
  maxSessions?: number;
  /** Capabilities (e.g. "gpu", "local-model:llama3", "fast-cpu"). */
  capabilities?: string[];
  /** Local models available. */
  modelsAvailable?: string[];
  /** Agents resident on the machine (multi-agent-per-machine, §L6). */
  agentsResident?: string[];
  /** Static hardware properties (§L2). */
  hardware?: MachineHardware;
  /** Clock-skew quarantine state (§L2 FSM). */
  clockSkewStatus: ClockSkewStatus;
}

export interface MultiMachineConfig {
  /** Whether multi-machine is enabled */
  enabled: boolean;
  /** Whether to auto-promote standby when awake goes silent */
  autoFailover: boolean;
  /** Minutes of silence before auto-failover (default: 15) */
  failoverTimeoutMinutes: number;
  /** Whether to require human confirmation before auto-failover */
  autoFailoverConfirm: boolean;
  /**
   * Coordination mode (Gap 1 — Active/Active support).
   * - 'primary-standby': One awake, others standby with failover (default)
   * - 'independent': Both machines active with separate Telegram groups
   */
  coordinationMode?: CoordinationMode;

  // ── Cross-Machine Seamlessness (spec v1 §9 Tunability) ────────────
  // All optional with sane defaults; renamed to avoid collision with the
  // 30-min MachineHeartbeat and 60s Threadline ConnectionManager intervals.
  /** How often the lease holder refreshes its liveness/lease over the tunnel. Default 30s. */
  ingressHeartbeatMs?: number;
  /** Debounce window for committing DURABLE registry changes to git. Default 10s. */
  registrySyncDebounceMs?: number;
  /**
   * Standby git-pull cadence. Default auto = failoverThresholdMs/4, validated
   * against the < failoverThresholdMs/3 AND < leaseTtlMs invariants on startup.
   */
  standbyPullIntervalMs?: number;
  /** Lease expiry; bounds worst-case transfer overlap. Default 2 × ingressHeartbeatMs. */
  leaseTtlMs?: number;
  /** Live-tail transport: 'tunnel' (low-latency) | 'git' (durable-only, cheaper N>3). Default 'tunnel'. */
  liveTailTransport?: 'tunnel' | 'git';
  /** RPO: max staleness of the standby's persisted live tail. Default 5s. */
  liveTailMaxStalenessMs?: number;
  /** How often the holder pushes a tail flush. Invariant: ≤ liveTailMaxStalenessMs. */
  liveTailPushRateMs?: number;
  /** How long the standby holds an out-of-order flush before declaring the gap unfillable. Default = leaseTtlMs. */
  liveTailOutOfOrderTimeoutMs?: number;
  /** Memory/bandwidth cap per topic; drop-oldest on overflow. Default 256KB. */
  liveTailMaxBytesPerTopic?: number;
  /** Max wait for a verified "caught up" ack before aborting graceful handoff. Default 5s. */
  handoffAckTimeoutMs?: number;
  /** Anti-oscillation floor (protects CONTINUATION LLM cost). Default 60s. */
  minHandoffIntervalMs?: number;
  /** After this, stop re-escalating an unresolved partition until the user acts. Default 5min. */
  splitBrainEscalationCooldownMs?: number;
  /** 'near-instant' (continuous tail buffer) | 'relaxed' (catch-up pull at handoff). Default 'near-instant'. */
  handoffBar?: 'near-instant' | 'relaxed';
  /** A message-ledger entry left 'processing' past this is re-runnable by the new holder. Default 5min. */
  maxProcessingMs?: number;
  /**
   * Exactly-once ingress gate (spec §8 G3a). DEFAULT false — when true, inbound
   * Telegram forwards are deduped via the MessageProcessingLedger and replies
   * commit reply_committed. Ships dark; flip ON only after live test-as-self.
   */
  exactlyOnceIngress?: boolean;
  /**
   * Mesh protocol version override. Normally left unset (the build constant
   * SEAMLESSNESS_PROTOCOL_VERSION applies); present so migrations/tests can pin it.
   */
  protocolVersion?: number;
  /**
   * Multi-Machine Session Pool (spec docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md).
   * Active-active per-session placement + transfer on top of the router lease.
   * Ships DARK: the entire layer is inert unless `enabled` is true AND the
   * graduated `stage` has been advanced past 'dark' (the stage is written ONLY
   * by StageAdvancer — Track H — gated on a green E2E result). Independent of
   * the single-awake seamlessness model above; a 1-machine agent is a no-op.
   */
  sessionPool?: SessionPoolConfig;
  /**
   * Whether THIS machine's lifeline owns the Telegram long-poll. Telegram allows
   * exactly one getUpdates poller per bot token, so a second machine that also
   * polls causes a permanent 409-conflict war and nondeterministic message
   * delivery (the 2026-05-29 duplicate-poller incident). A standby machine MUST
   * set this false so it runs the full server + joins the session pool WITHOUT
   * polling Telegram — only the awake/primary machine polls.
   *
   * DEFAULT (undefined) = poll, so every existing single-machine agent is
   * unchanged. Only a machine that explicitly sets `false` suppresses its poll.
   * This is a per-machine LOCAL flag (read from this machine's own config); it
   * does not require any shared/git-synced coordination, so a credential-less
   * standby can honor it. Consumed by TelegramLifeline.start().
   */
  telegramPolling?: boolean;
}

/**
 * Multi-Machine Session Pool config block. All optional with safe dark defaults
 * (see ConfigDefaults `SHARED_DEFAULTS.multiMachine.sessionPool`). Tunables for
 * later layers (placement, transfer, registry, clock-skew) are added to this
 * interface by their tracks as they land.
 */
export interface SessionPoolConfig {
  /** Master switch. Default false — the entire session-pool layer is inert when false. */
  enabled?: boolean;
  /**
   * Graduated rollout stage (spec §Rollout). 'dark' (code shipped, placement
   * dry-run, always local) → 'shadow' (real placement + ownership, no transfer)
   * → 'live-transfer' (failover + pin transfers) → 'rebalance' (load-driven).
   * Written ONLY by StageAdvancer via a Config.ts write-guard (Track H);
   * a direct write is rejected. Default 'dark'.
   */
  stage?: 'dark' | 'shadow' | 'live-transfer' | 'rebalance';
  /**
   * When true, the placement engine LOGS the decision it would make but always
   * places locally (Stage-0 behavior). Default true.
   */
  dryRun?: boolean;
  /**
   * Clock-skew divergence tolerance (ms) — a machine whose self-reported vs
   * router-observed timestamps diverge beyond this on 2 consecutive heartbeats
   * is quarantined from placement (§L2). Default 300000 (5 min). Must be
   * ≥ 2× maxExpectedNtpDriftMs (validated at startup).
   */
  clockSkewToleranceMs?: number;
  /**
   * Max expected NTP drift (ms) on a healthy host. `clockSkewToleranceMs` must
   * be ≥ 2× this. Default 250.
   */
  maxExpectedNtpDriftMs?: number;
  /**
   * How long an offline machine's capacity record is retained before eviction
   * (ms). Default 86400000 (24h) — a briefly-offline machine keeps its
   * nickname/hardware/history for fast re-placement.
   */
  machineRecordEvictionMs?: number;
  /**
   * MeshRpc (§L0) command timestamp tolerance (ms) — a signed command whose
   * timestamp is outside |now - ts| is rejected `stale-timestamp`. Default 30000.
   */
  meshRpcClockToleranceMs?: number;
  /**
   * §L4 deliverMessage per-attempt timeout (ms) — the router treats a forward that
   * does not ACK within this as failed and retries. Default 5000.
   */
  deliverMessageTimeoutMs?: number;
  /**
   * §L4 max deliverMessage retries before the router falls back to owner-dead
   * re-placement. Default 3.
   */
  deliverMessageMaxRetries?: number;
  /**
   * §L4 placement stickiness margin — the current owner is kept unless another
   * machine is better by more than this score delta (prevents flapping). Default 0.15.
   */
  placementHysteresisDelta?: number;
  /**
   * §L3 max per-session ownership CAS retries on non-fast-forward contention before
   * the router queues the message. Default 5.
   */
  ownershipCasMaxRetries?: number;
  /**
   * §L5 max time (ms) the source drains an in-flight reply before cancelling and
   * proceeding with the transfer — a long reply/tool-call must not block. Default 30000.
   */
  transferDrainTimeoutMs?: number;
  /**
   * §L5 output-exclusion window (ms): the source emits no NEW output after entering
   * `transferring` and the target holds its CONTINUATION until this elapses, so the
   * two emission windows are disjoint (no double-send). Default 1000.
   */
  transferOutputCutoffMs?: number;
  /**
   * §L4 cool-down (ms) after a transfer before a session is eligible for re-placement
   * (a hard user-pin bypasses it). Default 300000.
   */
  placementCooldownMs?: number;
  /**
   * §L4 minimum interval (ms) between placement updates per topic — defeats rapid-fire
   * transfers. Default 10000.
   */
  topicPlacementUpdateMinIntervalMs?: number;
}

// ── Agent Autonomy ──────────────────────────────────────────────────

export type AgentAutonomyLevel = 'supervised' | 'collaborative' | 'autonomous';

export type UserRegistrationPolicy = 'open' | 'invite-only' | 'admin-only';

export interface AgentAutonomyCapabilities {
  /** Agent adds context to admin join-request notifications */
  assessJoinRequests: boolean;
  /** Agent suggests resolution before escalating conflicts */
  proposeConflictResolution: boolean;
  /** Agent surfaces usage-based config recommendations */
  recommendConfigChanges: boolean;
  /** Agent enables jobs it previously ran on another machine */
  autoEnableVerifiedJobs: boolean;
  /** Agent notices and reports degraded states proactively */
  proactiveStatusAlerts: boolean;
  /** Agent approves joins for pre-announced users (autonomous only) */
  autoApproveKnownContacts: boolean;
}

export interface AgentAutonomyConfig {
  /** How much the agent handles on its own */
  level: AgentAutonomyLevel;
  /** Fine-grained capability toggles */
  capabilities: AgentAutonomyCapabilities;
}

export interface RecoveryKeyConfig {
  /** bcrypt hash of the recovery key */
  keyHash: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last use, or null */
  lastUsedAt: string | null;
  /** Number of times the recovery key has been used */
  usageCount: number;
}

export interface ConsentRecord {
  /** Whether consent was given */
  consentGiven: boolean;
  /** ISO timestamp of consent */
  consentDate: string;
  /** Version of the privacy notice consented to */
  consentNoticeVersion?: string;
}

export interface DataCollectedManifest {
  name: boolean;
  telegramId: boolean;
  communicationPreferences: boolean;
  conversationHistory: boolean;
  memoryEntries: boolean;
  machineIdentities: boolean;
}

// ── Onboarding Configuration ────────────────────────────────────────

/**
 * Agent-configurable onboarding settings.
 * Controls what data is collected during user registration beyond the minimum
 * (name + consent). All fields are optional — agents can progressively enhance
 * onboarding depth.
 */
export interface OnboardingConfig {
  /** Whether to collect a short bio during onboarding (default: false) */
  collectBio?: boolean;
  /** Whether to collect interests/topics (default: false) */
  collectInterests?: boolean;
  /** Whether to collect timezone (default: false) */
  collectTimezone?: boolean;
  /** Whether to collect communication style preference (default: false) */
  collectStyle?: boolean;
  /** Whether to collect relationship context — how the user relates to the agent/project (default: false) */
  collectRelationshipContext?: boolean;
  /** Custom onboarding questions defined by the agent operator */
  customQuestions?: OnboardingQuestion[];
  /** Custom consent disclosure text (overrides default) */
  consentDisclosure?: string;
  /** Max tokens for per-user context injection into sessions (default: 500) */
  maxContextTokens?: number;
}

/**
 * A custom onboarding question defined by the agent operator.
 * Answers are stored in UserProfile.customFields keyed by `fieldName`.
 */
export interface OnboardingQuestion {
  /** Storage key in UserProfile.customFields */
  fieldName: string;
  /** Human-readable prompt shown to the user */
  prompt: string;
  /** Whether this question is required (default: false) */
  required?: boolean;
  /** Placeholder text / example answer */
  placeholder?: string;
}

export interface VerificationCode {
  /** The hashed code */
  codeHash: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** Minutes until expiry */
  expiryMinutes: number;
  /** Max attempts before lockout */
  maxAttempts: number;
  /** Current attempt count */
  attempts: number;
  /** Whether this code has been used */
  used: boolean;
  /** Target user ID (for Telegram push) or machine ID (for pairing) */
  targetId: string;
  /** Code type */
  type: 'telegram-push' | 'pairing-code' | 'recovery-key';
}

export interface JoinRequest {
  /** Unique request ID */
  requestId: string;
  /** Display name from the requester */
  name: string;
  /** Telegram user ID of the requester */
  telegramUserId: number;
  /** Agent's contextual assessment (from conversation history) */
  agentAssessment: string | null;
  /** Approval code for this request */
  approvalCode: string;
  /** ISO timestamp */
  requestedAt: string;
  /** Status */
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** Who approved/denied (user ID) */
  resolvedBy?: string;
  /** ISO timestamp of resolution */
  resolvedAt?: string;
}

// ── External Operation Safety ────────────────────────────────────────

export interface ExternalOperationsConfig {
  /** Whether external operation safety is enabled (default: true) */
  enabled: boolean;
  /** Message Sentinel configuration */
  sentinel?: {
    /** Whether the sentinel is enabled (default: true) */
    enabled: boolean;
  };
  /** Per-service permissions (structural floor) */
  services?: Record<string, ExternalServicePermissions>;
  /** Services that are completely read-only (no mutations allowed) */
  readOnlyServices?: string[];
  /** Trust configuration */
  trust?: {
    /** Trust floor — never auto-escalate past this (default: 'collaborative') */
    floor: 'supervised' | 'collaborative';
    /** Whether auto-elevation is enabled (default: true) */
    autoElevateEnabled: boolean;
    /** Successes before suggesting elevation (default: 5) */
    elevationThreshold: number;
  };
}

export interface ExternalServicePermissions {
  /** Allowed operation types */
  permissions: string[];
  /** Blocked operation types (hard gate — no override) */
  blocked?: string[];
  /** Operations that require approval regardless of trust level */
  requireApproval?: string[];
  /** Maximum items per batch operation */
  batchLimit?: number;
}

// ── Server Configuration ────────────────────────────────────────────

export interface InstarConfig {
  /** Project name (used in logging, tmux session names, etc.) */
  projectName: string;
  /** Project root directory */
  projectDir: string;
  /** Where instar stores its runtime state */
  stateDir: string;
  /** HTTP server port */
  port: number;
  /** HTTP server bind address (default: '127.0.0.1' for security) */
  host?: string;
  /** Session manager config */
  sessions: SessionManagerConfig;
  /**
   * Per-topic framework override. Maps a Telegram topic ID (as string,
   * since JSON object keys are strings) to the framework that should
   * run sessions spawned for that topic. When unset, sessions inherit
   * the agent-level `sessions.framework` (or default `claude-code`).
   * Lets you flip a single topic to Codex without changing the whole
   * agent's framework.
   */
  topicFrameworks?: Record<string, 'claude-code' | 'codex-cli'>;
  /**
   * Topic-intent auto-capture loop config (rung 0 of continuous-working-awareness).
   * `capture.enabled` (default true) is the kill-switch for the per-turn extraction
   * loop. See docs/specs/topic-intent-capture-loop.md.
   */
  topicIntent?: {
    capture?: {
      enabled?: boolean;
      /**
       * Optional per-kind decay-horizon overrides (existence-checked). Any subset
       * of refKinds (fact/decision/method/audience/goal), any subset of
       * {graceDays, halfLifeDays}; omitted fields keep the built-in defaults.
       * Lets operators tune the short/medium/long horizons from real data without
       * a code change. See docs/specs/topic-intent-task-context-capture.md §3.
       */
      decayProfiles?: Record<string, { graceDays?: number; halfLifeDays?: number }>;
    };
    /**
     * Topic-intent ArcCheck config (rung 3 / Layer 3 — pre-send classifier).
     * `arccheck.enabled` (default true) is the kill switch for the classifier
     * + the in-process check from checkOutboundMessage. The HTTP route
     * surface remains either way; with the classifier disabled, it returns a
     * degrade-open verdict. See docs/specs/topic-intent-arccheck-wiring.md.
     */
    arccheck?: {
      enabled?: boolean;
    };
  };
  /**
   * Spec-review standards-conformance gate (rung-3 normative slice).
   * `conformance.enabled` (default true) toggles the route that checks a spec
   * against docs/STANDARDS-REGISTRY.md. See docs/specs/standards-conformance-gate.md.
   */
  specReview?: {
    conformance?: {
      enabled?: boolean;
    };
  };
  /**
   * Usher (rung 4) — the signal-only mid-task re-surface watcher. `enabled`
   * (default true; signal-only is safe-on) is the kill-switch. See
   * docs/specs/cwa-usher.md.
   */
  usher?: {
    enabled?: boolean;
  };
  /**
   * LLM intelligence-layer config. Currently scopes the account-global
   * rate-limit circuit breaker (CircuitBreakingIntelligenceProvider +
   * LlmCircuitBreaker). The breaker defaults ON with a 15-minute open window
   * and needs NO config to work — these fields only let an operator tune or
   * disable it. Because the defaults apply when the section is absent, the
   * protection reaches every existing agent on a version bump with zero config
   * migration. See src/core/LlmCircuitBreaker.ts.
   */
  intelligence?: {
    circuitBreaker?: {
      /** Master switch for the rate-limit circuit breaker (default: true). */
      enabled?: boolean;
      /**
       * How long to fully pause LLM-backed work after the provider reports a
       * usage/rate limit, before admitting a single probe call (default:
       * 900000 ms = 15 min). A still-limited probe re-opens for another window;
       * a successful probe closes the breaker.
       */
      openMs?: number;
    };
  };
  /**
   * Agent-level set of frameworks this install actively uses. Drives
   * which framework-specific migration steps run on update: a
   * codex-cli-only install should not receive `.claude/`-specific
   * scaffolding it will never use. When unset or empty, defaults to
   * `['claude-code']` — the historical behavior, so existing and
   * dual-framework installs are unaffected. Set to `['codex-cli']`
   * for a Codex-only agent, or `['claude-code','codex-cli']` for a
   * dual-runtime install. (Mirrors FrameworkParitySentinel's
   * `enabledFrameworks`; this is the persisted, operator-settable
   * source of truth the migrator reads.)
   */
  enabledFrameworks?: ('claude-code' | 'codex-cli')[];
  /** Job scheduler config */
  scheduler: JobSchedulerConfig;
  /** Registered users */
  users: UserProfile[];
  /** Messaging adapters to enable */
  messaging: MessagingAdapterConfig[];
  /** Monitoring config */
  monitoring: MonitoringConfig;
  /** Feature-rollout reconciler config (docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md §4.3
   *  Layer C). Off by default — flips on to scan against canonical `main`
   *  instead of the local working tree (which silently misses freshly-merged
   *  specs when the developer's branch doesn't contain them). On any failure
   *  the scan gracefully falls back to the local scan + emits a degradation
   *  event; never throws into boot. */
  featureRollout?: {
    /** Master kill switch for the canonical-ref scan (default: false). */
    canonicalRefScan?: boolean;
    /** Git remote name to fetch canonical `main` from (default: the same as
     *  releaseReadiness.canonicalRemote, falling back to auto-detection). */
    canonicalRemote?: string;
    /** Bounded canonical-fetch timeout (ms) (default: 30_000). */
    fetchTimeoutMs?: number;
  };
  /** Auth token for API access (generated during setup) */
  authToken?: string;
  /** PIN for dashboard web access (simpler than authToken, used for mobile/remote login) */
  dashboardPin?: string;
  /** Relationship tracking config */
  relationships?: RelationshipManagerConfig;
  /** Feedback loop config */
  feedback?: FeedbackConfig;
  /** Dispatch (intelligence broadcast) config */
  dispatches?: DispatchConfig;
  /** Git backup config (opt-in for standalone agents) */
  gitBackup?: {
    /** Whether git backup is enabled. Defaults to true if .git/ exists, false otherwise. */
    enabled: boolean;
    /** Git remote name (default: "origin") */
    remote?: string;
    /** Auto-push after commits (default: true) */
    autoPush?: boolean;
    /** How often to run the git-sync job in minutes (default: 60). Set to 0 to disable. */
    syncIntervalMinutes?: number;
  };
  /** Update configuration */
  updates?: UpdateConfig;
  /** Publishing (Telegraph) config */
  publishing?: PublishingConfig;
  /** Cloudflare Tunnel config */
  tunnel?: TunnelConfigType;
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeoutMs?: number;
  /** Instar version (from package.json) */
  version?: string;
  /** Safety configuration for autonomous operation */
  safety?: SafetyConfig;
  /** Evolution system configuration */
  evolution?: EvolutionManagerConfig;
  /** Multi-machine coordination config */
  multiMachine?: MultiMachineConfig;
  /** Agent type -- standalone lives at ~/.instar/agents/<name>/, project-bound lives in a project */
  agentType?: AgentType;
  /** User registration policy */
  userRegistrationPolicy?: UserRegistrationPolicy;
  /** Agent autonomy configuration */
  agentAutonomy?: AgentAutonomyConfig;
  /** External operation safety — gate, sentinel, trust */
  externalOperations?: ExternalOperationsConfig;
  /** Recovery key for admin self-recovery */
  recoveryKey?: RecoveryKeyConfig;
  /** Registration contact hint for rejected users */
  registrationContactHint?: string;
  /** Onboarding configuration — controls what data is collected during user registration */
  onboarding?: OnboardingConfig;
  /** Adaptive Autonomy — unified autonomy profile that coordinates all subsystems */
  autonomyProfile?: AutonomyProfileLevel;
  /** Multi-session autonomy — concurrent per-topic autonomous jobs */
  autonomousSessions?: {
    /** Max concurrent autonomous jobs (default 5). New starts beyond this are refused. */
    maxConcurrent?: number;
  };
  /** Notification preferences for autonomy events */
  notifications?: NotificationPreferences;
  /** Response Review Pipeline (Coherence Gate) configuration */
  responseReview?: ResponseReviewConfig;
  /** Input Guard — cross-topic injection defense */
  inputGuard?: InputGuardConfig;
  /** Threadline relay — cloud relay connection for inter-agent communication */
  threadline?: ThreadlineConfig;
  /** Dashboard configuration */
  dashboard?: DashboardConfig;
  /**
   * Telegram markdown formatter mode. Default `'legacy-passthrough'` —
   * byte-for-byte identical to pre-PR2 behavior (formatter bypassed; callsite
   * parse_mode preserved). Flip to `'markdown'` / `'plain'` / `'code'` / `'html'`
   * to enable formatting. See docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md.
   * Hot-reloadable: the adapter/lifeline read the config on every send.
   */
  telegramFormatMode?: 'plain' | 'html' | 'code' | 'markdown' | 'legacy-passthrough';
  /** When true, lint issues return 422 / throw instead of just being logged. */
  telegramLintStrict?: boolean;
  /**
   * Free-text description of how outbound agent-to-user messages should be
   * written for this agent's user. Consumed by the MessagingToneGate's style
   * rule (B11_STYLE_MISMATCH). Generic by design — every agent's operator sets
   * their own preferred style without code changes. Examples:
   *   "ELI10 — write for a 10-year-old. Short sentences. Plain words."
   *   "Technical and terse. Prefer precise vocabulary."
   *   "Formal business-memo tone."
   * When undefined/empty the style rule does not apply (behavior unchanged).
   */
  messagingStyle?: string;
  /** HMAC signing key for context file integrity verification (auto-generated, 32-byte hex) */
  contextSigningKey?: string;
  /** MoltBridge integration — trust network for agent discovery and credibility */
  moltbridge?: {
    enabled: boolean;
    apiUrl: string;
    autoRegister?: boolean;
    enrichmentMode?: 'manual' | 'cached-only' | 'auto';
    agentName?: string;
    platform?: string;
  };
  /** Integrated-Being ledger (cross-session coherence) — see docs/specs/integrated-being-ledger-v1.md */
  integratedBeing?: IntegratedBeingConfig;
  /**
   * BackupManager configuration override. Optional; all fields merge over
   * BackupManager's DEFAULT_CONFIG. `includeFiles` is set-unioned with
   * defaults (see {@link BackupConfig.includeFiles}) — this is how
   * migrators and users add extra paths to backups without displacing
   * identity/memory defaults.
   */
  backup?: Partial<BackupConfig>;
  /**
   * PR-REVIEW-HARDENING kill-switch and rollout phase. Default 'off'
   * (Phase A landing). Flipping to 'shadow' / 'layer1-2' / 'layer3'
   * activates progressively more pipeline enforcement — see
   * docs/specs/PR-REVIEW-HARDENING-SPEC.md §"Rollout plan".
   */
  prGate?: PrGateConfig;
  /**
   * PARALLEL-DEV-ISOLATION rollout phase. Default 'off' (no WorktreeManager
   * instantiated, sessions share one working tree). Flipping to 'shadow' or
   * 'enforce' spins up the WorktreeManager and gives each topic session its
   * own isolated worktree — see docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md.
   */
  parallelDev?: ParallelDevConfig;
}

// ── Parallel-dev isolation (PARALLEL-DEV-ISOLATION-SPEC) ────────────

export interface ParallelDevConfig {
  /**
   * Rollout phase.
   *   'off'      — no WorktreeManager; sessions share one working tree (legacy).
   *   'shadow'   — WorktreeManager active locally; sessions spawn in isolated
   *                worktrees, but the GitHub workflow check is advisory only.
   *   'enforce'  — WorktreeManager active AND the push gate at GitHub Actions
   *                blocks unsigned commits. Requires a working OIDC verifier
   *                and installed GH rulesets.
   */
  phase: 'off' | 'shadow' | 'enforce';
  /**
   * Allow the headless AES-GCM + scrypt flat-file fallback when no OS keychain
   * is reachable. When true, `INSTAR_WORKTREE_PASSPHRASE` (≥12 chars) must be
   * set in the server's environment. See WorktreeKeyVault K1.
   */
  headlessAllowed?: boolean;
  /**
   * Repos enrolled for OIDC-authenticated push-gate calls, e.g.
   * `[{ owner: 'JKHeadley', repo: 'instar' }]`. Empty = accept no OIDC tokens.
   */
  oidcEnrolledRepos?: Array<{ owner: string; repo: string }>;
  /** Maximum commit→push delay before a trailer nonce expires (seconds). */
  maxPushDelaySeconds?: number;
}

// ── PR-gate (PR-REVIEW-HARDENING-SPEC Phase A) ────────────────────

export interface PrGateConfig {
  /**
   * Rollout phase. 'off' returns 404 for every /pr-gate/* route.
   * 'shadow' | 'layer1-2' | 'layer3' progressively enable enforcement.
   */
  phase: 'off' | 'shadow' | 'layer1-2' | 'layer3';
  /** Machine ID that serves the authoritative pr-gate endpoints. */
  primaryMachineId?: string;
  /** Machine IDs paired for replication / cross-tunnel failover. */
  pairedMachineIds?: string[];
}

// ── Integrated-Being Ledger (v1) ────────────────────────────────────

/**
 * Configuration for the Integrated-Being ledger (per-agent shared state across
 * concurrent sessions). All fields are optional — defaults apply when absent.
 * See docs/specs/integrated-being-ledger-v1.md for the authoritative spec.
 */
export interface IntegratedBeingConfig {
  /** Master switch. Default: true. Gates endpoint registration, emitter
   *  registration, and backup inclusion. When false, all three are skipped. */
  enabled?: boolean;
  /** Outbound commitment classifier. Default: false (explicit opt-in). */
  classifierEnabled?: boolean;
  /** Retention for rotated archives. Default: 7 days. */
  retentionDays?: number;
  /** Fraction of prefilter-hits to LLM-classify (0..1). Default: 1.0. */
  classifierSampleRate?: number;
  /** Downstream paraphrase cross-check in outbound path. Default: true. */
  paraphraseCheckEnabled?: boolean;
  /** Per-agent salt for hashing untrusted counterparty names. Generated on
   *  first use; never rotated silently. */
  counterpartyHashSalt?: string;

  // ── v2 knobs (docs/specs/integrated-being-ledger-v2.md) ──────────
  /** Master v2 switch. Gates session-write endpoints, session registry,
   *  and dashboard additions. Default false — v2 ships dark for observation. */
  v2Enabled?: boolean;
  /** Enables POST /shared-state/resolve/:id user-facing resolution flow.
   *  Loader forces false when v2Enabled is false; auto-trues on first
   *  v2Enabled flip unless operator explicitly set false. */
  resolutionEnabled?: boolean;
  /** Per-session write rate (writes/min). Default 30. Returns 429. */
  sessionWriteRatePerMinute?: number;
  /** Per-agent global write ceiling (writes/min, summed across sessions).
   *  Default 100. */
  maxWritesPerMinuteGlobal?: number;
  /** Per-session cap on open commitments. Default 20. */
  openCommitmentsPerSession?: number;
  /** Per-session cap on passive-wait commitments. Default 3. */
  passiveWaitCommitmentsPerSession?: number;
  /** Absolute TTL for binding tokens (hours). Default 72. Past this,
   *  tokens are invalid regardless of refresh. */
  tokenAbsoluteTtlHours?: number;
  /** Rolling idle TTL for binding tokens (hours). Default 24.
   *  Absolute TTL still caps total lifetime. */
  tokenIdleTtlHours?: number;
  /** Days after last write that a session registration is retained.
   *  Default 7. */
  sessionBindingRetentionDays?: number;
  /** Mechanism-ref validation timeout (ms). Default 200. */
  mechanismRefValidateTimeoutMs?: number;
  /** Trust-tier lookup timeout (ms). Default 500. */
  trustTierLookupTimeoutMs?: number;
  /** Dispute-count threshold for rendering disputed status. Default 3. */
  disputeCountThreshold?: number;
  /** Disputes per session per hour cap. Default 10. */
  disputesPerSessionPerHour?: number;
  /** Dispute window (hours). Default 24. */
  disputeWindowHours?: number;
  /** Aggregation signal threshold (cross-session dedup hits in 24h). Default 5. */
  aggregationSignalThreshold?: number;
  /** Aggregation signal immediate threshold (same-session dedup hits). Default 2. */
  aggregationSignalImmediateThreshold?: number;
  /** Phase A sidecar buffer max entries. Default 500 — overflow 429s. */
  sidecarBufferMax?: number;
}

/** Ledger entry subsystem (who emitted). Always bound server-side. */
export type LedgerEntrySubsystem =
  | 'threadline'
  | 'outbound-classifier'
  | 'session-manager'
  | 'compaction-sentinel'
  | 'dispatch'
  | 'coherence-gate'
  /** v2: session-asserted writes via POST /shared-state/append. instance = session id. */
  | 'session'
  /** v2 slice 5: CommitmentSweeper expired/stranded emissions. */
  | 'commitment-sweeper'
  /** TaskFlow Phase 3a: DivergenceChecker JSON↔TaskFlow mismatch notes. */
  | 'taskflow-divergence'
  /** TaskFlow Phase 5: state-transition audit notes from TaskFlowRegistry. */
  | 'taskflow-transition';

/** Ledger entry kind. */
export type LedgerEntryKind =
  | 'commitment'
  | 'agreement'
  | 'thread-opened'
  | 'thread-closed'
  | 'thread-abandoned'
  | 'decision'
  | 'note';

/** Authorship label on each entry (replaces "confidence"). */
export type LedgerProvenance =
  | 'subsystem-asserted'
  | 'subsystem-inferred'
  /** v2: bearer-token-authenticated session write via POST /shared-state/append. */
  | 'session-asserted';

/** Counterparty metadata for a ledger entry. */
export interface LedgerCounterparty {
  /** Type of counterparty. */
  type: 'user' | 'agent' | 'self' | 'system';
  /** Raw name. Charset [a-zA-Z0-9-_.:], max 64 chars. Rendered as
   *  agent:<hash> for untrusted-tier counterparties at render time. */
  name: string;
  /** Trust tier, snapshotted at append time. Never re-resolved on read. */
  trustTier: 'trusted' | 'untrusted';
}

/**
 * A single append-only ledger entry.
 *
 * The id and timestamp are server-generated at append time; emittedBy is
 * bound from calling code and never from external input.
 */
export interface LedgerEntry {
  /** 12-hex server-generated ID. */
  id: string;
  /** ISO timestamp, server-set. */
  t: string;
  /** Who emitted this entry (always server-bound). */
  emittedBy: {
    subsystem: LedgerEntrySubsystem;
    /** Instance identifier. Max 64 chars, charset [a-zA-Z0-9-_.:]. */
    instance: string;
  };
  /** Entry kind. */
  kind: LedgerEntryKind;
  /** Human-readable subject. Max 200 chars, Unicode-sanitized at render time. */
  subject: string;
  /** Optional expanded summary. Max 400 chars, Unicode-sanitized at render time. */
  summary?: string;
  /** Counterparty metadata (required — addresses authority ambiguity). */
  counterparty: LedgerCounterparty;
  /** Optional id of an earlier entry this resolves/withdraws. */
  supersedes?: string;
  /** Authorship label (replaces earlier "confidence" field). */
  provenance: LedgerProvenance;
  /** Append-side dedup key within the rotation window.
   *  e.g., "threadline:opened:<thread-id>". */
  dedupKey: string;
  /** Optional source label for classifier-produced entries. */
  source?: 'heuristic-classifier';
  /** v2: commitment-kind fields. Present iff kind === 'commitment'. */
  commitment?: LedgerCommitmentFields;
  /** v2: dispute pointer — kind must be 'note'. Separate from supersedes. */
  disputes?: string;
}

// ── Integrated-Being Ledger (v2) ────────────────────────────────────

/** Commitment mechanism declaration — how the commitment will be fulfilled. */
export type LedgerMechanismType =
  | 'scheduled-job'
  | 'polling-sentinel'
  | 'external-callback'
  | 'passive-wait'
  | 'user-driven';

/** Result of one-time server-side mechanism-ref resolution at write. */
export type LedgerMechanismRefStatus = 'valid' | 'invalid' | 'unverified';

/** Commitment status in the stored state enum. 'stranded' is render-only. */
export type LedgerCommitmentStatus =
  | 'open'
  | 'resolved'
  | 'cancelled'
  | 'expired'
  | 'disputed';

/** Tier of a resolution outcome — readers calibrate trust accordingly. */
export type LedgerResolutionTier =
  | 'self-asserted'
  | 'subsystem-verified'
  | 'user-resolved';

/** Mechanism block for a commitment entry. refStatus is server-bound. */
export interface LedgerMechanismSpec {
  type: LedgerMechanismType;
  /** Opaque ref resolvable against the mechanism-type registry. */
  ref?: string;
  /** ISO 8601 timestamp. Server-set — frozen at append. */
  refResolvedAt: string;
  /** Result of one-time resolution at write. Server-bound — never from client. */
  refStatus: LedgerMechanismRefStatus;
}

/** Resolution block — present when a commitment is non-open. */
export interface LedgerResolutionSpec {
  /** ISO 8601 timestamp. */
  at: string;
  /** Which tier wrote this resolution. */
  by: LedgerResolutionTier;
  /** Optional note. Max 400 chars, Unicode-sanitized per v1 rules. */
  note?: string;
  /** Opaque pointer to audit trail. */
  evidenceRef?: string;
}

/** Commitment-specific fields attached to a LedgerEntry of kind 'commitment'. */
export interface LedgerCommitmentFields {
  mechanism: LedgerMechanismSpec;
  /** Optional ISO 8601 deadline. Sanity range: now+60s..now+90d. */
  deadline?: string;
  status: LedgerCommitmentStatus;
  resolution?: LedgerResolutionSpec;
}

/**
 * A registered session in the LedgerSessionRegistry. Represents a live
 * or retained session that holds a binding token used to authenticate
 * writes via POST /shared-state/append.
 */
export interface LedgerSessionRegistration {
  /** Opaque session id (UUIDv4). */
  sessionId: string;
  /** Hex-encoded SHA-256 of the binding token. Plaintext token is returned
   *  to the caller ONCE on register; only the hash is persisted. */
  tokenHash: string;
  /** ISO 8601 timestamp of initial registration. */
  registeredAt: string;
  /** ISO 8601 timestamp of most recent write or rotation. */
  lastActiveAt: string;
  /** ISO 8601 timestamp when the absolute TTL expires. */
  absoluteExpiresAt: string;
  /** ISO 8601 timestamp when the idle TTL expires (refreshed on write). */
  idleExpiresAt: string;
  /** True once the session has made at least one successful write.
   *  Determines retention tier on cleanup (7d vs 1d). */
  hasWritten: boolean;
  /** True if revoked. Revoked sessions are purged on cleanup; verify fails closed. */
  revoked: boolean;
  /** Optional label for dashboard rendering — set by hook, max 64 chars. */
  label?: string;
}

// ── Dashboard ───────────────────────────────────────────────────────

export interface DashboardConfig {
  /** File viewer configuration */
  fileViewer?: FileViewerConfig;
}

export interface FileViewerConfig {
  /** Enable the file viewer tab in the dashboard. Default: true */
  enabled: boolean;

  /** Directories available for browsing (relative to project root).
   *  Default: ['.claude/', 'docs/'] */
  allowedPaths: string[];

  /** Directories where editing is permitted (subset of allowedPaths).
   *  Default: [] — nothing editable without explicit opt-in. */
  editablePaths: string[];

  /** Maximum file size to serve for reading (bytes). Default: 1048576 (1MB) */
  maxFileSize: number;

  /** Maximum file size for editing (bytes). Default: 204800 (200KB) */
  maxEditableFileSize: number;

  /** File patterns that are NEVER served, even within allowed directories. */
  blockedFilenames: string[];
}

// ── Threadline Relay ────────────────────────────────────────────────

export interface ThreadlineListenerConfig {
  /** Whether the listener daemon is enabled */
  enabled?: boolean;
  /** Relay URL override for the daemon */
  relayUrl?: string;
  /** Pipe-mode session config */
  pipeMode?: {
    enabled?: boolean;
    model?: string;
    timeoutMs?: number;
    warningMs?: number;
    maxConcurrent?: number;
    allowedTools?: string[];
    allowedPaths?: string[];
    minIqsBand?: number;
  };
  /** Failover config */
  failover?: {
    mode?: 'relay-presence' | 'heartbeat';
    fallback?: string;
    cooldownMs?: number;
    max24h?: number;
  };
  /** Inbox retention in days */
  inboxRetentionDays?: number;
  /** Whether to publish availability to MoltBridge */
  publishAvailability?: boolean;
  /** Offline queue TTL in ms */
  offlineQueueTtlMs?: number;
}

export interface ThreadlineConfig {
  /** Whether cloud relay is enabled (default: false, opt-in) */
  relayEnabled: boolean;
  /** Cloud relay URL (default: 'wss://threadline-relay.fly.dev/v1/connect') */
  relayUrl?: string;
  /** Agent visibility on the relay network: 'public' (discoverable), 'unlisted' (direct only), 'private' (no relay) */
  visibility?: 'public' | 'unlisted' | 'private';
  /** Agent capabilities advertised on the network */
  capabilities?: string[];
  /** Whether to send auto-ack for incoming messages (default: true) */
  autoAck?: boolean;
  /** Custom auto-ack message text */
  autoAckMessage?: string;
  /** Max acks per minute per sender (default: 5) */
  ackRateLimit?: number;
  /** First-contact policy: 'supervised' (hold for approval) or 'auto' (respond immediately) */
  firstContactPolicy?: 'supervised' | 'auto';
  /** Listener daemon configuration */
  listener?: ThreadlineListenerConfig;
  /** §4.4: Spawn manager / drain loop configuration */
  spawn?: ThreadlineSpawnConfig;
}

/**
 * §4.4: Configuration for the SpawnRequestManager and its drain loop.
 *
 * All fields are optional — sensible defaults are baked into the manager.
 * The whole subtree can be omitted to keep prior behavior.
 *
 * The `drainEnabled` flag is the kill switch: setting `false` skips the
 * `start()` call at server boot, leaving the drain loop dormant. Useful
 * for emergency rollback without code changes.
 */
export interface ThreadlineSpawnConfig {
  /** Cooldown between spawn requests per agent (ms). Default: 30000. */
  cooldownMs?: number;
  /** Max drains per tick. Default: 8. */
  maxDrainsPerTick?: number;
  /** Max envelope context size in UTF-8 bytes. Default: 262144 (256 KiB). */
  maxEnvelopeBytes?: number;
  /** Max queued messages across ALL agents. Default: 1000. */
  maxGlobalQueued?: number;
  /** Per-agent queue cap while in soft-limiter degradation. Default: 1. */
  degradedMaxQueuedPerAgent?: number;
  /** Kill switch: set false to skip starting the drain loop. Default: true. */
  drainEnabled?: boolean;
}

// ── Input Guard ─────────────────────────────────────────────────────

export interface InputGuardConfig {
  /** Whether the Input Guard is enabled */
  enabled: boolean;
  /** Enable Layer 1 provenance checking (default: true) */
  provenanceCheck?: boolean;
  /** Enable Layer 1.5 injection pattern detection (default: true) */
  injectionPatterns?: boolean;
  /** Enable Layer 2 LLM topic coherence review (default: true) */
  topicCoherenceReview?: boolean;
  /** Action on suspicious messages: 'warn' (default), 'block', 'log' */
  action?: 'warn' | 'block' | 'log';
  /** Timeout for LLM review in ms (default: 3000) */
  reviewTimeout?: number;
}

// ── Response Review Pipeline (Coherence Gate) ───────────────────────

export interface ResponseReviewConfig {
  /** Whether the review pipeline is enabled */
  enabled: boolean;
  /** Per-reviewer configuration */
  reviewers?: Record<string, ReviewerConfig>;
  /** Observe-only mode — log violations without blocking */
  observeOnly?: boolean;
  /** Default timeout for reviewers in ms */
  timeoutMs?: number;
  /** Model to use for the gate reviewer */
  gateModel?: string;
  /** Model to use for specialist reviewers */
  reviewerModel?: string;
  /** Per-reviewer model overrides */
  reviewerModelOverrides?: Record<string, string>;
  /** Max retries for failed reviews */
  maxRetries?: number;
  /** Per-reviewer criticality levels */
  reviewerCriticality?: Record<string, 'critical' | 'high' | 'medium' | 'low'>;
  /** Threshold for escalating warn-mode violations */
  warnEscalationThreshold?: number;
  /** Per-channel overrides */
  channels?: Record<string, ChannelReviewConfig>;
  /** Default channel configs by type */
  channelDefaults?: {
    internal?: ChannelReviewConfig;
    external?: ChannelReviewConfig;
  };
  /** Enable prompt caching for LLM calls */
  promptCaching?: boolean;
  /** Disable the test endpoint */
  testEndpointDisabled?: boolean;
}

export interface ReviewerConfig {
  enabled: boolean;
  mode: 'block' | 'warn' | 'observe';
}

export interface ChannelReviewConfig {
  /** Whether to fail open (allow message) on review error */
  failOpen?: boolean;
  /** Skip the gate reviewer for this channel */
  skipGate?: boolean;
  /** Queue the message for manual review on failure */
  queueOnFailure?: boolean;
  /** Timeout for queued reviews in ms */
  queueTimeoutMs?: number;
  /** Additional reviewer names to enable for this channel */
  additionalReviewers?: string[];
}

// ── Adaptive Autonomy (PROP — Unified Self-Evolution Governance) ────

/**
 * Four named autonomy profiles, each coordinating all subsystems.
 * Users set this conversationally ("go autonomous", "supervise everything").
 * The agent handles the config mapping.
 */
export type AutonomyProfileLevel = 'cautious' | 'supervised' | 'collaborative' | 'autonomous';

/**
 * The resolved autonomy state after profile + overrides are applied.
 * This is what subsystems actually read.
 */
export interface ResolvedAutonomyState {
  /** The base profile */
  profile: AutonomyProfileLevel;
  /** Evolution governance mode */
  evolutionApprovalMode: 'ai-assisted' | 'autonomous';
  /** Safety level */
  safetyLevel: 1 | 2;
  /** Agent autonomy level for operations */
  agentAutonomyLevel: AgentAutonomyLevel;
  /** Whether updates auto-apply */
  autoApplyUpdates: boolean;
  /** Whether server auto-restarts after updates */
  autoRestart: boolean;
  /** Trust auto-elevation enabled */
  trustAutoElevate: boolean;
  /** How aggressively to surface undiscovered features */
  discoveryAggressiveness: 'passive' | 'contextual' | 'proactive';
}

export interface NotificationPreferences {
  /** How evolution notifications are batched */
  evolutionDigest?: 'immediate' | 'hourly' | 'daily';
  /** Whether to surface trust elevation suggestions */
  trustElevationSuggestions?: boolean;
  /** Whether to notify about post-update migrations */
  migrationNotifications?: boolean;
}

/**
 * Safety configuration — controls the progression from supervised to autonomous operation.
 *
 * The PreToolUse hook system supports two safety levels:
 *
 * Level 1 (default): "Ask the user"
 *   - Risky commands are blocked. Agent must ask the user for confirmation.
 *   - Safe starting point. Human stays in the loop. Trust builds over time.
 *
 * Level 2: "Agent self-verifies"
 *   - Risky commands inject a self-verification prompt instead of blocking.
 *   - Agent reasons about whether the action is correct before proceeding.
 *   - Enables fully hands-off autonomous operation with intelligent safety.
 *   - Truly catastrophic commands (rm -rf /, fork bombs) are ALWAYS blocked.
 *
 * The progression from Level 1 → Level 2 is the path to full autonomy.
 */
export interface SafetyConfig {
  /**
   * Safety level:
   * 1 = Ask user before risky actions (default, recommended to start)
   * 2 = Agent self-verifies before risky actions (autonomous mode)
   */
  level: 1 | 2;
  /**
   * Commands that are ALWAYS blocked regardless of safety level.
   * These are catastrophic, irreversible operations that no self-check can undo.
   */
  alwaysBlock?: string[];
}

export interface PublishingConfig {
  /** Whether publishing is enabled (default: true when Telegram is configured) */
  enabled: boolean;
  /** Short name for the Telegraph account */
  shortName?: string;
  /** Author name shown on published pages */
  authorName?: string;
  /** Author URL shown on published pages */
  authorUrl?: string;
}

export interface TunnelConfigType {
  /** Whether tunnel is enabled */
  enabled: boolean;
  /** Tunnel type: 'quick' (ephemeral, no account) or 'named' (persistent, requires token) */
  type: 'quick' | 'named';
  /** Cloudflare tunnel token (required for named tunnels using token auth) */
  token?: string;
  /** Config file path for named tunnels using credentials file auth */
  configFile?: string;
  /** Public hostname for named tunnels (e.g., echo.dawn-tunnel.dev) */
  hostname?: string;
  // ── Tunnel-failure-resilience (spec Part 4) — all optional ─────────
  /** Consent-offer order for Tier-2 relays. Default ['localtunnel']; 'bore' is opt-in. */
  relayProviders?: ('localtunnel' | 'bore')[];
  /** Master switch for Tier-2 relays. Default true (still consent-gated). false = Cloudflare-only. */
  relaysEnabled?: boolean;
  /** 'ask' (default) prompts the owner before a relay; 'never' = Cloudflare-only. ('always' is intentionally NOT offered.) */
  relayConsent?: 'ask' | 'never';
  /** Consent-prompt timeout in ms. Default 900000 (15 min). */
  consentTimeoutMs?: number;
  /** Which Telegram topic carries tunnel status. Default 'dashboard'. */
  notifyTopic?: 'dashboard' | 'lifeline';
}

export interface DispatchConfig {
  /** Whether dispatch polling is enabled */
  enabled: boolean;
  /** URL to poll for dispatches */
  dispatchUrl: string;
  /** Local dispatch storage file */
  dispatchFile: string;
  /** Instar version — sent in headers for version-specific filtering */
  version?: string;
  /** Whether to auto-apply safe dispatches (lesson, strategy types with non-critical priority) */
  autoApply?: boolean;
}

export interface UpdateConfig {
  /** Whether to auto-apply updates without user confirmation (default: true) */
  autoApply: boolean;
  /** Preferred restart window (24h local time). Restarts deferred until this window.
   *  Example: { start: "02:00", end: "05:00" }. Manual triggers bypass the window. */
  restartWindow?: { start: string; end: string } | null;
  /** Minimum ms between two update-driven restart requests. AutoUpdater
   *  batches new restart requests that land within this window of the
   *  previous one into a single deferred restart. Default 900_000 (15 min);
   *  0 disables. See src/core/RestartCascadeDampener.ts. */
  restartCascadeDampenerWindowMs?: number;
}

export interface MessagingAdapterConfig {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface MonitoringConfig {
  /** Enable quota tracking */
  quotaTracking: boolean;
  /** Enable memory pressure monitoring */
  memoryMonitoring: boolean;
  /** Health check interval in ms */
  healthCheckIntervalMs: number;
  /**
   * CollaborationRedriveEngine — proactively re-engage a counterpart that
   * has gone silent on an open threadline-reply commitment. Ships OFF.
   * Spec: docs/specs/collaboration-redrive-on-counterpart-silence.md.
   */
  collaborationRedrive?: {
    enabled?: boolean;
    sweepIntervalMs?: number;
    silenceThresholdMs?: number;
    maxRedrives?: number;
    perPeerDailyCap?: number;
    maxRedriveSendsPerDay?: number;
    maxRedrivesPerTick?: number;
    trustFloor?: string;
    dedupeJaccard?: number;
  };
  /** Session watchdog — auto-remediation for stuck commands */
  watchdog?: {
    enabled: boolean;
    /** Seconds before a command is considered stuck (default: 180) */
    stuckCommandSec?: number;
    /** Poll interval in ms (default: 30000) */
    pollIntervalMs?: number;
    /**
     * How long a throttled pane must stay byte-identical across polls before the
     * settled-throttle backstop hands it to the RateLimitSentinel (default:
     * 20000). With the default 30s poll, recovery engages on the 2nd consecutive
     * throttled poll (~30-60s). Lower only for tests.
     */
    rateLimitSettleMs?: number;
  };
  /**
   * RateLimitSentinel — rides out Anthropic's server-side capacity throttle
   * ("Server is temporarily limiting requests · not your usage limit") with
   * backoff-before-nudge, user check-ins, and escalation, instead of dropping
   * the session. See docs/specs/rate-limit-sentinel.md.
   */
  rateLimitSentinel?: {
    /** Master kill switch (default: true). false → pre-feature behavior. */
    enabled: boolean;
    /** Escalating wait (ms) before each re-engagement attempt. Last value repeats. */
    backoffScheduleMs?: number[];
    /** Max re-engagement attempts before escalating (default: 6). */
    maxAttempts?: number;
    /** Max wall-clock window (ms) before escalating (default: 1_800_000). */
    maxWindowMs?: number;
    /** Wait after a nudge before checking jsonl growth (default: 25_000). */
    verifyWindowMs?: number;
    /** Minimum spacing (ms) between user check-ins (default: 120_000). */
    checkInEveryMs?: number;
    /** Ignore repeat reports within this window (default: 60_000). */
    dedupeWindowMs?: number;
  };
  /**
   * SocketDisconnectSentinel — detects Claude Code's "socket connection closed
   * unexpectedly" family in tracked sessions and runs a bounded recovery loop
   * (notice → Enter retry → verify → escalate via the tone-gated /attention
   * path). Default-on. See docs/specs/silently-stopped-trio.md.
   */
  socketDisconnectSentinel?: {
    /** Master kill switch (default: true). */
    enabled: boolean;
    /** Backoff staircase (ms) between recovery attempts. Last value repeats. */
    backoffScheduleMs?: number[];
    /** Max recovery attempts before escalating (default: 4). */
    maxAttempts?: number;
    /** Wait after a nudge before declaring recovery (ms) (default: 60_000). */
    verifyWindowMs?: number;
    /** Scan-loop interval (ms) (default: 15_000). */
    tickIntervalMs?: number;
  };
  /**
   * ActiveWorkSilenceSentinel — topic-independent watchdog: a session that was
   * actively producing output goes silent for N minutes. Covers the gap left
   * by SessionWatchdog (needs a running child), SessionMonitor (topic-bound
   * only), and PresenceProxy (needs a user message). Default-on. See
   * docs/specs/silently-stopped-trio.md.
   */
  activeWorkSilenceSentinel?: {
    /** Master kill switch (default: true). */
    enabled: boolean;
    /** Registry-walk interval (ms) (default: 60_000). */
    tickIntervalMs?: number;
    /** Output-gap that triggers detection (ms) (default: 900_000 = 15m). */
    silenceThresholdMs?: number;
    /** Wait after the nudge before escalating (ms) (default: 30_000). */
    verifyWindowMs?: number;
  };
  /**
   * ContextWedgeSentinel — detects the Claude Code "thinking/redacted_thinking
   * blocks in the latest assistant message cannot be modified" 400 fast-fail
   * wedge (a cancelled tool call inside a parallel batch corrupts the latest
   * assistant turn's thinking block, so every subsequent resume 400s instantly
   * and the session is permanently dead while still emitting output). A nudge
   * cannot fix it; recovery is a FRESH respawn (kill + clear the topic's resume
   * UUID so the bridge does not --resume the corrupted transcript).
   *
   * Detection/audit ships default-ON (housekeeping — harmless, kills nothing).
   * The destructive respawn is gated behind `autoRecovery` (default OFF + dryRun)
   * and rides the Graduated Feature Rollout track (rollout-flag-path:
   * monitoring.contextWedgeSentinel.autoRecovery). See
   * docs/specs/context-wedge-sentinel.md.
   */
  contextWedgeSentinel?: {
    /** Master kill switch for detection + audit (default: true). */
    enabled: boolean;
    /** Scan-loop interval (ms) (default: 20_000). */
    tickIntervalMs?: number;
    /** How long the signature must persist as the non-progressing session tail
     *  before the wedge is confirmed (ms) (default: 45_000). Guards against a
     *  session merely discussing the error or a transient render. */
    confirmWindowMs?: number;
    /** Pane lines to capture when scanning for the signature (default: 30). */
    captureLines?: number;
    /**
     * Destructive auto-recovery (fresh respawn). The Graduated-Feature-Rollout
     * staged flag: dark (enabled:false) → dry-run (enabled:true + dryRun:true,
     * logs would-respawn) → live (enabled:true + dryRun:false) → default-on
     * (shipped default enabled:true). Read at runtime as a fallback against the
     * shipped default so a default flip propagates fleet-wide with no migration.
     */
    autoRecovery?: {
      /** Whether confirmed wedges are auto-respawned (default: false). */
      enabled: boolean;
      /** When true, log the would-respawn decision but kill nothing (default: true). */
      dryRun?: boolean;
    };
  };
  /**
   * SleepWakeDetector CPU-starvation guard tuning. All optional — the class ships
   * sane defaults, so absence of this block (every existing agent) still gets the
   * fix on update with no config migration. Read at runtime as a fallback against
   * the shipped defaults.
   */
  sleepWake?: {
    /** loadavg[0]/cpuCount above which a SHORT drift is treated as CPU starvation
     *  (suppressed, not a wake). Default: 1.5. Set high to disable the guard. */
    maxLoadRatio?: number;
    /** A drift at least this long (seconds) is always treated as real sleep,
     *  regardless of load. Default: 300. */
    longSleepFloorSeconds?: number;
    /** Minimum gap (ms) between EMITTED wakes; short drifts within it are
     *  rate-limited. Long sleeps bypass it. Default: 60000. */
    minWakeIntervalMs?: number;
  };
  /**
   * SessionReaper — pressure-aware reaper of idle-but-alive sessions. The only
   * monitor that *kills* on a heuristic, so it ships OFF + dry-run by default.
   * See docs/specs/SESSION-REAPER-SPEC.md and DEFAULT_SESSION_REAPER_CONFIG.
   */
  sessionReaper?: {
    enabled: boolean;
    dryRun?: boolean;
    tickIntervalSec?: number;
    minAgeMinutes?: number;
    confirmObservations?: number;
    confirmWindowMinutes?: number;
    paneCaptureLines?: number;
    recentUserWindowMinutes?: number;
    idleThresholdModerateMinutes?: number;
    idleThresholdCriticalMinutes?: number;
    normalTierReaps?: boolean;
    maxReapsPerTick?: number;
    maxReapsPerHour?: number;
    finalGraceSec?: number;
    protectOpenCommitments?: boolean;
  };
  /**
   * Reap-notification (UNIFIED-SESSION-LIFECYCLE §P3). The single coalescing
   * listener on `sessionReaped` that surfaces a "your session was shut down"
   * notice so a session never silently vanishes. Default ON (the disappearing-
   * session incident is exactly the silence this closes); recovery-bounce and
   * operator kills stay silent regardless. Terminal reaps within
   * `coalesceWindowMs` collapse into one consolidated lifeline message.
   */
  reapNotify?: {
    enabled?: boolean;
    coalesceWindowMs?: number;
  };
  /**
   * Unkillability backstop (UNIFIED-SESSION-LIFECYCLE §P5). Watches for sessions
   * the conservative KEEP-rules would protect forever — one that FAKES work, or
   * one stuck `indeterminate` — and raises a SINGLE deduped Attention item for an
   * operator decision (never an auto-kill). Default ON; signal-only.
   */
  staleBackstop?: {
    enabled?: boolean;
    tickIntervalSec?: number;
    unverifiableEscalateMinutes?: number;
    indeterminateEscalateCount?: number;
    progressFloorBytes?: number;
  };
  /**
   * Failure-Learning Loop (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md) — instar
   * self-hosting dev-process forensics. Ships OFF (registers itself on the
   * rollout board). When enabled, the FailureLedger + /failures routes + the
   * analyzer come alive; toolchain attribution is instar-repo-local. The gates
   * below are the §4.4 source-diversity + §4.3 attribution-confidence controls.
   */
  failureLearning?: {
    enabled: boolean;
    minSupport?: number;
    minDistinctSessions?: number;
    minDistinctCauseCommits?: number;
    attributionConfidenceFloor?: number;
    /** Off by default — when true, thresholded insights post ONCE to the existing
     *  system topic (never a new per-feature topic). Spec §4.5 / round-2 M1. */
    insightTelegramEscalation?: boolean;
    /**
     * Automatic ingestion sources (FAILURE-LEARNING-INGESTION-SOURCES-SPEC §4.4).
     * Each off by default; every source is fail-open + near-silent (writes the
     * ledger only). Slice 1 ships `ci` + `revert`; `regression`/`degradation`
     * land in later slices.
     */
    sources?: {
      /** Poll CI runs via `gh` and file failed ones (spec §3.1). Default false. */
      ci?: boolean;
      /** Detect `Revert "…"` commits and close/open records (spec §3.2). Default false. */
      revert?: boolean;
      /** Edge-triggered regression event from InitiativeTracker (spec §3.3, slice 2). Default false. */
      regression?: boolean;
      /** Include rollout-backslide regressions, not just merge-unreachable (spec §3.3). Default false. */
      regressionIncludesBackslide?: boolean;
      /** Subsystem allow-list for runtime-degradation ingestion (spec §3.4, slice 3, dashboard-only). Default []. */
      degradation?: string[];
      /** CI poll interval override in minutes (spec §3.1/§9 Q1). Default = reconciler cadence. */
      ciPollMinutes?: number;
      /** Max failed CI runs filed per poll tick (spec §5). Default 50. */
      ciMaxRunsPerTick?: number;
    };
  };
  /**
   * Correction & Preference Learning Sentinel
   * (docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md). Ships OFF.
   * Slice 1a wires only the preferences read-surface: when `enabled`, the
   * `GET /preferences/session-context` route serves the learned-preference
   * block (else 503) and the session-start hook injects it. SIGNAL-ONLY — it
   * never blocks or rewrites an outbound message. Slice 1b adds the capture →
   * distill → ledger → recurrence-gate loop that writes via `recordPreference()`.
   */
  correctionLearning?: {
    /** Master kill switch (default: false). Gates the loop AND the read route. */
    enabled: boolean;
    /** Min total occurrences before a learning crosses the recurrence gate (Slice 1b). */
    minSupport?: number;
    /** Distinct calendar days required for an infra-gap learning (Slice 1b, restart-proof). */
    minDistinctDaysInfraGap?: number;
    /** Distinct calendar days required for an explicit-preference learning (Slice 1b). */
    minDistinctDaysPreference?: number;
    /** Distinct topics required for the preference path's second prong (Slice 1b). */
    minDistinctTopicsPreference?: number;
    /** Auto-submit infra-gap learnings to /feedback (Slice 1b/3). Default false. */
    autoFeedback?: boolean;
    /** Post a periodic Telegram digest of learned preferences (Slice 2). Default false. */
    telegramDigest?: boolean;
    /** Drift canary that samples un-classified messages through the LLM (Slice 1b). Default false. */
    driftCanary?: boolean;
    /** Per-sentinel LLM daily spend cap in cents (own LlmQueue instance, Slice 1b). */
    llmDailyCents?: number;
    /** Max concurrent LLM distillation calls (Slice 1b). */
    llmMaxConcurrent?: number;
    /** Per-topic look-back ring depth captured for distillation (Slice 1b). */
    captureContextTurns?: number;
    /** Max distinct topics held in the capture map before LRU eviction (Slice 1b). */
    captureTopicMapMax?: number;
    /** Idle TTL (minutes) before a topic's capture ring is evicted (Slice 1b). */
    captureTopicTtlMinutes?: number;
    /** Per-topic distillation rate ceiling per minute (Slice 1b). */
    distillPerTopicRatePerMinute?: number;
    /** Verify-window days for the infra-gap closed loop (Slice 1b/2). */
    verifyWindowDaysInfraGap?: number;
    /** Verify-window days for the preference closed loop (Slice 1b). */
    verifyWindowDaysPreference?: number;
    /** Byte cap on the injected session-start preferences block (Slice 1a). */
    maxInjectedPreferencesBytes?: number;
    /** Priority ordering string for the injected block (Slice 1a). */
    preferencesInjectionPriority?: string;
    /** Max times a closed-loop verification may reopen the same dedupeKey (Slice 1b). */
    maxReopens?: number;
  };
  /**
   * ReleaseReadinessSentinel (docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md §4.2)
   * — Layer B. A repo-gated dev-environment watchdog: evaluates the canonical
   * `main` of the instar checkout and surfaces a stalled/blocked release as a
   * single, deduped, age-escalating Attention item. Ships OFF (Echo dogfoods
   * first). Inert on any install with no analyzable instar git repo. Tier 0.
   */
  releaseReadiness?: {
    /** Master kill switch (default: false). */
    enabled: boolean;
    /** Scan cadence (ms) (default: 21_600_000 = 6h). */
    tickIntervalMs?: number;
    /** Backlog age (days) below which the check is silent (default: 2). */
    backlogAgeDaysSilent?: number;
    /** Age thresholds (days) for LOW / MEDIUM / HIGH priority (default: 2 / 4 / 7). */
    backlogAgeDaysLow?: number;
    backlogAgeDaysMedium?: number;
    backlogAgeDaysHigh?: number;
    /** Hysteresis window (hours) before re-raising the same episode (default: 12). */
    hysteresisHours?: number;
    /** TTL (days) after which an abandoned open episode is reaped as stale (default: 30). */
    staleEpisodeTtlDays?: number;
    /** Bounded canonical-fetch timeout (ms) (default: 30_000). */
    fetchTimeoutMs?: number;
    /** Override the canonical remote NAME (default: auto-detect a JKHeadley/instar
     *  remote; a non-canonical override raises a HIGH-priority signal). */
    canonicalRemote?: string;
    /** Override the instar repo path to analyze (default: the agent home). */
    repoPath?: string;
  };
  /**
   * Master gate for Telegram delivery of silently-stopped-sentinel escalations
   * (SentinelNotifier). Default false → sentinel notices are logged to the
   * server log + .instar/../logs/sentinel-events.jsonl only; the user never
   * sees them. When true, genuine recovery-failed escalations are COALESCED
   * into ONE consolidated message and sent to the existing system (lifeline)
   * topic — never one-topic-per-event. Default false in response to the
   * 2026-05-22 topic-spam flood. See docs/specs/silently-stopped-trio.md.
   */
  sentinelTelegramEscalation?: boolean;
  /**
   * notify-on-stop Layer B (docs/specs/NOTIFY-ON-STOP-SPEC.md). When the
   * UnjustifiedStopGate (shadow/enforce) judges a stop unjustified-but-unblockable
   * (`continue` in shadow) or ambiguous (`escalate`) for an UNATTENDED session,
   * send the user one coalesced heads-up. Default enabled (Justin's explicit
   * "tell me why it stopped"); attended-gate + per-session dedup keep it
   * near-silent. Distinct from sentinelTelegramEscalation (housekeeping, default-off).
   */
  notifyOnStop?: {
    /** Master gate. Default true. */
    enabled?: boolean;
    /** Only notify unattended (autonomous) sessions. Default true. */
    unattendedOnly?: boolean;
    /** Per-session dedup window (ms). Default 1800000 (30 min). */
    cooldownMs?: number;
  };
  /** LLM-powered stall triage nurse — intelligent session recovery */
  triage?: {
    enabled: boolean;
    /** Anthropic API key (falls back to env) */
    apiKey?: string;
    /** Cooldown between triages for same topic in ms (default: 180000) */
    cooldownMs?: number;
    /** Delay before verifying action worked in ms (default: 10000) */
    verifyDelayMs?: number;
    /** Max escalation attempts (default: 2) */
    maxEscalations?: number;
    /** Use IntelligenceProvider instead of direct API (default: true) */
    useIntelligenceProvider?: boolean;
  };
  /** TriageOrchestrator — next-gen session recovery with scoped Claude Code sessions */
  triageOrchestrator?: {
    enabled: boolean;
    /** Cooldown between triages for same topic in ms (default: 180000) */
    cooldownMs?: number;
    /** Max concurrent triage sessions (default: 3) */
    maxConcurrentTriages?: number;
    /** Enable auto-actions like auto_restart, auto_interrupt (default: true) */
    autoActionEnabled?: boolean;
    /** Max auto-actions per hour (default: 5) */
    maxAutoActionsPerHour?: number;
    /** Default model tier for triage sessions (default: 'sonnet') */
    defaultModel?: 'sonnet' | 'opus';
  };
  /** Proactive session health monitoring */
  sessionMonitor?: {
    /** Enable the session monitor (default: true) */
    enabled?: boolean;
    /** How often to check sessions, in seconds (default: 60) */
    pollIntervalSec?: number;
    /** Minutes of inactivity before a session is flagged as idle (default: 15) */
    idleThresholdMinutes?: number;
    /** Minimum minutes between user notifications per topic (default: 30) */
    notificationCooldownMinutes?: number;
  };
  /** Whether to report external (non-instar) Claude processes to the user (default: true) */
  reportExternalProcesses?: boolean;
  /** System Reviewer — periodic self-monitoring of feature health */
  systemReview?: {
    /** Enable the system reviewer (default: true) */
    enabled?: boolean;
    /** How often to run scheduled reviews in ms (default: 6 hours) */
    scheduleMs?: number;
    /** Which tiers to include in scheduled runs (default: [1, 2, 3]) */
    scheduledTiers?: number[];
    /** Whether to auto-submit failures as feedback (default: false) */
    autoSubmitFeedback?: boolean;
    /** Whether feedback consent is given (default: false) */
    feedbackConsentGiven?: boolean;
    /** Whether to send alerts for critical failures (default: true) */
    alertOnCritical?: boolean;
    /** Cooldown between alerts for same probe in ms (default: 1 hour) */
    alertCooldownMs?: number;
    /** Probe IDs to skip (default: []) */
    disabledProbes?: string[];
  };
  /** Opt-in anonymous telemetry — sends usage heartbeats to help improve Instar */
  telemetry?: TelemetryConfig;
  /** Prompt Gate — detect and handle interactive prompts in sessions */
  promptGate?: {
    /** Enable prompt detection (default: false) */
    enabled?: boolean;
    /** Lines from buffer tail to examine (default: 50) */
    detectionWindowLines?: number;
    /** Auto-approve configuration */
    autoApprove?: {
      /** Enable auto-approval (default: false, opt-in) */
      enabled?: boolean;
      /** Auto-approve file creation in project dir (default: true) */
      fileCreation?: boolean;
      /** Auto-approve file edits in project dir (default: true) */
      fileEdits?: boolean;
      /** Auto-approve plan mode (default: true) */
      planApproval?: boolean;
    };
    /** Dry-run: log what would be auto-approved without acting (default: false) */
    dryRun?: boolean;
    /** Include human-readable summary in audit log (default: false) */
    verboseLogging?: boolean;
    /** Audit log retention in days (default: 30) */
    logRetentionDays?: number;
    /** Telegram user ID authorized to respond to relayed prompts */
    ownerId?: number;
    /** Relay timeout in seconds (default: 300) */
    relayTimeoutSeconds?: number;
  };
  /**
   * Episodic memory sentinel — periodic mid-session activity digestion.
   * The sentinel digests long-running sessions on a cadence so activity
   * (and the entities extracted from it) is captured before sessions end,
   * not only at sessionComplete.
   */
  episodicSentinel?: {
    /** Enable the periodic scan (default: true when the sentinel is built). */
    enabled?: boolean;
    /** Minutes between periodic scans (default: 30). Clamped to >= 5. */
    scanIntervalMinutes?: number;
  };
}

export type TelemetryLevel = 'basic' | 'usage';

export interface TelemetryConfig {
  /** Whether telemetry is enabled (default: false — strictly opt-in) */
  enabled: boolean;
  /** What level of data to send (default: 'basic') */
  level?: TelemetryLevel;
  /** Heartbeat interval in milliseconds (default: 21600000 = 6 hours) */
  intervalMs?: number;
  /** Telemetry endpoint URL */
  endpoint?: string;
}

// ── Baseline Telemetry (Cross-Agent) ────────────────────────────────

/**
 * Skip reason taxonomy for Baseline telemetry.
 * Maps to the telemetry-specific reasons that distinguish design problems
 * from correct behavior across the agent population.
 */
export type BaselineSkipReason =
  | 'quota'         // Agent wanted to run but couldn't afford it (constraint)
  | 'priority'      // A higher-priority job won the slot (constraint)
  | 'cooldown'      // Job ran recently, skipped to avoid redundancy (healthy)
  | 'disabled'      // User or agent explicitly turned it off (choice)
  | 'error'         // Job attempted but failed (broken)
  | 'stale-handoff'; // Skipped because prior run's output wasn't consumed (healthy)

/** Per-job skip metrics for a submission window */
export interface BaselineSkipMetric {
  slug: string;
  reason: BaselineSkipReason;
  count: number;
}

/** Per-job execution result metrics for a submission window */
export interface BaselineResultMetric {
  slug: string;
  success: number;
  error: number;
  timeout: number;
}

/** Per-job duration metrics for a submission window */
export interface BaselineDurationMetric {
  slug: string;
  meanMs: number;
  count: number;
}

/** Per-job model usage for a submission window */
export interface BaselineModelMetric {
  slug: string;
  model: string;
  runCount: number;
}

/** Per-job schedule adherence for a submission window */
export interface BaselineAdherenceMetric {
  slug: string;
  expectedRuns: number;
  actualRuns: number;
}

/** Watchdog intervention metrics for a Baseline submission window */
export interface BaselineWatchdogMetrics {
  /** Total interventions in the submission window */
  interventions: number;
  /** Breakdown by escalation level (e.g., "ctrl-c": 3, "sigterm": 1) */
  byLevel: Record<string, number>;
  /** Sessions that recovered after intervention */
  recoveries: number;
  /** Sessions that died after intervention */
  deaths: number;
  /** Times the LLM gate classified a command as "legitimate" (no escalation) */
  llmGateOverrides: number;
}

/** Agent-level metrics for a Baseline submission */
export interface BaselineAgentMetrics {
  version: string;
  nodeVersion: string;
  os: string;
  arch: string;
  uptimeHours: number;
  totalJobs: number;
  enabledJobs: number;
  disabledJobs: number;
  /** Curated feature flag whitelist — usage/adoption flags only */
  features: Record<string, boolean>;
  /** Coarse session activity bucket */
  sessionsBucket: '0' | '1-5' | '6-20' | '20+';
  /** Quota pressure signals */
  gateTriggersLast24h: number;
  blocksLast24h: number;
  /** Watchdog intervention metrics — optional for backward compatibility */
  watchdog?: BaselineWatchdogMetrics;
  /** Session recovery metrics (mechanical JSONL-based recovery) */
  recovery?: BaselineRecoveryMetrics;
  /** Triage orchestrator decision metrics */
  triage?: BaselineTriageMetrics;
  /** Notification batching effectiveness */
  notifications?: BaselineNotificationMetrics;
  /** Process staleness detection */
  staleness?: BaselineStalenessMetrics;
}

/** Mechanical session recovery metrics */
export interface BaselineRecoveryMetrics {
  attempts: { stall: number; crash: number; errorLoop: number };
  successes: { stall: number; crash: number; errorLoop: number };
}

/** Triage orchestrator decision metrics */
export interface BaselineTriageMetrics {
  activations: number;
  heuristicResolutions: number;
  llmResolutions: number;
  failures: number;
  actionCounts: Record<string, number>;
}

/** Notification batching metrics */
export interface BaselineNotificationMetrics {
  flushed: number;
  suppressed: number;
  summaryQueueSize: number;
  digestQueueSize: number;
}

/** Process staleness metrics */
export interface BaselineStalenessMetrics {
  versionMismatch: boolean;
  driftCount: number;
}

/** Full Baseline telemetry submission payload */
export interface BaselineSubmission {
  v: 1;
  installationId: string;
  version: string;
  windowStart: string;
  windowEnd: string;
  agent: BaselineAgentMetrics;
  jobs: {
    skips: BaselineSkipMetric[];
    results: BaselineResultMetric[];
    durations: BaselineDurationMetric[];
    models: BaselineModelMetric[];
    adherence: BaselineAdherenceMetric[];
  };
}

/** @deprecated Use InstarConfig instead */
export type AgentKitConfig = InstarConfig;

// ── Agent Registry ──────────────────────────────────────────────────

export type AgentType = 'standalone' | 'project-bound';

export type AgentStatus = 'running' | 'stopped' | 'stale';

export interface AgentRegistryEntry {
  /** Agent display name (from config.json projectName) — NOT unique, display label only */
  name: string;
  /** Agent type */
  type: AgentType;
  /** Canonical absolute path — the TRUE unique key */
  path: string;
  /** Allocated server port */
  port: number;
  /** Process ID of the server (0 if stopped) */
  pid: number;
  /** Current status */
  status: AgentStatus;
  /** When this agent was first registered */
  createdAt: string;
  /** Last heartbeat timestamp */
  lastHeartbeat: string;
  /** Instar version this agent was created with */
  instarVersion?: string;
}

export interface AgentRegistry {
  /** Schema version for future migrations */
  version: 1;
  entries: AgentRegistryEntry[];
}

// ── Backup System ───────────────────────────────────────────────────

export interface BackupSnapshot {
  /** Timestamp-based ID (ISO format, filesystem-safe) */
  id: string;
  /** When this snapshot was created */
  createdAt: string;
  /** What triggered this snapshot */
  trigger: 'auto-session' | 'manual' | 'pre-update';
  /** Files included in this snapshot */
  files: string[];
  /** Total size in bytes */
  totalBytes: number;
  /** SHA-256 integrity hash for manifest validation */
  integrityHash?: string;
}

export interface BackupConfig {
  /** Whether auto-backup before sessions is enabled (default: true) */
  enabled: boolean;
  /** Maximum snapshots to retain (default: 20) */
  maxSnapshots: number;
  /**
   * Additional files to include in backups, unioned with
   * `BackupManager.DEFAULT_CONFIG.includeFiles`. Users and migrators
   * can extend the default set but cannot remove from it.
   * Paths are relative to `stateDir` (typically `.instar/`).
   *
   * Defense-in-depth: any entry resolving under `.instar/secrets/` is
   * refused by `BLOCKED_PATH_PREFIXES` at snapshot time regardless of
   * source (defaults, user config, migrator).
   */
  includeFiles: string[];
}

// ── Git-Backed State ───────────────────────────────────────────────

export interface GitStateConfig {
  /** Whether git tracking is enabled */
  enabled: boolean;
  /** Remote URL for push/pull (optional) — only https://, git@, ssh:// allowed */
  remote?: string;
  /** Branch name (default: 'main') */
  branch: string;
  /** Auto-commit on state changes */
  autoCommit: boolean;
  /** Auto-push after commits (default: false) */
  autoPush: boolean;
  /** Debounce interval for auto-commits in seconds (default: 60) */
  commitDebounceSeconds: number;
  /** Last remote that was successfully pushed to (for first-push confirmation gate) */
  lastPushedRemote?: string;
}

export interface GitLogEntry {
  /** Commit hash (short) */
  hash: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** Commit date */
  date: string;
}

export interface GitStatus {
  /** Whether git is initialized */
  initialized: boolean;
  /** Current branch name */
  branch: string;
  /** Number of staged files */
  staged: number;
  /** Number of modified but unstaged files */
  modified: number;
  /** Number of untracked files */
  untracked: number;
  /** Whether there are unpushed commits */
  ahead: number;
  /** Whether there are unpulled commits */
  behind: number;
  /** Remote URL if configured */
  remote?: string;
}

// ── Memory Search ──────────────────────────────────────────────

export interface MemorySearchConfig {
  /** Whether memory search is enabled */
  enabled: boolean;
  /** Path to the SQLite database */
  dbPath: string;
  /** Source files/directories to index (relative to .instar/) */
  sources: MemorySource[];
  /** Chunk size in approximate tokens (default: 400) */
  chunkSize: number;
  /** Chunk overlap in approximate tokens (default: 80) */
  chunkOverlap: number;
  /** Whether to index session logs (can be large) */
  indexSessionLogs: boolean;
  /** Temporal decay factor (0-1, how much to weight recency; default: 0.693 for 30-day half-life) */
  temporalDecayFactor: number;
}

export interface MemorySource {
  /** Relative path to file or directory */
  path: string;
  /** Source type affects chunking strategy */
  type: 'markdown' | 'json' | 'jsonl';
  /** Whether this source is "evergreen" (no temporal decay) */
  evergreen: boolean;
}

export interface MemorySearchResult {
  /** The matched text chunk */
  text: string;
  /** Source file path */
  source: string;
  /** Byte offset within the source file */
  offset: number;
  /** Relevance score (higher = more relevant) */
  score: number;
  /** FTS5 highlight with match markers */
  highlight?: string;
  /** When this chunk's source was last modified */
  sourceModifiedAt: string;
}

export interface MemoryIndexStats {
  /** Total number of indexed files */
  totalFiles: number;
  /** Total number of chunks */
  totalChunks: number;
  /** Database file size in bytes */
  dbSizeBytes: number;
  /** When the index was last updated */
  lastIndexedAt: string;
  /** Files that have changed since last index */
  staleFiles: number;
  /** Whether vector search is available */
  vectorSearchAvailable: boolean;
}

// ── Semantic Memory ──────────────────────────────────────────────

/**
 * Entity types for the semantic memory store.
 * Different knowledge needs different handling — facts decay faster
 * than lessons, people link to projects, patterns inform decisions.
 */
export type EntityType = 'fact' | 'person' | 'project' | 'tool' | 'pattern' | 'decision' | 'lesson';

/**
 * Relationship types between memory entities.
 * Enables meaningful graph traversal ("who built X?", "what depends on Y?").
 */
export type RelationType =
  | 'related_to'       // Generic association
  | 'built_by'         // Person → Project/Tool
  | 'learned_from'     // Lesson → Session/Person
  | 'depends_on'       // Project → Tool/API
  | 'supersedes'       // New fact → Old fact
  | 'contradicts'      // Fact → Fact (conflict detection)
  | 'part_of'          // Component → System
  | 'used_in'          // Tool → Project
  | 'knows_about'      // Person → Topic
  | 'caused'           // Event → Consequence
  | 'verified_by';     // Fact → Session (re-verification)

/**
 * A knowledge entity in semantic memory.
 * Facts, people, projects, tools, patterns, decisions, lessons — anything
 * the agent knows, with confidence tracking and temporal metadata.
 */
export interface MemoryEntity {
  id: string;
  type: EntityType;
  name: string;
  /** The actual knowledge content (markdown) */
  content: string;
  /** How confident the agent is in this knowledge (0.0-1.0) */
  confidence: number;

  // Temporal
  createdAt: string;
  /** When this was last confirmed to be true */
  lastVerified: string;
  /** When this was last retrieved for a session */
  lastAccessed: string;
  /** Optional hard expiry (e.g., "API key rotates monthly") */
  expiresAt?: string;

  // Provenance
  /** Where this came from ('session:ABC', 'observation', 'user:Justin') */
  source: string;
  /** Session ID that created this entity */
  sourceSession?: string;

  // Classification
  tags: string[];
  /** Domain grouping ('infrastructure', 'relationships', 'business') */
  domain?: string;

  // Privacy (Phase 2 — User-Agent Topology Spec)
  /** User who owns this entity (null = agent-owned / shared) */
  ownerId?: string;
  /** Privacy scope controlling visibility (default: 'shared-project' for backward compat) */
  privacyScope?: PrivacyScopeType;

  /**
   * Typed evidence array — per-claim provenance with file:line citations,
   * weights, and confidence (OpenClaw WikiClaim shape).
   *
   * Loaded lazily — `recall()` and `searchHybrid()` do NOT populate this
   * field; use `getEntityWithEvidence()` or `getEvidence()` to read evidence.
   * Empty array `[]` means "loaded but the entity has no evidence";
   * `undefined` means "not loaded by this code path".
   */
  evidence?: MemoryEvidence[];
}

/**
 * Typed citation kind for `MemoryEvidence`. Free-form `kind` would defeat
 * inverse queries; the enum keeps the lookup surface small and indexable.
 */
export type MemoryEvidenceKind =
  | 'feedback'
  | 'commit'
  | 'session'
  | 'document'
  | 'message'
  | 'job-run'
  | 'ledger-entry'
  | 'pattern-entity'
  | 'external-url'
  | 'supersedes-evidence';

/**
 * A single piece of evidence supporting a `MemoryEntity` claim. Evidence is
 * append-only-mostly; existing entries can have `updatedAt` refreshed and
 * weights recomputed, but entries are not destructively edited. Retire an
 * evidence entry by adding a new one with `kind:'supersedes-evidence'`
 * pointing at the old `sourceId`.
 *
 * See docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md.
 */
export interface MemoryEvidence {
  /** Kind of source — typed, not free-form, for queryability. */
  kind: MemoryEvidenceKind;
  /** Foreign key to the source system. Cross-store FK is best-effort —
   *  consumers tolerate dangling references. */
  sourceId: string;
  /** Optional file path or URL (relative to repo root or absolute URL). */
  path?: string;
  /** Inclusive start line. */
  lineStart?: number;
  /** Inclusive end line; equal to `lineStart` for single-line citations. */
  lineEnd?: number;
  /** Optional freeform line range, e.g. "42-58". Derived from
   *  `lineStart`/`lineEnd` when both present. Kept for OpenClaw shape parity. */
  lines?: string;
  /** Optional contribution weight (0–1). */
  weight?: number;
  /** Optional trust in the source (0–1) — separate from weight. */
  confidence?: number;
  /** Optional privacy tier; defaults to entity's privacyScope. Narrowing-only
   *  at write time (see § Storage and Privacy). The evidence vocabulary
   *  diverges from `PrivacyScopeType` per spec § Schema Changes — adds
   *  'public' and 'sensitive' as endpoint tiers. */
  privacyTier?: EvidencePrivacyTier;
  /** Optional free-form annotation. Hard cap MAX_EVIDENCE_NOTE_BYTES = 500. */
  note?: string;
  /** ISO 8601 timestamp of when this evidence was added or refreshed. */
  updatedAt: string;
}

/**
 * Privacy tier vocabulary for `MemoryEvidence.privacyTier`. Distinct from
 * `PrivacyScopeType` (which is the entity-level vocabulary): adds `public`
 * and `sensitive` endpoint tiers per spec § Schema Changes line 136.
 *
 * Ordering for narrowing-only constraint:
 *   public < shared-project < private < sensitive
 *
 * Entity vocabulary maps onto this:
 *   PrivacyScopeType.shared-project → EvidencePrivacyTier.shared-project
 *   PrivacyScopeType.shared-topic    → EvidencePrivacyTier.private
 *                                        (shared-topic is conservative-mapped
 *                                         to private; topic-scope evidence is
 *                                         not in the spec's privacyTier set).
 *   PrivacyScopeType.private         → EvidencePrivacyTier.private
 */
export type EvidencePrivacyTier = 'public' | 'shared-project' | 'private' | 'sensitive';

/** Per-entity cap; overridable up to MAX_EVIDENCE_CAP_PER_ENTITY via config. */
export const DEFAULT_EVIDENCE_CAP_PER_ENTITY = 50;
/** Hard upper bound on per-entity evidence cap. */
export const MAX_EVIDENCE_CAP_PER_ENTITY = 500;
/** Hard cap on `note` field bytes. */
export const MAX_EVIDENCE_NOTE_BYTES = 500;
/** Bound for traversal of `kind:'supersedes-evidence'` chains. */
export const MAX_SUPERSEDES_DEPTH = 32;

/**
 * Producer identifier — capability token for `addEvidence` /
 * `rememberWithEvidence` calls. Restricts which kinds each subsystem may
 * write (per-caller kind allowlist). Cross-process spoofing is NOT in the
 * threat model — the producer ID is a process-internal symbol.
 */
export type EvidenceProducerId =
  | 'EvolutionManager'
  | 'DispatchExecutor'
  | 'DecisionJournal'
  | 'LearnSkill'
  | 'manual';

/**
 * A directional connection between two entities.
 */
export interface MemoryEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: RelationType;
  /** Connection strength (0.0-1.0) */
  weight: number;
  /** Why this connection exists */
  context?: string;
  createdAt: string;
}

/**
 * Entity with a computed retrieval score.
 */
export interface ScoredEntity extends MemoryEntity {
  score: number;
}

/**
 * Entity with its connected neighbors.
 */
export interface ConnectedEntity {
  entity: MemoryEntity;
  edge: MemoryEdge;
  direction: 'outgoing' | 'incoming';
}

/**
 * Report from confidence decay operation.
 */
export interface DecayReport {
  entitiesProcessed: number;
  entitiesDecayed: number;
  entitiesExpired: number;
  minConfidence: number;
  maxConfidence: number;
  avgConfidence: number;
}

/**
 * Report from import operation.
 */
export interface ImportReport {
  entitiesImported: number;
  edgesImported: number;
  entitiesSkipped: number;
  edgesSkipped: number;
}

/**
 * Statistics for the semantic memory store.
 */
export interface SemanticMemoryStats {
  totalEntities: number;
  totalEdges: number;
  entityCountsByType: Record<EntityType, number>;
  avgConfidence: number;
  staleCount: number;
  dbSizeBytes: number;
  /** Whether vector search (sqlite-vec) is active */
  vectorSearchAvailable?: boolean;
  /** Number of entities with computed embeddings */
  embeddingCount?: number;
}

/**
 * Configuration for semantic memory.
 */
export interface SemanticMemoryConfig {
  /** Path to SQLite database file */
  dbPath: string;
  /** Half-life for confidence decay in days (default: 30) */
  decayHalfLifeDays: number;
  /** Half-life for lessons (longer-lived knowledge, default: 90) */
  lessonDecayHalfLifeDays: number;
  /** Minimum confidence before an entity is considered stale (default: 0.2) */
  staleThreshold: number;
  /** Max JSONL file size (bytes) for synchronous auto-rebuild on corruption recovery.
   *  Files larger than this are skipped with a warning — operator must rebuild manually.
   *  Default: 50 MB (≈500k entities). Set 0 to disable auto-rebuild entirely. */
  autoRebuildMaxBytes?: number;
}

/**
 * Options for semantic memory search.
 */
export interface SemanticSearchOptions {
  types?: EntityType[];
  domain?: string;
  minConfidence?: number;
  limit?: number;
  /** Filter to entities visible to this user (includes shared-project + user's private).
   *  If not set, returns all entities (backward-compatible for single-user). */
  userId?: string;
}

/**
 * Options for graph traversal (explore).
 */
export interface ExploreOptions {
  maxDepth?: number;
  relations?: RelationType[];
  minWeight?: number;
}

// ── Privacy Scoping (User-Agent Topology Spec, Phase 2) ──────────────

/**
 * Privacy scope for data items (memories, messages, entities).
 *
 * Controls who can see what:
 *   - private: Only the owning user (identified by userId)
 *   - shared-topic: All participants of a specific Telegram topic
 *   - shared-project: All users of the agent (project-wide visibility)
 *
 * Default for new data: 'private' (fail-closed).
 * Agent-generated shared knowledge (tool docs, project facts): 'shared-project'.
 */
export type PrivacyScopeType = 'private' | 'shared-topic' | 'shared-project';

export interface PrivacyScope {
  /** Scope type */
  type: PrivacyScopeType;
  /** Owner user ID (required for 'private', optional for shared scopes) */
  ownerId?: string;
  /** Topic ID (required for 'shared-topic') */
  topicId?: number;
}

/**
 * Onboarding state for a user who is in the process of registering.
 * Gates messages during onboarding to prevent consent bypass (Gap 13).
 *
 * State machine:
 *   unknown → pending → consented → authorized
 *                    ↘ rejected
 *   unknown → authorized (admin pre-approved)
 */
export type OnboardingState = 'unknown' | 'pending' | 'consented' | 'rejected' | 'authorized';

/**
 * Tracks the onboarding process for a Telegram user.
 * Stored in-memory (not persisted — onboarding is transient).
 */
export interface OnboardingSession {
  /** Telegram user ID */
  telegramUserId: number;
  /** Display name */
  name: string;
  /** Current onboarding state */
  state: OnboardingState;
  /** When onboarding started */
  startedAt: string;
  /** When the state last changed */
  updatedAt: string;
  /** Topic where onboarding is happening */
  topicId: number;
  /** Number of messages received while in pending state (for rate limiting) */
  pendingMessageCount: number;
}

/**
 * User data export for /mydata command (GDPR Article 15).
 */
export interface UserDataExport {
  /** Export metadata */
  exportedAt: string;
  exportVersion: string;
  userId: string;
  /** User profile */
  profile: UserProfile;
  /** Conversation messages (from TopicMemory) */
  messages: {
    topicId: number;
    messageCount: number;
    messages: Array<{
      text: string;
      fromUser: boolean;
      timestamp: string;
      topicId: number;
    }>;
  }[];
  /** Semantic memory entities owned by this user */
  knowledgeEntities: Array<{
    name: string;
    type: string;
    content: string;
    createdAt: string;
  }>;
  /** Episodic memory digests from this user's sessions */
  activityDigests: Array<{
    summary: string;
    startedAt: string;
    endedAt: string;
    themes: string[];
  }>;
}

/**
 * Result of a /forget (erasure) operation (GDPR Article 17).
 */
export interface UserErasureResult {
  userId: string;
  erasedAt: string;
  /** Number of messages deleted from TopicMemory */
  messagesDeleted: number;
  /** Number of semantic entities deleted */
  entitiesDeleted: number;
  /** Number of episodic digests deleted */
  digestsDeleted: number;
  /** Whether the user profile was removed */
  profileRemoved: boolean;
  /** Items that could not be erased (e.g., shared-project entities) */
  retainedItems: Array<{
    type: string;
    reason: string;
    count: number;
  }>;
}
