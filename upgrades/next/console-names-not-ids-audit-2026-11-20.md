<!-- bump: patch -->
## What Changed

Dashboard makeover fixes from a live check of every console page at laptop and phone size (spec overview `docs/specs/console-names-not-ids-audit-2026-11-20.eli16.md`).

- Needs-you: work-board rows keep whole words (cut at 140 characters with "…" instead of a raw 80-character cut that produced "needs y"). The incomplete badge reads "12+" instead of "12+?".
- Work board: the "may not have the newest changes" and "may have changed on" notes name the machine by its nickname (`behind.machineName`, `mayHaveChangedOnName`), or "another of your machines", never by its id.
- Documents: a document's conversation shows by name (pool topic names), or "A Telegram conversation", never "Telegram topic N".
- Notifications: notice text shows conversation and machine names and drops ids and hex references (shared `plainReferenceText`); the original text stays on hover.
- Costs: the machine comparison uses nicknames; a conversation with no known name no longer shows as "Conversation <id>".
- Telegram: a topic with no known name learns it from Telegram's answer to the agent's own next message there (the topic-creation message the answer replies to). A known name is never replaced. This restores names lost when a machine is rebuilt, with no extra request.

## What to Tell Your User

The dashboard now shows names where it used to show codes: machines by their names, conversations by their titles. "Needs you" items no longer get cut off mid-word. If some conversations showed "Conversation name unavailable" after a computer was rebuilt, they get their names back the next time I write in them. Nothing to do.

## Summary of New Capabilities

- Topic names are learned from the agent's own sends when unknown (no new route or setting).
- Work-board `behind` answer carries `machineName`; card answers carry `mayHaveChangedOnName`.

## Evidence

- Unit: `tests/unit/console-work-model.test.ts`, `tests/unit/console-documents.test.ts`, `tests/unit/console-live-check-fixes.test.ts`, `tests/unit/console-usage.test.ts`, `tests/unit/console-front-doors.test.ts`, `tests/unit/topic-names-through-lifeline.test.ts`. Console suite 78 files / 1558 tests green; typecheck clean.
- Live: audit of all 32 console pages at 1280x728 and 390x844 on the Studio (1.3.1942) found each fixed string; a re-audit after release is recorded in topic 127504.
