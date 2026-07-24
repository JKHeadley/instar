/**
 * SlackApiClient — Zero-SDK HTTP client for the Slack Web API.
 *
 * All Slack API calls go through this class, which handles:
 * - Authentication (bot token vs app token)
 * - Rate limit detection and retry (Retry-After header)
 * - Error classification (permanent vs transient)
 * - Token redaction in logs
 */

import { getTier, type RateLimitTier } from './types.js';
import { redactToken } from './sanitize.js';
import { Agent } from 'undici';

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

const FETCH_FAILURES_BEFORE_TRANSPORT_RESET = 3;

export class SlackApiClient {
  private botToken: string;
  private appToken: string | null;
  private consecutiveFetchFailures = 0;
  private dispatcher: Agent;

  constructor(botToken: string, appToken?: string) {
    this.botToken = botToken;
    this.appToken = appToken ?? null;
    this.dispatcher = new Agent({
      connections: 10,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
    });
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
  async call(
    method: string,
    params: Record<string, unknown> = {},
    options: SlackApiOptions = {},
  ): Promise<SlackApiResponse> {
    const token = options.useAppToken ? this.appToken : this.botToken;
    if (!token) {
      throw new Error(`[slack-api] No ${options.useAppToken ? 'app' : 'bot'} token configured`);
    }

    const maxRetries = options.maxRetries ?? 3;
    return this._callWithRetry(method, params, token, 0, maxRetries);
  }

  /** Get the rate limit tier for a method. */
  getTier(method: string): RateLimitTier {
    return getTier(method);
  }

  private async _callWithRetry(
    method: string,
    params: Record<string, unknown>,
    token: string,
    attempt: number,
    maxRetries: number,
  ): Promise<SlackApiResponse> {
    let response: Response;
    try {
      response = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(params),
        // Keep the recovery pool scoped to Slack requests. Rebuilding a
        // process-global dispatcher could disrupt unrelated HTTP clients.
        dispatcher: this.dispatcher,
      } as RequestInit & { dispatcher: Agent });
      this.consecutiveFetchFailures = 0;
    } catch (error) {
      this.consecutiveFetchFailures++;
      if (this.consecutiveFetchFailures >= FETCH_FAILURES_BEFORE_TRANSPORT_RESET) {
        this.resetHttpTransport();
      }
      throw error;
    }

    const data = (await response.json()) as SlackApiResponse;

    // Rate limit handling
    if (data.error === 'ratelimited' && attempt < maxRetries) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
      const tier = getTier(method);
      console.warn(
        `[slack-api] Rate limited on ${method} (tier ${tier}). Retry in ${retryAfter}s (attempt ${attempt + 1}/${maxRetries})`,
      );
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return this._callWithRetry(method, params, token, attempt + 1, maxRetries);
    }

    if (!data.ok) {
      const isPermanent = PERMANENT_ERRORS.has(data.error || '');
      const redacted = redactToken(token);
      const err = new SlackApiError(
        `Slack API ${method} failed: ${data.error}`,
        method,
        data.error || 'unknown',
        isPermanent,
      );
      if (isPermanent) {
        console.error(`[slack-api] Permanent error on ${method}: ${data.error} (token: ${redacted})`);
      }
      throw err;
    }

    return data;
  }

  /**
   * Rebuild undici's connection pool after repeated network failures. A Wi‑Fi
   * interface/DNS change can leave keep-alive sockets pinned to the old route;
   * retrying through that pool otherwise fails for the whole outage window.
   */
  private resetHttpTransport(): void {
    this.consecutiveFetchFailures = 0;
    this.dispatcher.close().catch(() => {});
    this.dispatcher = new Agent({
      connections: 10,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
    });
    console.warn('[slack-api] Rebuilt HTTP transport after repeated fetch failures');
  }
}

/** Typed error for Slack API failures. */
export class SlackApiError extends Error {
  readonly method: string;
  readonly slackError: string;
  readonly permanent: boolean;

  constructor(message: string, method: string, slackError: string, permanent: boolean) {
    super(message);
    this.name = 'SlackApiError';
    this.method = method;
    this.slackError = slackError;
    this.permanent = permanent;
  }
}
