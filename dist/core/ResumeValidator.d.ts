/**
 * ResumeValidator — LLM-supervised coherence gate for session resume.
 *
 * Before resuming a Claude session for a Telegram topic, validates that
 * the session's content actually matches the topic's conversation history.
 * Uses Claude CLI (via IntelligenceProvider) — no external API keys needed.
 *
 * Fail-safe: on ANY error (CLI unavailable, timeout, ambiguous response),
 * returns false — meaning "start fresh" rather than risk cross-connecting
 * topics to wrong sessions.
 *
 * Standard: LLM-Supervised Execution — all critical processes require
 * at minimum a lightweight model wrapper as the final call.
 *
 * REQUIREMENT: Instar NEVER requires external API keys for functionality
 * that can be handled by Claude Code models. This validator uses the
 * IntelligenceProvider interface (defaulting to ClaudeCliIntelligenceProvider)
 * which runs on the user's existing Claude subscription.
 */
import type { IntelligenceProvider } from './types.js';
export interface TopicHistoryProvider {
    searchLog(opts: {
        topicId: number;
        limit: number;
    }): Array<{
        text: string;
        fromJustin?: boolean;
        fromUser?: boolean;
    }>;
    getTopicName(topicId: number): string | null | undefined;
}
export interface ResumeValidatorDeps {
    /** Override topic history for testing */
    getTopicHistory?: () => Promise<{
        topicName: string;
        messages: Array<{
            sender: string;
            text: string;
        }>;
    }>;
    /** Override LLM evaluation for testing */
    evaluateFn?: (prompt: string) => Promise<string>;
    /** Override session JSONL reader for testing */
    readSessionJsonl?: (uuid: string) => string;
}
/**
 * Validate that a resume UUID's session content is coherent with a topic's history.
 *
 * @param resumeUuid - The Claude session JSONL UUID to resume
 * @param topicId - The Telegram topic ID requesting resume
 * @param topicName - Human-readable topic name
 * @param projectDir - The project directory for JSONL path resolution
 * @param telegram - Optional TelegramAdapter for reading topic history
 * @param intelligence - IntelligenceProvider (Claude CLI) for LLM judgment
 * @param deps - Injectable dependencies for testing
 */
export declare function llmValidateResumeCoherence(resumeUuid: string, topicId: number, topicName: string, projectDir: string, telegram?: TopicHistoryProvider | null, intelligence?: IntelligenceProvider | null, deps?: ResumeValidatorDeps): Promise<boolean>;
//# sourceMappingURL=ResumeValidator.d.ts.map