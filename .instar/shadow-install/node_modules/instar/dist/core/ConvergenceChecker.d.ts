/**
 * ConvergenceChecker — TypeScript port of convergence-check.sh.
 *
 * Heuristic content quality gate. No LLM calls. Completes in <10ms.
 * Checks 7 categories of common agent failure modes via regex:
 *
 * 1. capability_claims — Claims about what the agent can't do
 * 2. commitment_overreach — Promises that may not survive sessions
 * 3. settling — Accepting empty results without investigation
 * 4. experiential_fabrication — Claiming first-person experience
 * 5. sycophancy — Reflexive agreement, excessive apology
 * 6. url_provenance — URLs with unfamiliar domains
 * 7. temporal_staleness — Language suggesting outdated perspective
 */
export interface ConvergenceIssue {
    category: string;
    detail: string;
}
export interface ConvergenceResult {
    pass: boolean;
    issues: ConvergenceIssue[];
}
export declare function checkConvergence(content: string): ConvergenceResult;
//# sourceMappingURL=ConvergenceChecker.d.ts.map