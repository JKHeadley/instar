/**
 * Global Install Cleanup
 *
 * Detects and removes global `instar` installations that can cause version
 * confusion. Each agent manages its own version via shadow installs — global
 * binaries are vestigial and actively harmful (agents report stale versions).
 *
 * Runs at server startup and after successful auto-updates.
 */
export interface CleanupResult {
    found: string[];
    removed: string[];
    failed: Array<{
        path: string;
        error: string;
    }>;
}
/**
 * Clean up all global instar installations.
 * Safe to run multiple times — idempotent.
 */
export declare function cleanupGlobalInstalls(): CleanupResult;
//# sourceMappingURL=GlobalInstallCleanup.d.ts.map