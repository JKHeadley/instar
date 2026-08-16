/**
 * SlackApiClient — Zero-SDK HTTP client for the Slack Web API.
 *
 * All Slack API calls go through this class, which handles:
 * - Authentication (bot token vs app token)
 * - Rate limit detection and retry (Retry-After header)
 * - Error classification (permanent vs transient)
 * - Token redaction in logs
 */
import { getTier } from './types.js';
import { redactToken } from './sanitize.js';
/** Errors that indicate the token is permanently invalid. */
const PERMANENT_ERRORS = new Set([
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'org_login_required',
    'ekm_access_denied',
    'missing_scope',
    'not_authed',
]);
export class SlackApiClient {
    botToken;
    appToken;
    constructor(botToken, appToken) {
        this.botToken = botToken;
        this.appToken = appToken ?? null;
    }
    /**
     * Call a Slack Web API method.
     *
     * @param method - API method name (e.g., 'chat.postMessage')
     * @param params - JSON body parameters
     * @param options - Token selection and retry options
     * @returns Parsed JSON response
     * @throws Error on non-ok response (after retries for rate limits)
     */
    async call(method, params = {}, options = {}) {
        const token = options.useAppToken ? this.appToken : this.botToken;
        if (!token) {
            throw new Error(`[slack-api] No ${options.useAppToken ? 'app' : 'bot'} token configured`);
        }
        const maxRetries = options.maxRetries ?? 3;
        return this._callWithRetry(method, params, token, 0, maxRetries);
    }
    /** Get the rate limit tier for a method. */
    getTier(method) {
        return getTier(method);
    }
    async _callWithRetry(method, params, token, attempt, maxRetries) {
        const response = await fetch(`https://slack.com/api/${method}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify(params),
        });
        const data = (await response.json());
        // Rate limit handling
        if (data.error === 'ratelimited' && attempt < maxRetries) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
            const tier = getTier(method);
            console.warn(`[slack-api] Rate limited on ${method} (tier ${tier}). Retry in ${retryAfter}s (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            return this._callWithRetry(method, params, token, attempt + 1, maxRetries);
        }
        if (!data.ok) {
            const isPermanent = PERMANENT_ERRORS.has(data.error || '');
            const redacted = redactToken(token);
            const err = new SlackApiError(`Slack API ${method} failed: ${data.error}`, method, data.error || 'unknown', isPermanent);
            if (isPermanent) {
                console.error(`[slack-api] Permanent error on ${method}: ${data.error} (token: ${redacted})`);
            }
            throw err;
        }
        return data;
    }
}
/** Typed error for Slack API failures. */
export class SlackApiError extends Error {
    method;
    slackError;
    permanent;
    constructor(message, method, slackError, permanent) {
        super(message);
        this.name = 'SlackApiError';
        this.method = method;
        this.slackError = slackError;
        this.permanent = permanent;
    }
}
//# sourceMappingURL=SlackApiClient.js.map