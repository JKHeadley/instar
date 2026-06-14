/**
 * Input sanitization for Slack adapter.
 *
 * Prevents prompt injection, path traversal, and SSRF attacks
 * by validating and cleaning user-controlled fields before use.
 *
 * CONTRACT-EVIDENCE: EXEMPT — this module is pure local string
 * validation/transformation; it makes no Slack API calls and touches no
 * API-contract surface. The change here adds `slugifyChannelName`, a pure
 * helper covered by unit tests; live-API contract tests are not applicable.
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
 * Slugify an agent/workspace-derived segment into a Slack-channel-safe form.
 *
 * Slack channel names must be lowercase alphanumeric with hyphens/underscores
 * (see {@link validateChannelName}). A raw workspaceName such as
 * "SageMind Live Test" otherwise produces an invalid name like
 * "SageMind Live Test-sys-updates" that `ChannelManager.createChannel`
 * rejects. This mirrors the session-channel slugify in `SlackAdapter`
 * (`<workspace>-sess-...`): lowercase, replace every non-`[a-z0-9]` char with
 * a hyphen, collapse runs, trim leading/trailing hyphens. Falls back to
 * "agent" when the input slugs away to empty.
 *
 * The result is a single name SEGMENT (callers append suffixes like
 * `-sys-updates`); it is intentionally not length-clamped here so a short
 * suffix still fits inside Slack's 80-char limit.
 */
export function slugifyChannelName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'agent';
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
