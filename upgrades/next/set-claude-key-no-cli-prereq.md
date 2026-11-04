<!-- internal-only -->
# set-claude-key works without the Claude CLI installed

## What Changed
`instar set-claude-key` no longer calls `loadConfig`, so it no longer fails with "Claude CLI not found" on a machine where the Claude CLI is not installed. It finds `<project>/.instar/config.json` directly.

## Evidence
main CI run 41830360617 failed `tests/e2e/claude-key-alive.test.ts` with "Claude CLI not found" from `loadConfig` called in `setClaudeKey`. With the fix the test passes locally (5/5).
