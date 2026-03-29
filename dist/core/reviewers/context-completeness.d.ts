/**
 * Context Completeness Reviewer — Catches missing context for decisions.
 *
 * Detects when the agent presents decisions, recommendations, or status updates
 * without providing the context the user would need.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
export declare class ContextCompletenessReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    protected buildPrompt(context: ReviewContext): string;
}
//# sourceMappingURL=context-completeness.d.ts.map