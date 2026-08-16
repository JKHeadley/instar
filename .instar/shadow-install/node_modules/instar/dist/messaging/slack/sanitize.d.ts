/**
 * Input sanitization for Slack adapter.
 *
 * Prevents prompt injection, path traversal, and SSRF attacks
 * by validating and cleaning user-controlled fields before use.
 */
/**
 * Sanitize a Slack display name for safe injection into session context.
 *
 * Strips brackets, angle brackets, newlines, control characters.
 * Truncates to 64 chars.
 */
export declare function sanitizeDisplayName(name: string): string;
/**
 * Validate a Slack channel ID format.
 * Must match ^[CDG][A-Z0-9]{8,12}$ (C = public, D = DM, G = group/private).
 */
export declare function validateChannelId(id: string): boolean;
/**
 * Validate a Slack channel name.
 * Must be lowercase alphanumeric with hyphens/underscores, max 80 chars.
 */
export declare function validateChannelName(name: string): boolean;
/**
 * Validate that a URL hostname belongs to *.slack.com.
 * Used to prevent SSRF via manipulated upload URLs.
 */
export declare function validateSlackHostname(url: string): boolean;
/**
 * Escape text for Slack mrkdwn format.
 * Escapes &, <, > to prevent mrkdwn injection in user-supplied fields.
 */
export declare function escapeMrkdwn(text: string): string;
/**
 * Redact a Slack token for safe logging.
 * Shows first 8 chars + "..." to identify the token type without exposing the secret.
 */
export declare function redactToken(token: string): string;
//# sourceMappingURL=sanitize.d.ts.map