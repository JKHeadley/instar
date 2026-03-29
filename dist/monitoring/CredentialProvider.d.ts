/**
 * CredentialProvider — cross-platform abstraction for Claude Code OAuth credential access.
 *
 * Implementations:
 * - KeychainCredentialProvider: macOS Keychain (os-encrypted, production-proven)
 * - ClaudeConfigCredentialProvider: File-based fallback (all platforms, 0600 permissions)
 *
 * Part of the Instar Quota Migration spec (Phase 1).
 */
export interface ClaudeCredentials {
    accessToken: string;
    expiresAt: number;
    refreshToken?: string;
    email?: string;
}
export interface AccountInfo {
    email: string;
    name: string | null;
    hasToken: boolean;
    tokenExpired: boolean;
}
export type SecurityLevel = 'os-encrypted' | 'file-permission-only';
export interface CredentialProvider {
    /** Read the current active credentials */
    readCredentials(): Promise<ClaudeCredentials | null>;
    /** Write/update credentials */
    writeCredentials(creds: ClaudeCredentials): Promise<void>;
    /** Delete credentials for a specific account */
    deleteCredentials?(email: string): Promise<void>;
    /** List all known accounts */
    listAccounts?(): Promise<AccountInfo[]>;
    /** Platform identifier */
    platform: string;
    /** Security level of this provider's storage */
    securityLevel: SecurityLevel;
}
/**
 * Redact a token for safe logging. Shows first 4 chars only.
 * Returns "[TOKEN:abc1****]" format.
 */
export declare function redactToken(token: string): string;
/**
 * Redact an email for safe logging.
 * Returns "[EMAIL:j***@***.com]" format.
 */
export declare function redactEmail(email: string): string;
export declare class KeychainCredentialProvider implements CredentialProvider {
    readonly platform = "darwin";
    readonly securityLevel: SecurityLevel;
    private keychainAccount;
    constructor();
    readCredentials(): Promise<ClaudeCredentials | null>;
    writeCredentials(creds: ClaudeCredentials): Promise<void>;
    deleteCredentials(_email: string): Promise<void>;
}
/**
 * Reads credentials from Claude Code's local config files.
 * Falls back to file-based storage with enforced 0600 permissions.
 *
 * Config path: ~/.claude/ (standard Claude Code config directory)
 */
export declare class ClaudeConfigCredentialProvider implements CredentialProvider {
    readonly platform: NodeJS.Platform;
    readonly securityLevel: SecurityLevel;
    private configDir;
    constructor(configDir?: string);
    readCredentials(): Promise<ClaudeCredentials | null>;
    writeCredentials(creds: ClaudeCredentials): Promise<void>;
    deleteCredentials(_email: string): Promise<void>;
    private parseCredentialFile;
}
/**
 * Create the best available credential provider for the current platform.
 *
 * Priority:
 * 1. macOS: Keychain (os-encrypted)
 * 2. All platforms: File-based (~/.claude/) with 0600 permissions
 *
 * Note: keytar support (Linux libsecret, Windows Credential Manager)
 * is planned but not yet implemented. When added, it will slot between
 * Keychain and file-based in the priority chain.
 */
export declare function createDefaultProvider(): CredentialProvider;
//# sourceMappingURL=CredentialProvider.d.ts.map