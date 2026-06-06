<!-- bump: patch -->

## What Changed

Fixes a **time-incoherency** class of bug: every context block that shows an
agent its conversation history rendered timestamps as **unlabeled UTC**
(`[21:23:10]`), while the CURRENT TIME hook block speaks labeled local time.
Agents read both as one clock — live incident 2026-06-05: an agent told its
user "you heard nothing between **9:23pm** and now" about an event at
**2:23pm** the user's local time.

Now every agent-facing timestamp renders in the **host's local timezone with
an explicit tz label and date**: `[2026-06-05 14:23 PDT]`.

Surfaces covered:

- Bootstrap Thread History (new/respawned sessions), auto-spawn history
- Moved-session context relay (multi-machine transfers)
- Per-message Telegram topic history hook + unanswered-messages block
- Post-compaction recovery context (Telegram + Slack blocks)
- Session-start RECENT MESSAGES, TopicMemory context blocks
- Slack channel context (tz label added)
- Lifeline "Last healthy" status line

New shared helper `src/utils/localTime.ts` (`formatLocalTimestamp`); hook
python blocks carry an equivalent `_localts()` with a safe fallback to the
old rendering on any parse failure. Stored timestamps remain ISO-UTC —
rendering only. Existing agents pick the hook changes up automatically
(built-in hooks are always-overwritten on migration).

## What to Tell Your User

Your agent no longer gets confused about what time things happened. Before
this, the agent saw conversation history stamped in UTC but the current time
in your local timezone — and could misquote a 2pm event as "9pm." Now every
timestamp it reads carries your local time and timezone, so "when did I last
hear from you?" answers come out right.

## Summary of New Capabilities

- None user-invocable — this is a correctness fix to how agents perceive
  time. (Internal: `formatLocalTimestamp()` in `src/utils/localTime.ts` is
  the one helper all history/status renderers now use.)

## Evidence

- New `tests/unit/localTime.test.ts` pins local-not-UTC semantically
  (TZ-portable: compares against the same instant's local Date getters),
  including the verbatim incident instant `2026-06-05T21:23:10Z`.
- Hook python smoke test: the incident payload now renders
  `[2026-06-05 14:23 PDT] Agent: executing now` (was `[2026-06-05 21:23]`).
- Updated `ForwardedTopicContext` / `compactionResumePayload` /
  `telegram-autospawn-history` tests to TZ-portable assertions through the
  helper; affected-area suites green; `tsc --noEmit` clean.
