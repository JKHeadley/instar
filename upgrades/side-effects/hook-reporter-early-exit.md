# Side-Effects Review — hook-event-reporter exits when the server has answered

**Version / slug:** `hook-reporter-early-exit`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `not required (no gate/sentinel/lifecycle decision; a reporting hook's exit timing)`

## Summary of the change

Tier 1. `hook-event-reporter.js` is a built-in PostToolUse hook (matcher `*`) that POSTs each tool event to the agent server (`/hooks/events`, which records `claudeSessionId` for session resume and feeds several ledgers). Claude Code waits for PostToolUse hooks before continuing. The script sent its request and then always waited a fixed 50 ms before `process.exit(0)`, whether or not the reply had arrived. The server answers this endpoint in ~7 ms (median of 8 local calls; max 124 ms under load). Now the script exits on the response's `end` (and on a request error), and the 50 ms timer stays as the upper bound, so a slow server is never waited on longer than before.

Both copies change identically: `getHookEventReporterScript()` in `src/commands/init.ts` (new agents) and in `src/core/PostUpdateMigrator.ts` (existing agents — built-in hooks are overwritten on every update, so the migrator copy is what the fleet runs).

Expected saving: up to ~40 ms of wall time per tool call (50 ms fixed wait minus a ~7 ms reply). Not separately measurable on this machine today: end-to-end timings were dominated by Node start-up under a load average of ~11 on 10 cores, which is itself recorded in the Rust/hook measurement notes. The claim rests on the code (a fixed 50 ms wait after send, by construction) plus the measured server reply time.

Effort: 1 profiling pass (which also disproved my first hypothesis that this hook's ~170 ms was mostly the wait — it is mostly Node start-up), 1 commit attempt so far.

## Decision-point inventory

No decision-point surface: a reporting hook's exit timing. It blocks nothing and decides nothing.

---

## 1. Over-block

No block/allow surface.

---

## 2. Under-block

Could the event now fail to arrive? The script exits only after the server has sent its complete response, which happens after the server has read the request; on a request error it exits as it previously would have after 50 ms (the error path was already a silent drop). No delivery path is removed.

---

## 3. Level-of-abstraction fit

Right place: the hook's own wait loop. No server change.

---

## 4. Signal vs authority compliance

Not applicable — the reporter is a telemetry signal and stays one (`docs/signal-vs-authority.md` reviewed).

---

## 5. Interactions

- `/hooks/events` consumers (claudeSessionId bridge, scope-accretion ledger, jev-circles-shadow) receive the same payload; only the client's exit moment changes.
- Migration parity: existing agents get the new script on their next update through `PostUpdateMigrator` (built-in hooks always overwritten); `tests/unit/hook-event-reporter-early-exit.test.ts` asserts the migrator copy, `tests/unit/hook-installation.test.ts` asserts the init copy and runs it against a real local HTTP server (event delivered, exit 0).

---

## 6. External surfaces

None beyond the agent's own server. Users see tool calls complete slightly sooner.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the hook posts to its own machine's server.

---

## 8. Rollback cost

Revert; the next update rewrites the hook back.
