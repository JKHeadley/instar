# Side-Effects Review — Project rows that say something, and the owner's project actions

**Version / slug:** `work-door-project-rows`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (owner-authority gate)`

## Summary of the change

The Work door's project read (`GET /work/projects`, `GET /mobile/work/projects`, `src/server/workProjectsRoutes.ts`) now carries what the Chief of Staff already knows per project: the latest report, why it waits on the owner, the next check (and a queued request), why it stopped retrying, each done item's kind and words, the binding version, and which actions apply. New routes: "Ask for an update" (`POST /work/projects/check` bearer, `POST /mobile/work/projects/check` owner phone, no Face ID; `ChiefOfStaffLoop.checkNow`), and three owner Face ID taps through the existing phone write gate (`src/server/mobilePermissionsRoutes.ts`, challenge actions `project-pause`, `project-item-check`, `project-finish`; port in `src/server/workProjectActions.ts`). The store gains two lifecycle events (`owner-item-check`, `check-requested`) and their fold (`src/core/ChiefOfStaffStore.ts`); the loop gains the queue rule in `planDue`, a shared restart budget, a deferred tick, a shared Confirm-done core with distinct outcomes and a durable close, and a stale-Telegram-ask rule (`src/core/ChiefOfStaffLoop.ts`). Device allowlist entries (`mobilePairingRoutes.ts`), a write-domain entry, a CapabilityIndex update and one awareness entry. Spec: `docs/specs/work-door-project-rows.md` (converged, 6 rounds, approved).

## Decision-point inventory

- Who may pause / resume / mark a judged item / finish from the phone — add — the owner phone's presence signature over one exact line (existing write gate).
- Ask for an update: run now or queue — add — the loop's own tick interval; never refuses for timing.
- `planDue` — modify — a queued request newer (HLC) than the last check is due once the last check is a tick old.
- Item check validity — add — counts only while goal + id + text match its checkRef; newest per item first; void after a reopen.
- Finish — add — the existing Confirm-done steps, plus owner checks and binding version re-verified immediately before the close.
- Confirm-done (Telegram / console PIN) — modify — shared core now distinguishes outcomes and awaits the close; judgment-only `claims-done` becomes a candidate.
- Telegram pause ask tap — modify — an ask older than the newest owner decision is ignored.

---

## 1. Over-block

- An owner who taps Ask for an update a minute after a check gets "queued" rather than an immediate check (by design; the next eligible tick checks it).
- An item whose id is shared by another item in the same binding cannot be checked alone (Finish confirms it).
- A Telegram pause ask outlived by a phone decision is ignored; under clock skew a newer ask could read as outlived (the agent asks again).
- A phone without an enrolled presence key, or an agent without a console PIN, gets the gate's existing refusals.

## 2. Under-block

- A phone Uncheck or Reopen written on another machine and not yet replicated when a Finish re-check runs is not seen; the close is the owner's own tap and Reopen undoes it.
- The restart budget is process memory on the holder; a restart or lease handoff resets it (the durable backoff and weekly breaker still hold).
- A session holding the bearer can call Ask for an update; it can only bring checks forward to the loop's own tick rate.

## 3. Level-of-abstraction fit

Right layer. The read composes from the loop's existing overview. Authority for owner decisions stays in the existing phone write gate (presence key + single-use challenge); the loop only records and folds. Finish reuses Confirm-done's own steps instead of a parallel close path. Ask for an update reuses `checkProject()` unchanged.

## 4. Signal vs authority compliance

- [x] No — this change has no brittle block/allow surface: the gates are cryptographic owner proofs (existing), record-shape validators, and HLC folds; the judge remains a signal under the existing floors.

The new refusals (item-changed, project-changed, not-all-checked) are exact equality checks over records the owner signed, not judgements.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The run-now/queue rule reuses the loop's configured tick interval (the fastest rate it checks anything) and never refuses; it is classified invariant with that evidence in the spec's Decision points table.

## 5. Interactions

- Shares the loop's one-at-a-time flag with `tick()`; a tick that fires during a check-now runs as soon as it ends.
- Restarts from checks-now and ticks share `restartsPerTick` per interval.
- Phone pauses use the existing owner-pause event, so `planDue`, the protocol's in-lock fence and the liveness reconciler honour them unchanged.
- The note's Confirm-done line lists only unchecked judged items and has a wording for projects with no automatic items.
- The record note is now cut at a word (`cutAtWord`, which also collapses whitespace) instead of `slice(0, 500)`.

## 6. External surfaces

- New row fields (additive; schemaVersion stays 1), five new routes, three new challenge action kinds, one new audit event (`project-tap`). Phone clients (iPhone, Mac, Android) and the dashboard draw them separately (spec §3.7).
- No messages to anyone are sent by these routes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer or markup file is touched in this change. The server writes every word a client shows (state words, refusal details, waiting reasons), so the phone and console surfaces read the same plain sentences.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated (unified): the new events ride the `chief-of-staff-record` journal stream, replicated by journal sync and folded from the union on every machine; older builds store them raw (the applier writes the received entry) and ignore them as counted unknown lifecycle events until they update. Checks run only on the serving-lease holder; a request elsewhere is a replicated record the holder honours. Finish closes from any machine as the console Confirm-done does today. The restart budget is holder-local process memory (as the per-tick count already is).

**Status surfaces:** `GET /work/projects` rows gain `checks.here` (whether this machine runs checks); `GET /chief-of-staff` `unknownLifecycleEvents` counts the new events on older builds.

## 8. Rollback cost

A revert removes the routes; clients see 404 and rows without `actions`. Written `owner-item-check` / `check-requested` events become counted unknown lifecycle events; phone pauses remain valid pauses (resumable from Telegram). Projects closed by Finish are ordinary Confirm-done closes and reopen the existing way. No data migration.

## Conclusion

Additive server contract plus four owner actions, all behind the existing owner proofs, reusing the loop's check and close paths. Ready to commit after the second-pass review.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (claude-opus-5-5), 2026-11-17
**Independent read of the artifact: concur**

Concur with the review. Notes (non-blocking): every write path is held by the owner phone + Face ID + single-use challenge + exact signed line (`writeGate`), and body fields outside the line cannot be swapped (`checkRef` recomputed for the named item; the pause note re-hashed); every success waits for a durable write; ownerTap confirm-done / unpark keep their steps, now with a durable close; `planDue` is unchanged without a queued request. Noted and accepted: the stale-ask rule compares two machines' wall clocks; a proven tap that is then refused still counts as a check-in (every Chief of Staff tap is a check-in); item checks are bound to goal + item text, not the binding version, so unrelated binding edits keep them while Finish re-checks the version.

## Evidence pointers

- Unit: `tests/unit/work-door-project-rows.test.ts` (25 tests); existing `cos-owner-pause`, `ChiefOfStaffLoop`, `ChiefOfStaffStore`, `work-projects-read`, `write-domain-registry`, `write-domain-conformance-ratchet`, `capabilities-discoverability`, `awareness-entry-registry` pass.
- Integration: `tests/integration/work-door-project-actions.test.ts`; E2E: `tests/e2e/work-door-project-rows-alive.test.ts` (run by Local Verify).
- Convergence: `docs/specs/reports/work-door-project-rows-convergence.md`.
