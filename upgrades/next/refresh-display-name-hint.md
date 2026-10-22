## What Changed

- **Restarting a dead session by its display name now gets a useful refusal.** The restart call (`POST /sessions/refresh`) takes a session's tmux name (for example `echo-topic-127831`). Given the display name instead (`topic-127831`), the server already pointed at the right name when such a session was running. When the session had died, the same call came back as "not bound to a Telegram topic (checked in-memory + disk registry)" with no hint, which read as a lost topic binding. It was not: the binding was intact and a restart under the tmux name would have resumed the conversation. The refusal now names the tmux name for a dead session too, as long as its topic still points at it, and says that a refresh of that name respawns from the saved conversation. A dead name whose topic has moved to another session is not suggested. The hint is still only a hint; nothing is remapped or restarted differently.

## What to Tell Your User

Nothing changes for you. This only makes one of the agent's internal error messages more accurate.

## Evidence

- `tests/unit/SessionRefresh.test.ts`: a dead session whose topic still points at it is named once (two finished records, one hint) and the authoritative path still refuses without killing anything; a dead session whose topic moved to another session gets no hint; a live match and a dead-bound match under one display name are both listed. The existing running-only wording and the route's 409 test are unchanged.
- Incident: Mama PC, 2026-10-22 ~19:05 UTC, topic 127831. The server log shows the same 10 topic bindings loaded at every boot and no unlink; the refusal came from the display name.
- Side-effect review: `upgrades/side-effects/refresh-display-name-hint.md`.

## Summary of New Capabilities

- No new capability. One refusal message now tells the caller the name that works.
