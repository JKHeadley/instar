/**
 * MCPAuth — Token-based authentication for the Threadline MCP Tool Server.
 *
 * Manages bearer tokens for network transports (SSE, HTTP streamable).
 * Local stdio transport needs no auth — this module is only relevant
 * when the MCP server is exposed over the network.
 *
 * Security model:
 * - Tokens generated with crypto.randomBytes (32 bytes, hex-encoded)
 * - Only SHA-256 hashes stored on disk — raw tokens returned once at creation
 * - Scoped access: send, read, discover, admin (admin implies all others)
 * - Optional expiry, explicit revocation, soft-delete
 *
 * Storage: {stateDir}/threadline/mcp-tokens.json
 */
export type MCPTokenScope = 'threadline:send' | 'threadline:read' | 'threadline:discover' | 'threadline:admin';
/** Stored token record (never contains raw token) */
export interface MCPTokenInfo {
    id: string;
    name: string;
    scopes: MCPTokenScope[];
    hashedToken: string;
    createdAt: string;
    expiresAt: string | null;
    revoked: boolean;
}
/** Returned once at token creation — the only time the raw token is available */
export interface MCPTokenCreateResult {
    id: string;
    name: string;
    scopes: MCPTokenScope[];
    rawToken: string;
    createdAt: string;
    expiresAt: string | null;
}
export declare class MCPAuth {
    private readonly threadlineDir;
    private readonly tokensPath;
    private tokens;
    constructor(stateDir: string);
    /**
     * Create a new MCP auth token.
     *
     * The raw token is returned exactly once in the result. It is never
     * stored — only a SHA-256 hash is persisted. Callers must save the
     * raw token securely.
     *
     * @param name Human-readable label for the token
     * @param scopes Access scopes granted to this token
     * @param expiresInSeconds Optional TTL; omit for non-expiring tokens
     */
    createToken(name: string, scopes: MCPTokenScope[], expiresInSeconds?: number): MCPTokenCreateResult;
    /**
     * Validate a raw bearer token.
     *
     * Returns the token info if the token is valid, not expired, and not
     * revoked. Returns null otherwise.
     */
    validateToken(rawToken: string): MCPTokenInfo | null;
    /**
     * Check whether a token has the required scope.
     *
     * `threadline:admin` implicitly grants all other threadline scopes.
     */
    hasScope(tokenInfo: MCPTokenInfo, requiredScope: MCPTokenScope): boolean;
    /**
     * Revoke a token by ID. The token remains in storage (for audit
     * purposes) but will no longer validate.
     *
     * Returns true if the token was found and revoked, false if not found
     * or already revoked.
     */
    revokeToken(tokenId: string): boolean;
    /**
     * List all tokens with metadata. The hashedToken field is included
     * (it's a hash, not the raw token) but raw tokens are never exposed.
     *
     * Returns all tokens including revoked ones — callers can filter
     * by the `revoked` field.
     */
    listTokens(): MCPTokenInfo[];
    /**
     * Permanently delete a token by ID.
     *
     * Unlike revocation, this removes the token from storage entirely.
     * Use revocation for audit trails; deletion for cleanup.
     *
     * Returns true if the token was found and deleted.
     */
    deleteToken(tokenId: string): boolean;
    /**
     * Force reload tokens from disk.
     */
    reload(): void;
    private loadTokens;
    private save;
}
//# sourceMappingURL=MCPAuth.d.ts.map