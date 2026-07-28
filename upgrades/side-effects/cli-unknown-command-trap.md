# Side-Effects Review - CLI unknown-command trap

**Version / slug:** `cli-unknown-command-trap`
**Date:** `2026-06-06`
**Author:** `instar-codey`

## Summary

This change adds a top-level command guard before Commander parses the CLI. Unknown first-position command tokens now print a clear error and exit 1. The existing no-argument setup path is preserved, and Commander’s implicit `help` command remains allowed.

## Decision Points

- Add `rejectUnknownTopLevelCommand` in `src/cli.ts`.
- Call it after all commands are registered and before `program.parse()`.
- Add e2e regression tests for `dist/cli.js dev:claim-checkk` and `dist/cli.js help`.

## Over-Block

Risk: rejecting a legitimate command before Commander sees it. Mitigation: the guard builds its allowlist from `program.commands` and command aliases after registration, and explicitly handles Commander’s implicit `help` command because Commander does not list it in `program.commands` and otherwise sends it into the default setup action. Options and the no-argument path bypass the guard.

## Under-Block

Nested unknown subcommands remain Commander-owned. This fix targets the incident class: unknown top-level command tokens falling into the default setup action.

## Interactions

No server routes, persistent state, messaging, or external APIs change. The behavior changes are limited to process exit behavior for unknown top-level CLI commands and restoring the intended `instar help` help output.

## Rollback

Rollback is a normal revert of the helper, call site, test, and notes. No data migration is involved.
