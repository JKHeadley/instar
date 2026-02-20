/**
 * Core type definitions for instar.
 *
 * These types define the contracts between all modules.
 * Everything flows from these — sessions, jobs, users, messaging.
 */

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
  /** Model to use for this session */
  model?: ModelTier;
  /** The initial prompt/instruction sent to Claude */
  prompt?: string;
}

export type SessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'killed';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface SessionManagerConfig {
  /** Path to tmux binary */
  tmuxPath: string;
  /** Path to claude CLI binary */
  claudePath: string;
  /** Project directory (where CLAUDE.md lives) */
  projectDir: string;
  /** Maximum concurrent sessions */
  maxSessions: number;
  /** Protected session names that should never be reaped */
  protectedSessions: string[];
  /** Patterns in tmux output that indicate session completion */
  completionPatterns: string[];
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
  /** Tags for filtering/grouping */
  tags?: string[];
  /** Telegram topic ID this job reports to (auto-created if not set) */
  topicId?: number;
}

export type JobPriority = 'critical' | 'high' | 'medium' | 'low';

export interface JobExecution {
  /** Type of execution */
  type: 'skill' | 'prompt' | 'script';
  /** The skill name, prompt text, or script path */
  value: string;
  /** Additional arguments */
  args?: string;
}

export interface JobState {
  slug: string;
  lastRun?: string;
  lastResult?: 'success' | 'failure' | 'timeout';
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
  /** Interaction history summary */
  context?: string;
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
export interface MessagingAdapter {
  /** Platform name (e.g., "telegram", "slack") */
  platform: string;
  /** Start listening for messages */
  start(): Promise<void>;
  /** Stop listening */
  stop(): Promise<void>;
  /** Send a message to a user */
  send(message: OutgoingMessage): Promise<void>;
  /** Register a handler for incoming messages */
  onMessage(handler: (message: Message) => Promise<void>): void;
  /** Resolve a platform-specific identifier to a user ID */
  resolveUser(channelIdentifier: string): Promise<string | null>;
}

// ── Monitoring ──────────────────────────────────────────────────────

export interface QuotaState {
  /** Current usage percentage (0-100) */
  usagePercent: number;
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
  isActive: boolean;
  lastUpdated: string;
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
}

// ── Activity Tracking ───────────────────────────────────────────────

export interface ActivityEvent {
  type: string;
  summary: string;
  /** Which session generated this event */
  sessionId?: string;
  /** Which user triggered this, if any */
  userId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ── Feedback Loop ───────────────────────────────────────────────────

export interface FeedbackItem {
  /** Unique feedback ID */
  id: string;
  /** Feedback type */
  type: 'bug' | 'feature' | 'improvement' | 'question' | 'other';
  /** Short title/summary */
  title: string;
  /** Detailed description */
  description: string;
  /** Agent name that submitted this */
  agentName: string;
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
  /** Webhook URL to forward feedback to (default: https://api.instar.sh/feedback) */
  webhookUrl: string;
  /** Local feedback storage file */
  feedbackFile: string;
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
}

// ── Server Configuration ────────────────────────────────────────────

export interface AgentKitConfig {
  /** Project name (used in logging, tmux session names, etc.) */
  projectName: string;
  /** Project root directory */
  projectDir: string;
  /** Where instar stores its runtime state */
  stateDir: string;
  /** HTTP server port */
  port: number;
  /** Session manager config */
  sessions: SessionManagerConfig;
  /** Job scheduler config */
  scheduler: JobSchedulerConfig;
  /** Registered users */
  users: UserProfile[];
  /** Messaging adapters to enable */
  messaging: MessagingAdapterConfig[];
  /** Monitoring config */
  monitoring: MonitoringConfig;
  /** Auth token for API access (generated during setup) */
  authToken?: string;
  /** Relationship tracking config */
  relationships: RelationshipManagerConfig;
  /** Feedback loop config */
  feedback: FeedbackConfig;
  /** Instar version (from package.json) */
  version?: string;
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
}
