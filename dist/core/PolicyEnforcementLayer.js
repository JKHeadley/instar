/**
 * Policy Enforcement Layer (PEL) — Deterministic hard policy checks for
 * the response review pipeline.
 *
 * Runs BEFORE any LLM-based review. Cannot be overridden. All rules are
 * regex-based and complete in <5ms. Even in observeOnly mode, PEL violations
 * are enforced — they represent non-negotiable safety boundaries.
 *
 * Checks for:
 * - Credential / API key leakage
 * - PII patterns (email, phone, SSN)
 * - Agent auth token leakage
 * - Internal URL exposure on external channels
 * - File path exposure on external channels
 * - Environment variable patterns
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Credential Patterns ──────────────────────────────────────────────
/** Regex patterns for common API key / credential formats */
const CREDENTIAL_PATTERNS = [
    { name: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
    { name: 'GitHub personal access token', pattern: /\bghp_[A-Za-z0-9]{36,}\b/ },
    { name: 'GitHub OAuth token', pattern: /\bgho_[A-Za-z0-9]{36,}\b/ },
    { name: 'GitHub user-to-server token', pattern: /\bghu_[A-Za-z0-9]{36,}\b/ },
    { name: 'GitHub server-to-server token', pattern: /\bghs_[A-Za-z0-9]{36,}\b/ },
    { name: 'GitHub refresh token', pattern: /\bghr_[A-Za-z0-9]{36,}\b/ },
    { name: 'Slack bot token', pattern: /\bxoxb-[0-9]{10,}-[A-Za-z0-9-]+\b/ },
    { name: 'Slack user token', pattern: /\bxoxp-[0-9]{10,}-[A-Za-z0-9-]+\b/ },
    { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'Stripe secret key', pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
    { name: 'Stripe test key', pattern: /\bsk_test_[A-Za-z0-9]{24,}\b/ },
    { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
    { name: 'Generic bearer token', pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
    { name: 'Password assignment', pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}/i },
    { name: 'Private key block', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/ },
];
// ── PII Patterns ─────────────────────────────────────────────────────
const PII_PATTERNS = [
    { name: 'Email address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i },
    { name: 'US phone number', pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
    { name: 'SSN pattern', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
];
// ── Internal URL Patterns ────────────────────────────────────────────
const INTERNAL_URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)]*/i;
// ── File Path Patterns ───────────────────────────────────────────────
const SENSITIVE_PATH_PATTERNS = [
    /\/?\.instar\/[^\s)"]*/,
    /\/?\.claude\/[^\s)"]*/,
    /\/Users\/[^\s)"]*/,
    /\/home\/[^\s)"]*/,
];
// ── Environment Variable Patterns ────────────────────────────────────
const ENV_VAR_PATTERNS = [
    { name: '$AUTH variable', pattern: /\$AUTH\b/ },
    { name: '$API_KEY variable', pattern: /\$API_KEY\b/ },
    { name: '$SECRET variable', pattern: /\$(?:SECRET|TOKEN|PASSWORD)\b/i },
    { name: 'process.env reference', pattern: /process\.env\.[A-Z_]{2,}/ },
];
// ── Implementation ───────────────────────────────────────────────────
export class PolicyEnforcementLayer {
    stateDir;
    cachedAuthToken = null;
    configWatcher = null;
    configPath;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.configPath = path.join(stateDir, 'config.json');
        this.loadAuthToken();
        this.watchConfig();
    }
    /**
     * Enforce all policy rules against a message. Returns within 5ms.
     * No I/O during enforcement — all state is pre-cached.
     */
    enforce(message, context) {
        const violations = [];
        for (const rule of this.rules) {
            if (rule.externalOnly && !context.isExternalFacing) {
                continue;
            }
            const violation = rule.test(message, context, this.cachedAuthToken);
            if (violation) {
                violations.push(violation);
            }
        }
        const hasHardBlock = violations.some(v => v.severity === 'hard_block');
        const hasWarn = violations.some(v => v.severity === 'warn');
        return {
            pass: violations.length === 0,
            violations,
            outcome: hasHardBlock ? 'hard_block' : hasWarn ? 'warn' : 'pass',
        };
    }
    /**
     * Clean up resources (file watcher).
     */
    destroy() {
        if (this.configWatcher) {
            this.configWatcher.close();
            this.configWatcher = null;
        }
    }
    /**
     * Get the cached auth token (for testing).
     */
    getAuthToken() {
        return this.cachedAuthToken;
    }
    // ── Private ──────────────────────────────────────────────────────
    loadAuthToken() {
        try {
            if (fs.existsSync(this.configPath)) {
                const config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                this.cachedAuthToken = config.authToken || null;
            }
        }
        catch {
            this.cachedAuthToken = null;
        }
    }
    watchConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                this.configWatcher = fs.watch(this.configPath, () => {
                    this.loadAuthToken();
                });
                // Don't let the watcher keep the process alive
                this.configWatcher.unref();
            }
        }
        catch {
            // Silently ignore watch failures — token will be stale but enforcement still works
        }
    }
    /**
     * All rules as a flat array. Each rule is a pure function that tests
     * a message and returns a violation or null.
     */
    rules = [
        // ── Credential Patterns ──────────────────────────────────────
        ...CREDENTIAL_PATTERNS.map(({ name, pattern }) => ({
            name: 'credential-leak',
            severity: 'hard_block',
            externalOnly: false,
            test: (message) => {
                const match = message.match(pattern);
                if (match) {
                    return {
                        rule: 'credential-leak',
                        severity: 'hard_block',
                        detail: `Detected ${name} pattern in message`,
                        match: match[0],
                    };
                }
                return null;
            },
        })),
        // ── PII Detection ────────────────────────────────────────────
        ...PII_PATTERNS.map(({ name, pattern }) => ({
            name: 'pii-detection',
            severity: 'hard_block',
            externalOnly: true,
            test: (message) => {
                const match = message.match(pattern);
                if (match) {
                    return {
                        rule: 'pii-detection',
                        severity: 'hard_block',
                        detail: `Detected ${name} pattern in external-facing message`,
                        match: match[0],
                    };
                }
                return null;
            },
        })),
        // ── Auth Token Leakage ───────────────────────────────────────
        {
            name: 'auth-token-leak',
            severity: 'hard_block',
            externalOnly: false,
            test: (message, _context, authToken) => {
                if (authToken && authToken.length >= 8 && message.includes(authToken)) {
                    return {
                        rule: 'auth-token-leak',
                        severity: 'hard_block',
                        detail: 'Message contains the agent\'s own auth token',
                        match: authToken.substring(0, 4) + '...',
                    };
                }
                return null;
            },
        },
        // ── Internal URL Detection ───────────────────────────────────
        {
            name: 'internal-url-leak',
            severity: 'hard_block',
            externalOnly: true,
            test: (message) => {
                const match = message.match(INTERNAL_URL_PATTERN);
                if (match) {
                    return {
                        rule: 'internal-url-leak',
                        severity: 'hard_block',
                        detail: 'Internal URL detected in external-facing message',
                        match: match[0],
                    };
                }
                return null;
            },
        },
        // ── File Path Detection ──────────────────────────────────────
        ...SENSITIVE_PATH_PATTERNS.map((pattern, i) => ({
            name: 'file-path-leak',
            severity: 'warn',
            externalOnly: true,
            test: (message) => {
                const match = message.match(pattern);
                if (match) {
                    return {
                        rule: 'file-path-leak',
                        severity: 'warn',
                        detail: 'Sensitive file path detected in external-facing message',
                        match: match[0],
                    };
                }
                return null;
            },
        })),
        // ── Environment Variable Patterns ────────────────────────────
        ...ENV_VAR_PATTERNS.map(({ name, pattern }) => ({
            name: 'env-var-leak',
            severity: 'warn',
            externalOnly: false,
            test: (message) => {
                const match = message.match(pattern);
                if (match) {
                    return {
                        rule: 'env-var-leak',
                        severity: 'warn',
                        detail: `Environment variable reference detected: ${name}`,
                        match: match[0],
                    };
                }
                return null;
            },
        })),
    ];
}
//# sourceMappingURL=PolicyEnforcementLayer.js.map