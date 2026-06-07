# Side-Effects Review — Pool dashboard streaming phase 3 (UI)

**Version / slug:** `dashboard-stream-phase3-ui`
**Date:** `2026-06-07`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Front-end only (dashboard/index.html): remote tiles clickable; subscribe/
input/key carry machineId for remote sessions; honest error-state rendering for
the new codes; resubscribe-on-reconnect. No server/TS change.

## Decision-point inventory

(1) Remote tile click → selectSession (was informational). (2) Error code →
visible terminal message (was console.error). (3) On WS reconnect → resubscribe
active session (was nothing).

## 1. Over-block

None — a UI change. Local sessions behave exactly as before (machineId only
added when session.remote). 

## 2. Under-block

The client trusts the session.machineId it rendered from /sessions?scope=pool;
a wrong value is re-checked server-side (transfer-staleness guard serves local
if the session is actually local; otherwise the peer only streams its own
sessions). No new client-side authority.

## 3. Level-of-abstraction fit

Pure presentation: clickability, machineId pass-through, honest state rendering.
All gating/auth remains server-side (phases 2a/2b). Reuses the existing
selectSession / wsSend / error-handler paths.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority. The UI only surfaces server decisions honestly (the spec §2.4
"never a lying state" requirement) and relays the user's intent with the
machineId the server validates.

## 5. Interactions

- /ws message handler: the error case now renders new codes; unknown codes
  still console.error (unchanged fallback).
- Reconnect: resubscribe-on-open fixes a pre-existing gap (the terminal went
  stale after a server restart even for LOCAL sessions) — an improvement for
  both local and remote.
- Backwards compatible: a server without phase 2a/2b ignores machineId and
  serves local (or nothing), so the UI degrades gracefully.

## 6. External surfaces

dashboard/index.html only. No HTTP/WS/config/notification change.
