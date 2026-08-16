/**
 * ContentClassifier — Optional outbound content filter for relay responses.
 *
 * Evaluates outbound messages before they're sent to detect sensitive data:
 *   - API keys, tokens, credentials
 *   - Database queries or internal data
 *   - System prompts or internal instructions
 *   - Personal user information
 *
 * Default: disabled. Operators enable via config for agents handling
 * sensitive data. Layer 4 (grounding preamble) is behavioral guidance;
 * Layer 5 (this) is the actual outbound enforcement.
 *
 * Part of PROP-relay-auto-connect, Layer 5.
 */
/**
 * Fast regex-based detection for common sensitive patterns.
 * This runs before (and sometimes instead of) the LLM classifier.
 */
const BUILTIN_PATTERNS = [
    // API keys and tokens
    { regex: /sk-[a-zA-Z0-9]{20,}/, label: 'API key (sk-* pattern)' },
    { regex: /sk-ant-api[a-zA-Z0-9-]{20,}/, label: 'Anthropic API key' },
    { regex: /ghp_[a-zA-Z0-9]{36,}/, label: 'GitHub personal access token' },
    { regex: /gho_[a-zA-Z0-9]{36,}/, label: 'GitHub OAuth token' },
    { regex: /xoxb-[0-9]{10,}-[a-zA-Z0-9-]+/, label: 'Slack bot token' },
    { regex: /xoxp-[0-9]{10,}-[a-zA-Z0-9-]+/, label: 'Slack user token' },
    { regex: /Bearer\s+[a-zA-Z0-9._\-]{20,}/, label: 'Bearer token' },
    { regex: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
    { regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, label: 'Private key' },
    // Database content
    { regex: /(?:postgres|mysql|mongodb|redis):\/\/[^\s]+:[^\s]+@/, label: 'Database connection string' },
    { regex: /SELECT\s+.+\s+FROM\s+\w+\s+WHERE/i, label: 'SQL query with data' },
    // Internal instructions
    { regex: /system\s*prompt\s*[:=]/i, label: 'System prompt reference' },
    { regex: /\[INTERNAL\].*(?:instruction|directive|config)/i, label: 'Internal instruction' },
    // PII patterns
    { regex: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/, label: 'Possible SSN' },
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b.*(?:password|passwd|pwd)/i, label: 'Email with password context' },
];
function detectPatterns(content, customPatterns) {
    const matches = [];
    for (const { regex, label } of BUILTIN_PATTERNS) {
        const match = content.match(regex);
        if (match) {
            matches.push({ label, match: match[0].slice(0, 30) + (match[0].length > 30 ? '...' : '') });
        }
    }
    if (customPatterns) {
        for (const { pattern, label } of customPatterns) {
            try {
                const regex = new RegExp(pattern);
                const match = content.match(regex);
                if (match) {
                    matches.push({ label, match: match[0].slice(0, 30) + (match[0].length > 30 ? '...' : '') });
                }
            }
            catch {
                // Invalid regex — skip
            }
        }
    }
    return matches;
}
// ── LLM Classification Prompt ────────────────────────────────────────
const LLM_CLASSIFIER_PROMPT = `You are a content safety classifier for an AI agent's outbound messages.

Evaluate whether the following message contains any sensitive information that should NOT be shared with an external agent:

1. API keys, tokens, secrets, or credentials
2. Database contents, queries, or connection strings
3. System prompts, internal instructions, or configuration details
4. Personal user information (emails with passwords, SSNs, financial data)
5. Proprietary business logic or trade secrets

Respond with EXACTLY one line in this format:
CLASSIFICATION: safe|sensitive|blocked
REASON: [brief reason if not safe]

"safe" = no sensitive content detected
"sensitive" = contains information that could be sensitive in context
"blocked" = contains clearly dangerous content (credentials, keys, PII)`;
function parseLLMResponse(response) {
    const classLine = response.match(/CLASSIFICATION:\s*(safe|sensitive|blocked)/i);
    const reasonLine = response.match(/REASON:\s*(.+)/i);
    if (!classLine) {
        // If LLM didn't follow format, default to safe (fail-open for availability)
        return { classification: 'safe' };
    }
    const classification = classLine[1].toLowerCase();
    return {
        classification,
        reason: reasonLine?.[1]?.trim(),
    };
}
// ── Implementation ───────────────────────────────────────────────────
export class ContentClassifier {
    config;
    // Metrics
    metrics = {
        classified: 0,
        safe: 0,
        sensitive: 0,
        blocked: 0,
        errors: 0,
        patternDetections: 0,
        llmClassifications: 0,
    };
    constructor(config) {
        this.config = config;
    }
    /**
     * Whether the classifier is active.
     */
    get enabled() {
        return this.config.enabled;
    }
    /**
     * Classify outbound content before sending.
     *
     * Two-stage pipeline:
     *   1. Fast regex pattern matching (catches obvious leaks)
     *   2. LLM classification (catches subtle leaks, if llmClassify is provided)
     *
     * If regex catches something definitive (API key, private key), we skip
     * the LLM call for speed and cost savings.
     */
    async classify(content, context) {
        if (!this.config.enabled) {
            return { classification: 'safe' };
        }
        this.metrics.classified++;
        try {
            // Stage 1: Fast pattern detection
            const patterns = detectPatterns(content, this.config.customPatterns);
            if (patterns.length > 0) {
                this.metrics.patternDetections++;
                // Definitive blocks: private keys, API keys, connection strings
                const definitiveLabels = ['Private key', 'Database connection string', 'AWS access key'];
                const isDefinitive = patterns.some(p => definitiveLabels.some(d => p.label.includes(d)));
                if (isDefinitive) {
                    this.metrics.blocked++;
                    return {
                        classification: 'blocked',
                        reason: `Pattern detected: ${patterns.map(p => p.label).join(', ')}`,
                    };
                }
                // Non-definitive patterns → sensitive
                const result = {
                    classification: this.config.blockSensitive ? 'blocked' : 'sensitive',
                    reason: `Potential sensitive content: ${patterns.map(p => p.label).join(', ')}`,
                };
                if (this.config.blockSensitive) {
                    this.metrics.blocked++;
                }
                else {
                    this.metrics.sensitive++;
                }
                return result;
            }
            // Stage 2: LLM classification (if available and no patterns found)
            if (this.config.llmClassify) {
                this.metrics.llmClassifications++;
                const llmResponse = await this.config.llmClassify(content, LLM_CLASSIFIER_PROMPT);
                const result = parseLLMResponse(llmResponse);
                // Apply blockSensitive policy
                if (result.classification === 'sensitive' && this.config.blockSensitive) {
                    result.classification = 'blocked';
                }
                this.metrics[result.classification]++;
                return result;
            }
            // No patterns, no LLM → safe
            this.metrics.safe++;
            return { classification: 'safe' };
        }
        catch (err) {
            this.metrics.errors++;
            // Fail-open: classification errors don't block messages
            // (availability > perfect security for a behavioral layer)
            return {
                classification: 'safe',
                reason: `Classification error (fail-open): ${err instanceof Error ? err.message : 'unknown'}`,
            };
        }
    }
    /**
     * Get classifier metrics for observability.
     */
    getMetrics() {
        return { ...this.metrics };
    }
}
/**
 * Create a disabled (no-op) classifier.
 * Used as default when content classification is not configured.
 */
export function createDisabledClassifier() {
    return new ContentClassifier({ enabled: false });
}
//# sourceMappingURL=ContentClassifier.js.map