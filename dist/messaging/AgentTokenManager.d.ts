/**
 * AgentTokenManager — per-agent authentication tokens for cross-agent messaging.
 *
 * Each agent on the machine gets a 256-bit random token stored at:
 *   ~/.instar/agent-tokens/{agentName}.token
 *
 * Tokens are generated on first agent registration and persist across restarts.
 * Used for:
 *   - Bearer auth on relay-agent endpoint (proving sender identity)
 *   - HMAC computation on message drops (tamper protection for offline delivery)
 *
 * Security properties:
 *   - Tokens are file-permission protected (0600 — owner read/write only)
 *   - Token directory is 0700
 *   - Agent names are validated to prevent path traversal
 *
 * Derived from: docs/specs/INTER-AGENT-MESSAGING-SPEC.md v3.1 §Cross-Agent Resolution
 */
/**
 * Ensure the token directory exists with proper permissions.
 */
export declare function ensureTokenDir(): void;
/**
 * Generate a new agent token and persist it to disk.
 * If a token already exists for this agent, returns the existing token.
 *
 * @param agentName - The agent's canonical name (validated for path safety)
 * @returns The hex-encoded token string
 */
export declare function generateAgentToken(agentName: string): string;
/**
 * Read an agent's token from disk.
 * Used by the sending agent to authenticate with the target agent's relay endpoint.
 *
 * @param agentName - The target agent's name
 * @returns The hex-encoded token, or null if no token exists
 */
export declare function getAgentToken(agentName: string): string | null;
/**
 * Verify a bearer token matches the expected agent token.
 * Used by the relay-agent endpoint to authenticate incoming requests.
 *
 * @param agentName - The agent whose token to check against
 * @param bearerToken - The token provided in the Authorization header
 * @returns true if the token matches
 */
export declare function verifyAgentToken(agentName: string, bearerToken: string): boolean;
/**
 * Compute HMAC-SHA256 for a message drop envelope.
 * Used when writing to the drop directory for offline same-machine delivery.
 *
 * The HMAC covers the same core fields as the cross-machine SignedPayload
 * (minus relayChain and signature which don't apply to same-machine drops).
 *
 * @param agentToken - The sending agent's token
 * @param fields - The fields to sign: { message, originServer, nonce, timestamp }
 */
export declare function computeDropHmac(agentToken: string, fields: {
    message: unknown;
    originServer: string;
    nonce: string;
    timestamp: string;
}): string;
/**
 * Verify HMAC on a received drop envelope.
 *
 * @param senderAgent - Name of the agent that wrote the drop
 * @param hmac - The HMAC value from the envelope
 * @param fields - The fields that were signed
 * @returns true if the HMAC is valid
 */
export declare function verifyDropHmac(senderAgent: string, hmac: string, fields: {
    message: unknown;
    originServer: string;
    nonce: string;
    timestamp: string;
}): boolean;
/**
 * Delete an agent's token. Used during agent unregistration.
 */
export declare function deleteAgentToken(agentName: string): boolean;
/**
 * List all agents that have tokens.
 */
export declare function listAgentTokens(): string[];
//# sourceMappingURL=AgentTokenManager.d.ts.map