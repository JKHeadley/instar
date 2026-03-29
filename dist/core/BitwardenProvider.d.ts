/**
 * Bitwarden CLI integration for secret management.
 *
 * Wraps the `bw` CLI to provide scoped secret storage per agent.
 * Secrets are stored as Bitwarden Secure Notes in a folder per agent.
 *
 * Folder structure in Bitwarden:
 *   instar/
 *     {agentName}/
 *       telegram-token
 *       telegram-chat-id
 *       auth-token
 *       dashboard-pin
 *       tunnel-token
 *
 * The session key is cached in memory and refreshed as needed.
 */
export interface BitwardenConfig {
    /** Agent name (used as folder scope) */
    agentName: string;
    /** Override bw binary path for testing. Pass null to simulate bw not installed. */
    bwPath?: string | null;
}
export interface BitwardenStatus {
    /** Whether the `bw` CLI is installed */
    installed: boolean;
    /** Whether the user is logged in */
    loggedIn: boolean;
    /** Whether the vault is unlocked */
    unlocked: boolean;
    /** User email (if logged in) */
    email?: string;
}
export declare class BitwardenProvider {
    private agentName;
    private sessionKey;
    private bwPath;
    private bwPathOverridden;
    constructor(config: BitwardenConfig);
    /** Check Bitwarden CLI status. */
    getStatus(): BitwardenStatus;
    /** Whether Bitwarden is ready to use (installed, logged in, unlocked). */
    isReady(): boolean;
    /**
     * Unlock the vault with a master password.
     * Returns true if successful.
     */
    unlock(masterPassword: string): boolean;
    /**
     * Log in with email and master password.
     * Returns true if successful.
     */
    login(email: string, masterPassword: string): boolean;
    /**
     * Get a secret by key name.
     * Returns null if not found.
     */
    get(key: string): string | null;
    /**
     * Set a secret by key name.
     * Creates or updates the item in Bitwarden.
     */
    set(key: string, value: string): boolean;
    /**
     * Check if a secret exists.
     */
    has(key: string): boolean;
    /**
     * Delete a secret by key name.
     */
    delete(key: string): boolean;
    /**
     * List all secrets for this agent.
     * Returns key-value pairs.
     */
    listAll(): Record<string, string>;
    private getOrCreateFolderId;
    private scopedName;
    private findItemId;
    private findBw;
    private requireBw;
    private requireSession;
    private getExistingSession;
}
//# sourceMappingURL=BitwardenProvider.d.ts.map