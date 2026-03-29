/**
 * URL Validity Reviewer — Catches fabricated or constructed URLs.
 *
 * Only receives extracted URLs and channel context (data minimization).
 * Detects URLs that appear to be guessed from project names rather than
 * retrieved from actual tool output.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
export declare class UrlValidityReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    protected buildPrompt(context: ReviewContext): string;
}
/**
 * Extract URLs from a text string.
 */
export declare function extractUrls(text: string): string[];
//# sourceMappingURL=url-validity.d.ts.map