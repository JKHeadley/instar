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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
export async function llmValidateResumeCoherence(resumeUuid, topicId, topicName, projectDir, telegram, intelligence, deps = {}) {
    // Must have either an IntelligenceProvider or a test evaluateFn
    if (!intelligence && !deps.evaluateFn) {
        console.warn(`[ResumeValidator] No IntelligenceProvider available — rejecting resume (fail-safe)`);
        return false;
    }
    try {
        // 1. Get topic history
        let topicHistory = `Topic name: "${topicName}"\n`;
        if (deps.getTopicHistory) {
            try {
                const history = await deps.getTopicHistory();
                if (history.messages.length > 0) {
                    topicHistory += 'Recent topic messages:\n';
                    for (const m of history.messages) {
                        topicHistory += `  ${m.sender}: ${m.text}\n`;
                    }
                }
                else {
                    topicHistory += '(No topic message history available)\n';
                }
            }
            catch {
                topicHistory += '(Failed to read topic history)\n';
            }
        }
        else if (telegram) {
            try {
                const history = telegram.searchLog({ topicId, limit: 10 });
                if (history.length > 0) {
                    topicHistory += 'Recent topic messages:\n';
                    for (const m of history) {
                        const sender = (m.fromJustin || m.fromUser) ? 'User' : 'Agent';
                        const text = (m.text || '').slice(0, 200);
                        topicHistory += `  ${sender}: ${text}\n`;
                    }
                }
                else {
                    topicHistory += '(No topic message history available)\n';
                }
            }
            catch {
                topicHistory += '(Failed to read topic history)\n';
            }
        }
        // 2. Sample the resume JSONL — read from BOTH head (initial prompt, most identifying)
        // and tail (recent activity). Claude JSONL entries use various types; only some have
        // message.content. We also check for type-based entries, slug fields, etc.
        let sessionContext = '';
        if (deps.readSessionJsonl) {
            sessionContext = deps.readSessionJsonl(resumeUuid);
        }
        else {
            const projectHash = projectDir.replace(/\//g, '-');
            const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectHash, `${resumeUuid}.jsonl`);
            if (fs.existsSync(jsonlPath)) {
                try {
                    const stat = fs.statSync(jsonlPath);
                    const fd = fs.openSync(jsonlPath, 'r');
                    const snippets = [];
                    // Helper: extract text content from a JSONL entry
                    const extractContent = (entry) => {
                        // Standard message.content (human/assistant messages)
                        if (entry.message?.content) {
                            const content = entry.message.content;
                            if (typeof content === 'string' && content.length > 10)
                                return content.slice(0, 300);
                            if (Array.isArray(content)) {
                                for (const block of content) {
                                    if (block?.text && block.text.length > 10)
                                        return block.text.slice(0, 300);
                                }
                            }
                        }
                        // Type-based entries (human/assistant turns)
                        if (entry.type === 'human' && typeof entry.content === 'string' && entry.content.length > 10) {
                            return entry.content.slice(0, 300);
                        }
                        if (entry.type === 'assistant' && typeof entry.content === 'string' && entry.content.length > 10) {
                            return entry.content.slice(0, 300);
                        }
                        // Summary/slug fields that identify the session
                        if (entry.slug && typeof entry.slug === 'string')
                            return `[session: ${entry.slug}]`;
                        return undefined;
                    };
                    // Read HEAD — first 16KB (contains initial prompt, session identity)
                    const headSize = Math.min(16384, stat.size);
                    const headBuf = Buffer.alloc(headSize);
                    fs.readSync(fd, headBuf, 0, headSize, 0);
                    const headLines = headBuf.toString('utf-8').split('\n').filter(l => l.trim());
                    for (const line of headLines) {
                        if (snippets.length >= 3)
                            break;
                        try {
                            const entry = JSON.parse(line);
                            const text = extractContent(entry);
                            if (text)
                                snippets.push(`[start] ${text}`);
                        }
                        catch { /* partial/malformed line */ }
                    }
                    // Read TAIL — last 32KB (more data to find actual content entries)
                    if (stat.size > headSize) {
                        const tailSize = Math.min(32768, stat.size - headSize);
                        const tailBuf = Buffer.alloc(tailSize);
                        fs.readSync(fd, tailBuf, 0, tailSize, Math.max(0, stat.size - tailSize));
                        const tailLines = tailBuf.toString('utf-8').split('\n').filter(l => l.trim());
                        const tailSnippets = [];
                        for (const line of tailLines) {
                            try {
                                const entry = JSON.parse(line);
                                const text = extractContent(entry);
                                if (text)
                                    tailSnippets.push(`[recent] ${text}`);
                            }
                            catch { /* partial/malformed line */ }
                        }
                        snippets.push(...tailSnippets.slice(-3));
                    }
                    fs.closeSync(fd);
                    sessionContext = snippets.length > 0
                        ? `Session content samples:\n${snippets.map(s => `  ${s}`).join('\n')}`
                        : '(Could not extract readable content from session JSONL)';
                }
                catch {
                    sessionContext = '(Failed to read session JSONL)';
                }
            }
        }
        // 3. Ask the LLM for coherence judgment (via Claude CLI, no API key needed)
        const prompt = `You are a session-topic coherence validator. You must determine if a Claude session's context matches a Telegram topic's conversation history.

TOPIC CONTEXT (what this topic is about):
${topicHistory.slice(0, 1500)}

SESSION CONTEXT (what the session was doing):
${sessionContext.slice(0, 1500)}

Question: Does the session context appear to be about the SAME conversation/task as the topic?
- MATCH means the session was working on the topic's conversation
- MISMATCH means the session was doing something completely different (e.g., a different job, different topic)

If there's not enough information to tell, say MISMATCH (fail-safe).

Respond with ONLY one word: MATCH or MISMATCH`;
        const evaluate = deps.evaluateFn ?? ((p) => intelligence.evaluate(p, { model: 'fast' }));
        const response = await evaluate(prompt);
        const text = response.trim().toUpperCase();
        console.log(`[ResumeValidator] Topic ${topicId} ("${topicName}") vs UUID ${resumeUuid.slice(0, 8)}...: LLM says ${text}`);
        if (text.includes('MATCH') && !text.includes('MISMATCH')) {
            return true;
        }
        console.warn(`[ResumeValidator] LLM detected MISMATCH for topic ${topicId} — will start fresh instead of resuming`);
        return false;
    }
    catch (err) {
        console.error(`[ResumeValidator] Error during coherence check:`, err);
        return false; // Fail-safe: don't resume if we can't validate
    }
}
//# sourceMappingURL=ResumeValidator.js.map