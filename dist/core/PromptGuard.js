/**
 * PromptGuard — Prompt injection defense for LLM conflict resolution.
 *
 * Mitigations:
 *   1. System prompt boundary enforcement (clear delimiters)
 *   2. Content filtering (blocks known injection patterns)
 *   3. Output validation (structured JSON expected → reject freeform)
 *   4. Deterministic fallback (if output is suspect, fall back to Tier 0)
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.1.1 (Prompt Injection Defenses).
 */
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_BOUNDARY = {
    systemStart: '<<<SYSTEM_INSTRUCTIONS>>>',
    systemEnd: '<<<END_SYSTEM_INSTRUCTIONS>>>',
    contentStart: '<<<MERGE_CONTENT>>>',
    contentEnd: '<<<END_MERGE_CONTENT>>>',
};
const DEFAULT_MAX_OUTPUT_LENGTH = 10_000;
/**
 * Known prompt injection patterns.
 * These detect attempts to override system instructions from within
 * merge content (file diffs, commit messages, etc.).
 */
const BUILTIN_PATTERNS = [
    // Direct instruction override attempts
    {
        name: 'system-override',
        pattern: /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|above|prior|system)\s+(?:instructions?|prompts?|rules?)/gi,
        severity: 'high',
    },
    {
        name: 'role-hijack',
        pattern: /you\s+are\s+(?:now|actually)\s+(?:a|an)\s+/gi,
        severity: 'high',
    },
    {
        name: 'new-instructions',
        pattern: /(?:new|updated|revised)\s+(?:system\s+)?instructions?:\s*/gi,
        severity: 'high',
    },
    {
        name: 'admin-override',
        pattern: /(?:admin|root|sudo|superuser)\s+(?:override|access|mode)/gi,
        severity: 'medium',
    },
    // Data exfiltration attempts
    {
        name: 'data-exfil',
        pattern: /(?:output|print|return|send|leak|exfiltrate)\s+(?:all\s+)?(?:the\s+)?(?:system\s+)?(?:prompt|instructions?|secrets?|keys?|tokens?)/gi,
        severity: 'high',
    },
    {
        name: 'base64-exfil',
        pattern: /(?:encode|convert)\s+(?:to\s+)?base64/gi,
        severity: 'low',
    },
    // Delimiter manipulation
    {
        name: 'delimiter-inject',
        pattern: /<<<(?:SYSTEM|END_SYSTEM|MERGE|END_MERGE)/gi,
        severity: 'high',
    },
    {
        name: 'xml-tag-inject',
        pattern: /<\/?(?:system|instructions?|prompt|admin|root|override)>/gi,
        severity: 'medium',
    },
    // Control flow manipulation
    {
        name: 'completion-hijack',
        pattern: /(?:instead|rather)\s+(?:of\s+)?(?:merging|resolving|the\s+conflict)/gi,
        severity: 'medium',
    },
    {
        name: 'tool-call-inject',
        pattern: /(?:call|execute|run|invoke)\s+(?:the\s+)?(?:function|tool|command|script)/gi,
        severity: 'medium',
    },
    // Jailbreak patterns
    {
        name: 'dan-pattern',
        pattern: /\bDAN\b.*\bDo\s+Anything\s+Now\b/gi,
        severity: 'high',
    },
    {
        name: 'developer-mode',
        pattern: /(?:developer|debug|test|maintenance)\s+mode\s+(?:enabled|activated|on)/gi,
        severity: 'medium',
    },
];
const THREAT_ORDER = ['none', 'low', 'medium', 'high'];
// ── PromptGuard ──────────────────────────────────────────────────────
export class PromptGuard {
    patterns;
    boundary;
    blockThreshold;
    maxOutputLength;
    validateOutputStructure;
    constructor(config) {
        this.patterns = [
            ...BUILTIN_PATTERNS,
            ...(config?.customPatterns ?? []),
        ];
        this.boundary = { ...DEFAULT_BOUNDARY, ...config?.boundary };
        this.blockThreshold = config?.blockThreshold ?? 'high';
        this.maxOutputLength = config?.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH;
        this.validateOutputStructure = config?.validateOutputStructure ?? true;
    }
    // ── Input Scanning ────────────────────────────────────────────────
    /**
     * Scan content for prompt injection attempts.
     * Run this on file content before including it in an LLM prompt.
     */
    scanContent(content) {
        const matches = [];
        for (const { name, pattern, severity } of this.patterns) {
            const regex = new RegExp(pattern.source, pattern.flags);
            let match;
            while ((match = regex.exec(content)) !== null) {
                matches.push({
                    patternName: name,
                    offset: match.index,
                    matchedText: match[0].slice(0, 100), // Truncate for safety
                    severity,
                });
            }
        }
        const threatLevel = this.computeThreatLevel(matches);
        const shouldBlock = THREAT_ORDER.indexOf(threatLevel) >= THREAT_ORDER.indexOf(this.blockThreshold);
        return {
            detected: matches.length > 0,
            threatLevel,
            matches,
            shouldBlock,
        };
    }
    // ── Prompt Wrapping ───────────────────────────────────────────────
    /**
     * Wrap system instructions and content with clear boundary markers.
     * This makes it harder for injected content to escape the content zone.
     */
    wrapPrompt(opts) {
        return [
            this.boundary.systemStart,
            opts.systemInstructions,
            '',
            opts.responseFormat
                ? `RESPONSE FORMAT: ${opts.responseFormat}`
                : 'RESPONSE FORMAT: Return ONLY a valid JSON object. No explanations, no markdown.',
            this.boundary.systemEnd,
            '',
            this.boundary.contentStart,
            opts.mergeContent,
            this.boundary.contentEnd,
        ].join('\n');
    }
    // ── Output Validation ─────────────────────────────────────────────
    /**
     * Validate LLM output for signs of injection success.
     *
     * Checks:
     * 1. Output length (unexpectedly long → suspicious)
     * 2. JSON structure (if structured output expected)
     * 3. Instruction leakage (system prompt repeated in output)
     * 4. Unexpected content patterns
     */
    validateOutput(output, opts) {
        // Check 1: Output length
        if (output.length > this.maxOutputLength) {
            return {
                valid: false,
                reason: `Output length (${output.length}) exceeds maximum (${this.maxOutputLength})`,
                fallbackRecommended: true,
            };
        }
        // Check 2: JSON structure validation
        if (this.validateOutputStructure && opts?.expectJson) {
            const trimmed = output.trim();
            // Allow JSON wrapped in markdown code blocks
            const jsonContent = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
            try {
                JSON.parse(jsonContent);
            }
            catch {
                return {
                    valid: false,
                    reason: 'Expected JSON output but received non-JSON content',
                    fallbackRecommended: true,
                };
            }
        }
        // Check 3: System prompt leakage
        if (opts?.systemPromptFragments) {
            for (const fragment of opts.systemPromptFragments) {
                if (fragment.length > 10 && output.includes(fragment)) {
                    return {
                        valid: false,
                        reason: `System prompt fragment leaked in output: "${fragment.slice(0, 30)}..."`,
                        fallbackRecommended: true,
                    };
                }
            }
        }
        // Check 4: Boundary markers in output (should never appear)
        if (output.includes(this.boundary.systemStart) ||
            output.includes(this.boundary.systemEnd) ||
            output.includes(this.boundary.contentStart) ||
            output.includes(this.boundary.contentEnd)) {
            return {
                valid: false,
                reason: 'Boundary markers detected in output — possible prompt manipulation',
                fallbackRecommended: true,
            };
        }
        return { valid: true, fallbackRecommended: false };
    }
    // ── Sanitization ──────────────────────────────────────────────────
    /**
     * Sanitize content before including in a prompt.
     * Escapes delimiter patterns and neutralizes common injection vectors.
     */
    sanitizeContent(content) {
        let sanitized = content;
        // Escape boundary markers
        sanitized = sanitized
            .replace(/<<</g, '‹‹‹')
            .replace(/>>>/g, '›››');
        return sanitized;
    }
    // ── Access ────────────────────────────────────────────────────────
    /**
     * Get the configured prompt boundary markers.
     */
    getBoundary() {
        return { ...this.boundary };
    }
    // ── Private Helpers ───────────────────────────────────────────────
    /**
     * Compute overall threat level from matches.
     */
    computeThreatLevel(matches) {
        if (matches.length === 0)
            return 'none';
        let maxLevel = 'none';
        for (const match of matches) {
            if (THREAT_ORDER.indexOf(match.severity) > THREAT_ORDER.indexOf(maxLevel)) {
                maxLevel = match.severity;
            }
        }
        // Multiple medium-severity matches escalate to high
        const mediumCount = matches.filter(m => m.severity === 'medium').length;
        if (mediumCount >= 3 && maxLevel === 'medium') {
            maxLevel = 'high';
        }
        return maxLevel;
    }
}
//# sourceMappingURL=PromptGuard.js.map