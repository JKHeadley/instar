/**
 * SlackApiClient — Zero-SDK HTTP client for the Slack Web API.
 *
 * All Slack API calls go through this class, which handles:
 * - Authentication (bot token vs app token)
 * - Rate limit detection and retry (Retry-After header)
 * - Error classification (permanent vs transient)
 * - Token redaction in logs
 */
import { type RateLimitTier } from './types.js';
export interface SlackApiOptions {
    /** Use app-level token instead of bot token */
    useAppToken?: boolean;
    /** Max retries on rate limit (default: 3) */
    maxRetries?: number;
}
export interface SlackApiResponse {
    ok: boolean;
    error?: string;
    response_metadata?: {
        next_cursor?: string;
        retry_after?: number;
    };
    [key: string]: unknown;
}
export declare class SlackApiClient {
    private botToken;
    private appToken;
    constructor(botToken: string, appToken?: string);
    /**
     * Call a Slack Web API method.
     *
     * @param method - API method name (e.g., 'chat.postMessage')
     * @param params - JSON body parameters
     * @param options - Token selection and retry options
     * @returns Parsed JSON response
     * @throws Error on non-ok response (after retries for rate limits)
     */
    call(method: string, params?: Record<string, unknown>, options?: SlackApiOptions): Promise<SlackApiResponse>;
    /** Get the rate limit tier for a method. */
    getTier(method: string): RateLimitTier;
    private _callWithRetry;
}
/** Typed error for Slack API failures. */
export declare class SlackApiError extends Error {
    readonly method: string;
    readonly slackError: string;
    readonly permanent: boolean;
    constructor(message: string, method: string, slackError: string, permanent: boolean);
}
//# sourceMappingURL=SlackApiClient.d.ts.map