/**
 * Gate Reviewer — Fast triage to determine if a response needs full review.
 *
 * Returns a GateResult instead of the standard ReviewResult.
 * Includes the "Simple Acknowledgment Loophole" fix: short messages expressing
 * inability ALWAYS need review.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewResult, ReviewerOptions } from '../CoherenceReviewer.js';
export interface GateResult {
    needsReview: boolean;
    reason: string;
    reviewer: string;
    latencyMs: number;
}
export declare class GateReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    review(context: ReviewContext): Promise<ReviewResult>;
    /**
     * Gate-specific response: full review is needed. Conservative fail-open.
     */
    reviewAsGate(context: ReviewContext): Promise<GateResult>;
    protected buildPrompt(context: ReviewContext): string;
    private parseGateResponse;
}
//# sourceMappingURL=gate-reviewer.d.ts.map