# CLI unknown-command trap - ELI16

The one-line version: a typo in the first `instar` command word now fails fast instead of opening the setup wizard.

## The problem

`instar` with no arguments intentionally starts the interactive setup flow. That is useful for humans, but a typo like `instar dev:claim-checkk` could be interpreted as the bare command path and fall into setup instead of exiting. In an agent shell, that looks like a hung command.

## What changed

The CLI now checks the first positional argument immediately before parsing. If there is no argument, or the first argument is an option like `--version`, behavior is unchanged. If the first positional argument is not a registered top-level command or alias, the CLI prints a clear unknown-command error and exits with code 1. The implicit `help` command is treated as known even though Commander does not include it in the normal command list.

## What did not change

Bare `instar` still starts setup. Known commands such as `instar server`, `instar dev:claim-check`, `instar help`, and `instar --version` keep their existing behavior.

## Why this is narrow

The guard only handles the top-level command token. It does not rewrite nested command behavior or change any setup/init logic. Commander still owns parsing for known command families.
