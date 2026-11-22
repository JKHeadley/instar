# Internal judges on the subscription pool run with no tools and a fresh window each time

<!-- bump: patch -->

## What Changed

SEC-172. When `intelligence.subscriptionPath.mode` is `force` or `auto`, internal judgment calls (reply gates, intent classifiers, sentinels) can be served by the interactive subscription pool: long-lived `claude` REPLs in tmux. Those REPLs were spawned with `--dangerously-skip-permissions` and every built-in tool, ran in a folder inside the agent home (so the agent's project CLAUDE.md loaded), and went back to ready after each prompt, serving up to 50 judgments in one conversation. Several judgments embed text from peer agents, Slack members or team members, so a hidden instruction was stopped only by the model refusing.

Every pool REPL is now spawned with `--tools ''` (no built-in tools), `--strict-mcp-config` (no MCP servers), `--setting-sources user` (no project CLAUDE.md, hooks or settings) and `--disable-slash-commands`. `--dangerously-skip-permissions` stays because with no tools it grants nothing, and it keeps the folder-trust question from appearing at spawn. Every pool REPL now serves exactly one prompt, then is retired and replaced in the background, so no judgment reads another judgment's text. `maxMessagesPerSession` is no longer consulted.

Agents with the subscription path `off` (the default) are unaffected.

## What to Tell Your User

- **Safer quick judgments**: "The small checks I run on incoming messages can no longer be talked into using tools, and each one starts fresh."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pool judges run with no tools and one prompt per window | Automatic when the subscription path is on |

## Evidence

- `tests/unit/sec172-pool-judge-lockdown.test.ts`: the spawn argv carries the empty tool list, strict MCP, user-only settings and no slash commands; a released session is killed and replaced, and four allocations in a row never get the same session even with the old 50-message setting.
- Live on Claude Code 2.1.330: through the real pool code, a judgment asked to write a file answered that it had no tool and no file appeared; the next judgment could not recall a codeword from the previous one. With the old argv, the same REPL loaded the agent's CLAUDE.md and wrote the file.
