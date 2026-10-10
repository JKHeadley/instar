/**
 * Credential-shaped environment variable names (docs/specs/feedback-triage-and-execution.md §4,
 * `omitAuthEnv`). Shared by SessionManager's confined spawn and the feedback executor's confined
 * commands: a confined process never inherits one of these.
 */
/** Environment variable names a confined process must never inherit (credentials and the agent's own authority). */
export const CREDENTIAL_ENV_EXACT = new Set([
  'INSTAR_AUTH_TOKEN', 'INSTAR_ORIGIN_TOKEN', 'INSTAR_BIND_TOKEN', 'INSTAR_FENCING_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_DEPLOYMENT_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'DATABASE_URL', 'DIRECT_DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'BW_SESSION', 'FEEDBACK_INBOX_BLOB_TOKEN', 'VERCEL_TOKEN', 'CLOUDFLARE_API_TOKEN',
]);
export const CREDENTIAL_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH)/i;


/** True for an env var name a confined spawn must drop. */
export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV_EXACT.has(name) || CREDENTIAL_ENV_PATTERN.test(name);
}

/**
 * CLI arguments a confined Claude Code session runs with INSTEAD of `--dangerously-skip-permissions`:
 * `dontAsk` refuses every tool use the settings do not allow (an allowlist — in bypass mode only
 * deny rules apply, and a write to a path created after spawn slipped through; the live canary
 * caught it), and only file and shell tools exist (no web, no MCP, no sub-agents).
 */
export const CLAUDE_CONFINED_PERMISSION_ARGS = ['--permission-mode', 'dontAsk', '--tools', 'Bash,Read,Edit,Write,Glob,Grep,TodoWrite'] as const;
