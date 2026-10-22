## What Changed

- **An idle conversation's four-hour clock now survives a server restart.** The "first seen idle at a prompt" instant is recorded on the session record (`Session.idleSince`) and, after a restart, the session monitor resumes the clock from it instead of starting at zero — but only when a pure resolver (`src/core/idleSincePersistence.ts`) finds the recorded instant usable: present, parseable, not in the future, and not contradicted by the conversation's transcript having been written after it. Every doubtful case starts the clock fresh, which is exactly the previous behaviour.
- The recorded instant is cleared, on disk as well as in memory, at every point the monitor already reset the clock: the session is seen active, a new message arrives, the pasted-text retry, the API-error nudge, and the compaction-recovery veto.
- No new way to close a session, no change to the closing authority or its vetoes; only the clock's starting point changed.

## What to Tell Your User

Nothing to do. Previously, if my server restarted often (updates land about every half hour), conversations that had gone quiet were never closed, because the four-hour timer started over at every restart. They piled up until I hit my limit of open conversations and could not answer anyone new. That timer now carries across restarts, so quiet conversations close on schedule and there is always room for a new one. A conversation that is closed this way reopens with its full history the moment you write in it again.

## Summary of New Capabilities

- None (bug fix to the existing idle-session cleanup).

## Evidence

- Before: the sagemind agent's laptop server, 2026-10-22 — `GET /health` → `sessions: {current: 20, max: 20}`; `POST /sessions/spawn` → `500 "Max sessions (20) reached"`; every one of the 20 sessions idle at its prompt, 17 of them since 2026-10-19/21 (17–64 h) against `maxDurationMinutes: 240`; the server had restarted 1.3.1391 → 1.3.1394 → 1.3.1399 that day. `SessionManager.idlePromptSince` was `new Map()` with no persistence.
- After: `tests/unit/session-idle-clock-survives-restart.test.ts` (13 tests) — the `REGRESSION` case builds a second `SessionManager` over the same state directory and asserts the observed idleness spans the restart (≥ 240 min); with the seed disabled the same case fails on `expected 0 to be >= 14400000`. The resolver is covered on both sides of every branch (seeded; absent, empty, unparseable, future-dated, transcript-advanced → fresh).
