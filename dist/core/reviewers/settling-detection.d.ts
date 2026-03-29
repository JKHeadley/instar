/**
 * Settling Detection Reviewer — Catches the agent giving up too easily.
 *
 * Detects when the agent accepts empty or failed results without trying
 * alternatives, or reports inability without exploring workarounds.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
export declare class SettlingDetectionReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    protected buildPrompt(context: ReviewContext): string;
}
//# sourceMappingURL=settling-detection.d.ts.map