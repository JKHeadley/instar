/**
 * LedgerAuth — Ed25519 authentication for work ledger entries.
 *
 * Provides signing and verification for multi-machine/multi-user
 * work coordination. Each machine signs entries with its Ed25519
 * private key; any machine can verify using the signer's public key.
 *
 * Scenario A (same user): Signing optional, verification failures logged.
 * Scenario B (multi-user): Signing mandatory, unsigned entries rejected.
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.4 (Ledger Entry Authentication).
 */
import type { LedgerEntry } from './WorkLedger.js';
export type AuthScenario = 'same-user' | 'multi-user';
export type VerificationStatus = 'valid' | 'invalid' | 'unsigned' | 'key-not-found' | 'key-revoked';
export interface SigningResult {
    /** Whether signing succeeded. */
    success: boolean;
    /** The signature string (ed25519:base64...). */
    signature?: string;
    /** The fields that were signed. */
    signedFields?: string[];
    /** Error if signing failed. */
    error?: string;
}
export interface VerificationResult {
    /** Verification status. */
    status: VerificationStatus;
    /** Whether the entry should be trusted. */
    trusted: boolean;
    /** The machine ID from the entry. */
    machineId: string;
    /** Human-readable message. */
    message: string;
}
export interface KeyInfo {
    /** The machine's public key (PEM format). */
    publicKey: string;
    /** Whether this key has been revoked. */
    revoked: boolean;
    /** Machine ID this key belongs to. */
    machineId: string;
}
export interface LedgerAuthConfig {
    /** Operating scenario. */
    scenario: AuthScenario;
    /** This machine's Ed25519 private key (PEM). */
    privateKey?: string;
    /** This machine's ID. */
    machineId: string;
    /** Key resolver: given a machineId, returns its public key info. */
    keyResolver: (machineId: string) => KeyInfo | null;
}
export declare class LedgerAuth {
    private scenario;
    private privateKey?;
    private machineId;
    private keyResolver;
    constructor(config: LedgerAuthConfig);
    /**
     * Sign a ledger entry with this machine's private key.
     * Returns the signature and signed fields list.
     */
    signEntry(entry: LedgerEntry, fields?: Array<keyof LedgerEntry>): SigningResult;
    /**
     * Sign a ledger entry in-place (mutates the entry).
     * Convenience method that sets signature + signedFields on the entry.
     */
    signEntryInPlace(entry: LedgerEntry, fields?: Array<keyof LedgerEntry>): boolean;
    /**
     * Verify a ledger entry's signature.
     */
    verifyEntry(entry: LedgerEntry): VerificationResult;
    /**
     * Verify all entries in a set.
     * Returns entries grouped by verification status.
     */
    verifyEntries(entries: LedgerEntry[]): {
        trusted: LedgerEntry[];
        untrusted: LedgerEntry[];
        results: VerificationResult[];
    };
    /**
     * Check if signing is required in the current scenario.
     */
    isSigningRequired(): boolean;
    /**
     * Get the current scenario.
     */
    getScenario(): AuthScenario;
    /**
     * Canonicalize an entry for signing/verification.
     *
     * Sort fields alphabetically, concatenate as "key=value\n".
     * Undefined/null values are represented as empty strings.
     */
    private canonicalize;
}
//# sourceMappingURL=LedgerAuth.d.ts.map