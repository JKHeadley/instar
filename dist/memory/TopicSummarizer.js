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
const DEFAULT_CONFIG = {
    messageThreshold: 20,
    maxMessagesPerPrompt: 200,
    maxSummaryTokens: 1024,
};
/**
 * Build the prompt for generating a topic summary.
 */
function buildSummaryPrompt(messages, existingSummary, topicName) {
    const lines = [];
    lines.push('You are summarizing a conversation between a user and their AI agent.');
    lines.push('Your summary will be loaded as context for future sessions so the agent can continue the conversation seamlessly.');
    lines.push('');
    if (topicName) {
        lines.push(`Topic: ${topicName}`);
        lines.push('');
    }
    lines.push('RULES:');
    lines.push('- Capture what was discussed, decisions made, current state, and any pending items');
    lines.push('- Preserve specific details: names, file paths, version numbers, URLs, technical decisions');
    lines.push('- Note the emotional tone and relationship dynamics if relevant');
    lines.push('- Keep it under 500 words — concise but complete');
    lines.push('- Write in present tense for current state, past tense for completed work');
    lines.push('- DO NOT include meta-commentary about the summarization itself');
    lines.push('');
    lines.push('FORMAT: Your response MUST start with a PURPOSE line, then a blank line, then the summary.');
    lines.push('The PURPOSE is a single sentence describing what this topic is currently about — its recent focus.');
    lines.push('It should reflect what the conversation has evolved into, not just the original topic name.');
    lines.push('Example: PURPOSE: Debugging OAuth token refresh failures in the quota collector');
    lines.push('');
    if (existingSummary) {
        lines.push('EXISTING SUMMARY (update this with the new messages below):');
        lines.push('---');
        lines.push(existingSummary);
        lines.push('---');
        lines.push('');
        lines.push('NEW MESSAGES SINCE LAST SUMMARY:');
    }
    else {
        lines.push('CONVERSATION TO SUMMARIZE:');
    }
    lines.push('');
    for (const m of messages) {
        const sender = m.fromUser ? 'User' : 'Agent';
        const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ') : '';
        // Truncate very long messages to keep prompt manageable
        const text = m.text.length > 1000 ? m.text.slice(0, 1000) + '...' : m.text;
        lines.push(`[${ts}] ${sender}: ${text}`);
    }
    lines.push('');
    lines.push('Write the PURPOSE line followed by the updated conversation summary:');
    return lines.join('\n');
}
/**
 * Parse a PURPOSE line from the LLM response.
 * Expected format: "PURPOSE: Some description\n\nSummary text..."
 * Gracefully handles missing PURPOSE line — returns the full text as body.
 */
function parsePurposeFromResponse(text) {
    const match = text.match(/^PURPOSE:[ \t]*(.+?)[ \t]*(?:\r?\n|$)/i);
    if (!match) {
        return { purpose: null, body: text };
    }
    const purpose = match[1].trim();
    // Strip the PURPOSE line (and any following blank lines) from the body
    const body = text.slice(match[0].length).replace(/^\s*\n/, '').trim();
    return { purpose: purpose || null, body: body || text };
}
export class TopicSummarizer {
    intelligence;
    topicMemory;
    config;
    constructor(intelligence, topicMemory, config) {
        this.intelligence = intelligence;
        this.topicMemory = topicMemory;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Generate or update the summary for a topic.
     * Returns null if the topic doesn't need a summary update.
     */
    async summarize(topicId, force) {
        const needsUpdate = force || this.topicMemory.needsSummaryUpdate(topicId, this.config.messageThreshold);
        if (!needsUpdate)
            return null;
        const startTime = Date.now();
        // Get existing summary and new messages
        const existingSummary = this.topicMemory.getTopicSummary(topicId);
        const newMessages = this.topicMemory.getMessagesSinceSummary(topicId);
        if (newMessages.length === 0 && !force)
            return null;
        // Limit messages to prevent prompt explosion
        const messagesToProcess = newMessages.slice(-this.config.maxMessagesPerPrompt);
        const meta = this.topicMemory.getTopicMeta(topicId);
        const prompt = buildSummaryPrompt(messagesToProcess, existingSummary?.summary ?? null, meta?.topicName ?? null);
        // Generate summary via LLM (Haiku for cost efficiency)
        const summary = await this.intelligence.evaluate(prompt, {
            model: 'fast',
            maxTokens: this.config.maxSummaryTokens,
        });
        if (!summary || summary.trim().length < 10) {
            throw new Error(`Summary generation returned empty/invalid result for topic ${topicId}`);
        }
        // Parse purpose from the response (first line starting with "PURPOSE:")
        const { purpose, body } = parsePurposeFromResponse(summary.trim());
        // Get the last message ID for tracking what's been summarized
        const lastMessage = newMessages[newMessages.length - 1];
        const totalMessages = this.topicMemory.getMessageCount(topicId);
        // Save the summary
        this.topicMemory.saveTopicSummary(topicId, body, totalMessages, lastMessage?.messageId ?? existingSummary?.lastMessageId ?? 0, purpose);
        return {
            topicId,
            summary: body,
            purpose,
            messagesProcessed: messagesToProcess.length,
            isUpdate: !!existingSummary,
            durationMs: Date.now() - startTime,
        };
    }
    /**
     * Check all topics and summarize those that need it.
     * Returns results for topics that were summarized.
     */
    async summarizeAll() {
        const topics = this.topicMemory.listTopics();
        const results = [];
        for (const topic of topics) {
            try {
                const result = await this.summarize(topic.topicId);
                if (result)
                    results.push(result);
            }
            catch (err) {
                console.error(`[TopicSummarizer] Failed to summarize topic ${topic.topicId}: ${err}`);
            }
        }
        return results;
    }
    /**
     * Check if a specific topic needs a summary update.
     */
    needsUpdate(topicId) {
        return this.topicMemory.needsSummaryUpdate(topicId, this.config.messageThreshold);
    }
}
// Export helpers for testing
export { buildSummaryPrompt, parsePurposeFromResponse };
//# sourceMappingURL=TopicSummarizer.js.map