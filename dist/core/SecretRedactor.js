/**
 * SecretRedactor — Redact secrets from content before LLM exposure.
 *
 * Two-layer detection:
 *   1. Pattern matching — known secret formats (API keys, connection strings, etc.)
 *   2. Entropy scanning — high-entropy strings that may be non-standard secrets
 *
 * Replacement is indexed for provenance-aware restoration after LLM resolution.
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.3 (Secret Redaction).
 */
import crypto from 'node:crypto';
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_ENTROPY_THRESHOLD = 4.5;
const DEFAULT_ENTROPY_MIN_LENGTH = 20;
const DEFAULT_MAX_ENTROPY_BEFORE_EXCLUSION = 5;
/**
 * Built-in secret patterns — Layer 1 detection.
 */
const BUILTIN_PATTERNS = [
    // API keys
    { type: 'api-key', pattern: /\bsk-[a-zA-Z0-9_-]{20,}\b/g },
    { type: 'api-key', pattern: /\bsk-ant-api[a-zA-Z0-9_-]{20,}\b/g },
    { type: 'api-key', pattern: /\bxoxb-[a-zA-Z0-9-]+\b/g },
    { type: 'api-key', pattern: /\bxoxp-[a-zA-Z0-9-]+\b/g },
    { type: 'api-key', pattern: /\bghp_[a-zA-Z0-9]{36,}\b/g },
    { type: 'api-key', pattern: /\bghs_[a-zA-Z0-9]{36,}\b/g },
    { type: 'api-key', pattern: /\bgho_[a-zA-Z0-9]{36,}\b/g },
    { type: 'api-key', pattern: /\bAKIA[A-Z0-9]{16}\b/g },
    { type: 'api-key', pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/g },
    { type: 'api-key', pattern: /\bnpm_[a-zA-Z0-9]{36,}\b/g },
    { type: 'api-key', pattern: /\bglpat-[a-zA-Z0-9_-]{20,}\b/g },
    // Connection strings
    { type: 'connection-string', pattern: /\bpostgres(?:ql)?:\/\/[^\s"'`]+/g },
    { type: 'connection-string', pattern: /\bmongodb(?:\+srv)?:\/\/[^\s"'`]+/g },
    { type: 'connection-string', pattern: /\bredis:\/\/[^\s"'`]+/g },
    { type: 'connection-string', pattern: /\bmysql:\/\/[^\s"'`]+/g },
    // Private keys (multiline — match the BEGIN marker)
    { type: 'private-key', pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g },
    // JWT tokens (three base64url segments)
    { type: 'jwt', pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g },
    // Environment variable references with values
    { type: 'env-ref', pattern: /(?:export\s+)?[A-Z_]{2,}(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)=["']?[^\s"']+["']?/g },
];
/**
 * File patterns excluded from LLM resolution entirely.
 */
const DEFAULT_EXCLUDED_PATTERNS = [
    /^\.env/,
    /\.env$/,
    /\.env\..+/,
    /credentials/i,
    /secrets/i,
    /\.pem$/,
    /\.key$/,
    /\.p12$/,
    /\.pfx$/,
    /\.instar\/config\.json$/,
];
// ── SecretRedactor ───────────────────────────────────────────────────
export class SecretRedactor {
    patterns;
    entropyThreshold;
    entropyMinLength;
    maxEntropyStrings;
    excludePatterns;
    constructor(config) {
        this.patterns = [
            ...BUILTIN_PATTERNS,
            ...(config?.customPatterns ?? []),
        ];
        this.entropyThreshold = config?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;
        this.entropyMinLength = config?.entropyMinLength ?? DEFAULT_ENTROPY_MIN_LENGTH;
        this.maxEntropyStrings = config?.maxEntropyStringsBeforeExclusion ?? DEFAULT_MAX_ENTROPY_BEFORE_EXCLUSION;
        this.excludePatterns = [
            ...DEFAULT_EXCLUDED_PATTERNS,
            ...(config?.excludePatterns?.map(p => new RegExp(p)) ?? []),
        ];
    }
    // ── File Exclusion Check ──────────────────────────────────────────
    /**
     * Check whether a file should be excluded from LLM resolution entirely.
     */
    shouldExcludeFile(filePath, content) {
        // Check file path patterns
        for (const pattern of this.excludePatterns) {
            if (pattern.test(filePath)) {
                return { excluded: true, reason: `File path matches exclusion pattern: ${pattern}` };
            }
        }
        // Check entropy density if content provided
        if (content) {
            const entropyStrings = this.findHighEntropyStrings(content);
            if (entropyStrings.length > this.maxEntropyStrings) {
                return {
                    excluded: true,
                    reason: `File contains ${entropyStrings.length} high-entropy strings (threshold: ${this.maxEntropyStrings}). Likely a credentials file.`,
                };
            }
        }
        return { excluded: false };
    }
    // ── Redaction ─────────────────────────────────────────────────────
    /**
     * Redact secrets from content.
     * Returns the redacted content and a map for later restoration.
     */
    redact(content, fileSection = 'unknown') {
        const redactions = [];
        let redactedContent = content;
        let index = 0;
        // Layer 1: Pattern matching
        for (const { type, pattern } of this.patterns) {
            // Reset the regex (global flag means lastIndex persists)
            const regex = new RegExp(pattern.source, pattern.flags);
            let match;
            while ((match = regex.exec(content)) !== null) {
                const value = match[0];
                const placeholder = `[REDACTED:${type}:${index}]`;
                // Check not already inside a redaction placeholder
                if (!this.isInsideRedaction(match.index, redactions)) {
                    redactions.push({
                        index,
                        type,
                        originalValue: value,
                        fileSection,
                        startOffset: match.index,
                        endOffset: match.index + value.length,
                    });
                    index++;
                }
            }
        }
        // Layer 2: Entropy scanning
        const entropyMatches = this.findHighEntropyStrings(content);
        for (const { value, start, end } of entropyMatches) {
            // Skip if already caught by pattern matching
            if (!this.isInsideRedaction(start, redactions)) {
                redactions.push({
                    index,
                    type: 'high-entropy',
                    originalValue: value,
                    fileSection,
                    startOffset: start,
                    endOffset: end,
                });
                index++;
            }
        }
        // Sort redactions by offset (descending) so we can replace from end to start
        const sorted = [...redactions].sort((a, b) => b.startOffset - a.startOffset);
        for (const entry of sorted) {
            const placeholder = `[REDACTED:${entry.type}:${entry.index}]`;
            redactedContent =
                redactedContent.slice(0, entry.startOffset) +
                    placeholder +
                    redactedContent.slice(entry.endOffset);
        }
        // Build type counts
        const typeCounts = {};
        for (const entry of redactions) {
            typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1;
        }
        return {
            content: redactedContent,
            redactions,
            count: redactions.length,
            typeCounts,
        };
    }
    // ── Restoration ───────────────────────────────────────────────────
    /**
     * Restore redacted secrets in LLM output.
     *
     * Provenance-aware: only restores a secret to a region matching its
     * original file section. If a placeholder appears in a mismatched
     * region, it is NOT restored and flagged for human review.
     */
    restore(content, redactions, currentSection) {
        let restoredContent = content;
        let restored = 0;
        let blocked = 0;
        const blockedEntries = [];
        // Build lookup map
        const redactionMap = new Map();
        for (const entry of redactions) {
            redactionMap.set(entry.index, entry);
        }
        // Find all placeholders in the content
        const placeholderRegex = /\[REDACTED:([a-z-]+):(\d+)\]/g;
        let match;
        const replacements = [];
        while ((match = placeholderRegex.exec(content)) !== null) {
            const idx = parseInt(match[2], 10);
            const entry = redactionMap.get(idx);
            if (!entry) {
                // Unknown redaction — leave placeholder
                continue;
            }
            // Provenance check: if currentSection is specified, verify match
            if (currentSection && entry.fileSection !== 'unknown' && entry.fileSection !== currentSection) {
                blocked++;
                blockedEntries.push({
                    index: idx,
                    reason: `Secret from "${entry.fileSection}" section found in "${currentSection}" section — provenance mismatch`,
                });
                continue;
            }
            replacements.push({
                start: match.index,
                end: match.index + match[0].length,
                value: entry.originalValue,
                index: idx,
            });
            restored++;
        }
        // Apply replacements from end to start
        const sortedReplacements = replacements.sort((a, b) => b.start - a.start);
        for (const rep of sortedReplacements) {
            restoredContent =
                restoredContent.slice(0, rep.start) +
                    rep.value +
                    restoredContent.slice(rep.end);
        }
        return { content: restoredContent, restored, blocked, blockedEntries };
    }
    // ── Entropy Analysis ──────────────────────────────────────────────
    /**
     * Calculate Shannon entropy of a string (bits per character).
     */
    shannonEntropy(str) {
        if (str.length === 0)
            return 0;
        const freq = new Map();
        for (const ch of str) {
            freq.set(ch, (freq.get(ch) ?? 0) + 1);
        }
        let entropy = 0;
        const len = str.length;
        for (const count of freq.values()) {
            const p = count / len;
            entropy -= p * Math.log2(p);
        }
        return entropy;
    }
    // ── Private Helpers ───────────────────────────────────────────────
    /**
     * Find high-entropy strings in content (Layer 2).
     */
    findHighEntropyStrings(content) {
        const results = [];
        // Match contiguous non-whitespace strings of sufficient length
        const tokenRegex = /\S{20,}/g;
        let match;
        while ((match = tokenRegex.exec(content)) !== null) {
            const token = match[0];
            // Skip if it looks like a URL, path, or common code pattern
            if (this.isLikelyNonSecret(token))
                continue;
            const entropy = this.shannonEntropy(token);
            if (entropy > this.entropyThreshold) {
                results.push({
                    value: token,
                    start: match.index,
                    end: match.index + token.length,
                    entropy,
                });
            }
        }
        return results;
    }
    /**
     * Check if a high-entropy string is likely NOT a secret
     * (URLs, file paths, common code constructs).
     */
    isLikelyNonSecret(str) {
        // URLs
        if (/^https?:\/\//i.test(str))
            return true;
        // File paths
        if (/^[.\/]/.test(str) && str.includes('/'))
            return true;
        // Import paths
        if (/^@?[a-z][a-z0-9-]*\//.test(str))
            return true;
        // Hex color codes
        if (/^#[0-9a-fA-F]{6,8}$/.test(str))
            return true;
        // Common code identifiers (camelCase, snake_case)
        if (/^[a-z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)*$/.test(str) && str.length < 40)
            return true;
        return false;
    }
    /**
     * Check if a position falls inside an already-detected redaction range.
     */
    isInsideRedaction(position, existing) {
        return existing.some(e => position >= e.startOffset && position < e.endOffset);
    }
    // ── Utility: Content Hash ─────────────────────────────────────────
    /**
     * Hash content for audit trail (does NOT contain secrets).
     * Uses SHA-256 truncated to 16 hex chars.
     */
    static hashContent(content) {
        return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
}
//# sourceMappingURL=SecretRedactor.js.map