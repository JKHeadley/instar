/**
 * Commitment Sentinel — LLM-powered scanner that detects unregistered commitments.
 *
 * Periodically scans Telegram topic messages to find commitments the agent
 * made but didn't register via the CommitmentTracker API. Closes the gap
 * between "the agent said it would" and "the system knows about it."
 *
 * Uses IntelligenceProvider (Haiku by default) for lightweight scanning.
 * Tracks a high-water mark per topic so it only reads new messages each cycle.
 *
 * This is the "trust but verify" layer — instead of brittle string matching,
 * an LLM reads the conversation and understands intent.
 */
import type { IntelligenceProvider } from '../core/types.js';
import type { CommitmentTracker } from './CommitmentTracker.js';
export interface CommitmentSentinelConfig {
    /** State directory (.instar/) */
    stateDir: string;
    /** LLM provider for scanning */
    intelligence: IntelligenceProvider;
    /** CommitmentTracker to register detected commitments */
    commitmentTracker: CommitmentTracker;
    /** Scan interval in ms. Default: 300_000 (5 minutes) */
    scanIntervalMs?: number;
    /** Maximum messages to scan per topic per cycle. Default: 20 */
    maxMessagesPerScan?: number;
}
export declare class CommitmentSentinel {
    private config;
    private scanState;
    private scanStatePath;
    private messagesPath;
    private interval;
    private isScanning;
    constructor(config: CommitmentSentinelConfig);
    start(): void;
    stop(): void;
    /**
     * Scan recent messages for unregistered commitments.
     */
    scan(): Promise<number>;
    /**
     * Read messages newer than the high-water mark from the JSONL log.
     */
    private readNewMessages;
    /**
     * Extract user→agent conversation pairs from messages.
     */
    private extractConversationPairs;
    /**
     * Ask the LLM to detect commitments in conversation pairs.
     */
    private detectCommitments;
    private loadScanState;
    private saveScanState;
}
//# sourceMappingURL=CommitmentSentinel.d.ts.map