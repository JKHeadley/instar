---
title: "Install framework flag — ELI16"
slug: "install-framework-flag-eli16"
parent: "install-framework-flag.md"
---

# Install framework flag — explained simply

## The problem

Today, when someone sets up an Instar agent, the tool doesn't ask which AI
runtime they want. It just assumes Claude Code. All the plumbing UNDERNEATH
already knows how to handle either Claude or Codex (we shipped that this
morning), but the install command itself had no question to ask. So even a
Codex user ended up with a Claude-shaped setup.

## The fix

`instar init` now takes a `--framework` flag. Three values: `claude-code`
(the default — exactly today's behavior), `codex-cli` (Codex-only install),
or `both`. Whatever the user picks gets written into the agent's config, and
every downstream step we shipped this morning reads it.

This is the first of four pieces. By itself it just records the choice;
the next three pieces actually act on it (stop writing Claude-only files
when Codex is chosen, ask the same question in setup, and run the wizard
through the chosen runtime).

## Why it's safe

Default unchanged. A user who doesn't pass the flag gets exactly today's
behavior. Five tests pin every value of the flag plus the default plus a
no-shared-state invariant. No behavior changes for anyone until they
opt in.
