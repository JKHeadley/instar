---
title: "Framework session store — ELI16"
slug: "portability-session-store-eli16"
parent: "portability-session-store.md"
---

# Framework session store — explained simply

## The problem

Two safety features — saving important context before the conversation gets
compacted, and checking a resume request points at the right conversation —
both needed to find the session's transcript file. They only knew where
Claude Code puts transcripts. Codex puts them somewhere completely different,
so for a Codex agent these features quietly did nothing.

## How we found Codex's layout

We didn't guess. We looked inside a real `~/.codex/` folder on the machine.
Codex stores transcripts as `~/.codex/sessions/YEAR/MONTH/DAY/rollout-...-<id>.jsonl`
— organized by date, with the session id at the end of the filename. Claude
Code stores them in a folder named after the project path. Both confirmed by
actually looking, not assuming.

## The fix

One small shared helper now answers "where is this session's transcript?"
based on which runtime produced it. The Claude answer is exactly what it was
before. The Codex answer searches the date folders for the file ending in
that session's id. Both features now call this helper.

## A bonus correctness fix

While doing this we found the resume checker was building the Claude path
slightly wrong — it didn't account for dots in folder names, so for any
project with a dot in its path (like `.instar`) it was looking in a folder
that doesn't exist and silently failing. Routing it through the shared,
correct helper fixes that too. We've flagged this explicitly rather than
sneaking it in.

## Why it's safe

If a caller doesn't say which runtime, it defaults to Claude Code — today's
behavior. Seven tests cover the new helper (including a decoy file that must
not match), and 35 existing tests on the two features still pass. Third of
six portability patches; this one is the fourth shipped (1.0.12).
