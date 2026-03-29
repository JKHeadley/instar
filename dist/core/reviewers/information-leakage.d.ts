/**
 * Information Leakage Reviewer — Agent-to-agent information boundary enforcement.
 *
 * Only runs when recipientType is NOT 'primary-user'. Ensures messages to other
 * agents, secondary users, or external contacts don't leak the primary user's
 * private data or internal context.
 *
 * Data minimization: receives only recipientType + trustLevel (no tool output,
 * no value documents, no relationship context).
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewResult, ReviewerOptions } from '../CoherenceReviewer.js';
export declare class InformationLeakageReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    /**
     * Override review to skip when recipient is primary-user.
     */
    review(context: ReviewContext): Promise<ReviewResult>;
    protected buildPrompt(context: ReviewContext): string;
}
//# sourceMappingURL=information-leakage.d.ts.map