/**
 * Value Alignment Reviewer — Catches value violations against the three-tier hierarchy.
 *
 * Checks responses against agent values (AGENT.md), user values (USER.md),
 * and org values (ORG-INTENT.md). Uses separate boundaries for each value
 * section. Defaults to 'sonnet' model for higher accuracy.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
export declare class ValueAlignmentReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    protected buildPrompt(context: ReviewContext): string;
}
//# sourceMappingURL=value-alignment.d.ts.map