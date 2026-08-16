/**
 * Feedback Manager — handles the agent-to-origin feedback loop.
 *
 * Stores feedback locally and forwards it to a configured webhook URL.
 * This is the "phone home" mechanism: agents can report issues, request
 * features, and provide feedback that flows back to the Instar maintainers.
 *
 * Part of the "Rising Tide" system — every user's feedback improves
 * the platform for everyone.
 *
 * Security: Sends proper identification headers (User-Agent, X-Instar-Version)
 * so the receiving endpoint can verify requests come from real Instar agents.
 */
import type { FeedbackItem, FeedbackConfig } from './types.js';
export interface FeedbackQualityResult {
    valid: boolean;
    reason?: string;
}
export declare class FeedbackManager {
    private config;
    private feedbackFile;
    private version;
    /** Cache of agentName -> pseudonym for resolvePseudonym reverse lookups */
    private pseudonymMap;
    constructor(config: FeedbackConfig);
    /** Standard headers that identify this as a legitimate Instar agent. */
    private getWebhookHeaders;
    /** Validate webhook URL is HTTPS and not pointing to internal addresses. */
    private static validateWebhookUrl;
    /**
     * Validate feedback content quality.
     * Checks for whitespace-only input, minimum description length, and duplicate titles.
     */
    validateFeedbackQuality(title: string, description: string): FeedbackQualityResult;
    /**
     * Generate a stable pseudonym for an agent name.
     * Uses SHA-256 of (agentName + secret), truncated to 12 hex chars, prefixed with "agent-".
     */
    generatePseudonym(agentName: string): string;
    /**
     * Resolve a pseudonym back to the real agent name.
     * Only works locally since it requires the cached mapping (which needs the secret).
     */
    resolvePseudonym(pseudonym: string): string | null;
    /**
     * Submit feedback — stores locally and forwards to webhook.
     */
    submit(item: Omit<FeedbackItem, 'id' | 'submittedAt' | 'forwarded' | 'agentPseudonym'>): Promise<FeedbackItem>;
    /**
     * List all stored feedback.
     */
    list(): FeedbackItem[];
    /**
     * Get a single feedback item by ID.
     */
    get(id: string): FeedbackItem | null;
    /**
     * Retry forwarding any un-forwarded feedback.
     */
    retryUnforwarded(): Promise<{
        retried: number;
        succeeded: number;
    }>;
    private loadFeedback;
    private saveFeedback;
    private appendFeedback;
    private updateFeedback;
}
//# sourceMappingURL=FeedbackManager.d.ts.map