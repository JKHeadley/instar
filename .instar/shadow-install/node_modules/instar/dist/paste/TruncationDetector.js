/**
 * TruncationDetector — detects when Telegram messages appear truncated.
 *
 * Runs as server-side middleware in the Telegram message ingestion path.
 * Detects near-limit messages, rapid multi-part sends, and structurally
 * incomplete code/log content. Returns metadata that the session can use
 * to suggest the Drop Zone.
 */
// ── Constants ──────────────────────────────────────────────────────
const TELEGRAM_LIMIT = 4096;
const NEAR_LIMIT_THRESHOLD = 50; // within 50 chars of limit
const RAPID_MESSAGE_WINDOW_MS = 15_000; // 15 seconds
const MAX_RECENT_MESSAGES = 50;
// Unclosed delimiters that suggest truncation
const UNCLOSED_DELIMITERS = ['{', '[', '(', '`'];
const OPENING_TO_CLOSING = {
    '{': '}',
    '[': ']',
    '(': ')',
};
// ── Detector ───────────────────────────────────────────────────────
export class TruncationDetector {
    recentMessages = [];
    /** Track which topics have already been nudged to avoid repetition */
    nudgedTopics = new Map(); // topicId → timestamp
    nudgeCooldownMs = 30 * 60 * 1000; // 30 minutes between nudges per topic
    /**
     * Analyze a Telegram message for truncation signals.
     */
    detect(topicId, userId, text) {
        const now = Date.now();
        // Store for rapid-message detection
        this.recentMessages.push({ topicId, userId, text, timestamp: now });
        // Trim old messages
        while (this.recentMessages.length > MAX_RECENT_MESSAGES) {
            this.recentMessages.shift();
        }
        // Check cooldown — don't flag if we recently nudged this topic
        const lastNudge = this.nudgedTopics.get(topicId);
        if (lastNudge && (now - lastNudge) < this.nudgeCooldownMs) {
            return { truncationSuspected: false };
        }
        // Run heuristics in order of confidence
        const nearLimit = this.checkNearLimit(text);
        if (nearLimit.truncationSuspected) {
            this.nudgedTopics.set(topicId, now);
            return nearLimit;
        }
        const rapidMultiPart = this.checkRapidMultiPart(topicId, userId, now);
        if (rapidMultiPart.truncationSuspected) {
            this.nudgedTopics.set(topicId, now);
            return rapidMultiPart;
        }
        const structural = this.checkStructuralIncompleteness(text);
        if (structural.truncationSuspected) {
            this.nudgedTopics.set(topicId, now);
            return structural;
        }
        return { truncationSuspected: false };
    }
    /**
     * Heuristic 1: Message is within NEAR_LIMIT_THRESHOLD chars of the
     * Telegram limit AND ends in a way that suggests manual chopping.
     */
    checkNearLimit(text) {
        if (text.length < TELEGRAM_LIMIT - NEAR_LIMIT_THRESHOLD) {
            return { truncationSuspected: false };
        }
        // Check if it ends mid-word (no trailing whitespace or punctuation)
        const lastChar = text[text.length - 1];
        const endsCleanly = /[.!?;:)\]}\s"']/.test(lastChar);
        if (!endsCleanly) {
            return {
                truncationSuspected: true,
                reason: 'near-limit + ends mid-word',
                confidence: 'high',
            };
        }
        // Check for unclosed delimiters
        if (this.hasUnclosedDelimiters(text)) {
            return {
                truncationSuspected: true,
                reason: 'near-limit + unclosed delimiter',
                confidence: 'high',
            };
        }
        // Even near-limit with clean ending is suspicious if content looks like code/logs
        if (this.looksLikeCode(text) && text.length > TELEGRAM_LIMIT - 20) {
            return {
                truncationSuspected: true,
                reason: 'near-limit + code/log content',
                confidence: 'medium',
            };
        }
        return { truncationSuspected: false };
    }
    /**
     * Heuristic 2: Multiple messages from same user in same topic
     * within a short window, suggesting manual splitting.
     */
    checkRapidMultiPart(topicId, userId, now) {
        const recent = this.recentMessages.filter(m => m.topicId === topicId &&
            m.userId === userId &&
            (now - m.timestamp) < RAPID_MESSAGE_WINDOW_MS);
        if (recent.length < 2) {
            return { truncationSuspected: false };
        }
        // Check if messages look like continuation
        const prev = recent[recent.length - 2];
        const curr = recent[recent.length - 1];
        // Second message starts lowercase or with continuation patterns
        const firstChar = curr.text[0];
        const continuesLowercase = firstChar && /[a-z]/.test(firstChar);
        const continuesCode = /^[}\])\s]/.test(curr.text) || /^(else|catch|finally|then|and|or)\b/i.test(curr.text);
        const prevEndsAbruptly = !/[.!?]\s*$/.test(prev.text);
        if ((continuesLowercase || continuesCode) && prevEndsAbruptly) {
            return {
                truncationSuspected: true,
                reason: 'rapid multi-part messages',
                confidence: 'medium',
            };
        }
        return { truncationSuspected: false };
    }
    /**
     * Heuristic 3: Content looks like code/logs but is structurally incomplete.
     */
    checkStructuralIncompleteness(text) {
        if (!this.looksLikeCode(text)) {
            return { truncationSuspected: false };
        }
        // Check for unclosed code fences
        const fenceCount = (text.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) {
            return {
                truncationSuspected: true,
                reason: 'unclosed code fence',
                confidence: 'medium',
            };
        }
        // Check for trailing ellipsis
        if (/\.\.\.\s*$/.test(text)) {
            return {
                truncationSuspected: true,
                reason: 'trailing ellipsis',
                confidence: 'medium',
            };
        }
        // Unclosed delimiters in code context
        if (this.hasUnclosedDelimiters(text)) {
            return {
                truncationSuspected: true,
                reason: 'structurally incomplete (unclosed delimiters)',
                confidence: 'medium',
            };
        }
        return { truncationSuspected: false };
    }
    /**
     * Check if text has significantly more opening than closing delimiters.
     */
    hasUnclosedDelimiters(text) {
        for (const open of UNCLOSED_DELIMITERS) {
            if (open === '`') {
                // Check backtick pairs
                const count = (text.match(/`/g) || []).length;
                if (count % 2 !== 0)
                    return true;
                continue;
            }
            const close = OPENING_TO_CLOSING[open];
            const openCount = this.countChar(text, open);
            const closeCount = this.countChar(text, close);
            // Significant imbalance suggests truncation
            if (openCount > closeCount && (openCount - closeCount) >= 1) {
                return true;
            }
        }
        return false;
    }
    /**
     * Heuristic: does this text look like code or log output?
     */
    looksLikeCode(text) {
        const lines = text.split('\n');
        if (lines.length < 3)
            return false;
        let codeSignals = 0;
        for (const line of lines.slice(0, 30)) {
            // Indentation
            if (/^\s{2,}/.test(line))
                codeSignals++;
            // Common code patterns
            if (/[{}\[\]();]/.test(line))
                codeSignals++;
            // Log-like timestamps
            if (/\d{2}:\d{2}:\d{2}/.test(line))
                codeSignals++;
            // Stack trace patterns
            if (/^\s+at\s/.test(line) || /Error:|Exception:|Traceback/i.test(line))
                codeSignals++;
        }
        return codeSignals > lines.length * 0.3;
    }
    countChar(text, char) {
        let count = 0;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === char)
                count++;
        }
        return count;
    }
    /**
     * Clear nudge cooldowns (useful for testing).
     */
    clearCooldowns() {
        this.nudgedTopics.clear();
    }
}
//# sourceMappingURL=TruncationDetector.js.map