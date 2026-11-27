# Side-Effects Review — Triage owner epoch gap

**Version / slug:** triage-owner-epoch-gap
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** independent Claude subagent (see below)

## Summary of the change
Tier 1, 2 runtime files plus unit coverage, about 15 runtime lines. `reserveTriageCall` no longer refuses when the durable owner epoch is merely behind the current owner's epoch; it advances it inside the reservation transaction after every other check passes. `beginPrimaryCall` refusals are labelled by their real cause. Effort: one test correction, no spec rounds.

## Decision-point inventory
- `FeedbackDrainStore.reserveTriageCall` owner fence — modify: behind-by-restart becomes admit-and-advance; older, foreign, restored, revoked and capped stay refused.
- `FeedbackTriageService` refusal reason — modify: `call-cap-reached` only when a counter is at its limit; otherwise `authority-admission-refused`.
- `launchTriageCall` fence — pass-through: still requires exact equality.
- `QueuePaceTuner` step-down on `call-cap-reached` — pass-through: now only sees real caps.

## 1. Over-block
Removes an over-block: the same owner refusing itself after each restart. No new refusal.

## 2. Under-block
A same-host process holding a newer epoch can now advance the durable epoch from triage, not only from a drain run. It already must pass `isCanonicalOwner`, the live epoch match and tenure. A drain run left active at an older epoch has its claim-fenced writes refused as stale slightly sooner, while its heartbeat and own run transitions continue; in one process its owner check already stops it, and across overlapping processes that is the fence's stated meaning.

## 3. Level-of-abstraction fit
The store owns the fence, and `advanceOwnerAuthorityEpoch` is the existing funnel used by run start and claims. Triage stores no epoch of its own.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. This is a deterministic ownership invariant, not a judgment heuristic. No new authority; an existing fence stops misfiring. The reason label is a signal only.

## 4b. Judgment-point check
No static heuristic added at a competing-signals decision point.

## 5. Interactions
`authority-admission-refused` matches the triage job's self-managed `authority-` prefix, so the job does not page, and needs no template change. QueuePace classifies it as a normal stop, so pace is not stepped down. A restore sets the tenure host empty, so reservation stays refused until a new drain run rewrites tenure and the authority is freshly approved. That state raises no alert, the same as before this change.

## 6. External surfaces
A new reason string in the triage status and tick result. No route, config or notification change.

## 7. Multi-machine posture
Machine-local BY DESIGN: the drain database belongs to the canonical owner. A foreign host fails the tenure check and is refused before any advance. A change of operated host is unchanged. A lease that returns to the same host opens the fence at once instead of at the next drain run, which grants nothing new because starting a run already advances without a tenure check.

## 8. Rollback cost
Plain revert. A durable epoch advanced early holds the same value the next drain run would write. No migration.

## Second-pass review
Concur with the review (independent subagent). It probed the real store for foreign host, stale epoch, restore, lease bounce and an active run, and found no way for a non-owner to spend a call or move the epoch. Its findings, now addressed: a lease change during a tick is labelled owner-lost; added a service-level test of the bug and a restore test; tightened three sentences above. Left unchanged as existing behaviour: a canary refused at the cap reports authority-self-healing, and QueuePace treats a refused tick as a normal run.
