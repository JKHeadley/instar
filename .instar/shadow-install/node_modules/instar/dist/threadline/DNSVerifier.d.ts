/**
 * DNSVerifier — DNS TXT record verification for Threadline agent identity.
 *
 * Verifies agent identity by checking DNS TXT records at `_threadline.{domain}`.
 * Expected record format: `threadline-agent=v1 fp={hex-fingerprint}`
 *
 * Features:
 * - Configurable cache TTL (default 5 minutes)
 * - Injectable DNS resolver for testing
 * - Handles timeouts, NXDOMAIN, multiple TXT records
 *
 * Part of Threadline Protocol Phase 6C.
 */
export interface DNSVerifyResult {
    verified: boolean;
    record?: string;
    reason: string;
}
/** Injectable DNS resolver function for testing */
export type DNSResolverFn = (hostname: string) => Promise<string[][]>;
export interface DNSVerifierConfig {
    /** Cache TTL in milliseconds. Default: 5 minutes */
    cacheTtlMs?: number;
    /** Injectable DNS resolver (for testing). Default: dns.promises.resolveTxt */
    resolver?: DNSResolverFn;
}
export declare class DNSVerifier {
    private readonly resolver;
    private readonly cacheTtlMs;
    private readonly cache;
    constructor(config?: DNSVerifierConfig);
    /**
     * Verify that a domain has a Threadline TXT record matching the expected fingerprint.
     *
     * Looks up `_threadline.{domain}` TXT record.
     * Expected format: `threadline-agent=v1 fp={hex-fingerprint}`
     */
    verify(domain: string, expectedFingerprint: string): Promise<DNSVerifyResult>;
    /**
     * Clear the DNS verification cache.
     */
    clearCache(): void;
    /**
     * Get current cache size (for diagnostics).
     */
    getCacheSize(): number;
}
//# sourceMappingURL=DNSVerifier.d.ts.map