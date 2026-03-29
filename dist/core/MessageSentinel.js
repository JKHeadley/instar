/**
 * Message Sentinel — Intelligent interrupt interpreter for agent sessions.
 *
 * Sits between user messages and the active session, classifying every
 * incoming message to detect emergency signals that need immediate action.
 *
 * Born from the OpenClaw email deletion incident (2026-02-25): The user
 * typed "STOP" repeatedly but the agent continued deleting emails because
 * messages queued in the session's input buffer. By the time the session
 * processed "stop," 200+ emails were gone.
 *
 * The Sentinel solves this by running in the server process (separate from
 * the session). It can kill or pause the session immediately — before the
 * message even enters the session's queue.
 *
 * Two classification layers:
 * 1. Fast-path — regex patterns for obvious signals (<5ms)
 * 2. LLM classification — haiku-tier for ambiguous messages (<500ms)
 *
 * Word count gate (2026-02-26 fix):
 * Regex patterns ONLY fire on short messages (≤ MAX_FAST_PATH_WORDS).
 * True emergency signals are short: "stop", "cancel", "please stop".
 * Longer messages like "Please stop warning me about memory" are
 * conversational and must go to the LLM or pass through to the session.
 * Slash commands (/stop, /pause) are exempt — always unambiguous.
 *
 * Design principle: The entity that evaluates whether to stop must be
 * separate from the entity performing the work.
 */
// ── Constants ───────────────────────────────────────────────────────
/**
 * Maximum word count for regex/exact-match fast-path classification.
 *
 * Messages longer than this are routed to LLM or passed through.
 * True emergency signals are short ("stop", "cancel everything", "please stop").
 * Conversational messages ("please stop warning me about memory") are NOT emergencies.
 *
 * Slash commands (/stop, /pause) are exempt — always unambiguous regardless of length.
 */
const MAX_FAST_PATH_WORDS = 4;
// ── Fast-Path Patterns ───────────────────────────────────────────────
/**
 * Exact-match patterns that bypass LLM classification.
 * These are unambiguous emergency signals.
 */
const FAST_STOP_EXACT = new Set([
    'stop',
    'stop!',
    'stop!!',
    'stop!!!',
    'abort',
    'abort!',
    'cancel',
    'cancel!',
    'kill',
    'kill it',
    'stop now',
    'stop immediately',
    'cancel everything',
    'abort everything',
    'stop right now',
    'cease',
    'halt',
    'quit',
    'terminate',
]);
/**
 * Slash command patterns — always fast-path.
 */
const SLASH_STOP = new Set([
    '/stop',
    '/kill',
    '/abort',
    '/cancel',
    '/terminate',
]);
const SLASH_PAUSE = new Set([
    '/pause',
    '/wait',
    '/hold',
]);
/**
 * Regex patterns for fast-path stop detection.
 * Tested before LLM classification.
 */
