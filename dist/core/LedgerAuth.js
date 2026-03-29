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
import { sign, verify } from './MachineIdentity.js';
// ── Constants ────────────────────────────────────────────────────────
const SIGNATURE_PREFIX = 'ed25519:';
/**
 * Default fields to include in signatures.
 * Covers identity + intent + timing — enough to prevent spoofing
 * without being fragile to cosmetic changes.
 */
const DEFAULT_SIGNED_FIELDS = [
    'machineId',
    'userId',
    'sessionId',
    'task',
    'status',
    'updatedAt',
];
// ── LedgerAuth ───────────────────────────────────────────────────────
export class LedgerAuth {
    scenario;
    privateKey;
    machineId;
    keyResolver;
    constructor(config) {
        this.scenario = config.scenario;
        this.privateKey = config.privateKey;
        this.machineId = config.machineId;
        this.keyResolver = config.keyResolver;
    }
    // ── Signing ───────────────────────────────────────────────────────
    /**
     * Sign a ledger entry with this machine's private key.
     * Returns the signature and signed fields list.
     */
    signEntry(entry, fields) {
        if (!this.privateKey) {
            if (this.scenario === 'multi-user') {
                return { success: false, error: 'Private key required for multi-user scenario' };
            }
            // Same-user: signing is optional
            return { success: false, error: 'No private key configured (optional in same-user mode)' };
        }
        const signedFields = fields ?? DEFAULT_SIGNED_FIELDS;
        const canonical = this.canonicalize(entry, signedFields);
        try {
            const sig = sign(canonical, this.privateKey);
            return {
                success: true,
                signature: `${SIGNATURE_PREFIX}${sig}`,
                signedFields: signedFields,
            };
        }
        catch (err) {
            // @silent-fallback-ok — signing failure returns structured error to caller; not a silent degradation
            return {
                success: false,
                error: `Signing failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    /**
     * Sign a ledger entry in-place (mutates the entry).
     * Convenience method that sets signature + signedFields on the entry.
     */
    signEntryInPlace(entry, fields) {
        const result = this.signEntry(entry, fields);
        if (result.success && result.signature && result.signedFields) {
            entry.signature = result.signature;
            entry.signedFields = result.signedFields;
            return true;
        }
        return false;
    }
    // ── Verification ──────────────────────────────────────────────────
    /**
     * Verify a ledger entry's signature.
     */
    verifyEntry(entry) {
        // Check if entry is signed
        if (!entry.signature || !entry.signedFields) {
            if (this.scenario === 'multi-user') {
                return {
                    status: 'unsigned',
                    trusted: false,
                    machineId: entry.machineId,
                    message: `Unsigned entry from machine "${entry.machineId}" — rejected in multi-user mode`,
                };
            }
            // Same-user: unsigned entries are acceptable
            return {
                status: 'unsigned',
                trusted: true,
                machineId: entry.machineId,
                message: `Unsigned entry from machine "${entry.machineId}" — accepted in same-user mode`,
            };
        }
        // Resolve the signing machine's public key
        const keyInfo = this.keyResolver(entry.machineId);
        if (!keyInfo) {
            return {
                status: 'key-not-found',
                trusted: false,
                machineId: entry.machineId,
                message: `Public key not found for machine "${entry.machineId}"`,
            };
        }
        // Check for revoked key
        if (keyInfo.revoked) {
            return {
                status: 'key-revoked',
                trusted: false,
                machineId: entry.machineId,
                message: `Key for machine "${entry.machineId}" has been revoked`,
            };
        }
        // Verify the signature
        const canonical = this.canonicalize(entry, entry.signedFields);
        const sigBase64 = entry.signature.startsWith(SIGNATURE_PREFIX)
            ? entry.signature.slice(SIGNATURE_PREFIX.length)
            : entry.signature;
        try {
            const valid = verify(canonical, sigBase64, keyInfo.publicKey);
            if (valid) {
                return {
                    status: 'valid',
                    trusted: true,
                    machineId: entry.machineId,
                    message: `Valid signature from machine "${entry.machineId}"`,
                };
            }
            else {
                return {
                    status: 'invalid',
                    trusted: false,
                    machineId: entry.machineId,
                    message: `Invalid signature from machine "${entry.machineId}" — possible tampering`,
                };
            }
        }
        catch (err) {
            return {
                status: 'invalid',
                trusted: false,
                machineId: entry.machineId,
                message: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    /**
     * Verify all entries in a set.
     * Returns entries grouped by verification status.
     */
    verifyEntries(entries) {
        const trusted = [];
        const untrusted = [];
        const results = [];
        for (const entry of entries) {
            const result = this.verifyEntry(entry);
            results.push(result);
            if (result.trusted) {
                trusted.push(entry);
            }
            else {
                untrusted.push(entry);
            }
        }
        return { trusted, untrusted, results };
    }
    // ── Configuration ─────────────────────────────────────────────────
    /**
     * Check if signing is required in the current scenario.
     */
    isSigningRequired() {
        return this.scenario === 'multi-user';
    }
    /**
     * Get the current scenario.
     */
    getScenario() {
        return this.scenario;
    }
    // ── Private: Canonicalization ──────────────────────────────────────
    /**
     * Canonicalize an entry for signing/verification.
     *
     * Sort fields alphabetically, concatenate as "key=value\n".
     * Undefined/null values are represented as empty strings.
     */
    canonicalize(entry, fields) {
        const sorted = [...fields].sort();
        const lines = [];
        for (const field of sorted) {
            const value = entry[field];
            const strValue = value === undefined || value === null
                ? ''
                : Array.isArray(value)
                    ? value.join(',')
                    : String(value);
            lines.push(`${field}=${strValue}`);
        }
        return lines.join('\n');
    }
}
//# sourceMappingURL=LedgerAuth.js.map