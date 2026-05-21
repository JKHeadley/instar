# Upgrade Guide — vNEXT (current-time injection in agent hooks)

<!-- bump: patch -->
<!-- patch = behavior fix that closes a recurring failure mode, no new surface -->

## What Changed

**Fix: every instar agent now sees the current wall-clock time at session start AND on every user prompt.**

Claude Code's harness injects `currentDate: YYYY-MM-DD` into the agent's system prompt — but NOT the current time of day. In long-running sessions (hours, days), agents that try to say "it's 2am" or "you've been up X hours" or "we just talked an hour ago" were either hallucinating clock times outright or pulling stale time strings from earlier conversation context. Iris hit this on 2026-05-21: she told a user "it's 2am" when it was actually 5:45am, and only realized it after the user contradicted her with a timestamped screenshot.

The fix is structural, not behavioral. Two existing hooks every instar agent already runs now emit a `--- CURRENT TIME ---` block backed by a live `date(1)` call:

- **`session-start.sh`** (SessionStart hook, startup / resume / clear) — emits the time block immediately after `=== SESSION START ===`, before any other context. Refreshed on every session lifecycle event including post-compaction resume.
- **`telegram-topic-context.sh`** (UserPromptSubmit hook) — emits the time block on **every** user prompt, BEFORE the `[telegram:N]` prefix early-exit. So agents get a fresh wall-clock anchor on every turn, not just at session start, regardless of whether the prompt arrived via Telegram or direct CLI use.

Format: `2026-05-21 14:15:29 -0500 (CDT)` — ISO date + 24h time + signed offset + tz abbreviation. Same line every time. Agents are told explicitly: "Quote this — do not carry stale clock times from prior context."

The hook content lives inline in `src/core/PostUpdateMigrator.ts` (functions `getSessionStartHook()` and `getTelegramTopicContextHook()`), which is the source of truth that both `init` (new agents) and `migrate` (existing agents) write to disk. Built-in hooks are unconditionally overwritten on every migration run, so existing agents pick up the fix automatically on their next `npx instar` invocation — no manual migration required.

## What to Tell Your User

If your agent has ever made a clock-time claim that turned out to be wrong (saying it's the middle of the night when it isn't, miscalculating "how long ago" something happened, mismatching AM/PM), that failure mode is closed after this release. Your agent now sees the actual current time on every interaction and is structurally instructed to quote it rather than guess.

No action needed from you. The next time your agent updates, the fix lands.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Wall-clock time injected at session start | Automatic — `--- CURRENT TIME ---` block at the top of session-start output |
| Wall-clock time refreshed on every user prompt | Automatic — same block emitted ahead of telegram-topic-context every UserPromptSubmit |

## Evidence

- New test: `tests/unit/PostUpdateMigrator-time-injection.test.ts` — 13 cases. Static assertions on the inlined bash (date format, guard, delimiters, ordering) PLUS end-to-end execution of both hook scripts against a fresh sandboxed temp dir, asserting the actual emitted output matches the expected `YYYY-MM-DD HH:MM:SS +ZZZZ (TZ)` shape.
- Existing tests still pass: `tests/unit/PostUpdateMigrator-sharedState.test.ts` (Integrated-Being session-start regression) and `tests/unit/scaffold-identity-hooks.test.ts` (scaffold integrity) verified green against the patched migrator.
- Side-effects review: `upgrades/side-effects/inject-current-time-into-hooks.md`.

## Original Incident

Iris session, Business Plan topic, 2026-05-21 ~5:45am CDT. Agent said "It's 2am. The laptop can wait. Goodnight." User's actual local time was 5:45am Central. Memory note `feedback_clock_time_must_call_date.md` captured the rule per-agent; this release lifts the fix to the framework so every instar agent benefits without each agent having to learn the lesson independently.
