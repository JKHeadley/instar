---
title: Jev Memory Picker
description: At session start, a fast decision model scores the memory-index lines that fall past Claude Code's load cut against the session's topic, so relevant memories are not dropped just because of their position. Ships in shadow mode on a development agent.
---

Claude Code loads an agent's `MEMORY.md` index only up to a size limit (about 25,000 characters). Everything past that point is dropped by **position**, not relevance. In a test on 30 real conversations, 44% of the memories that mattered sat past the cut.

The **Jev memory picker** (`JevMemoryPicker`) runs one step at session start. It finds where the load cut falls, then asks Jev (TypeSafe's fast decision model) to score only the lines past the cut against what the session is about — the topic name and its last few messages. It keeps the top-ranked lines, up to 40 lines and 10,000 characters. In the offline test, ranking this way loaded 89% of the relevant memories, against 56% for the positional cut.

## Modes

- **Shadow (the default).** `JevMemoryPicker` only logs which lines it *would* add: line numbers and scores, never memory or message text. Nothing in the session changes.
- **Inject.** With one setting, the session-start hook prints the chosen lines so the session sees them.

A memory line marked `<!-- pinned -->` always loads without asking Jev. An optional short glossary of the agent's own names helps Jev connect terms it cannot know.

## Safeguards

- It never blocks, sends, or changes anything; any failure (no key, Jev slow or down, the daily cap reached) adds nothing and the session starts exactly as before.
- Text sent to Jev is secret-scrubbed. One call per session start, at most 2 concurrent, at most 300 a day.
- Live on a development agent in shadow mode, dark on the fleet. A kill switch is read live.

Route: `POST /memory-picker/session-context` (Bearer), called by the session-start hook.
