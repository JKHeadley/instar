---
title: "Framework-spawn portability — codex agents spawn Codex sessions"
slug: "framework-spawn-portability"
author: "echo"
eli16-overview: "framework-spawn-portability.eli16.md"
review-convergence: "2026-05-22T18:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T18:30:00Z"
review-report: "docs/specs/reports/framework-spawn-portability-convergence.md"
approved: true
---

# Framework-spawn portability — codex agents spawn Codex sessions

## Problem statement

A user messaged a codex-cli-only agent ("codey") in its Lifeline
Telegram topic. The agent spawned a **Claude Code** session to
handle the message — even though the install was Codex-only
(`enabledFrameworks: ['codex-cli']`). This is a critical
framework-portability violation: the entire point of the
codex-cli framework is that the agent runs on Codex, not Claude.

### Root cause (two compounding bugs)

**Bug 1 — `spawnInteractiveSession` hardcoded the framework
default.** The interactive-session spawn path (which handles
Telegram/Slack messages) resolved its framework as:

```ts
const framework = options?.framework ?? 'claude-code';
```

It did NOT read the agent's config or the `INSTAR_FRAMEWORK` env —
unlike `spawnSession` (the scheduled-job path), which at least
read the env via `resolveInteractiveFramework`. The
messaging-triggered callsites (`server.ts` lifeline handlers) never
pass `options.framework`, so the interactive path ALWAYS defaulted
to claude-code.

**Bug 2 — the runtime read a different config field than the
wizard wrote.** The wizard/init persists the framework choice as
top-level `config.enabledFrameworks` (e.g. `['codex-cli']`). But
the runtime's framework resolution (`resolveConfiguredFramework`
in Config.load) only consulted `sessions.framework` and the
`INSTAR_FRAMEWORK` env — NEITHER of which the wizard sets. So a
codex-cli agent had:

- `enabledFrameworks: ['codex-cli']` ✓ (set by wizard)
- `sessions.framework`: unset
- `INSTAR_FRAMEWORK` env: unset

…and the runtime resolution defaulted to claude-code. Even fixing
Bug 1 to read config wouldn't help, because the config field the
runtime read was empty.

The two halves of the codebase used different fields for "what
framework is this agent."

## Proposed design

Make `enabledFrameworks` the single source of truth that flows into
the runtime, and route both spawn paths through it.

### Change 1 — `resolveConfiguredFramework` reads enabledFrameworks

Add a third input. New precedence:

1. `sessions.framework` (explicit per-install runtime override)
2. `INSTAR_FRAMEWORK` env (explicit per-boot override)
3. `enabledFrameworks[0]` (the wizard's persisted install choice)
4. `'claude-code'` (historical default)

Also handle the `INSTAR_FRAMEWORK=claude-code|claude` env case
explicitly (previously only `codex` was recognized; a
`claude-code` env value fell through to the default, which was
fine when the default was claude but matters now that
enabledFrameworks can override the default).

### Change 2 — Config.load stores the resolved framework

`Config.load` passes `fileConfig.enabledFrameworks` into
`resolveConfiguredFramework`, then stores the result on the
SessionManagerConfig as a new `framework` field. This makes the
agent's resolved runtime framework a first-class config value the
SessionManager can read directly.

### Change 3 — both spawn paths read `config.framework`

- `spawnInteractiveSession`: replace the hardcoded
  `options?.framework ?? 'claude-code'` with
  `resolveInteractiveFramework({ perCall: options?.framework,
  configFramework: this.config.framework, envFramework:
  frameworkFromEnv() })`.
- `spawnSession`: change `configFramework: undefined` to
  `configFramework: this.config.framework`.

Both now resolve identically: per-call override > config.framework
> env > claude-code.

### Why this fixes existing agents on update

The fix is a config-LOAD-time derivation. Existing codex-cli
agents already have `enabledFrameworks: ['codex-cli']` on disk
(written by their install). The moment they update to this version
and their server reloads config, `config.framework` resolves to
codex-cli and both spawn paths honor it. No migration needed — no
on-disk config change required.

## Decision points touched

- `enabledFrameworks` becomes the AUTHORITY for the agent's runtime
  framework (was: only an input to the migrator + parity sentinel).
- The per-call `options.framework` remains the highest-precedence
  SIGNAL (lets a caller force a framework for a specific session).
- `INSTAR_FRAMEWORK` env remains a valid per-boot override, slotted
  between explicit config and the persisted install choice.

## Open questions

None. The fix is a precedence change + one config field + two
one-line spawn-path edits.

## Out of scope

- Persisting `sessions.framework` at init time. Not needed — the
  load-time derivation from `enabledFrameworks` covers it, and
  fixes already-installed agents without a migration. A future
  cleanup could also write `sessions.framework` for redundancy,
  but it's not required.
- Multi-framework agents picking different frameworks per topic.
  Today `enabledFrameworks[0]` is the single runtime default;
  per-topic framework selection is a separate feature.
- The Codex wizard prompt (separate concern, already shipped).
