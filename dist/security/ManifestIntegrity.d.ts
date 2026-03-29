/**
 * ManifestIntegrity — HMAC-SHA256 signing and verification for capability-manifest.json.
 *
 * Uses a machine-local secret stored in .instar/state/.manifest-key (generated once at
 * `instar init`, never transmitted, added to .gitignore).
 *
 * On every write: compute HMAC over all entries, store as `_hmac` field.
 * On every read: verify HMAC before trusting data.
 * On verification failure: log warning, trigger alert, fall back to rescan.
 */
export interface SignedManifest {
    schemaVersion: number;
    version: string;
    generatedAt: string;
    entries: Record<string, unknown>;
    _hmac: string;
}
export declare class ManifestIntegrity {
    private stateDir;
    private keyPath;
    constructor(stateDir: string);
    /**
     * Generate a new signing key if one doesn't exist.
     * Called during `instar init`.
     * Returns true if a new key was generated, false if one already existed.
     */
    ensureKey(): boolean;
    /**
     * Read the signing key. Returns null if no key exists.
     */
    private getKey;
    /**
     * Deterministic JSON serialization with sorted keys at all levels.
     */
    private static sortedStringify;
    /**
     * Compute HMAC-SHA256 over the manifest entries (excluding the _hmac field itself).
     */
    private computeHmac;
    /**
     * Sign a manifest object. Adds `_hmac` field in-place and returns it.
     */
    sign<T extends Record<string, unknown>>(manifest: T): T & {
        _hmac: string;
    };
    /**
     * Verify a signed manifest. Returns true if the HMAC matches.
     */
    verify(manifest: Record<string, unknown>): boolean;
    /**
     * Read and verify a manifest file. Returns the parsed manifest and verification status.
     */
    readAndVerify(manifestPath: string): {
        manifest: SignedManifest | null;
        verified: boolean;
        error?: string;
    };
    /**
     * Write a signed manifest to disk. Signs before writing.
     */
    writeAndSign(manifestPath: string, manifest: Record<string, unknown>): void;
    /**
     * Check if a signing key exists.
     */
    hasKey(): boolean;
    /**
     * Rotate the signing key. Generates a new key, re-signs the manifest file if it exists.
     * Returns the path to the old key backup.
     */
    rotateKey(manifestPath?: string): string | null;
}
//# sourceMappingURL=ManifestIntegrity.d.ts.map