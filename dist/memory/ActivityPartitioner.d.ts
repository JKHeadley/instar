/**
 * ActivityPartitioner — Dual-source activity timeline builder with boundary detection.
 *
 * Reads from two sources to build a unified activity timeline:
 *   1. Session logs (tmux capture-pane) — WHAT the agent did
 *   2. Telegram topic logs (JSONL) — WHY the agent did it
 *
 * Identifies natural boundaries where activity shifts, producing
 * discrete ActivityUnits that the Sentinel can digest independently.
 *
 * Boundary detection signals (ranked by strength):
 *   1. Explicit topic shift in Telegram ("now let's work on X")
 *   2. Git commit in session output (task completion marker)
 *   3. Long pause (30+ min gap in activity)
 *   4. Telegram topic change (messages shift subject)
 *   5. Time threshold (60 min max per unit)
 *
 * Implements Phase 3 of PROP-memory-architecture.md v3.1.
 */
import type { BoundarySignal } from './EpisodicMemory.js';
export interface TelegramLogEntry {
    messageId: number;
    topicId: number | null;
    text: string;
    fromUser: boolean;
    timestamp: string;
    sessionName: string | null;
    senderName?: string;
}
export interface ActivityUnit {
    startedAt: string;
    endedAt: string;
    sessionContent: string;
    telegramContent?: string;
    boundarySignal: BoundarySignal;
}
export interface PartitionInput {
    sessionOutput: string;
    telegramMessages?: TelegramLogEntry[];
    lastDigestedAt?: string;
}
export interface ActivityPartitionerConfig {
    /** Minimum messages before creating a digest (default: 5) */
    minTelegramMessages: number;
    /** Minimum session output minutes before creating a digest (default: 10) */
    minSessionMinutes: number;
    /** Maximum time per activity unit in minutes (default: 60) */
    maxUnitMinutes: number;
    /** Pause threshold in minutes that triggers a boundary (default: 30) */
    pauseThresholdMinutes: number;
}
export declare class ActivityPartitioner {
    private readonly config;
    constructor(config?: Partial<ActivityPartitionerConfig>);
    /**
     * Build a unified activity timeline from session + Telegram logs.
     * Identifies natural boundaries where activity shifts.
     */
    partition(input: PartitionInput): ActivityUnit[];
    private buildTimeline;
    private splitAtBoundaries;
    private isExplicitSwitch;
    private isGitCommit;
    private meetsMinimumThreshold;
    private minutesBetween;
}
//# sourceMappingURL=ActivityPartitioner.d.ts.map