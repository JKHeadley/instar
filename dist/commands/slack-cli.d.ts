/**
 * CLI commands for Slack adapter management.
 *
 * `instar add slack` — Interactive token input (stdin-only for security).
 * `instar remove slack` — Remove config and purge associated data.
 */
/**
 * Add Slack adapter interactively.
 * Tokens are collected via stdin (never as CLI arguments for security).
 */
export declare function addSlack(): Promise<void>;
/**
 * Remove Slack adapter and purge associated data.
 */
export declare function removeSlack(): Promise<void>;
//# sourceMappingURL=slack-cli.d.ts.map