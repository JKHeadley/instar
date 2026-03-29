/**
 * Job Scheduler — cron-based job execution engine.
 *
 * Schedules jobs via croner, respects session limits and quota,
 * queues jobs when at capacity, and drains when slots open.
 *
 * Simplified from Dawn's 1400-line scheduler — serial queue,
 * no JSONL discovery, no machine coordination.
 */
import { IntegrationGate } from './IntegrationGate.js';
import { JobRunHistory } from './JobRunHistory.js';
import { SkipLedger } from './SkipLedger.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';
import type { IntelligenceProvider, MessagingAdapter } from '../core/types.js';
import type { JobDefinition, JobSchedulerConfig, JobPriority } from '../core/types.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { JobClaimManager } from './JobClaimManager.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
interface QueuedJob {
    slug: string;
    reason: string;
    queuedAt: string;
}
interface SchedulerStatus {
    running: boolean;
    paused: boolean;
    jobCount: number;
    enabledJobs: number;
    queueLength: number;
    activeJobSessions: number;
}
export declare class JobScheduler {
    private config;
    private sessionManager;
    private state;
    private stateDir;
    private skipLedger;
    private runHistory;
    private jobs;
    private cronTasks;
    private queue;
    private running;
    private paused;
    /** Map session names to run IDs for completion tracking */
    private activeRunIds;
    /** Local machine identity — used for machine-scoped job filtering */
    private machineId;
    private machineName;
    /** Callback to check if quota allows running a job at the given priority */
    canRunJob: (priority: JobPriority) => boolean;
    /** Optional messenger for sending job notifications */
    private messenger;
    /** Optional Telegram adapter for job-topic coupling */
    private telegram;
    /** Optional quota tracker for death classification cross-reference */
    private quotaTracker;
    /** Optional job claim manager for multi-machine deduplication (Phase 4C) */
    private claimManager;
    /** Optional LLM provider for per-job reflection (Living Skills Phase 4) */
    private intelligence;
    /** Optional IntegrationGate for post-completion learning consolidation */
    private integrationGate;
    /** Optional TopicMemory for topic-aware job sessions */
    private topicMemory;
    constructor(config: JobSchedulerConfig, sessionManager: SessionManager, state: StateManager, stateDir: string);
    /**
     * Set a messaging adapter for job completion notifications.
     */
    setMessenger(adapter: MessagingAdapter): void;
    /**
     * Set the Telegram adapter for job-topic coupling.
     * Every job gets its own topic — the user's window into the job.
     */
    setTelegram(adapter: TelegramAdapter): void;
    /**
     * Set the quota tracker for session death classification.
     * When set, session deaths are cross-referenced with quota state
     * to determine if they died from quota exhaustion.
     */
    setQuotaTracker(tracker: QuotaTracker): void;
    /**
     * Set the job claim manager for multi-machine deduplication.
     * When set, the scheduler will broadcast claims before executing jobs
     * and skip jobs already claimed by other machines.
     */
    setJobClaimManager(manager: JobClaimManager): void;
    /**
     * Set local machine identity for machine-scoped job filtering.
     * Jobs with a `machines` field will only run on machines whose ID or name matches.
     */
    setMachineIdentity(machineId: string, machineName: string): void;
    /**
     * Set the intelligence provider for per-job LLM reflection (Living Skills Phase 4).
     */
    setIntelligence(provider: IntelligenceProvider): void;
    /**
     * Set the IntegrationGate for post-completion learning consolidation.
     * When set, reflection runs synchronously before queue drain.
     * When not set, the existing fire-and-forget reflection behavior is preserved.
     */
    setIntegrationGate(gate: IntegrationGate): void;
    /**
     * Set the TopicMemory for topic-aware job sessions.
     * When set, jobs bound to a topic receive awareness context about the topic's focus.
     */
    setTopicMemory(topicMemory: TopicMemory): void;
    /**
     * Start the scheduler — load jobs, set up cron tasks, check for missed jobs.
     */
    start(): void;
    /**
     * Stop the scheduler — cancel all cron tasks.
     */
    stop(): void;
    /**
     * Trigger a job by slug. Checks claims, quota, session limits, queues if at capacity.
     */
    triggerJob(slug: string, reason: string): 'triggered' | 'queued' | 'skipped';
    /**
     * Check if a job is scoped to run on this machine.
     * Jobs without a `machines` field run everywhere (backwards-compatible).
     * Jobs with `machines` only run if this machine's ID or name matches.
     */
    private isJobScopedToThisMachine;
    /**
     * Process the queue — dequeue and run next job if a slot is available.
     */
    processQueue(): void;
    /**
     * Pause — cron tasks keep ticking but triggers are skipped.
     */
    pause(): void;
    /**
     * Resume — triggers start executing again.
     */
    resume(): void;
    /**
     * Get scheduler status for the /status endpoint.
     */
    getStatus(): SchedulerStatus;
    /**
     * Get loaded job definitions (for /jobs endpoint).
     */
    getJobs(): JobDefinition[];
    /**
     * Get the current queue.
     */
    getQueue(): QueuedJob[];
    /**
     * Check if a job will run on this machine (for API visibility).
     */
    isJobLocal(slug: string): boolean;
    /**
     * Get the skip ledger instance (for API routes).
     */
    getSkipLedger(): SkipLedger;
    /**
     * Get the run history instance (for API routes).
     */
    getRunHistory(): JobRunHistory;
    private enqueue;
    private spawnJobSession;
    /**
     * Resolve the model tier for a job. Normally uses the job's configured model,
     * but gates can write a severity file to escalate the model for complex work.
     *
     * The git-sync gate writes to /tmp/instar-git-sync-severity:
     * - "clean" → use configured model (haiku)
     * - "state" → escalate to sonnet (structured conflict resolution)
     * - "code"  → escalate to opus (semantic code merge)
     */
    private resolveModelTier;
    private buildPrompt;
    /**
     * Resolve the effective notification mode for a job.
     * Default (undefined) → 'on-alert': quiet unless signaled.
     */
    private getNotifyMode;
    /**
     * Check if session output contains an attention signal.
     * The convention: [ATTENTION] on its own line (case-insensitive).
     */
    private hasAttentionSignal;
    /**
     * Extract handoff notes from session output.
     * Agents can include a [HANDOFF] ... [/HANDOFF] block in their output
     * to leave context for the next execution. This is auto-extracted on completion.
     */
    static extractHandoff(output: string): string | null;
    private getConsecutiveFailures;
    private getNextRun;
    /**
     * Called when a job's session completes. Updates job state and notifies via messenger.
     */
    notifyJobComplete(sessionId: string, tmuxSession: string): Promise<void>;
    /**
     * Ensure every enabled job has a Telegram topic.
     * Creates topics for jobs that don't have one.
     * This is the "job-topic coupling" — every job lives in a topic.
     */
    private ensureJobTopics;
    /**
     * Save a job-topic mapping (used when recreating a deleted topic).
     */
    private saveJobTopicMapping;
    /**
     * Run a job's gate command. Returns true if the job should proceed, false to skip.
     * Gates are zero-token pre-screening — a bash command that exits 0 (proceed) or non-zero (skip).
     */
    private runGate;
    /**
     * Alert when a job hits consecutive failure thresholds.
     * Critical/high priority jobs alert after 2 failures.
     * Medium/low priority jobs alert after 3 failures.
     * Only alerts at the threshold (not every failure after).
     *
     * When the failure is a session limit issue (not a job execution error),
     * the notification is reframed as "Job Blocked" with intelligent diagnostics:
     * running session list with ages, stale session flags, memory pressure,
     * and actionable suggestions.
     */
    private alertOnConsecutiveFailures;
    /**
     * Build an intelligent "Job Blocked" notification when a job can't start
     * because all session slots are occupied. Includes session diagnostics,
     * staleness detection, memory pressure, and actionable suggestions.
     */
    private buildSessionBlockedAlert;
    private checkMissedJobs;
    /**
     * Run per-job LLM reflection after execution.
     * Always-on for every completed job — history is memory.
     * Persists the reflection to run history and optionally sends to Telegram.
     */
    private runJobReflection;
}
export {};
//# sourceMappingURL=JobScheduler.d.ts.map