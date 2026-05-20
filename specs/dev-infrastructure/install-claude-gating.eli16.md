---
title: "Codex-only init zero .claude/ — ELI16"
slug: "install-claude-gating-eli16"
parent: "install-claude-gating.md"
---

# Codex-only init produces zero .claude/ files — explained simply

## What changed

The previous release let users pick `--framework codex-cli` at install
time, but the install scripts still wrote all the Claude-specific files
anyway. So a Codex user got a clean Codex setup *plus* a Claude-shaped
folder full of files Codex would never read. This release makes the choice
actually mean what it says: pick Codex and you get zero Claude files.

## Why it's safe

Default behavior is identical to before. A user who doesn't pass the flag,
or who passes `--framework claude-code`, or who passes `--framework both`,
gets exactly the files they got in the previous release.

Only a deliberate codex-only choice changes anything, and what changes is
exactly what should: no `.claude/` directory, no CLAUDE.md. Existing Claude
agents on update keep their setup — the gate reads the persisted config,
which defaults to `claude-code` when unset, so older configs are unaffected.

## Test that pins it

A small end-to-end test stands up a fresh standalone agent in a temp
directory with `--framework codex-cli`, then asserts: no `.claude/`
directory exists at all, no CLAUDE.md exists, but AGENTS.md does exist
(rendered from canonical identity), and the config persists the choice.
Two paired tests verify the default and `--framework both` paths produce
their expected outputs.

## Next steps

This is PR 2 of 4. PR 3 adds the same `--framework` flag to the `setup`
wizard (today it exits if Claude isn't installed, even for Codex users).
PR 4 routes the wizard through the chosen runtime.
