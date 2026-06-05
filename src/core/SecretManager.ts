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
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// ── Types ────────────────────────────────────────────────────────────

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

// ── Well-Known Secret Keys ───────────────────────────────────────────

/** Standard secret keys used across Instar. */
export const SECRET_KEYS = {
  TELEGRAM_TOKEN: 'telegram-token',
  TELEGRAM_CHAT_ID: 'telegram-chat-id',
  AUTH_TOKEN: 'auth-token',
  DASHBOARD_PIN: 'dashboard-pin',
  TUNNEL_TOKEN: 'tunnel-token',
} as const;

// ── Secret Manager ───────────────────────────────────────────────────

export class SecretManager {
  private agentName: string;
  private backend: SecretBackend = 'manual';
  private bitwarden: BitwardenProvider | null = null;
  private localStore: GlobalSecretStore | null = null;
  private initialized = false;
  private secretsDir: string;
  private backendFile: string;
  private basePath?: string;

  constructor(config: SecretManagerConfig) {
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
  initialize(): SecretBackend {
    if (this.initialized) return this.backend;

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
  configureBackend(backend: SecretBackend, options?: { bitwardenEmail?: string }): void {
    this.backend = backend;

    // Save preference
    const pref: BackendPreference = {
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
  get(key: string): string | null {
    this.ensureInitialized();

    // Try primary backend
    const primary = this.getFromBackend(key);
    if (primary !== null) return primary;

    // If primary is bitwarden, fall back to local
    if (this.backend === 'bitwarden') {
      const local = this.getFromLocal(key);
      if (local !== null) return local;
    }

    return null;
  }

  /**
   * Set a secret.
   * Writes to the configured backend AND the local store (as backup).
   */
  set(key: string, value: string): boolean {
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
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete a secret from all backends.
   */
  delete(key: string): void {
    this.ensureInitialized();

    if (this.bitwarden) {
      try { this.bitwarden.delete(key); } catch {
        // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
      }
    }

    if (this.localStore || this.backend !== 'bitwarden') {
      try {
        const store = this.localStore || new GlobalSecretStore(this.basePath);
        store.autoInit();
        store.deleteSecret(this.agentName, key);
      } catch {
        // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
      }
    }
  }

  /**
   * Get all secrets for this agent from the active backend.
   */
  getAll(): Record<string, string> {
    this.ensureInitialized();

    switch (this.backend) {
      case 'bitwarden':
        if (this.bitwarden) {
          const bwSecrets = this.bitwarden.listAll();
          if (Object.keys(bwSecrets).length > 0) return bwSecrets;
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
  backupFromConfig(config: {
    telegramToken?: string;
    telegramChatId?: string;
    authToken?: string;
    dashboardPin?: string;
    tunnelToken?: string;
  }): void {
    this.ensureInitialized();

    if (config.telegramToken) this.set(SECRET_KEYS.TELEGRAM_TOKEN, config.telegramToken);
    if (config.telegramChatId) this.set(SECRET_KEYS.TELEGRAM_CHAT_ID, config.telegramChatId);
    if (config.authToken) this.set(SECRET_KEYS.AUTH_TOKEN, config.authToken);
    if (config.dashboardPin) this.set(SECRET_KEYS.DASHBOARD_PIN, config.dashboardPin);
    if (config.tunnelToken) this.set(SECRET_KEYS.TUNNEL_TOKEN, config.tunnelToken);
  }

  /**
   * Restore Telegram config from the secret store.
   * Returns null if no secrets found.
   */
  restoreTelegramConfig(): { token: string; chatId: string } | null {
    const token = this.get(SECRET_KEYS.TELEGRAM_TOKEN);
    const chatId = this.get(SECRET_KEYS.TELEGRAM_CHAT_ID);

    if (token && chatId) {
      return { token, chatId };
    }

    return null;
  }

  // ── Status ────────────────────────────────────────────────────────

  /** Get the active backend type. */
  getBackend(): SecretBackend {
    return this.backend;
  }

  /** Get the saved backend preference. */
  getPreference(): BackendPreference | null {
    return this.loadPreference();
  }

  /** Whether any backend is configured (not 'manual'). */
  isConfigured(): boolean {
    return this.backend !== 'manual';
  }

  /** Whether Bitwarden is ready to use. */
  isBitwardenReady(): boolean {
    if (!this.bitwarden) {
      const bw = new BitwardenProvider({ agentName: this.agentName });
      return bw.isReady();
    }
    return this.bitwarden.isReady();
  }

  // ── Backend Helpers ───────────────────────────────────────────────

  private getFromBackend(key: string): string | null {
    switch (this.backend) {
      case 'bitwarden':
        if (this.bitwarden) {
          try { return this.bitwarden.get(key); } catch {
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

  /** A failed local-store read/write is REPORTED (spec
   *  keychain-per-agent-master-key §5) — an undecryptable store must never
   *  silently look identical to "no secrets stored" (the 2026-06-05 class). */
  private reportLocalStoreFailure(op: string, err: unknown): void {
    DegradationReporter.getInstance().report({
      feature: `SecretManager.${op}`,
      primary: 'Read/write the local GlobalSecretStore',
      fallback: 'Operation degrades (null/empty result)',
      reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
      impact: 'Local secrets unavailable — possible key mismatch or locked store',
    });
  }

  private getFromLocal(key: string): string | null {
    try {
      const store = this.localStore || new GlobalSecretStore(this.basePath);
      if (!this.localStore) store.autoInit();
      return store.getSecret(this.agentName, key);
    } catch (err) {
      // @silent-fallback-ok — reported via reportLocalStoreFailure (DegradationReporter)
      this.reportLocalStoreFailure('getFromLocal', err);
      return null;
    }
  }

  private setToLocal(key: string, value: string): void {
    try {
      const store = this.localStore || new GlobalSecretStore(this.basePath);
      if (!this.localStore) store.autoInit();
      store.setSecret(this.agentName, key, value);
    } catch (err) {
      // @silent-fallback-ok — reported via reportLocalStoreFailure (DegradationReporter);
      // not critical if the primary backend succeeded, but never silent
      this.reportLocalStoreFailure('setToLocal', err);
    }
  }

  private getAllFromLocal(): Record<string, string> {
    try {
      const store = this.localStore || new GlobalSecretStore(this.basePath);
      if (!this.localStore) store.autoInit();
      return store.getAgentSecrets(this.agentName);
    } catch (err) {
      // @silent-fallback-ok — reported via reportLocalStoreFailure (DegradationReporter)
      this.reportLocalStoreFailure('getAllFromLocal', err);
      return {};
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }

  private loadPreference(): BackendPreference | null {
    if (!fs.existsSync(this.backendFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.backendFile, 'utf-8'));
    } catch {
      // @silent-fallback-ok — secret not found or provider unavailable — returns undefined
      return null;
    }
  }
}
