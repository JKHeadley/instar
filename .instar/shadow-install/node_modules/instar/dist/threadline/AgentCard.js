/**
 * AgentCard — Generates, self-signs, and serves A2A Agent Cards.
 *
 * Implements the A2A (Agent-to-Agent) Agent Card specification:
 * - Generates Agent Card JSON for `/.well-known/agent-card.json`
 * - Self-signs with Ed25519 identity key via ThreadlineCrypto
 * - Signature covers canonical JSON (sorted keys, no whitespace)
 * - Skill descriptions sanitized against prompt injection
 * - Extended card with Threadline internals requires authentication
 *
 * Part of Threadline Protocol Phase 6A — Network Interop.
 */
import { verify } from './ThreadlineCrypto.js';
// ── Constants ────────────────────────────────────────────────────────
const A2A_CARD_VERSION = '1.0';
const DEFAULT_THREADLINE_VERSION = '0.6';
const DEFAULT_INPUT_MODES = ['text/plain'];
const DEFAULT_OUTPUT_MODES = ['text/plain'];
/**
 * Regex patterns for sanitization — strips markdown, HTML, and control characters
 * to prevent prompt injection through skill descriptions.
 */
const SANITIZE_PATTERNS = [
    // HTML tags
    { pattern: /<[^>]*>/g, replacement: '' },
    // Markdown links [text](url)
    { pattern: /\[([^\]]*)\]\([^)]*\)/g, replacement: '$1' },
    // Markdown images ![alt](url)
    { pattern: /!\[([^\]]*)\]\([^)]*\)/g, replacement: '$1' },
    // Markdown bold/italic
    { pattern: /[*_]{1,3}([^*_]+)[*_]{1,3}/g, replacement: '$1' },
    // Markdown code blocks
    { pattern: /```[\s\S]*?```/g, replacement: '' },
    // Markdown inline code
    { pattern: /`([^`]+)`/g, replacement: '$1' },
    // Markdown headers
    { pattern: /^#{1,6}\s+/gm, replacement: '' },
    // Markdown horizontal rules
    { pattern: /^[-*_]{3,}\s*$/gm, replacement: '' },
    // Control characters (except newline, tab)
    { pattern: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, replacement: '' },
    // Collapse multiple whitespace/newlines
    { pattern: /\s+/g, replacement: ' ' },
];
// ── AgentCard ────────────────────────────────────────────────────────
/**
 * Generates, self-signs, and serves A2A Agent Cards.
 *
 * The Agent Card is the discovery document that tells other agents
 * what this agent can do and how to interact with it. Self-signing
 * with the Ed25519 identity key proves the card was issued by the
 * agent that owns the corresponding private key.
 */
export class AgentCard {
    config;
    signFn;
    /**
     * @param config - Agent card configuration
     * @param signFn - Ed25519 signing function (typically bound to the agent's private key)
     */
    constructor(config, signFn) {
        this.config = config;
        this.signFn = signFn;
    }
    // ── Public API ───────────────────────────────────────────────────
    /**
     * Generate the full Agent Card, canonicalize it, and self-sign.
     * Returns the card object, hex signature, and the canonical JSON that was signed.
     */
    generate() {
        const card = this.buildFullCard();
        const canonicalJson = AgentCard.canonicalize(card);
        const signature = this.signFn(Buffer.from(canonicalJson, 'utf-8'));
        return {
            card,
            signature: signature.toString('hex'),
            canonicalJson,
        };
    }
    /**
     * Returns the public card — suitable for unauthenticated `/.well-known/agent-card.json`.
     * Excludes Threadline internal extensions.
     */
    getPublicCard() {
        const { agentName, description, url, version, capabilities, skills, provider } = this.config;
        const card = {
            name: agentName,
            description: AgentCard.sanitizeDescription(description),
            url,
            version: version ?? '0.0.0',
            cardVersion: A2A_CARD_VERSION,
            capabilities: this.buildCapabilities(capabilities),
            skills: this.buildSkills(skills),
        };
        if (provider) {
            card.provider = provider;
        }
        return card;
    }
    /**
     * Returns the extended card with Threadline internals.
     * Should only be served to authenticated agents.
     */
    getExtendedCard() {
        const publicCard = this.getPublicCard();
        return {
            ...publicCard,
            threadline: {
                version: this.config.threadlineVersion ?? DEFAULT_THREADLINE_VERSION,
                identityPublicKey: this.config.identityPublicKey.toString('hex'),
                capabilities: this.config.capabilities ?? [],
                supportsHandshake: true,
                supportsRelay: true,
            },
        };
    }
    // ── Static Methods ───────────────────────────────────────────────
    /**
     * Verify an Agent Card signature against its canonical JSON.
     *
     * @param cardJson - The canonical JSON string that was signed
     * @param signature - Hex-encoded Ed25519 signature
     * @param publicKey - Ed25519 public key (32 bytes raw)
     * @returns true if the signature is valid
     */
    static verify(cardJson, signature, publicKey) {
        try {
            const message = Buffer.from(cardJson, 'utf-8');
            const sig = Buffer.from(signature, 'hex');
            return verify(publicKey, message, sig);
        }
        catch {
            return false;
        }
    }
    /**
     * Sanitize a description string by stripping markdown, HTML, and control characters.
     * Prevents prompt injection through skill descriptions.
     *
     * @param text - Raw description text
     * @returns Sanitized plain text
     */
    static sanitizeDescription(text) {
        let sanitized = text;
        for (const { pattern, replacement } of SANITIZE_PATTERNS) {
            sanitized = sanitized.replace(pattern, replacement);
        }
        return sanitized.trim();
    }
    /**
     * Produce canonical JSON for signing: sorted keys, no whitespace.
     * This ensures signature stability regardless of property insertion order.
     */
    static canonicalize(obj) {
        return JSON.stringify(sortKeysDeep(obj));
    }
    // ── Private Helpers ──────────────────────────────────────────────
    /** Build the full card including Threadline extensions (used for signing). */
    buildFullCard() {
        return this.getExtendedCard();
    }
    /** Build the capabilities object from the A2A spec. */
    buildCapabilities(caps) {
        const result = {
            streaming: false,
            pushNotifications: false,
            stateTransitionHistory: false,
        };
        if (caps) {
            for (const cap of caps) {
                result[cap] = true;
            }
        }
        return result;
    }
    /** Build sanitized skill entries. */
    buildSkills(skills) {
        if (!skills || skills.length === 0) {
            return [];
        }
        return skills.map((skill) => ({
            id: skill.id,
            name: AgentCard.sanitizeDescription(skill.name),
            description: AgentCard.sanitizeDescription(skill.description),
            inputModes: skill.inputModes ?? DEFAULT_INPUT_MODES,
            outputModes: skill.outputModes ?? DEFAULT_OUTPUT_MODES,
        }));
    }
}
// ── Utilities ────────────────────────────────────────────────────────
/**
 * Recursively sort all object keys for canonical JSON serialization.
 * Arrays preserve element order; only object keys are sorted.
 */
function sortKeysDeep(value) {
    if (value === null || value === undefined) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (typeof value === 'object') {
        const sorted = {};
        const keys = Object.keys(value).sort();
        for (const key of keys) {
            sorted[key] = sortKeysDeep(value[key]);
        }
        return sorted;
    }
    return value;
}
//# sourceMappingURL=AgentCard.js.map