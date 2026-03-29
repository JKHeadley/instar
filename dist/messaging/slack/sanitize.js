/**
 * Input sanitization for Slack adapter.
 *
 * Prevents prompt injection, path traversal, and SSRF attacks
 * by validating and cleaning user-controlled fields before use.
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
export function sanitizeDisplayName(name) {
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
export function validateChannelId(id) {
    return CHANNEL_ID_PATTERN.test(id);
}
/**
 * Validate a Slack channel name.
 * Must be lowercase alphanumeric with hyphens/underscores, max 80 chars.
 */
export function validateChannelName(name) {
    return CHANNEL_NAME_PATTERN.test(name);
}
/**
 * Validate that a URL hostname belongs to *.slack.com.
 * Used to prevent SSRF via manipulated upload URLs.
 */
export function validateSlackHostname(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname === 'slack.com' || parsed.hostname.endsWith('.slack.com');
    }
    catch {
        return false;
    }
}
/**
 * Escape text for Slack mrkdwn format.
 * Escapes &, <, > to prevent mrkdwn injection in user-supplied fields.
 */
export function escapeMrkdwn(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
/**
 * Redact a Slack token for safe logging.
 * Shows first 8 chars + "..." to identify the token type without exposing the secret.
 */
export function redactToken(token) {
    if (token.length <= 12)
        return '***';
    return token.slice(0, 8) + '...';
}
//# sourceMappingURL=sanitize.js.map