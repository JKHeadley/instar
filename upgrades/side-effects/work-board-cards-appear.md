# Side-Effects Review — Work Board cards actually appear

**Version / slug:** `work-board-cards-appear`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Spec: `docs/specs/work-board-cards-appear.md` (converged in 6 rounds). Tier 2 (fold changes to the replicated work-card store, an approval-rule amendment, a new writer in the Chief of Staff loop). About 14 files.

1. `src/core/ChiefOfStaffWaitCards.ts` (new): at the end of each Chief of Staff tick on the lease holder (not on the grace tick), one fixed-id, server-owned card per tracked project that waits on the owner: opened, edited only on change, closed on the record that clears the wait (later verdict, effective owner pause, current-binding close, park), reopened on a new wait. Fenced by `mirror` (the Chief of Staff record it reflects, HLC against HLC). Switch `workBoard.chiefOfStaffCards` (dev-gated).
2. `src/core/WorkCardStore.ts`: fields `whyYou`, `covers`, `mirror`; `created` folded first; a non-outward card a person carries needs no approve tap; an agent claim on such a card needs that person's Confirm done, except a server-owned card.
3. `src/core/WorkBoardService.ts`: server principal (`server: true`, no route builds it), cover allowlist (`plan:`, `pr:`; `cos:waiting:` for the server), server-owned refusals, deterministic close keys for the server writer, `counted` fixed-id create, `askFieldsRefusal`, graduation exclusion, `limits()`, `atSoftBudget()`.
4. `src/server/workBoardRoutes.ts`: route create/edit require `recommendation` and `whyYou` from agent/session writers.
5. `dashboard/console/needs-model.js`, `work-model.js`, `src/server/needsRoutes.ts`: a covered Needs-you row keeps its words and action and gains `card`; only a server-owned wait card that just waits on the person drops its own row.
6. `src/core/workBoardViews.ts`: card read carries `whyYou`, `covers`, `createdAt`, `serverOwned`.
7. `src/core/ChiefOfStaffLoop.ts` (one optional dep + one call), `src/commands/server.ts` (wiring), `src/data/awareness/work-board-cards-instead-of-asking.md`.

## Decision-point inventory

- Open/close a wait card — mirror of recorded Chief of Staff state (enumerable inputs); add.
- Fence on `mirror.hlc` — invariant; add.
- Approve tap not required for non-outward person-carried cards — modify (rule C subset).
- Agent claim on such a card needs the person's Confirm done — add (keeps the visibility approval used to give).
- Cover allowlist — invariant; add.
- Required recommendation/why-you on route agent writes — presence check; add.

## 1. Over-block

Route agent cards without `recommendation`/`whyYou` are refused (by design; named field). Covers outside `plan:`/`pr:` are refused, so a card about a promise or a feedback item cannot link its row. An agent session's card that covers a plan or pull request keeps its own row as well (only the Chief of Staff's own wait cards stand in for their row), so no agent ask is made less visible; the cost is two linked rows for that item. An agent claim on a person-carried inward card that before finished on agent-certified items now waits for Confirm done (stricter; Echo has none). A memory-scoped session still cannot create cards (unchanged; awareness says so).

## 2. Under-block

Sessions are told, not forced, to write a card instead of a chat ask (Structure > Willpower gap, left behind with a follow-up below). A wait clears and returns with the intermediate clearing record replicating late: the card notices on the next Chief of Staff record, not at once. A person who answers in the wait card's own chat reaches that card's session, not the project's (the recommendation points to the project conversation; noted for slice 3, the embedded-conversation work).

## 3. Level-of-abstraction fit

The card mirrors the Chief of Staff's recorded verdict, the existing authority; it adds no judgment. Approval and claim rules live in the fold, where every surface reads them. Needs-you linking lives in the shared `needs-model.js` that both the console and `GET /needs` use.

## 4. Signal vs authority compliance

No brittle blocking authority added. The approve-tap amendment removes a tap where nothing is approved (no agent work possible on a person-carried card); the Confirm-done rule adds a person's authority, not the agent's. Only a person's tap approves; no constitution file is touched.

## 4b. Judgment-point check

The wait verdict stays the Chief of Staff's judged, floored verdict. The new points are enumerable mirrors or invariants with stated evidence (spec Decision points table).