const FAST_STOP_PATTERNS = [
    /^stop\b/i, // "stop" at start of message
    /^don'?t do (that|this|anything)/i, // "don't do that/this/anything"
    /^no!?\s*stop/i, // "no stop", "no! stop"
    /^STOP/, // All caps STOP (without /i — caps matters)
    /^please stop/i, // "please stop"
    /^stop\s*(it|this|that|now)/i, // "stop it", "stop this", "stop now"
];
const FAST_PAUSE_EXACT = new Set([
    'wait',
    'wait!',
    'hold on',
    'hold on!',
    'pause',
    'one moment',
    'one sec',
    'hang on',
]);
const FAST_PAUSE_PATTERNS = [
    /^wait\b/i,
    /^hold on/i,
    /^pause\b/i,
    /^hang on/i,
    /^one (sec|moment|minute)/i,
    /^let me think/i,
];
// ── Sentinel Implementation ──────────────────────────────────────────
export class MessageSentinel {
    config;
    stats;
    customStopExact;
    customPauseExact;
    constructor(config = {}) {
        this.config = config;
        this.stats = {
            totalClassified: 0,
            byCategory: { 'emergency-stop': 0, 'pause': 0, 'redirect': 0, 'normal': 0 },
            byMethod: { 'fast-path': 0, 'llm': 0, 'default': 0 },
            avgLatencyMs: 0,
            emergencyStops: 0,
        };
        // Merge custom patterns
        this.customStopExact = new Set((config.customStopPatterns ?? []).map(p => p.toLowerCase().trim()));
        this.customPauseExact = new Set((config.customPausePatterns ?? []).map(p => p.toLowerCase().trim()));
    }
    /**
     * Classify an incoming user message.
     *
     * Returns the classification with recommended action.
     * The caller (TelegramAdapter/server) decides whether to execute the action.
     */
    async classify(message) {
        if (this.config.enabled === false) {
            return {
                category: 'normal',
                confidence: 1,
                method: 'default',
                latencyMs: 0,
                action: { type: 'pass-through' },
                reason: 'Sentinel disabled',
            };
        }
        const start = Date.now();
        // Layer 1: Fast-path classification
        const fastResult = this.fastClassify(message);
        if (fastResult) {
            const latency = Date.now() - start;
            this.recordStats(fastResult.category, 'fast-path', latency);
            return {
                ...fastResult,
                method: 'fast-path',
                latencyMs: latency,
            };
        }
        // Layer 2: LLM classification (if available and not fast-path-only)
        if (this.config.intelligence && !this.config.fastPathOnly) {
            const llmResult = await this.llmClassify(message);
            const latency = Date.now() - start;
            this.recordStats(llmResult.category, 'llm', latency);
            return {
                ...llmResult,
                method: 'llm',
                latencyMs: latency,
            };
        }
        // Default: pass through
        const latency = Date.now() - start;
        this.recordStats('normal', 'default', latency);
        return {
            category: 'normal',
            confidence: 0.5,
            method: 'default',
            latencyMs: latency,
            action: { type: 'pass-through' },
            reason: 'No fast-path match, no LLM available',
        };
    }
    /**
     * Fast-path classification using pattern matching.
     * Returns null if no pattern matches (falls through to LLM).
     *
     * Word count gate: Messages longer than MAX_FAST_PATH_WORDS skip
     * exact matches and regex patterns. Only slash commands are exempt.
     * This prevents conversational messages like "please stop warning me
     * about memory" from being misclassified as emergency stops.
     */
    fastClassify(message) {
        const trimmed = message.trim();
        const lower = trimmed.toLowerCase();
        // Slash commands — highest priority, unambiguous, exempt from word count gate
        if (SLASH_STOP.has(lower)) {
            return {
                category: 'emergency-stop',
                confidence: 1.0,
                action: { type: 'kill-session' },
                reason: `Slash command: ${lower}`,
            };
        }
        if (SLASH_PAUSE.has(lower)) {
            return {
                category: 'pause',
                confidence: 1.0,
                action: { type: 'pause-session' },
                reason: `Slash command: ${lower}`,
            };
        }
        // Word count gate: longer messages are conversational, not emergency signals.
        // Route them to LLM classification or pass-through instead.
        const wordCount = trimmed.split(/\s+/).length;
        if (wordCount > MAX_FAST_PATH_WORDS) {
            return null;
        }
        // Exact match — emergency stop
        if (FAST_STOP_EXACT.has(lower) || this.customStopExact.has(lower)) {
            return {
                category: 'emergency-stop',
                confidence: 0.95,
                action: { type: 'kill-session' },
                reason: `Exact match: "${lower}"`,
            };
        }
        // Exact match — pause
        if (FAST_PAUSE_EXACT.has(lower) || this.customPauseExact.has(lower)) {
            return {
                category: 'pause',
                confidence: 0.95,
                action: { type: 'pause-session' },
                reason: `Exact match: "${lower}"`,
            };
        }
        // Regex patterns — emergency stop
        for (const pattern of FAST_STOP_PATTERNS) {
            if (pattern.test(trimmed)) {
                return {
                    category: 'emergency-stop',
                    confidence: 0.85,
                    action: { type: 'kill-session' },
                    reason: `Pattern match: ${pattern}`,
                };
            }
        }
        // Regex patterns — pause
        for (const pattern of FAST_PAUSE_PATTERNS) {
            if (pattern.test(trimmed)) {
                return {
                    category: 'pause',
                    confidence: 0.85,
                    action: { type: 'pause-session' },
                    reason: `Pattern match: ${pattern}`,
                };
            }
        }
        // All caps message (short) — likely an emergency
        if (trimmed === trimmed.toUpperCase() && trimmed.length > 2 && trimmed.length < 50 && /[A-Z]/.test(trimmed)) {
            // Only if it contains stop-like words
            if (/\b(STOP|NO|DON'?T|CANCEL|ABORT|HALT|QUIT)\b/.test(trimmed)) {
                return {
                    category: 'emergency-stop',
                    confidence: 0.8,
                    action: { type: 'kill-session' },
                    reason: `All-caps stop signal: "${trimmed}"`,
                };
            }
        }
        // No fast-path match
        return null;
    }
    /**
     * LLM-based classification for ambiguous messages.
     */
    async llmClassify(message) {
        if (!this.config.intelligence) {
            return {
                category: 'normal',
                confidence: 0.5,
                action: { type: 'pass-through' },
                reason: 'No intelligence provider',
            };
        }
        const prompt = [
            'You are a message classifier for an AI agent system.',
            'Classify the following user message into exactly one category:',
            '',
            '- emergency-stop: User wants the agent to stop immediately (examples: "don\'t do that", "I changed my mind stop", "NO NO NO", "cancel what you\'re doing")',
            '- pause: User DIRECTLY INSTRUCTS the agent to pause and wait (examples: "wait for me", "pause please", "not yet hold off", "stop and wait for my signal")',
            '- redirect: User wants to change the agent\'s course (examples: "actually do X instead", "no I meant Y", "forget that, do this")',
            '- normal: Regular conversation that doesn\'t require interruption (examples: "hold on let me think", "wait a second I\'m reading", "one moment let me check something")',
            '',
            'KEY DISTINCTION: Phrases like "hold on", "wait", "one moment" are NORMAL unless the user is clearly directing the agent.',
            'A user narrating their own thought process ("hold on let me think") is NORMAL, not a directive to the agent.',
            '',
            'IMPORTANT: When in doubt between emergency-stop and normal, prefer emergency-stop.',
            'It is much safer to stop unnecessarily than to continue destructively.',
            '',
            `Message: "${message}"`,
            '',
            'Respond with exactly one word: emergency-stop, pause, redirect, or normal.',
        ].join('\n');
        try {
            const response = await this.config.intelligence.evaluate(prompt, {
                maxTokens: 10,
                temperature: 0,
            });
            const parsed = this.extractCategory(response);
            if (!parsed) {
                console.warn(`[sentinel] LLM returned unparseable response: "${response.trim().slice(0, 200)}"`);
                return {
                    category: 'normal',
                    confidence: 0.2,
                    action: { type: 'pass-through' },
                    reason: `LLM response unparseable (passed through)`,
                };
            }
            return {
                category: parsed.category,
                confidence: parsed.exact ? 0.8 : 0.6,
                action: this.categoryToAction(parsed.category, message),
                reason: `LLM classification: ${parsed.category}${parsed.exact ? '' : ' (extracted)'}`,
            };
        }
        catch {
            // LLM failure → pass through (don't block on evaluation errors)
            return {
                category: 'normal',
                confidence: 0.3,
                action: { type: 'pass-through' },
                reason: 'LLM classification failed, defaulting to pass-through',
            };
        }
    }
    /**
     * Extract a valid category from an LLM response.
     *
     * Handles three cases:
     * 1. Exact match: response is just the category word (ideal)
     * 2. Extracted: response contains the category word in a sentence
     *    (e.g., "I would classify this as normal")
     * 3. null: no valid category found in the response
     *
     * Priority order when multiple categories appear: emergency-stop > pause > redirect > normal.
     * This ensures that if the LLM says "this is normal, not emergency-stop", the higher-priority
     * category wins — erring toward caution.
     */
    extractCategory(response) {
        const trimmed = response.trim().toLowerCase();
        const validCategories = ['emergency-stop', 'pause', 'redirect', 'normal'];
        // Exact match — ideal case
        if (validCategories.includes(trimmed)) {
            return { category: trimmed, exact: true };
        }
        // If the response is longer than ~100 chars, it's a conversational response
        // from a context-contaminated LLM — don't try to extract from it
        if (trimmed.length > 100) {
            return null;
        }
        // Try to extract: check for category words as whole words in the response.
        // Check in priority order (most disruptive first).
        const priorityOrder = ['emergency-stop', 'pause', 'redirect', 'normal'];
        for (const cat of priorityOrder) {
            const pattern = new RegExp(`\\b${cat.replace('-', '[-\\s]')}\\b`, 'i');
            if (pattern.test(trimmed)) {
                return { category: cat, exact: false };
            }
        }
        return null;
    }
    /**
     * Map a category to its recommended action.
     */
    categoryToAction(category, message) {
        switch (category) {
            case 'emergency-stop':
                return { type: 'kill-session' };
            case 'pause':
                return { type: 'pause-session' };
            case 'redirect':
                return { type: 'priority-inject', message };
            case 'normal':
                return { type: 'pass-through' };
        }
    }
    /**
     * Record classification stats.
     */
    recordStats(category, method, latencyMs) {
        this.stats.totalClassified++;
        this.stats.byCategory[category]++;
        this.stats.byMethod[method] = (this.stats.byMethod[method] ?? 0) + 1;
        if (category === 'emergency-stop') {
            this.stats.emergencyStops++;
        }
        // Running average
        const n = this.stats.totalClassified;
        this.stats.avgLatencyMs = ((this.stats.avgLatencyMs * (n - 1)) + latencyMs) / n;
    }
    /**
     * Get current stats.
     */
    getStats() {
        return { ...this.stats };
    }
    /**
     * Reset stats.
     */
    resetStats() {
        this.stats = {
            totalClassified: 0,
            byCategory: { 'emergency-stop': 0, 'pause': 0, 'redirect': 0, 'normal': 0 },
            byMethod: { 'fast-path': 0, 'llm': 0, 'default': 0 },
            avgLatencyMs: 0,
            emergencyStops: 0,
        };
    }
    /**
     * Check if the sentinel is enabled.
     */
    isEnabled() {
        return this.config.enabled !== false;
    }
}
//# sourceMappingURL=MessageSentinel.js.map