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
import type { CredentialProvider } from './CredentialProvider.js';
export interface SwitchResult {
    success: boolean;
    message: string;
    previousAccount: string | null;
    newAccount: string | null;
}
export declare class AccountSwitcher {
    private registryPath;
    private provider;
    constructor(options?: {
        registryPath?: string;
        provider?: CredentialProvider;
    });
    /**
     * Get the credential provider being used.
     */
    getProvider(): CredentialProvider;
    /**
     * Switch to a target account. Supports fuzzy matching:
     * - "dawn" matches "dawn@sagemindai.io"
     * - Full email also works
     */
    switchAccount(target: string): Promise<SwitchResult>;
    /**
     * Get the credentials for a specific account from the registry.
     * Does NOT modify global state — for use with session-scoped credential injection.
     */
    getAccountCredentials(target: string): {
        email: string;
        accessToken: string;
        expiresAt: number;
    } | null;
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
    }>;
    private resolveAccount;
    private loadRegistry;
    private saveRegistry;
}
//# sourceMappingURL=AccountSwitcher.d.ts.map