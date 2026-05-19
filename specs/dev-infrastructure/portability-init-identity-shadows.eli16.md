---
title: "Init identity shadows — ELI16"
slug: "portability-init-identity-shadows-eli16"
parent: "portability-init-identity-shadows.md"
---

# Init identity shadows — explained simply

## The problem

Different AI runtimes look for their instructions in different filenames.
Claude Code reads CLAUDE.md. Codex reads AGENTS.md. Gemini reads GEMINI.md.
Instar keeps the real identity in one canonical file (.instar/AGENT.md) and
generates the runtime-specific copy from it.

When you set up a brand-new agent (`instar init`), it wrote CLAUDE.md and
nothing else. So if you were running Codex instead of Claude Code, your fresh
agent had no file Codex would actually read. It only got fixed later, the
first time the server started a session. Until then, a Codex agent booted
without knowing who it was.

## The fix

Init now also writes the non-Claude identity files (AGENTS.md, GEMINI.md) from
the canonical identity, right when you set the agent up — not later. It
deliberately does NOT touch CLAUDE.md, because that file is the big
Claude-specific capability guide, a different thing from the identity copy.

## Why it's safe

It only adds files, never overwrites the Claude guide, does nothing if there's
no canonical identity yet, and can be run repeatedly with the same result.
Five tests cover each of those guarantees. This is the first of six small
portability hardening patches the v1.0 release notes promised.
