/**
 * System Review CLI command — `instar review`
 *
 * Runs the System Reviewer to verify feature functionality end-to-end.
 * This is a client command that calls the running server's API endpoints.
 */
interface ReviewOptions {
    dir?: string;
    tier?: string;
    probe?: string;
    dryRun?: boolean;
    history?: boolean;
    trend?: boolean;
    json?: boolean;
}
export declare function review(options: ReviewOptions): Promise<void>;
export {};
//# sourceMappingURL=review.d.ts.map