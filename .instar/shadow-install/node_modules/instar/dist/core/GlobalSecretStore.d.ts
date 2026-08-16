/**
 * Global encrypted secret store — lives at ~/.instar/secrets/ to survive repo nukes.
 *
 * Unlike the per-agent SecretStore (which lives inside .instar/secrets/),
 * this store persists across agent deletions and reinstalls on the same machine.
 *
 * Encryption: AES-256-GCM with a master key stored in:
 *   1. macOS Keychain (preferred — transparent, no password needed)
 *   2. Password-derived key via PBKDF2 (fallback — user enters password)
 *
 * File layout:
 *   ~/.instar/secrets/
 *     global.secrets.enc    — encrypted secrets (all agents on this machine)
 *     global.key            — master key file (0600, only if keychain unavailable)
 *
 * Secrets are organized by agent name:
 *   {
 *     "agents": {
 *       "my-agent": {
 *         "telegram-token": "bot123:ABC",
 *         "telegram-chat-id": "-100123",
 *         ...
 *       }
 *     }
 *   }
 */
export interface GlobalSecrets {
    agents: Record<string, Record<string, string>>;
}
export declare class GlobalSecretStore {
    private masterKey;
    private secretsDir;
    private encryptedFile;
    private keyFile;
    private useKeychain;
    constructor(basePath?: string);
    /**
     * Get a secret for an agent.
     * Returns null if the agent or key doesn't exist.
     */
    getSecret(agentName: string, key: string): string | null;
    /**
     * Set a secret for an agent.
     */
    setSecret(agentName: string, key: string, value: string): void;
    /**
     * Get all secrets for an agent.
     * Returns empty object if agent has no secrets.
     */
    getAgentSecrets(agentName: string): Record<string, string>;
    /**
     * Set multiple secrets for an agent at once.
     */
    setAgentSecrets(agentName: string, newSecrets: Record<string, string>): void;
    /**
     * Delete all secrets for an agent.
     */
    deleteAgent(agentName: string): void;
    /**
     * Delete a specific secret for an agent.
     */
    deleteSecret(agentName: string, key: string): void;
    /**
     * Check if any secrets exist for an agent.
     */
    hasAgent(agentName: string): boolean;
    /**
     * Check if a specific secret exists for an agent.
     */
    hasSecret(agentName: string, key: string): boolean;
    /**
     * List all agent names that have stored secrets.
     */
    listAgents(): string[];
    /** Whether the encrypted store file exists. */
    get exists(): boolean;
    /**
     * Initialize with a user-provided password.
     * Derives the master key via PBKDF2.
     * Returns true if this created a new store (vs unlocked existing).
     */
    initWithPassword(password: string): boolean;
    /**
     * Initialize with auto-generated key in OS keychain.
     * Transparent — no password needed.
     * Returns false if keychain is not available.
     */
    initWithKeychain(): boolean;
    /**
     * Auto-initialize: respects existing store type, falls back to keychain for new stores.
     * When keychain is unavailable, falls back to a machine-derived password.
     * Returns true if the store is ready to use without user interaction.
     */
    autoInit(): boolean;
    /**
     * Initialize with a machine-derived password (hostname + homedir).
     * The key file is marked as 'pbkdf2-auto' so autoInit() can re-unlock.
     */
    private initWithMachinePassword;
    /** Whether the store requires a password to unlock. */
    requiresPassword(): boolean;
    private readSecrets;
    private writeSecrets;
    private encrypt;
    private decrypt;
    private deriveKeyFromPassword;
    private readKeychain;
    private writeKeychain;
    /** Destroy all stored secrets and keys. For testing only. */
    destroy(): void;
}
//# sourceMappingURL=GlobalSecretStore.d.ts.map