## 5. Interactions

Project-app version cards (outward, server-written, uncounted) are unaffected: verified by `ProjectAppCustomSource.test.ts` and a dedicated case. Pickup controller: wait cards are never workable (owner carrier), so no pickups; `created`-first reordering in the pickup-cause walk is limited to the card's own records so policy records keep their place (an existing pickup test caught the first version). The Chief of Staff note and its Needs-you rows are unchanged; the card row folds under them. Expected merge conflicts: #3374 (`WorkBoardService.createCard`, `WorkCardStore` regex export, `ChiefOfStaffLoop` deps), #3377 (`workBoardRoutes.ts`), #3361 (`work-model.js`), #3380 (`needsRoutes.ts`), slice 1 (`ChiefOfStaffLoop.ts`).

## 6. External surfaces

New optional fields in the card read (`whyYou`, `covers`, `createdAt`, `serverOwned`) and in `GET /needs` items (`card`); schema version unchanged (additive). The iPhone, Mac and Android apps should show `whyYou` under the recommendation and may link `card`; apps that do not know them show today's view. No notification is sent by a card, so night hours are untouched. Journal growth: at most a few records per project per Chief of Staff record that changes something.

## 6b. Operator-surface quality

1. Leads with the primary action: the Needs-you row keeps its own action first; the card link is secondary.
2. No raw internals: the link label is fixed plain words ("Has a card on the work board"); the wait id in the need is an 8-hex support detail after the plain sentence.
3. No destructive actions added.
4. Plain language: card titles "X is waiting on you" / "X looks done and needs your OK"; no layout change, so phone width is unchanged (the console renders the existing row).

## 7. Multi-machine posture

Replicated: wait cards and their fields ride the `work-card-record` journal; the writer is the Chief of Staff lease holder, fenced by `mirror` and skipped on the grace tick; a doubly-stale holder's single write is corrected by the next up-to-date sync. Needs-you linking is computed per read from replicated reads. The refusal brake and "logged once" memory are machine-local (logging/retry pacing only). Older builds: drop the new fields and show wait cards as needing Approve until they update (visible, not hidden). Server ownership and the person-carried claim rule are enforced in this build's service and fold; an older build's agent could still edit or claim a wait card, and an older fold finishes an agent claim on an owner-carried inward card without Confirm done, so builds can disagree on such a card's done state until every machine updates. Bound: only agent records are possible there; no approval or outward path opens. No new status surface.

## 8. Rollback cost

`workBoard.chiefOfStaffCards: false` stops every wait-card write. A code revert below this version shows past wait cards as needing Approve (owner archives them) and stops linking; no data migration.

## Conclusion

Review-driven changes: HLC fencing on `mirror`, `created`-first fold, Confirm-done rule for person-carried cards, server ownership, source row kept with a card link, cover allowlist, deterministic close keys, wait start and wait id, need bounded to limits, retry brake. Left behind: structural enforcement of "card instead of chat" (follow-up), late intermediate records healing on the next record, card-chat answer routing (slice 3). Clear to ship.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur** (after one round of concerns)

First read raised two concerns: an agent session's card covering a plan or pull request could drop its own row and so make its ask less visible; and the mixed-version behavior of server ownership and the claim rule was unstated. Both were fixed (only server-owned cards stand in for their row, with a unit test; §7 and the spec's Multi-machine posture now state the bound). Second read: "Concur with the review. Only server-owned cards now drop their own row, and the mixed-version gap and its bound are stated in spec Multi-machine posture and artifact §7." The reviewer also verified that no route can build the server principal, no new path starts work, spends or sends outward without a tap, project-app version cards are unaffected, and no constitution file is touched.

## Evidence pointers

`tests/unit/chief-of-staff-wait-cards.test.ts` (27), `tests/unit/work-board-cards-appear.test.ts` (19), related existing units (WorkBoardService, PickupController, Runtime, needs-read, console-chief-of-staff-needs, ProjectAppCustomSource, console-work-model, chief-of-staff-topic, work-board-wiring, awareness-entry-registry) passing; integration (`tests/integration/work-board-routes.test.ts`) and e2e (`tests/e2e/work-board-alive.test.ts`) additions run in Local Verify.
