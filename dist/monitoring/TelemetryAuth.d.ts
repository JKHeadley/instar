/**
 * TelemetryAuth — Installation identity and HMAC signing for Baseline telemetry.
 *
 * Manages:
 *   - Installation ID: Random UUID, stored at {stateDir}/telemetry/install-id
 *   - HMAC secret: 32 random bytes (hex), stored at {stateDir}/telemetry/local-secret
 *   - Signature generation using canonical message format
 *
 * Security:
 *   - Secret file is chmod 600 (owner read/write only)
 *   - Telemetry directory is chmod 700
 *   - Secret never leaves the machine — only the HMAC signature is transmitted
 */
export declare class TelemetryAuth {
    private telemetryDir;
    private installIdPath;
    private secretPath;
    constructor(stateDir: string);
    /**
     * Check if this installation has been provisioned (has install-id and secret).
     */
    isProvisioned(): boolean;
    /**
     * Provision identity files. Called on `instar telemetry enable`.
     * Creates install-id and local-secret with secure permissions.
     */
    provision(): {
        installationId: string;
        created: boolean;
    };
    /**
     * Read the installation ID, or null if not provisioned.
     */
    getInstallationId(): string | null;
    /**
     * Read the HMAC secret, or null if not provisioned.
     */
    private getSecret;
    /**
     * Sign a submission payload using HMAC-SHA256 with canonical message format.
     *
     * Canonical message: installationId:timestamp:hex(SHA-256(payload))
     *
     * @param installationId - The 36-character UUID
     * @param timestamp - Unix epoch seconds as decimal string
     * @param payloadBytes - The exact JSON request body as bytes
     * @returns The hex-encoded HMAC signature, or null if not provisioned
     */
    sign(installationId: string, timestamp: string, payloadBytes: Buffer): string | null;
    /**
     * Compute the key fingerprint for server-side binding.
     * SHA-256(installationId + ":" + localSecret)
     */
    getKeyFingerprint(): string | null;
    /**
     * Delete all local identity files. Called on `instar telemetry disable`.
     */
    deprovision(): void;
    /**
     * Get the first 8 characters of the installation ID (for status display).
     */
    getInstallationIdPrefix(): string | null;
}
//# sourceMappingURL=TelemetryAuth.d.ts.map