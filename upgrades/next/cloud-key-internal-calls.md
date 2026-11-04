# Cloud agents: the sign-in key reaches internal model calls, and a dead key is told and recovers

<!-- bump: patch -->

## What Changed

An agent signed in with one key (`sessions.credentials.anthropic`, every headless cloud install) passed it to sessions only. `ClaudeCliIntelligenceProvider` ran `claude -p` with the server's own env, so every internal model call answered "Not logged in". Every server-side `claude` child now gets the same key: the provider's default and hardened paths, project rounds, the headless one-shot, Threadline pipe sessions, the lifeline doctor and triage. Direct children take it through their env; shell and tmux launches source a private file that is deleted before `claude` starts, so the key stays out of argv.

New `ClaudeKeyHealth`, active only with an oauth-token configured. A failed call or a session at the login screen asks for a direct probe. Only Anthropic's 401, seen twice, makes a key dead; "Not logged in" is reported as an Instar fault. The operator gets one notice, each waiting person is told once, and authenticated `/health` shows `claudeKey`. `instar set-claude-key` puts a new key in place, a running server finds it within a minute with no restart, and once a probe proves it, conversations at the login screen restart and answer what they missed. `SessionManager.setAnthropicKey` carries the key into its config copy.

## What to Tell Your User

If your agent runs on a cloud server with a sign-in key, its background checks now work. Those checks review outgoing messages and sort incoming ones, and until now they failed quietly on these installs. If the key ever stops working, your agent tells you plainly and says how to fix it. Once a new key is in place, open conversations pick up by themselves. A conversation that ended during the outage is not replayed.

## Summary of New Capabilities

- `instar set-claude-key` puts a new Claude sign-in key in place, from stdin or a hidden prompt.
- Authenticated `GET /health` shows `claudeKey` on agents signed in with a key.
- Off switches: `sessions.claudeKeyHealth.enabled: false` and `sessions.claudeChildAuth.enabled: false`.

## Evidence

Found on nimbus by the customer proof (fb-03ec0234-b5b, fb-1dc4a0ca-260): PromptGate 463/463 errors, `llmReliability` failing. Real CLI failure output was captured on Claude Code 2.1.316 and is pinned in `tests/unit/ClaudeKeyHealth.test.ts`. `tests/unit/claude-spawn-auth-class.test.ts` fails if a new `claude` launch site neither takes the key nor says why not.
