/**
 * Capability Accuracy Reviewer — Catches false "I can't" claims.
 *
 * Detects when the agent falsely claims inability or deflects tasks to the user
 * that the agent should handle itself.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
export declare class CapabilityAccuracyReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    protected buildPrompt(context: ReviewContext): string;
}
//# sourceMappingURL=capability-accuracy.d.ts.map