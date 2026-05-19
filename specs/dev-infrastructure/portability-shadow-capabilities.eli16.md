---
title: "Shadow capability mirror — ELI16"
slug: "portability-shadow-capabilities-eli16"
parent: "portability-shadow-capabilities.md"
---

# Shadow capability mirror — explained simply

## The problem

Claude Code agents read a big instructions file (CLAUDE.md) that, on top of
identity, also has a "here's what you can do" section — discover capabilities,
publish private views, check the coherence gate, use the agent network, and
so on. Codex and Gemini agents read their own files (AGENTS.md, GEMINI.md),
and an earlier patch (v1.0.9) gave those the right identity, but those files
never got the "what you can do" parts. So a Codex agent knew who it was, but
not what its toolbox was.

## The fix

Right after the migrator updates CLAUDE.md, it now also looks at AGENTS.md
and GEMINI.md if they exist. For each of the well-known capability sections,
if the section isn't already in the shadow file, it copies that section
*directly out of the freshly-updated CLAUDE.md* and appends it. Nothing about
the section's content is duplicated in our source code — it's literally
copied at runtime, so the Claude and non-Claude versions stay in sync
automatically.

## Why it's safe

Claude-only setups have no AGENTS.md/GEMINI.md so nothing happens — Claude
behavior is byte-for-byte unchanged. The mirror skips sections that already
exist in the shadow, so running it twice does nothing. Six tests cover the
appended-correctly, idempotent, both-shadows, no-shadow no-op, no-CLAUDE.md
no-op, and identity-preserved cases. This is the sixth and final code-level
portability patch — the v1.0.0 cross-framework portability audit is now
closed at 6/6.
