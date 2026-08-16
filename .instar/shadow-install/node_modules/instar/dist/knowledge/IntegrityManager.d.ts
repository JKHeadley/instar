/**
 * IntegrityManager — HMAC-SHA256 integrity verification for context files.
 *
 * Signs context files and verifies them at tree traversal time.
 * Uses a dedicated signing key (NOT the auth token) that is per-agent
 * and auto-generated on first use.
 *
 * Manifest is stored at .instar/context/.integrity.json
 */
export interface IntegritySignature {
    hmac: string;
    signedAt: string;
    size: number;
}
export interface IntegrityManifest {
    version: string;
    signatures: Record<string, IntegritySignature>;
}
export interface VerifyResult {
    valid: boolean;
    reason?: string;
}
export declare class IntegrityManager {
    private signingKey;
    private _manifestPath;
    constructor(signingKey: string, stateDir: string);
    get manifestPath(): string;
    /**
     * Sign a file and store its HMAC in the manifest.
     * The filePath should be relative to the project/state dir for manifest keys,
     * but absolute for reading.
     */
    sign(filePath: string): void;
    /**
     * Sign all files in a directory recursively.
     */
    signDirectory(dirPath: string): void;
    /**
     * Verify a single file against its stored HMAC.
     */
    verify(filePath: string): VerifyResult;
    private computeHmac;
    private loadManifest;
    private saveManifest;
}
//# sourceMappingURL=IntegrityManager.d.ts.map