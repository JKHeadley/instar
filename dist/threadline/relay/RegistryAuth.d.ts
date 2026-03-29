/**
 * RegistryAuth — JWT-based authentication for registry REST endpoints.
 *
 * Issues short-lived JWT tokens during WebSocket auth, verified on REST calls.
 * Tokens are signed with the relay's Ed25519 key (not the agent's key).
 *
 * Part of Threadline Relay Phase 1.1.
 */
export interface RegistryToken {
    token: string;
    expiresAt: string;
}
export interface TokenPayload {
    sub: string;
    iat: number;
    exp: number;
    iss: string;
}
export declare class RegistryAuth {
    private readonly relayPrivateKey;
    private readonly relayPublicKey;
    private readonly relayId;
    private readonly tokenLifetimeMs;
    constructor(config: {
        relayId: string;
        /** Path to store relay key pair. If not provided, generates ephemeral key. */
        keyDir?: string;
        /** Token lifetime in ms. Default: 1 hour. */
        tokenLifetimeMs?: number;
    });
    /**
     * Issue a JWT for an authenticated agent.
     */
    issueToken(agentPublicKey: string): RegistryToken;
    /**
     * Verify a JWT and return the payload.
     * Returns null if invalid or expired.
     */
    verifyToken(token: string): TokenPayload | null;
    /**
     * Extract bearer token from Authorization header.
     */
    extractToken(authHeader: string | undefined): string | null;
}
//# sourceMappingURL=RegistryAuth.d.ts.map