/**
 * TopicSummarizer — LLM-powered rolling summary generation for topic conversations.
 *
 * Generates and maintains rolling summaries for each Telegram topic thread.
 * Summaries compress the full conversation history into a concise context
 * that new sessions can load instantly — no need to replay hundreds of messages.
 *
 * Summary strategy:
 *   - First summary: Generated from all messages when topic exceeds threshold
 *   - Incremental updates: Previous summary + new messages → updated summary
 *   - Triggered: On session end (if threshold exceeded) or on-demand via API
 *
 * Uses IntelligenceProvider (Claude CLI by default) for LLM calls.
 * Haiku tier for cost efficiency — summaries don't need deep reasoning.
 */
import type { IntelligenceProvider } from '../core/types.js';
import type { TopicMemory, TopicMessage } from './TopicMemory.js';
export interface TopicSummarizerConfig {
    /** Minimum new messages before triggering a summary update */
    messageThreshold: number;
    /** Maximum messages to include in a single summarization prompt */
    maxMessagesPerPrompt: number;
    /** Maximum tokens for the summary response */
    maxSummaryTokens: number;
}
export interface SummarizeResult {
    topicId: number;
    summary: string;
    /** One-line description of the topic's current focus */
    purpose: string | null;
    messagesProcessed: number;
    isUpdate: boolean;
    durationMs: number;
}
/**
 * Build the prompt for generating a topic summary.
 */
declare function buildSummaryPrompt(messages: TopicMessage[], existingSummary: string | null, topicName: string | null): string;
/**
 * Parse a PURPOSE line from the LLM response.
 * Expected format: "PURPOSE: Some description\n\nSummary text..."
 * Gracefully handles missing PURPOSE line — returns the full text as body.
 */
declare function parsePurposeFromResponse(text: string): {
    purpose: string | null;
    body: string;
};
export declare class TopicSummarizer {
    private intelligence;
    private topicMemory;
    private config;
    constructor(intelligence: IntelligenceProvider, topicMemory: TopicMemory, config?: Partial<TopicSummarizerConfig>);
    /**
     * Generate or update the summary for a topic.
     * Returns null if the topic doesn't need a summary update.
     */
    summarize(topicId: number, force?: boolean): Promise<SummarizeResult | null>;
    /**
     * Check all topics and summarize those that need it.
     * Returns results for topics that were summarized.
     */
    summarizeAll(): Promise<SummarizeResult[]>;
    /**
     * Check if a specific topic needs a summary update.
     */
    needsUpdate(topicId: number): boolean;
}
export { buildSummaryPrompt, parsePurposeFromResponse };
//# sourceMappingURL=TopicSummarizer.d.ts.map