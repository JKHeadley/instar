---
title: "Framework gate — ELI16"
slug: "portability-framework-gate-eli16"
parent: "portability-framework-gate.md"
---

# Framework gate — explained simply

## The problem

When an agent updates, a migrator runs steps that set up files. Some of those
steps create Claude-Code-only files (like `.claude/settings.json`) that a
Codex agent would never read. The audit said "just add a check: skip the
Claude-only steps if Claude isn't in use." But the setting that check would
read didn't actually exist as a real option anywhere — it was always blank,
so the check would have always said "Claude is in use" and never skipped
anything. A check that can never trigger isn't a fix; it's decoration.

## The fix

First make the setting real: `enabledFrameworks` is now a genuine option you
can put in the config (e.g. `["codex-cli"]` for a Codex-only agent). Then add
one well-tested gate: the step that writes Claude's settings file now actually
skips when Claude isn't in the enabled list. Tests prove it both ways — it
skips for a Codex-only agent, and it does NOT skip for a normal (default)
agent.

## Why it's safe

If you don't set the option, it defaults to "Claude Code" — exactly today's
behavior, so every existing agent is unaffected. Only someone who explicitly
says "this is Codex-only" sees the new skipping. One shared helper now answers
"which runtimes does this install use?", and the older duplicate copy of that
logic was replaced by it, so they can't drift apart. This is the fifth of six
small portability patches.
