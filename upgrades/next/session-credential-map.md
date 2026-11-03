# Sessions read the sign-in key from sessions.credentials.anthropic

<!-- bump: patch -->

## What Changed

Session launch filled CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL only from the legacy `sessions.anthropicApiKey` / `sessions.anthropicBaseUrl`. An install that configured the documented `sessions.credentials.anthropic` therefore launched every claude-code session with an empty token, and it answered "Not logged in". `loadConfig` now resolves the launch fields with the same precedence as `getProviderCredential()`: the explicit `credentials.anthropic` entry first, the legacy fields as the fallback, per field. A non-string value is ignored. Legacy-only installs are unchanged.

## What to Tell Your User

If your agent signs in to Claude with a long-lived key (common on a rented cloud server), putting that key in the recommended credentials setting now works. Before, its conversations could start with "Not logged in".

## Summary of New Capabilities

None. This is a fix: the documented credential setting now reaches every session the agent starts.

## Evidence

Reproduced on a fresh Ubuntu 24.04 cloud agent (Instar 1.3.1611): the launch argv carried an empty `CLAUDE_CODE_OAUTH_TOKEN` and the transcript answered "Not logged in". `tests/unit/anthropic-launch-credential.test.ts` (8 tests). The loadConfig wiring case fails with the old code and passes with the fix.
