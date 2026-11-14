# Side-Effects Review — lookups by tmux name find the live session

**Version / slug:** `session-by-tmux`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** gpt-6-astra via codex, outside review, two rounds. Round one objected: `ThreadlineMcpHttpService.noteCallFailure` still took the first record by name. Fixed through the shared `pickSessionByTmux`. Round two concurred.

## Summary of the change

`state.listSessions().find(s => s.tmuxSession === name)` returns whichever record the directory lists first, and a name is reused when a conversation comes back to a machine. A drain closed a finished record, was told `already-completed`, and left the running session on the machine the conversation had left (signed red, Studio to Mini, 2026-11-04). `StateManager.findSessionByTmux` prefers a running record, then the newest, at all nine lookups, and a test keeps the pattern out of `src`.

## Decision-point inventory

- Session lookup by name — modify — nine call sites read `StateManager.findSessionByTmux`, and the Threadline failure report reads the same `pickSessionByTmux` rule. No decision rule changes; each now reads the right record.

---

## 1. Over-block

The drain now closes a session it used to miss. That is the intent: the record says the conversation lives elsewhere. Closing still goes through `terminateWithAuthority`.

## 2. Under-block

Only records with a shared name change outcome. If a name has no running record the newest wins, which is the closest fact available.

## 3. Level-of-abstraction fit

One pure rule, `pickSessionByTmux`, exposed on `StateManager`, the owner of session records, rather than a fix at the drain alone, because ten sites had the same fault. The Threadline service gets its records from an injected list, so it calls the rule directly.

## 4. Signal vs authority compliance

No new authority. Readers get a truer record.

## 5. Interactions

Each site meant "the session this name means now": framework resolution, the output route, bound-session reads, delivery incarnation checks and the drain. The Threadline failure report no longer stays silent for a live HTTP session that shares a name with a finished stdio record. `DeviceLimitSessionMover` keeps its injected list and is exempt in the guard. The result is a copy, as before.

## 6. External surfaces

None. No route shape, config or message changes.

## 7. Multi-machine posture

Machine-local records. It fixes a multi-machine symptom: one conversation running in two places after a return trip.

## 8. Rollback cost

Revert the commit. No state depends on it.
