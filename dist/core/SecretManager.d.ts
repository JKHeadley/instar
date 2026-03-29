/**
 * Unified Secret Manager — single interface for all secret backends.
 *
 * Routes secret operations to the configured backend:
 *   1. Bitwarden (recommended) — cross-machine, cloud-backed
 *   2. Local encrypted store (fallback) — survives repo nukes on same machine
 *   3. Manual (no backend) — user pastes secrets when prompted
 *
 * The backend preference is stored in ~/.instar/secrets/backend.json
 * so it persists across agent installs.
 *
 * Usage:
 *   const mgr = new SecretManager('my-agent');
 *   await mgr.initialize();  // auto-detects or prompts for backend
 *   const token = mgr.get('telegram-token');
 *   mgr.set('telegram-token', 'bot123:ABC');
 */
export type SecretBackend = 'bitwarden' | 'local' | 'manual';
export interface SecretManagerConfig {
    /** Agent name (scopes secrets) */
    agentName: string;
    /** Override the backend (skip auto-detection) */
    backend?: SecretBackend;
    /** Override the secrets base directory (for testing) */
    basePath?: string;
}
export interface BackendPreference {
    backend: SecretBackend;
    /** When the preference was set */
    configuredAt: string;
    /** Bitwarden email (if applicable) */
    bitwardenEmail?: string;
}
/** Standard secret keys used across Instar. */
export declare const SECRET_KEYS: {
    readonly TELEGRAM_TOKEN: "telegram-token";
    readonly TELEGRAM_CHAT_ID: "telegram-chat-id";
    readonly AUTH_TOKEN: "auth-token";
    readonly DASHBOARD_PIN: "dashboard-pin";
    readonly TUNNEL_TOKEN: "tunnel-token";
};
export declare class SecretManager {
    private agentName;
    private backend;
    private bitwarden;
    private localStore;
    private initialized;
    private secretsDir;
    private backendFile;
    private basePath?;
    constructor(config: SecretManagerConfig);
    /**
     * Initialize the secret manager.
     * Loads the backend preference and connects to the chosen backend.
     * Returns the active backend type.
     */
    initialize(): SecretBackend;
    /**
     * Configure the backend and save the preference.
     */
    configureBackend(backend: SecretBackend, options?: {
        bitwardenEmail?: string;
    }): void;
    /**
     * Get a secret by key.
     * Tries the configured backend, falls back through the chain.
     */
    get(key: string): string | null;
    /**
     * Set a secret.
     * Writes to the configured backend AND the local store (as backup).
     */
    set(key: string, value: string): boolean;
    /**
     * Check if a secret exists in any backend.
     */
    has(key: string): boolean;
    /**
     * Delete a secret from all backends.
     */
    delete(key: string): void;
    /**
     * Get all secrets for this agent from the active backend.
     */
    getAll(): Record<string, string>;
    /**
     * Backup all config secrets to the secret store.
     * Called before nuke/uninstall to preserve secrets for reinstall.
     */
    backupFromConfig(config: {
        telegramToken?: string;
        telegramChatId?: string;
        authToken?: string;
        dashboardPin?: string;
        tunnelToken?: string;
    }): void;
    /**
     * Restore Telegram config from the secret store.
     * Returns null if no secrets found.
     */
    restoreTelegramConfig(): {
        token: string;
        chatId: string;
    } | null;
    /** Get the active backend type. */
    getBackend(): SecretBackend;
    /** Get the saved backend preference. */
    getPreference(): BackendPreference | null;
    /** Whether any backend is configured (not 'manual'). */
    isConfigured(): boolean;
    /** Whether Bitwarden is ready to use. */
    isBitwardenReady(): boolean;
    private getFromBackend;
    private getFromLocal;
    private setToLocal;
    private getAllFromLocal;
    private ensureInitialized;
    private loadPreference;
}
//# sourceMappingURL=SecretManager.d.ts.map