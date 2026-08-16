# Upgrade Guide — v1.0.11 (portability hardening 5 of 6)

<!-- bump: patch -->

## What Changed

Fifth of the six cross-framework portability hardening patches (v1.0.9–v1.0.14).

`enabledFrameworks` is now a real, settable config field. The post-update
migrator reads it through a single helper and skips Claude-Code-only
scaffolding for a Codex-only install. Previously the migrator had only inert
gating logic — the field it read was never a real config option, so the gate
never triggered.

The migrator step that maintains `.claude/settings.json` (Claude Code's
hook/MCP configuration, meaningless to Codex) now skips for an install that
does not list `claude-code` in `enabledFrameworks`. The default — when the
field is unset — is `['claude-code']`, so existing and dual-runtime installs
behave exactly as before.

## Evidence

Reproduction prior to this change: the migrator read `enabledFrameworks`
defensively in one place, but it was never an actual config field — always
undefined, always defaulting to Claude Code, so no Claude-only step could ever
be skipped for a Codex-only install.

Observed after this change: setting `enabledFrameworks` to `["codex-cli"]` in
the config makes the `.claude/settings.json` migrator step skip with a clear
note. Leaving the field unset keeps the default `["claude-code"]` and the step
runs exactly as before. A single helper now resolves the framework set and the
previously-duplicated inline logic was refactored to use it.

Unit verification: `tests/unit/PostUpdateMigrator-frameworkGate.test.ts` — six
cases: default when the field is absent; default when the config file is
absent; honors a Codex-only config; honors a dual config; the settings step
skips for a Codex-only install (proving the gate is reachable, not inert); the
settings step does NOT skip on the default install (negative side). The eleven
existing parity-renderings tests pass unchanged, confirming the refactor
preserved behavior.

## What to Tell Your User

- "You can now mark an agent as Codex-only, and updates will stop scaffolding Claude-Code-only configuration it would never use. If you do not set this, nothing changes — every existing agent keeps behaving exactly as before."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `enabledFrameworks` config field | Set it in the config to `["codex-cli"]`, `["claude-code"]`, or both. Unset defaults to `["claude-code"]`. |
| Framework-gated migration | Automatic. Claude-Code-only migrator steps skip when `claude-code` is not enabled. |

## Deferred (Tracked Follow-ups)

- Remaining legacy `.claude/`-specific migrator steps can adopt the shared
  framework helper incrementally; doing all of them in one change would be
  regression-prone, so the mechanism plus one proven guarded step ships here.
- Two cross-framework gaps remain (v1.0.x): framework-aware connector-server
  registration and a framework session-transcript store. Both depend on
  external Codex specifics and will ship as documented extension points rather
  than guessed implementations.
