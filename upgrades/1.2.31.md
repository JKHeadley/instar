# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fix, no new capability, no breaking change -->

## What Changed

**fix(framework): Codex-only agents now spawn Codex sessions on every path.**

A Codex-only agent ("codey") spawned a Claude Code session when messaged on
Telegram — even though the install was Codex-only. The whole point of a
codex-cli install is that the agent runs on Codex, so this was a direct
framework-portability violation.

Two compounding bugs caused it:

1. **`spawnInteractiveSession` hardcoded the framework default.** The
   interactive-session path — the one that handles incoming Telegram/Slack
   messages — resolved its framework as `options?.framework ?? 'claude-code'`.
   It never read the agent's config or the `INSTAR_FRAMEWORK` env. The
   messaging callsites never pass `options.framework`, so this path ALWAYS
   defaulted to claude-code.

2. **The runtime read a different config field than the wizard wrote.** The
   setup wizard persists the framework choice as top-level
   `config.enabledFrameworks` (e.g. `['codex-cli']`). But the runtime's
   `resolveConfiguredFramework` only consulted `sessions.framework` and
   `INSTAR_FRAMEWORK` — neither of which the wizard sets. So a codex-cli agent
   had `enabledFrameworks: ['codex-cli']` set, both other fields empty, and the
   runtime resolved claude-code.

The fix makes `enabledFrameworks` the authority that flows into the runtime.
`resolveConfiguredFramework` now takes `enabledFrameworks` as a third input
with precedence `sessions.framework` → `INSTAR_FRAMEWORK` env →
`enabledFrameworks[0]` → `'claude-code'`. `Config.load` stores the resolved
value as a new `config.framework` field, and BOTH spawn paths
(`spawnSession` for jobs, `spawnInteractiveSession` for messages) now read it.
A per-call `options.framework` override still wins, so a caller can force a
specific framework for one session.

Because the fix derives the framework at config-load time from a field existing
agents already have on disk, deployed Codex agents are fixed the moment they
update and reload — no reinstall, no migration.

## Evidence

The original failure: messaging codey (an agent installed with
`enabledFrameworks: ['codex-cli']`, no `sessions.framework`, no
`INSTAR_FRAMEWORK` env) in its Lifeline topic spawned a Claude Code session.

10 new unit tests in `tests/unit/framework-spawn-portability.test.ts`
reproduce and lock the fix:

1. `resolveConfiguredFramework` returns codex-cli when only
   `enabledFrameworks: ['codex-cli']` is set (the codey configuration) — was
   claude-code before the fix.
2. Explicit `sessions.framework` still wins over enabledFrameworks.
3. `INSTAR_FRAMEWORK=codex` env wins over an enabledFrameworks of claude-code.
4. `INSTAR_FRAMEWORK=claude` env wins over an enabledFrameworks of codex-cli
   (the new explicit-claude env branch).
5. Empty/absent inputs still resolve to the claude-code historical default.
6. Per-call `options.framework` is highest precedence.
7–8. Source-grep assertions that both `spawnSession` and
   `spawnInteractiveSession` resolve via `this.config.framework` (catches a
   regression that re-hardcodes the default).
9–10. `Config.load` wiring — `enabledFrameworks` flows into
   `config.framework`.

All 11 existing `frameworkPrerequisite.test.ts` tests still pass — the shared
resolver behaves identically for every previously-covered case. `tsc --noEmit`
clean, lint clean.

## What to Tell Your User

If you set up an agent to run on Codex, it will now correctly run on Codex
every time — including when you message it. Before this fix, a Codex-only agent
could quietly start up on Claude instead when you sent it a message, which was
the wrong engine entirely.

You do not need to do anything. There is no reinstall and no setup to redo. The
next time your agent updates and restarts, it reads the framework choice already
saved from when you set it up, and uses it for every session from then on.
Agents set up on Claude, or set up to use both, keep working exactly as before.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex-only agents spawn Codex on all paths (jobs + messages) | Automatic — derived from your install-time framework choice |
| Existing Codex agents fixed on update | Automatic — no reinstall or migration; the choice is read from disk at startup |
