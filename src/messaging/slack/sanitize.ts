/**
 * Input sanitization for Slack adapter.
 *
 * Prevents prompt injection, path traversal, and SSRF attacks
 * by validating and cleaning user-controlled fields before use.
 *
 * CONTRACT-EVIDENCE: EXEMPT — pure string-validation/slug helpers; this module
 * makes NO Slack API calls and touches no API-contract surface. The added
 * slugifyChannelName is covered by tests/unit/slack-channel-slug.test.ts.
 */

const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{8,12}$/;
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9\-_]{0,79}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const INJECTION_CHARS = /[[\]<>]/g;

/**
 * Sanitize a Slack display name for safe injection into session context.
 *
 * Strips brackets, angle brackets, newlines, control characters.
 * Truncates to 64 chars.
 */
export function sanitizeDisplayName(name: string): string {
  return name
    .replace(CONTROL_CHARS, '')
    .replace(INJECTION_CHARS, '')
    .trim()
    .slice(0, 64);
}

/**
 * Validate a Slack channel ID format.
 * Must match ^[CDG][A-Z0-9]{8,12}$ (C = public, D = DM, G = group/private).
 */
export function validateChannelId(id: string): boolean {
  return CHANNEL_ID_PATTERN.test(id);
}

/**
 * Validate a Slack channel name.
 * Must be lowercase alphanumeric with hyphens/underscores, max 80 chars.
 */
export function validateChannelName(name: string): boolean {
  return CHANNEL_NAME_PATTERN.test(name);
}

/**
 * Slugify an arbitrary string into a valid Slack channel name.
 *
 * Slack channel names must be lowercase and may only contain [a-z0-9-_]
 * (see {@link validateChannelName}). A workspace-derived name like
 * "SageMind Live Test" contains spaces and uppercase, which `createChannel`
 * rejects via validate-and-throw. This produces a guaranteed-valid slug:
 * lowercase, non-[a-z0-9] runs collapsed to a single hyphen, leading/trailing
 * hyphens trimmed, and clamped to Slack's 80-char limit.
 *
 * Mirrors the session-channel slug logic in SlackAdapter.
 */
export function slugifyChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Validate that a URL hostname belongs to *.slack.com.
 * Used to prevent SSRF via manipulated upload URLs.
 */
export function validateSlackHostname(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'slack.com' || parsed.hostname.endsWith('.slack.com');
  } catch {
    return false;
  }
}

/**
 * Escape text for Slack mrkdwn format.
 * Escapes &, <, > to prevent mrkdwn injection in user-supplied fields.
 */
export function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Redact a Slack token for safe logging.
 * Shows first 8 chars + "..." to identify the token type without exposing the secret.
 */
export function redactToken(token: string): string {
  if (token.length <= 12) return '***';
  return token.slice(0, 8) + '...';
}
