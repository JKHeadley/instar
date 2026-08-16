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
export interface AgentCardConfig {
    /** Display name for this agent */
    agentName: string;
    /** Human-readable description of the agent */
    description: string;
    /** Public URL where this agent is reachable (e.g. tunnel URL) */
    url: string;
    /** Semantic version of the agent */
    version?: string;
    /** Capabilities this agent advertises (e.g. 'streaming', 'pushNotifications') */
    capabilities?: string[];
    /** Skills this agent exposes */
    skills?: AgentCardSkill[];
    /** Organization providing this agent */
    provider?: {
        organization: string;
        url: string;
    };
    /** Threadline protocol version */
    threadlineVersion?: string;
    /** Ed25519 public key (32 bytes raw) */
    identityPublicKey: Buffer;
}
export interface AgentCardSkill {
    /** Unique identifier for the skill */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of what the skill does */
    description: string;
    /** Supported input MIME types */
    inputModes?: string[];
    /** Supported output MIME types */
    outputModes?: string[];
}
export interface GeneratedAgentCard {
    /** The full Agent Card JSON object */
    card: Record<string, unknown>;
    /** Hex-encoded Ed25519 signature over canonicalJson */
    signature: string;
    /** The canonical JSON that was signed (sorted keys, no whitespace) */
    canonicalJson: string;
}
/**
 * Generates, self-signs, and serves A2A Agent Cards.
 *
 * The Agent Card is the discovery document that tells other agents
 * what this agent can do and how to interact with it. Self-signing
 * with the Ed25519 identity key proves the card was issued by the
 * agent that owns the corresponding private key.
 */
export declare class AgentCard {
    private readonly config;
    private readonly signFn;
    /**
     * @param config - Agent card configuration
     * @param signFn - Ed25519 signing function (typically bound to the agent's private key)
     */
    constructor(config: AgentCardConfig, signFn: (message: Buffer) => Buffer);
    /**
     * Generate the full Agent Card, canonicalize it, and self-sign.
     * Returns the card object, hex signature, and the canonical JSON that was signed.
     */
    generate(): GeneratedAgentCard;
    /**
     * Returns the public card — suitable for unauthenticated `/.well-known/agent-card.json`.
     * Excludes Threadline internal extensions.
     */
    getPublicCard(): Record<string, unknown>;
    /**
     * Returns the extended card with Threadline internals.
     * Should only be served to authenticated agents.
     */
    getExtendedCard(): Record<string, unknown>;
    /**
     * Verify an Agent Card signature against its canonical JSON.
     *
     * @param cardJson - The canonical JSON string that was signed
     * @param signature - Hex-encoded Ed25519 signature
     * @param publicKey - Ed25519 public key (32 bytes raw)
     * @returns true if the signature is valid
     */
    static verify(cardJson: string, signature: string, publicKey: Buffer): boolean;
    /**
     * Sanitize a description string by stripping markdown, HTML, and control characters.
     * Prevents prompt injection through skill descriptions.
     *
     * @param text - Raw description text
     * @returns Sanitized plain text
     */
    static sanitizeDescription(text: string): string;
    /**
     * Produce canonical JSON for signing: sorted keys, no whitespace.
     * This ensures signature stability regardless of property insertion order.
     */
    static canonicalize(obj: Record<string, unknown>): string;
    /** Build the full card including Threadline extensions (used for signing). */
    private buildFullCard;
    /** Build the capabilities object from the A2A spec. */
    private buildCapabilities;
    /** Build sanitized skill entries. */
    private buildSkills;
}
//# sourceMappingURL=AgentCard.d.ts.map