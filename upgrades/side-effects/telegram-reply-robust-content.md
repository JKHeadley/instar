# Side-effects review — telegram reply robust content mode

## What changed

`telegram-reply.sh` now accepts `--stdin-base64` / `--base64-stdin`. In that mode, the script decodes the provided base64 payload before building the existing JSON request body. This gives agents a transport-safe path when the reply text itself contains shell metacharacters, quotes, JSON-looking text, or a literal heredoc delimiter line.

The normal heredoc path remains unchanged. The new mode is additive and only activates when the flag is present.

## Why

The standard relay instruction uses a single-quoted heredoc. That protects most shell-sensitive text, but it still fails when the response body contains a line that exactly matches the heredoc delimiter. During Gemini mentoring, Gemi hit this class directly: its heredoc relay attempt ended in a shell syntax error, then it recovered by squeezing the response into a quoted argument. That workaround is fragile for long or structured replies.

Base64 stdin moves the fragile bytes out of shell syntax entirely. The shell only carries base64 characters; the canonical reply script restores the original text before sending.

## Migration footprint

Existing unmodified `telegram-reply.sh` copies are SHA-migrated by `PostUpdateMigrator`. This PR registers the v1.3.266 template SHA as a prior shipped version so deployed agents receive the new script on update. Locally modified scripts are still preserved: the migrator writes a `.new` candidate and reports the existing relay-script-modified-locally degradation instead of overwriting custom content.

Generated identity/scaffold guidance now keeps the familiar heredoc example and adds the base64 fallback for delimiter-sensitive content.

## Risk

Low. The default send path, HTTP route, auth headers, port resolution, tone-gate handling, 408 ambiguous handling, recoverable relay queue, and JSON body shape are unchanged. The new branch only decodes input before the existing JSON builder.

The main operational risk is invalid base64 input; the script exits before contacting the server and prints a clear error.

## Tests

- Unit: `tests/unit/telegram-reply-port-resolution.test.ts` now proves `--stdin-base64` sends shell-sensitive text and a literal `EOF` line as exact message text.
- Unit: existing `PostUpdateMigrator-telegramReply`, `migration-relay-script-hash`, `IdentityRenderer`, and `telegramRelayPrompt` tests cover migration and generated guidance.
- Focused run: 58 tests passed across those five files.
