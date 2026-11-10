# Side-effects review — Chief of Staff PR 5: durable notes, failover settle, verified close, app check-in, the triage list (dev-gated)

**Spec:** docs/specs/chief-of-staff-topic.md §1.3, §3, §4, §6, Migration and rollout ("First run (one time): triage") (converged, approved 2026-11-09). Builds on PR 4 (#3008). Closes CMT-1416 and CMT-1417.
**Tier:** 2 (settlement authority after a lease failover; a close path; an owner-device route; a PIN-gated route that renders initiative data into a private view).
**Change size:** `ChiefOfStaffStore` (`note` record + fold, `trailingUnknownChecks`), `ChiefOfStaffLoop` (note cadence / immediate cap / Needs-you items derived from records; `confirm-done` hardening), `ChiefOfStaffActionProtocol.settle` (previous-holder settle), new `src/core/ChiefOfStaffTriage.ts` (pure), routes (`POST /chief-of-staff/triage`), mobile (`POST /mobile/chief-of-staff/check-in` + allowlist rule + server dep), site page section. Tests: unit (loop +7, protocol +1, triage 4), integration (app check-in 1).
**Effort:** build attempts 1.

## Summary
The two follow-ups the PR 3 review tracked, plus the three gaps the PR 4 review named, plus the spec's first-run triage list. **CMT-1416:** the note cadence, the daily cap on immediate messages and the Needs-you items no longer live in process memory — every sent note or immediate is a `note` record, and the Needs-you items (parked, breaker, waiting on you, paused-while-stalled, a run of unknowns, no owner id) are re-derived from the folds at note time, so a restart or a holder change can neither drop a line nor send a second note. **CMT-1417:** after a lease failover the current holder may settle an intent a previous holder left open, once that claim is older than a lease term; the outcome names the prior holder. **Verified close:** confirming "done" from a note button requires a live lease, re-gathers the deterministic items at tap time (all must pass, or the note says which still fail) and records a `done-verified` check-event (owner-confirmed) before the lifecycle close. **App check-in:** an owner-admitted phone can renew the lease (`POST /mobile/chief-of-staff/check-in`, owner-only allowlist rule, admission re-read in the route). **Triage:** `POST /chief-of-staff/triage` (PIN-gated) renders a private view of keep / review / archive over the active initiative records with the reason from each record's facts; it writes nothing else and remembers the view id so it runs once (`force: true` re-runs).

## 1. Over-block
- A previous holder's open intent cannot be settled until its claim is a full lease TTL old; until then the conversation stays under `cos-intent-open` — a bounded delay (TTL), the price of never settling an intent a still-acting holder owns.
- `confirm-done` refuses when any deterministic item fails at tap time or the lease is paused; the owner sees why in the note (failing checks) or the paused line. A re-gather that throws refuses (P20).
- The app check-in refuses any device that is not currently an admitted owner phone (403), and the triage route needs the PIN.
No issue identified.

## 2. Under-block
- The `note` record counts immediates per 24h from records; a machine whose journal has not yet replicated a peer's `note` record could send one extra immediate in that window. Bounded by the replication lag and the cap itself (one message), never an action.
- The triage recommendations are deterministic floors over record facts; they are advice in a private view the owner approves row by row. No record is archived or bound by this PR.
- `settle` with a prior holder relies on the current holder's signature + fresh renewal (the existing floor) plus the TTL age guard; a peer that is not the current holder still gets `unknown`.

## 3. Level-of-abstraction fit
Records for cadence/cap keep the loop stateless across restarts exactly like the check/intent/renewal records; the failover settle extends the protocol's own authentication floor rather than adding a bypass; the app check-in rides the owner-device admission + allowlist the other owner-only mobile routes use; the triage list is a pure builder rendered through the existing private viewer.

## 4. Signal vs authority compliance
No judgment logic is added. The triage floors are deterministic; the Needs-you derivation is a fold; the settle rule is identity + time mechanics.

## 5. Interactions
- **Loop ↔ store:** the memo is invalidated on every loop write (renewal, tap, note); peer-written records show within the 2 s memo window.
- **Protocol ↔ loop:** `settleOpenIntent` on the new holder now resolves intents the old holder left behind instead of blocking every tick; the note's "can't settle" line is reserved for a truly unreachable owner.
- **Console/app:** the Check-in button (dashboard) and the app route both land in `loop.checkIn`, producing the same signed renewal record; `GET /chief-of-staff` shows the lease live at once.
- **Triage ↔ initiatives:** read-only; the initiative mirror (`completed`/`active`) is untouched.

## 6. External surfaces
`POST /mobile/chief-of-staff/check-in` (owner phones), `POST /chief-of-staff/triage` (PIN), a `note` record type in the replicated store (inert data for readers on older builds), the triage private view (local link; tunnel link when a tunnel runs — the owner opens it with the dashboard PIN).

## 6b. Operator-surface quality
The triage view is a markdown page: an intro that says nothing has been changed and what approving means, then three tables (keep / review / archive) with project, last touched, why. Checked by the unit test for ordering, counts and escaping; rendered by the existing private viewer.

## 7. Multi-machine posture (Cross-Machine Coherence)
Unified: `note` records replicate like every other store record; the failover settle is the multi-machine case by definition (tested with two real-key machines in the protocol harness pattern); the triage view is created on the machine that answers (the lease holder) and its id recorded in that machine's state (`chief-of-staff-triage-view`, holder bookkeeping — a standby answers 503 on the PIN route anyway).

## 8. Rollback cost
`chiefOfStaff.enabled: false` stops the loop and the routes (503); `note` records stay as inert data; the triage view can be deleted like any private view; the allowlist rule is inert without the loop (503).

## Found problems (triage)
- The previous `confirm-done` could close a project on a stale checklist (PR 4 review #13) → fixed here.
- `settle` could never resolve a previous holder's intent (CMT-1417) → fixed here.
- Note state was process-local (CMT-1416) → fixed here.
- The close still writes no `intent` record (spec §6 lists closing among intent-writing actions): the protocol has no `close` executor; the close is recorded as a `done-verified` check-event (owner-confirmed) + the lifecycle event, which is the same audit trail by other names → carried to the binding UI (PR 5b) with the `close` action on the protocol.

## Proportion
Tier 2, ~600 LOC incl. tests, 1 attempt. In line.

## Addendum — the owner's binding and tap routes (same PR, after the second pass)

Two PIN-gated routes close the loop's last gap before the live proof: `POST /chief-of-staff/projects` writes a CONFIRMED `binding` (the store schema validates it; an invalid body writes nothing) plus the `tree` link under the Chief of Staff root (or a named parent for a sub-topic) and marks the project due — spec §1.3's "a binding is written ONLY by an owner tap", the dashboard PIN being that tap; `POST /chief-of-staff/projects/:key/tap` carries the dashboard's Unpark / Confirm-done to `ownerTap` (the same owner-only checks as the Telegram buttons). Both are owner identity mechanics (PIN), no judgment; both are refused 503 where the loop is off. The conversational draft-binding flow ("describe an effort in the Chief of Staff conversation") remains PR 5b; the live proof binds its four synthetic projects through the first route. Tests: unit (binding + tree + due + invalid refused; sub-topic under its parent), integration (PIN wrong/missing refused, bad body 400, bind 201, listed, tap ok, bad action 400).

## Live-proof findings (2026-11-09, throwaway agent on the test bot) and what changed

The first clean run of the four scenarios (moving / stalled / stand-down / claims-done) on a single-machine throwaway found two defects that no unit or integration test could see, because both sat at a REAL seam the harnesses had mocked:

- **The holder's own machine could never act.** `verifyCommand` and `settle` proved a holder fresh with `lease.freshRenewalWithin(holder, ttl)`, and the LeaseCoordinator stamps that watermark only for PEER holders (an observer-side timestamp on a nonce that advanced). On the machine that holds the lease itself, the common case and the ONLY case on one machine, every command refused `holder-lease-stale`, a pre-authentication reason that by design writes nothing, so four intents sat at `claimed` forever with no outcome and no note line. The protocol test harness answered one `fresh` boolean for every holder, which is how the gap survived three reviews. Fix: `holderFresh(holder)` — the holder's own machine proves freshness with its own live lease (`holdsLease()`, false once expired or released); a peer holder still needs the observed renewal. Tests: the holder's own claim executes with no peer-observed renewal; the self-case settle likewise; the peer-holder stale refusal is unchanged.
- **The note could not be sent.** The §3 one-reader rule reads the group's human reader count through `getChatMemberCount` and `getChatAdministrators`, neither of which the Telegram egress door had classified, so the door refused (correctly: an unclassified method is an unknown content decision) and the note failed every tick. Both methods take only `chat_id` and return member data; they are now in the no-reader-visible-field list. The same calls back the memory-privacy reader count on main (`groupReaderCount`, #2705), which no agent had exercised yet.

Posture: both fixes narrow a refusal that was wrong, neither widens authority (a peer holder is proven exactly as before; the egress door still refuses every method nobody classified). Proportion: ~15 LOC + 3 tests, found by the live proof the spec requires before the pilot.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure:** `n/a` — **reason:** this change adds no new self-triggered controller; it makes two existing bounded sends (the daily note, the capped immediates) count from durable records instead of memory, which can only lower their rate across restarts, and the triage route is a one-shot owner tap. No restart / respawn / kill / retry path is added.

## Second-pass review (Phase 5) and what changed because of it

Independent reviewer, 2026-11-09 15:26 PT: **"Concern raised: `maybeSendNote` drops every transient Needs-you line whenever any derived item exists."** Fixed, with the should-fixes; the notes are corrected here or carried.

MUST-FIX (fixed): **(1)** the dedupe no longer drops the transient needs-you class — items are deduped by tap id, then text, derived first; the only true duplicate (the transient "Confirm it's done?" and the derived "waiting on you") collapses on the shared `cos:confirm-done` id, and the refuted-twice line, a capped immediate's fallback and a project parked this tick all survive. Test: project A parked (derived) + project B refuted twice (transient) both reach the next note.

SHOULD-FIX closed here: **(2)** `settle` now refuses unless this machine owns the conversation and, when an `executing` record exists, wrote it (only that machine's registry can hold the receipt) — the new holder's settle routes to the owner as before; **(3)** the previous-holder minimum age is `max(lease TTL, lagging-fold window)` (30 min in production), and the artifact now says that the conversation lock, not the age guard, is what protects a run still executing on the same machine; **(4)** a refused `done-verified` check-event refuses the close (ordering enforced, not assumed); **(5)** the note record is written in its own step after a successful send, and a refused record falls back to a process-local "sent at" so the note is never re-sent every tick; **(6)** the triage reads every live status (active, awaiting-user, paused, halted) — the paused and awaiting-user records are exactly what the needs-you floor is for; **(7)** the app check-in rides the owner's own request bucket like every other owner tap; **(9)** `note.itemKeys` are 16-hex hashes of the lines, never note text or an immediate's free text; **(10)** the note derives from a fresh union and fold after the tick's checks, so this tick's parks and verdicts are in it; **(11)** the transient unknown-streak line is gone (the derived line is the one line); **(12)** the Confirm-done button is offered only when the newest check shows every deterministic item passing; **(16)** the Bearer case asserts 403; **(17)** `&` and `<` are escaped in the triage table; **(18)** an existing triage view id is honoured only while the view still exists.

Corrections / carried: **(8)** the triage route runs on any machine where the feature is on (the loop is constructed everywhere; only the tick is holder-gated); a standby creates the view in its own store and cannot record the id, so the holder may later mint a second view — harmless, and §7 above is corrected accordingly; **(13)** a judgment-only binding closes correctly on the tap but a `claims-done` verdict takes the refute path with an empty "missing" list → PR 5b with the binding UI (where `allDeterministicPass` for zero items becomes "ask the owner"); **(15)** browser devices cannot use the app check-in (not in the browser route list) — the dashboard PIN button is the browser path, by design; replay is bounded by the 60 s device-time window and the replay guard; **(19)** a holder flap inside the replication lag can double the daily note as well as an immediate — bounded by the lag, never an action; **(14)** repeated confirm-done taps cost one gather each and produce one deduped line.

## Second-pass verdict
Concern raised and resolved: the MUST-FIX is fixed with a test; eleven SHOULD-FIX/NOTE items are closed in this PR; the rest are corrected in this document or carried to PR 5b as named. The reviewer's "checked and found sound" list (non-holder settle refused, fold rank walk, nonce keys, immediate cap fails to the cap, confirm-done lease/re-gather real, owner-device admission re-read, PIN gate, floors, read-only state) stands.
