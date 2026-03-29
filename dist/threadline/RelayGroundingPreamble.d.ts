/**
 * RelayGroundingPreamble — Behavioral context injection for relay messages.
 *
 * Provides grounding context (not a security boundary) when an agent
 * processes messages from external agents via the Threadline relay.
 * The preamble primes the agent with identity awareness and boundary
 * guidelines to strengthen resistance to social engineering.
 *
 * Part of PROP-relay-auto-connect, Layer 4.
 */
import type { AgentTrustLevel } from './AgentTrustManager.js';
export interface RelayGroundingContext {
    /** Name of the receiving agent */
    agentName: string;
    /** Display name of the sender */
    senderName: string;
    /** Cryptographic fingerprint of the sender */
    senderFingerprint: string;
    /** Trust level of the sender */
    trustLevel: AgentTrustLevel;
    /** Who granted this trust level */
    trustSource?: string;
    /** When trust was granted */
    trustDate?: string;
    /** Original source fingerprint (for multi-hop provenance) */
    originFingerprint?: string;
    /** Original source name */
    originName?: string;
}
/**
 * Build the grounding preamble for a relay-sourced message.
 *
 * Dual-position: returns both a header and footer to resist
 * prompt injection "scroll-past" attacks.
 */
export declare function buildRelayGroundingPreamble(ctx: RelayGroundingContext): {
    header: string;
    footer: string;
    combined: string;
};
/** Trust-level-aware history depth limits for relay conversations */
export declare const RELAY_HISTORY_LIMITS: Record<AgentTrustLevel, number>;
/**
 * Tag a message as external for history injection.
 * Prepends [EXTERNAL] to messages from relay sources.
 */
export declare function tagExternalMessage(content: string, trustLevel: AgentTrustLevel): string;
//# sourceMappingURL=RelayGroundingPreamble.d.ts.map