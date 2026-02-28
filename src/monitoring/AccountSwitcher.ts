/**
 * Account Switcher — swap active Claude Code account via credential provider.
 *
 * Reads/writes credentials through the CredentialProvider abstraction,
 * supporting macOS Keychain, file-based, and future OS-native stores.
 * Supports fuzzy matching of account names (e.g., "dawn" matches "dawn@sagemindai.io").
 *
 * Ported from Dawn's dawn-server equivalent for general Instar use.
 * Refactored to use CredentialProvider (Phase 1 of Quota Migration spec).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CredentialProvider } from './CredentialProvider.js';
import { createDefaultProvider, redactToken } from './CredentialProvider.js';

interface AccountEntry {
  email: string;
  name: string | null;
  rateLimitTier: string | null;
  cachedOAuth: {
    accessToken: string;
    expiresAt: number;
  } | null;
  tokenCachedAt: string | null;
  staleSince: string | null;
  lastQuotaSnapshot: {
    collectedAt: string;
    weeklyUtilization: number;
    fiveHourUtilization: number;
    weeklyResetsAt: string | null;
    fiveHourResetsAt: string | null;
    sonnetUtilization: number;
    percentUsed: number;
    canRunPriority: string;
  } | null;
}

interface AccountRegistry {
  schemaVersion: number;
  accounts: Record<string, AccountEntry>;
  activeAccountEmail: string | null;
  lastUpdated: string;
}

export interface SwitchResult {
  success: boolean;
  message: string;
  previousAccount: string | null;
  newAccount: string | null;
}

export class AccountSwitcher {
  private registryPath: string;
  private provider: CredentialProvider;

  constructor(options?: {
    registryPath?: string;
    provider?: CredentialProvider;
  }) {
    this.registryPath = options?.registryPath || path.join(
      process.env.HOME || '',
      '.dawn-server/account-registry.json'
    );
    this.provider = options?.provider || createDefaultProvider();
  }

  /**
   * Get the credential provider being used.
   */
  getProvider(): CredentialProvider {
    return this.provider;
  }

  /**
   * Switch to a target account. Supports fuzzy matching:
   * - "dawn" matches "dawn@sagemindai.io"
   * - Full email also works
   */
  async switchAccount(target: string): Promise<SwitchResult> {
    const registry = this.loadRegistry();
    if (!registry) {
      return { success: false, message: 'Account registry not found', previousAccount: null, newAccount: null };
    }

    const resolvedEmail = this.resolveAccount(target, registry);
    if (!resolvedEmail) {
      const available = Object.keys(registry.accounts)
        .map(e => {
          const a = registry.accounts[e];
          return `${a.name || 'unknown'} (${e})`;
        })
        .join(', ');
      return {
        success: false,
        message: `Unknown account "${target}". Available: ${available}`,
        previousAccount: registry.activeAccountEmail,
        newAccount: null,
      };
    }

    const account = registry.accounts[resolvedEmail];
    if (!account) {
      return {
        success: false,
        message: `Account ${resolvedEmail} not in registry`,
        previousAccount: registry.activeAccountEmail,
        newAccount: null,
      };
    }

    if (!account.cachedOAuth?.accessToken) {
      return {
        success: false,
        message: `No cached token for ${resolvedEmail}. Use /login to authenticate.`,
        previousAccount: registry.activeAccountEmail,
        newAccount: null,
      };
    }

    if (account.cachedOAuth.expiresAt && account.cachedOAuth.expiresAt < Date.now()) {
      return {
        success: false,
        message: `Token for ${resolvedEmail} expired. Use /login to re-authenticate.`,
        previousAccount: registry.activeAccountEmail,
        newAccount: null,
      };
    }

    if (registry.activeAccountEmail === resolvedEmail) {
      return {
        success: true,
        message: `${resolvedEmail} is already the active account.`,
        previousAccount: resolvedEmail,
        newAccount: resolvedEmail,
      };
    }

    const previousAccount = registry.activeAccountEmail;

    try {
      await this.provider.writeCredentials({
        accessToken: account.cachedOAuth.accessToken,
        expiresAt: account.cachedOAuth.expiresAt,
        email: resolvedEmail,
      });
    } catch (err) {
      return {
        success: false,
        message: `Failed to write credentials via ${this.provider.platform} provider: ${err instanceof Error ? err.message : String(err)}`,
        previousAccount,
        newAccount: null,
      };
    }

    try {
      registry.activeAccountEmail = resolvedEmail;
      registry.lastUpdated = new Date().toISOString();
      this.saveRegistry(registry);
    } catch (err) {
      console.error('[AccountSwitcher] Failed to update registry:', err);
    }

    const name = account.name || resolvedEmail;
    return {
      success: true,
      message: `Switched to ${name} (${resolvedEmail}). New sessions will use this account.`,
      previousAccount,
      newAccount: resolvedEmail,
    };
  }

  /**
   * Get the credentials for a specific account from the registry.
   * Does NOT modify global state — for use with session-scoped credential injection.
   */
  getAccountCredentials(target: string): {
    email: string;
    accessToken: string;
    expiresAt: number;
  } | null {
    const registry = this.loadRegistry();
    if (!registry) return null;

    const resolvedEmail = this.resolveAccount(target, registry);
    if (!resolvedEmail) return null;

    const account = registry.accounts[resolvedEmail];
    if (!account?.cachedOAuth?.accessToken) return null;
    if (account.cachedOAuth.expiresAt && account.cachedOAuth.expiresAt < Date.now()) return null;

    return {
      email: resolvedEmail,
      accessToken: account.cachedOAuth.accessToken,
      expiresAt: account.cachedOAuth.expiresAt,
    };
  }

  /**
   * Get status of all accounts.
   */
  getAccountStatuses(): Array<{
    email: string;
    name: string | null;
    isActive: boolean;
    hasToken: boolean;
    tokenExpired: boolean;
    isStale: boolean;
    weeklyPercent: number;
    fiveHourPercent: number | null;
  }> {
    const registry = this.loadRegistry();
    if (!registry) return [];

    return Object.values(registry.accounts).map(account => {
      const hasToken = !!account.cachedOAuth?.accessToken;
      const tokenExpired = hasToken && account.cachedOAuth!.expiresAt < Date.now();
      return {
        email: account.email,
        name: account.name,
        isActive: account.email === registry.activeAccountEmail,
        hasToken,
        tokenExpired,
        isStale: !!account.staleSince,
        weeklyPercent: account.lastQuotaSnapshot?.percentUsed ?? 0,
        fiveHourPercent: account.lastQuotaSnapshot?.fiveHourUtilization ?? null,
      };
    });
  }

  private resolveAccount(target: string, registry: AccountRegistry): string | null {
    const lower = target.toLowerCase().trim();

    if (registry.accounts[lower]) return lower;

    for (const email of Object.keys(registry.accounts)) {
      if (email.toLowerCase() === lower) return email;
    }

    for (const email of Object.keys(registry.accounts)) {
      const prefix = email.split('@')[0].toLowerCase();
      if (prefix === lower) return email;
    }

    for (const [email, account] of Object.entries(registry.accounts)) {
      if (account.name && account.name.toLowerCase().includes(lower)) {
        return email;
      }
    }

    return null;
  }

  private loadRegistry(): AccountRegistry | null {
    try {
      if (!fs.existsSync(this.registryPath)) return null;
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
    } catch {
      // @silent-fallback-ok — defensive registry loading
      return null;
    }
  }

  private saveRegistry(registry: AccountRegistry): void {
    fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
  }
}
