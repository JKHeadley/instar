/**
 * InvitationManager — Invitation token lifecycle for Threadline trust bootstrap.
 *
 * Manages cryptographically random invitation tokens with:
 * - Optional expiry and max-uses
 * - HMAC-SHA256 signing with auto-generated server secret
 * - Single-use and multi-use token support
 * - Persistent storage to {stateDir}/threadline/invitations.json
 *
 * Part of Threadline Protocol Phase 6C.
 */
export interface InvitationCreateOptions {
    /** Human-readable label for the invitation */
    label?: string;
    /** Expiry time in milliseconds from now. Omit for no expiry. */
    expiresInMs?: number;
    /** Maximum number of uses. Default: 1 (single-use). 0 = unlimited. */
    maxUses?: number;
}
export interface Invitation {
    /** The token value (hex-encoded random bytes) */
    token: string;
    /** HMAC-SHA256 signature of the token */
    hmac: string;
    /** Human-readable label */
    label?: string;
    /** ISO timestamp when the invitation was created */
    createdAt: string;
    /** ISO timestamp when the invitation expires, or null for no expiry */
    expiresAt: string | null;
    /** Maximum number of uses (0 = unlimited) */
    maxUses: number;
    /** Number of times the token has been consumed */
    useCount: number;
    /** Agent identities that have consumed this token */
    consumedBy: string[];
    /** Whether the invitation has been manually revoked */
    revoked: boolean;
}
export type InvitationStatus = 'valid' | 'expired' | 'exhausted' | 'revoked' | 'not-found' | 'invalid-hmac';
export interface InvitationValidateResult {
    status: InvitationStatus;
    invitation?: Invitation;
    reason: string;
}
export declare class InvitationManager {
    private readonly threadlineDir;
    private readonly invitationsPath;
    private readonly secretPath;
    private readonly secret;
    private invitations;
    constructor(options: {
        stateDir: string;
    });
    /**
     * Create a new invitation token.
     * Returns the full token string (needed for sharing with the invitee).
     */
    create(options?: InvitationCreateOptions): string;
    /**
     * Validate an invitation token.
     * Checks existence, HMAC integrity, expiry, use count, and revocation status.
     */
    validate(token: string): InvitationValidateResult;
    /**
     * Consume an invitation token for a given agent identity.
     * Single-use tokens are effectively invalidated after first consume.
     * Returns the validation result (will be 'valid' if consumption succeeded).
     */
    consume(token: string, agentIdentity: string): InvitationValidateResult;
    /**
     * Manually revoke an invitation token.
     * Returns true if the token was found and revoked, false if not found.
     */
    revoke(token: string): boolean;
    /**
     * List all invitation tokens with their current status.
     */
    list(): Array<Invitation & {
        status: InvitationStatus;
    }>;
    /**
     * Force reload invitations from disk.
     */
    reload(): void;
    private computeHmac;
    private loadOrCreateSecret;
    private loadInvitations;
    private save;
}
//# sourceMappingURL=InvitationManager.d.ts.map