# Side effects: pool judges run with no tools and one prompt per REPL (SEC-172)

In plain words: internal judgment calls served by the interactive subscription pool ran in `claude` REPLs with every tool, the agent's project instructions, and up to 50 earlier judgments in context. Several judgments embed text from peer agents, Slack members or team members. Each pool REPL now has no tools, no MCP servers, no project settings or instructions, no slash commands, and answers one prompt before it is retired and replaced.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size: `pool.ts` (new exported `buildPoolReplArgs`, `release()` now retires), a deprecation note in `config.ts`, the adapter README, and 1 new unit test file.

## What changes for running agents
- **Only agents with `intelligence.subscriptionPath.mode` `force` or `auto`.** Mode `off` (the default) never builds the pool. Live exposure at the finding: Mini Echo and Mini instar-codey (`force`).
- **Argv.** `claude --tools '' --strict-mcp-config --setting-sources user --disable-slash-commands --dangerously-skip-permissions [--model m]`. Skip-permissions stays: with no tools it grants nothing, and without it a fresh spawn asks the folder-trust question nobody answers (seen live in a folder outside the agent home). The working folder is unchanged for the same reason. The idle markers the pool waits for are unchanged (checked live).
- **One prompt per REPL.** `release()` emits `session:released` then retires the session, which spawns a replacement in the background. `maxMessagesPerSession` is no longer consulted. Every judgment now waits for a REPL cold start when no spare is ready: about 1 second to the idle marker in the live check, more under load. Back-to-back bursts beyond `poolSize` (default 2) queue behind respawns. A failed replacement still uses the existing retry and degradation path.
- **Scheduled canary** (hourly) now retires and replaces the session it borrowed. The startup canary runs on a session no caller has seen.
- **WarmSessionInbox** keeps one session for its own messages by design and gets the same lockdown. Nothing in `src` outside the adapter uses it.
- **Known residuals (not attacker-controlled):** user-level `~/.claude` settings, hooks and global CLAUDE.md still load; the tmux server's environment is inherited. With no tools neither is reachable by the model. `reviewerHardening` (pinned model, JSON schema) is still not honoured on the pool, which was already true; its no-tools part is now always in force.

## Signal vs authority
Not applicable: this removes capabilities from a judge process; it adds no gate.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the finding and the diff), 2026-11-22. Verdict: CONCUR. It confirmed the four flags in `claude --help`, that tmux passes the empty argument intact, that every path that hands out or returns a session now retires it (allocate, waiter flush, release, error path, both canaries, idle sweep), that nothing outside the adapter needs tools (SessionManager's rerouted sessions spawn their own tmux), and that the tests fail on the old code. It suggested a test that a waiting caller is served by the replacement; that test was added. It flagged the cold-start latency as a follow-up to measure.

## Rollback
Revert the commit. No stored state changes.

## Tests
- `tests/unit/sec172-pool-judge-lockdown.test.ts` (new, 5 cases): locked-down argv from the builder and from the real tmux spawn call; release kills and replaces; four allocations never reuse a session even with the old 50-message setting; a waiting caller gets the replacement.
- Existing pool unit tests (model flag, lifecycle, degradation, canary, one-shot retire, spawn auth class) pass unchanged.
- Live on this Mac (Claude Code 2.1.330, my own tmux sessions, removed afterwards): with the old argv the REPL loaded the agent's CLAUDE.md and wrote a file on request. Through the real pool code with the fix, a judgment asked to write a file answered that it had no tool and no file appeared, and the next judgment could not recall a codeword from the previous one.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. One spawn per judgment, bounded by `poolSize` and the existing replacement retry limit.
