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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BitwardenProvider } from './BitwardenProvider.js';
import { GlobalSecretStore } from './GlobalSecretStore.js';
// ── Well-Known Secret Keys ───────────────────────────────────────────
/** Standard secret keys used across Instar. */
export const SECRET_KEYS = {
    TELEGRAM_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: 'telegram-chat-id',
    AUTH_TOKEN: 'auth-token',
    DASHBOARD_PIN: 'dashboard-pin',
    TUNNEL_TOKEN: 'tunnel-token',
};
// ── Secret Manager ───────────────────────────────────────────────────
export class SecretManager {
    agentName;
    backend = 'manual';
    bitwarden = null;
    localStore = null;
    initialized = false;
    secretsDir;
    backendFile;
    basePath;
    constructor(config) {
        this.agentName = config.agentName;
        this.basePath = config.basePath;
        this.secretsDir = config.basePath || path.join(os.homedir(), '.instar', 'secrets');
        this.backendFile = path.join(this.secretsDir, 'backend.json');
        if (config.backend) {
            this.backend = config.backend;
        }
    }
    // ── Initialization ────────────────────────────────────────────────
    /**
     * Initialize the secret manager.
     * Loads the backend preference and connects to the chosen backend.
     * Returns the active backend type.
     */
    initialize() {
        if (this.initialized)
            return this.backend;
        // Load saved preference if no explicit backend was set
        if (!this.backend || this.backend === 'manual') {
            const saved = this.loadPreference();
            if (saved) {
                this.backend = saved.backend;
            }
        }
        // Initialize the chosen backend
        switch (this.backend) {
            case 'bitwarden':
                this.bitwarden = new BitwardenProvider({ agentName: this.agentName });
                break;
            case 'local':
                this.localStore = new GlobalSecretStore(this.basePath);
                this.localStore.autoInit();
                break;
            case 'manual':
                // No backend to initialize
                break;
        }
        this.initialized = true;
        return this.backend;
    }
    /**
     * Configure the backend and save the preference.
     */
    configureBackend(backend, options) {
        this.backend = backend;
        // Save preference
        const pref = {
            backend,
            configuredAt: new Date().toISOString(),
            bitwardenEmail: options?.bitwardenEmail,
        };
        if (!fs.existsSync(this.secretsDir)) {
            fs.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
        }
        fs.writeFileSync(this.backendFile, JSON.stringify(pref, null, 2), { mode: 0o600 });
        // Re-initialize with new backend
        this.initialized = false;
        this.bitwarden = null;
        this.localStore = null;
        this.initialize();
    }
    // ── Secret Operations ─────────────────────────────────────────────
    /**
     * Get a secret by key.
     * Tries the configured backend, falls back through the chain.
     */
    get(key) {
        this.ensureInitialized();
        // Try primary backend
        const primary = this.getFromBackend(key);
        if (primary !== null)
            return primary;
        // If primary is bitwarden, fall back to local
        if (this.backend === 'bitwarden') {
            const local = this.getFromLocal(key);
            if (local !== null)
                return local;
        }
        return null;
    }
    /**
     * Set a secret.
     * Writes to the configured backend AND the local store (as backup).
     */
    set(key, value) {
        this.ensureInitialized();
        let primarySuccess = false;
        switch (this.backend) {
            case 'bitwarden':
                if (this.bitwarden) {
                    primarySuccess = this.bitwarden.set(key, value);
                }
                // Also save to local as backup
                this.setToLocal(key, value);
                break;
            case 'local':
                this.setToLocal(key, value);
                primarySuccess = true;
                break;
            case 'manual':
                // Save to local even in manual mode — improves future experience
                this.setToLocal(key, value);
                primarySuccess = true;
                break;
        }
        return primarySuccess;
    }
    /**
     * Check if a secret exists in any backend.
     */
    has(key) {
        return this.get(key) !== null;
    }
    /**
     * Delete a secret from all backends.
     */
    delete(key) {
        this.ensureInitialized();
        if (this.bitwarden) {
            try {
                this.bitwarden.delete(key);
            }
            catch {
                // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
            }
        }
        if (this.localStore || this.backend !== 'bitwarden') {
            try {
                const store = this.localStore || new GlobalSecretStore(this.basePath);
                store.autoInit();
                store.deleteSecret(this.agentName, key);
            }
            catch {
                // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
            }
        }
    }
    /**
     * Get all secrets for this agent from the active backend.
     */
    getAll() {
        this.ensureInitialized();
        switch (this.backend) {
            case 'bitwarden':
                if (this.bitwarden) {
                    const bwSecrets = this.bitwarden.listAll();
                    if (Object.keys(bwSecrets).length > 0)
                        return bwSecrets;
                }
                // Fall back to local
                return this.getAllFromLocal();
            case 'local':
                return this.getAllFromLocal();
            case 'manual':
                // Try local anyway — we always save there
                return this.getAllFromLocal();
        }
    }
    /**
     * Backup all config secrets to the secret store.
     * Called before nuke/uninstall to preserve secrets for reinstall.
     */
    backupFromConfig(config) {
        this.ensureInitialized();
        if (config.telegramToken)
            this.set(SECRET_KEYS.TELEGRAM_TOKEN, config.telegramToken);
        if (config.telegramChatId)
            this.set(SECRET_KEYS.TELEGRAM_CHAT_ID, config.telegramChatId);
        if (config.authToken)
            this.set(SECRET_KEYS.AUTH_TOKEN, config.authToken);
        if (config.dashboardPin)
            this.set(SECRET_KEYS.DASHBOARD_PIN, config.dashboardPin);
        if (config.tunnelToken)
            this.set(SECRET_KEYS.TUNNEL_TOKEN, config.tunnelToken);
    }
    /**
     * Restore Telegram config from the secret store.
     * Returns null if no secrets found.
     */
    restoreTelegramConfig() {
        const token = this.get(SECRET_KEYS.TELEGRAM_TOKEN);
        const chatId = this.get(SECRET_KEYS.TELEGRAM_CHAT_ID);
        if (token && chatId) {
            return { token, chatId };
        }
        return null;
    }
    // ── Status ────────────────────────────────────────────────────────
    /** Get the active backend type. */
    getBackend() {
        return this.backend;
    }
    /** Get the saved backend preference. */
    getPreference() {
        return this.loadPreference();
    }
    /** Whether any backend is configured (not 'manual'). */
    isConfigured() {
        return this.backend !== 'manual';
    }
    /** Whether Bitwarden is ready to use. */
    isBitwardenReady() {
        if (!this.bitwarden) {
            const bw = new BitwardenProvider({ agentName: this.agentName });
            return bw.isReady();
        }
        return this.bitwarden.isReady();
    }
    // ── Backend Helpers ───────────────────────────────────────────────
    getFromBackend(key) {
        switch (this.backend) {
            case 'bitwarden':
                if (this.bitwarden) {
                    try {
                        return this.bitwarden.get(key);
                    }
                    catch {
                        // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
                        return null;
                    }
                }
                return null;
            case 'local':
                return this.getFromLocal(key);
            case 'manual':
                return this.getFromLocal(key);
        }
    }
    getFromLocal(key) {
        try {
            const store = this.localStore || new GlobalSecretStore(this.basePath);
            if (!this.localStore)
                store.autoInit();
            return store.getSecret(this.agentName, key);
        }
        catch {
            // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
            return null;
        }
    }
    setToLocal(key, value) {
        try {
            const store = this.localStore || new GlobalSecretStore(this.basePath);
            if (!this.localStore)
                store.autoInit();
            store.setSecret(this.agentName, key, value);
        }
        catch {
            // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
            // Local store failed — not critical if primary backend succeeded
        }
    }
    getAllFromLocal() {
        try {
            const store = this.localStore || new GlobalSecretStore(this.basePath);
            if (!this.localStore)
                store.autoInit();
            return store.getAgentSecrets(this.agentName);
        }
        catch {
            // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
            return {};
        }
    }
    ensureInitialized() {
        if (!this.initialized) {
            this.initialize();
        }
    }
    loadPreference() {
        if (!fs.existsSync(this.backendFile))
            return null;
        try {
            return JSON.parse(fs.readFileSync(this.backendFile, 'utf-8'));
        }
        catch {
            // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
            return null;
        }
    }
}
//# sourceMappingURL=SecretManager.js.map