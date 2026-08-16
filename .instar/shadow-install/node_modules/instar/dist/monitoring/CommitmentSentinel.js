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
import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from './DegradationReporter.js';
// ── Implementation ────────────────────────────────────────────────
export class CommitmentSentinel {
    config;
    scanState;
    scanStatePath;
    messagesPath;
    interval = null;
    isScanning = false;
    constructor(config) {
        this.config = config;
        this.scanStatePath = path.join(config.stateDir, 'state', 'commitment-sentinel.json');
        this.messagesPath = path.join(config.stateDir, 'telegram-messages.jsonl');
        this.scanState = this.loadScanState();
    }
    // ── Lifecycle ──────────────────────────────────────────────────
    start() {
        if (this.interval)
            return;
        const intervalMs = this.config.scanIntervalMs ?? 300_000;
        // First scan after a delay (let messages accumulate)
        setTimeout(() => this.scan(), 60_000);
        this.interval = setInterval(() => this.scan(), intervalMs);
        this.interval.unref();
        console.log(`[CommitmentSentinel] Started (every ${Math.round(intervalMs / 60_000)}m)`);
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    // ── Scanning ───────────────────────────────────────────────────
    /**
     * Scan recent messages for unregistered commitments.
     */
    async scan() {
        if (this.isScanning)
            return 0;
        this.isScanning = true;
        try {
            const messages = this.readNewMessages();
            if (messages.length === 0) {
                this.isScanning = false;
                return 0;
            }
            // Group messages by topic for context
            const byTopic = new Map();
            for (const msg of messages) {
                const existing = byTopic.get(msg.topicId) ?? [];
                existing.push(msg);
                byTopic.set(msg.topicId, existing);
            }
            let detected = 0;
            for (const [topicId, topicMessages] of byTopic) {
                // Look for conversation pairs: user request → agent response
                const pairs = this.extractConversationPairs(topicMessages);
                if (pairs.length === 0)
                    continue;
                // Ask LLM to identify commitments in these pairs
                const commitments = await this.detectCommitments(pairs, topicId);
                for (const c of commitments) {
                    // Check if this commitment is already registered
                    const existing = this.config.commitmentTracker.getActive();
                    const isDuplicate = existing.some(e => e.topicId === topicId &&
                        e.userRequest.toLowerCase().includes(c.userRequest.toLowerCase().slice(0, 30)));
                    if (!isDuplicate) {
                        this.config.commitmentTracker.record({
                            ...c,
                            topicId,
                            source: 'sentinel',
                        });
                        detected++;
                        console.log(`[CommitmentSentinel] Detected commitment in topic ${topicId}: "${c.userRequest}"`);
                    }
                }
                // Update high-water mark for this topic
                const maxMsgId = Math.max(...topicMessages.map(m => m.messageId));
                this.scanState.topicHighWaterMark[topicId] = maxMsgId;
            }
            this.scanState.lastScanAt = new Date().toISOString();
            this.saveScanState();
            this.isScanning = false;
            if (detected > 0) {
                console.log(`[CommitmentSentinel] Scan complete: ${detected} new commitment(s) detected`);
            }
            return detected;
        }
        catch (err) {
            this.isScanning = false;
            DegradationReporter.getInstance().report({
                feature: 'CommitmentSentinel.scan',
                primary: 'Scan messages for unregistered commitments',
                fallback: 'Scan skipped, returning 0 detected',
                reason: `Scan error: ${err instanceof Error ? err.message : String(err)}`,
                impact: 'Unregistered commitments may go undetected until next successful scan',
            });
            console.error(`[CommitmentSentinel] Scan error:`, err);
            return 0;
        }
    }
    // ── Message Reading ────────────────────────────────────────────
    /**
     * Read messages newer than the high-water mark from the JSONL log.
     */
    readNewMessages() {
        if (!fs.existsSync(this.messagesPath))
            return [];
        try {
            const content = fs.readFileSync(this.messagesPath, 'utf-8');
            const lines = content.trim().split('\n');
            const messages = [];
            const maxPerScan = this.config.maxMessagesPerScan ?? 20;
            // Read from the end to get the most recent messages
            for (let i = lines.length - 1; i >= 0 && messages.length < maxPerScan * 10; i--) {
                try {
                    const msg = JSON.parse(lines[i]);
                    if (!msg.messageId || !msg.topicId || !msg.text)
                        continue;
                    // Skip if we've already scanned past this message
                    const hwm = this.scanState.topicHighWaterMark[msg.topicId] ?? 0;
                    if (msg.messageId <= hwm)
                        continue;
                    messages.push(msg);
                }
                catch {
                    // @silent-fallback-ok — skip individual malformed JSONL lines, other lines still parsed
                }
            }
            return messages.reverse(); // Chronological order
        }
        catch (err) {
            DegradationReporter.getInstance().report({
                feature: 'CommitmentSentinel.readNewMessages',
                primary: 'Read new Telegram messages from JSONL log',
                fallback: 'Returning empty array, no messages processed',
                reason: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
                impact: 'Commitment detection skipped for this cycle',
            });
            return [];
        }
    }
    /**
     * Extract user→agent conversation pairs from messages.
     */
    extractConversationPairs(messages) {
        const pairs = [];
        for (let i = 0; i < messages.length - 1; i++) {
            if (messages[i].fromUser && !messages[i + 1].fromUser) {
                pairs.push({
                    user: messages[i].text,
                    agent: messages[i + 1].text,
                });
            }
        }
        return pairs;
    }
    // ── LLM Detection ─────────────────────────────────────────────
    /**
     * Ask the LLM to detect commitments in conversation pairs.
     */
    async detectCommitments(pairs, topicId) {
        if (pairs.length === 0)
            return [];
        const conversationText = pairs.map((p, i) => `--- Exchange ${i + 1} ---\nUser: ${p.user}\nAgent: ${p.agent}`).join('\n\n');
        const prompt = `You are analyzing agent-user conversations to detect commitments the agent made.

A "commitment" is when:
1. The user asks the agent to change a setting, behavior, or perform a durable action
2. The agent acknowledges and agrees to do it

Types of commitments:
- "config-change": User asks to change a setting (e.g., "turn off auto-updates", "set max sessions to 5")
- "behavioral": User asks agent to change ongoing behavior (e.g., "always check with me before deploying", "stop sending daily reports")
- "one-time-action": User asks agent to do something once (e.g., "deploy the latest version", "clean up old logs")

Analyze these conversation exchanges and identify any commitments:

${conversationText}

Respond in JSON format. If no commitments found, return an empty array.
Example response:
[{"type":"config-change","userRequest":"turn off auto-updates","agentResponse":"Turning off auto-updates now","configPath":"updates.autoApply","configExpectedValue":false}]

For behavioral commitments, include a "behavioralRule" field with a clear imperative rule.
For one-time-action, omit configPath.

IMPORTANT: Only return genuine commitments where the agent explicitly agreed. Do not flag questions, status updates, or informational responses. Return ONLY the JSON array, nothing else.`;
        try {
            const response = await this.config.intelligence.evaluate(prompt, {
                model: 'fast',
                maxTokens: 500,
                temperature: 0,
            });
            // Parse JSON from response
            const trimmed = response.trim();
            // Handle case where LLM wraps in markdown code block
            const jsonStr = trimmed.startsWith('```')
                ? trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
                : trimmed;
            const parsed = JSON.parse(jsonStr);
            if (!Array.isArray(parsed))
                return [];
            return parsed.filter((c) => c.type && c.userRequest && c.agentResponse &&
                ['config-change', 'behavioral', 'one-time-action'].includes(c.type));
        }
        catch (err) {
            // @silent-fallback-ok — LLM detection is best-effort; infrastructure enforcement still works
            console.error(`[CommitmentSentinel] LLM detection failed:`, err instanceof Error ? err.message : String(err));
            return [];
        }
    }
    // ── Persistence ────────────────────────────────────────────────
    loadScanState() {
        try {
            if (fs.existsSync(this.scanStatePath)) {
                return JSON.parse(fs.readFileSync(this.scanStatePath, 'utf-8'));
            }
        }
        catch { /* start fresh */ }
        return { topicHighWaterMark: {}, lastScanAt: null };
    }
    saveScanState() {
        try {
            const dir = path.dirname(this.scanStatePath);
            fs.mkdirSync(dir, { recursive: true });
            const tmpPath = `${this.scanStatePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(this.scanState, null, 2));
            fs.renameSync(tmpPath, this.scanStatePath);
        }
        catch {
            // @silent-fallback-ok — scan state loss just means re-scanning some messages
        }
    }
}
//# sourceMappingURL=CommitmentSentinel.js.map