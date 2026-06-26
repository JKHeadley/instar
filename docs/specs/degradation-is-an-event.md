# Degradation Is an Event — the lease-tick stall reaches the user (F6)

**Status:** Tier-1 instar-dev (the PR is the review surface).
**Constitution:** *The User Experience Is the Product* → sub-standard #6 **Degradation Is an Event**.
**Earned from:** 2026-06-25 (postmortem Failure 6) — the mesh lease "who's-in-charge" tick stalled >10 minutes and a watchdog silently re-armed it (log-only); speaker-election fell back to a default. Nobody knew the coordination layer was degraded until messages started disappearing.

## What already exists (the surface to route TO)

`DegradationReporter` already reaches the user: `report()` → `[DEGRADATION]` log + persist + `connectDownstream` → `notify('SUMMARY','system',…)` → the attention topic (through the tone gate), plus a never-silent sweep that escalates persistent opens. Framework-unavailable already uses it. So F6 is **plumbing a silent site onto an existing user-visible surface**, not building a new one.

## The gap

`MultiMachineCoordinator.runTickWatchdog` detects a stalled coordinator tick and re-arms the main monitor — but each re-arm only `console.log`s and `emit`s a `tickStallRecovered` event that **nothing listens to**. `DegradationReporter.report` fired ONLY on the runaway self-disarm path (re-arms exceed `maxReArmsPerHour`). So the postmortem scenario — a single >staleMs stall, silently re-armed — was log-only / pull-only via `/health`, never pushed to the user.

## The change (narrow, additive)

In `runTickWatchdog`, surface the **FIRST re-arm of a stall episode** to the user via the existing `DegradationReporter.report(...)`, deduped per episode by a `leaseStallSurfaced` flag that resets when a real tick resumes (`checkHeartbeatAndAct`). So:
- a single >staleMs stall surfaces ONCE (not on every re-arm — no flood),
- a later, distinct stall surfaces again (not suppressed forever),
- the runaway self-disarm remains its own separate, louder event.

The watchdog's **re-arm / guard-reset / self-disarm decisions are byte-identical** — this adds no control logic, only a deduped notice.

## Scope decision

This ships the **primary** site (the lease-tick stall — the exact postmortem scenario). The secondary site (speaker-election fallback to a default, `SpeakerElection.onVerdict` → console.log) is **deliberately deferred**: election fallbacks can be frequent/normal, so surfacing every one risks notification noise; surfacing only a genuinely-anomalous/sustained fallback is a separate, carefully-scoped follow-up (tracked, not orphaned — it is named here).

## Tests

`MultiMachineCoordinator-tickSelfHeal.test.ts` — a new case asserts: first re-arm surfaces once; a second re-arm in the same episode does NOT re-surface (dedup); a real tick resets the flag; a new stall surfaces again. (The `tickStallRecovered` path had no listener and no coverage before.)
