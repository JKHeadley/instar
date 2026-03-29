/**
 * Claim Provenance Reviewer — Catches fabricated claims not traceable to tool output.
 *
 * Detects fabricated URLs, status codes, data points, and other specific claims
 * that aren't supported by actual tool output. Defaults to 'sonnet' model for
 * higher accuracy on nuanced judgment.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
export declare class ClaimProvenanceReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    protected buildPrompt(context: ReviewContext): string;
}
//# sourceMappingURL=claim-provenance.d.ts.map