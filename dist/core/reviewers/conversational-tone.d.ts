/**
 * Conversational Tone Reviewer — Catches technical language leaking to users.
 *
 * Detects config syntax, file paths, CLI commands, job field names, and
 * technical implementation details that should not be exposed to users.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
export declare class ConversationalToneReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    protected buildPrompt(context: ReviewContext): string;
}
//# sourceMappingURL=conversational-tone.d.ts.map