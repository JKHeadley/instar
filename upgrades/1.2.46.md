# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fix, no new capability, no breaking change -->

## What Changed

**fix(framework): Telegram spawn path now honors the agent's configured framework (codex-cli agents stop spawning Claude sessions).**

A follow-on to the framework-spawn-portability fix (v1.2.31). That fix
made the fresh-spawn path (`spawnInteractiveSession`'s internal
resolution) read the agent's resolved `config.sessions.framework`. But
there are TWO paths that pick a framework, and the **Telegram message
path** was missed.

When a Telegram message arrives, `spawnSessionForTopic` resolves the
framework via `resolveTopicFramework(topicId)`, which returns the
module-level `_defaultFramework` for any topic without an explicit
per-topic override (i.e. every fresh topic). `_defaultFramework` was
initialized in `startServer` as:

```ts
const framework = frameworkFromEnv() ?? 'claude-code';
```

— sourced ONLY from the `INSTAR_FRAMEWORK` environment variable. The
setup wizard sets `enabledFrameworks: ['codex-cli']` in config, NOT the
env var, so for a codex-cli-only agent that didn't export
`INSTAR_FRAMEWORK` (the common case), `frameworkFromEnv()` returned
undefined and `_defaultFramework` fell back to `'claude-code'`. Worse,
`spawnSessionForTopic` passes its resolved framework as the per-call
`options.framework` to `spawnInteractiveSession` — and per-call wins
over `config.framework`. So even though v1.2.31 correctly resolved
`config.framework` to `codex-cli`, the Telegram path's wrong default
overrode it and spawned a Claude session on every message.

The fix: derive `_defaultFramework` from the agent's resolved runtime
framework first, falling back to the env var only when that's unset:

```ts
const framework = config.sessions?.framework ?? frameworkFromEnv() ?? 'claude-code';
```

`config.sessions.framework` is the single resolved source
(`resolveConfiguredFramework(sessions.framework, INSTAR_FRAMEWORK,
enabledFrameworks)` from `Config.load`), so both the fresh-spawn path
and the Telegram path now agree. A codex-cli-only agent spawns Codex
sessions whether the session is created directly via the API or
triggered by a Telegram message.

No migration needed — the fix is a server-startup derivation. Deployed
codex-cli agents get the correct behavior the moment they update and
restart cleanly. (Note: a clean restart IS required — an agent running
an older server process keeps the old `_defaultFramework` in memory
until restarted, even after its files update.)

## Evidence

The original failure: a codex-cli-only agent ("codey") with
`enabledFrameworks: ['codex-cli']` and no `INSTAR_FRAMEWORK` env spawned
a Claude Code (Opus 4.7) session every time it answered a Telegram
message — including in brand-new topics. A direct `/sessions/create`
API spawn correctly produced Codex, which masked the bug (the API path
doesn't pass the Telegram default).

Regression coverage in `tests/unit/framework-spawn-portability.test.ts`
(2 new assertions):

1. `server.ts` derives `_defaultFramework` from `config.sessions?.framework`
   ahead of the `frameworkFromEnv()` fallback.
2. The pre-fix env-only derivation (`const framework = frameworkFromEnv()
   ?? 'claude-code';`) no longer appears in `server.ts`.

These join the existing 10 framework-spawn-portability tests (precedence
of `resolveConfiguredFramework`, the spawn-path source assertions, and
the `Config.load` wiring) — 12 tests total, all passing. `tsc --noEmit`
clean, lint clean.

Empirical confirmation against a live codex-cli agent (message it, watch
the spawned session run `codex --model gpt-5.3-codex` instead of
`claude`) is performed as part of the rollout, per the bug-fix evidence
bar — no "fixed" claim without reproducing the corrected behavior.

## What to Tell Your User

If you set up an agent to run on Codex, it will now correctly run on
Codex when it answers your messages — not just when a session is
created some other way. Before this fix, a Codex-only agent could still
quietly start up on Claude whenever you messaged it, because the
message-handling path was reading the wrong setting. You don't need to
do anything beyond letting your agent update and restart; the Codex
choice you made at setup is now respected on every path.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Telegram message path honors configured framework | Automatic — codex-cli agents spawn Codex on incoming messages |
| Single framework source of truth across both spawn paths | Automatic — derived from your install-time framework choice |
