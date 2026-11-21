# Side-Effects Review — Work cards: Done with a note, Not important with a reason, whose turn, and the card's conversation

**Version / slug:** `work-card-closeout`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Slice 3 of the Work Board plan, agent side, driven by the approved, converged `docs/specs/work-front-doors.md` (§6 "Closing a card needs a closeout note", "'Not important' closes a card with a required reason; reasons become lessons the agent checks before raising a new card", "Dismissal lessons keep their source"; decision 3 "card and chat on one page"). Tier 2 (touches the person-tap path and the phone Face ID signed line). Size: 6 source files (`src/core/WorkCardStore.ts`, `src/core/WorkBoardService.ts`, `src/core/workBoardViews.ts`, `src/server/workBoardRoutes.ts`, `src/server/mobilePermissionsRoutes.ts`, `src/server/CapabilityIndex.ts`), one awareness entry, three new test files (unit, integration, e2e); about 250 lines of source. Effort: no spec rounds (already converged and approved), one build pass.

- A person's close is an `archive` tap carrying `closeAs` (`done` | `not-important`) and a required `note` (1–2000 chars, credential-checked). Reopen is the existing `unarchive` naming the tap. The fold exposes `closeout` (the newest standing archive when it carries a note). A "Done" close shows in the Done lane; "Not important" and a plain archive stay archived.
- `GET /work-board/lessons` (bearer only) lists standing "Not important" reasons with who gave them and the card/tap they came from; an agent's `POST /work-board/cards` answer carries the newest 10 as `lessons`.
- Every card read gains `turn` (`you` | `agent` | `others` | `nobody`, from the viewer's lane), `started`/`startedAt` (first person tap, hand-over, evidence or claim), `closeout`, and `conversation` (the card's own app conversation and the EXISTING read/send routes). The board lists untouched cards first in the three open lanes.
- The phone's signed tap line covers `closeAs` and `note` (only when present, so every existing line is byte-identical).

## Decision-point inventory

- Person-tap authorization (`POST /work-board/cards/:id/tap` PIN, `POST /mobile/work-board/cards/:id/tap` Face ID) — pass-through. No new gate; the close rides the existing tap path and the existing write gate. The agent still cannot tap.
- `WorkBoardService.tap` input validation — modify: `archive` accepts the close fields and refuses a close without its note (`note-required` / `reason-required`), an unknown `closeAs`, an over-long or credential-bearing note.
- Phone `buildAction('work-card-tap')` — modify: shape-checks the close before a challenge is issued.
- Record schema (`workCardRecordStoreSchema` tap case) — modify: accepts `closeAs`+`note` only together and only on `archive`.
- Lane assignment (`laneFor`) — modify: an archived card with a Done close goes to the Done lane.

---

## 1. Over-block

A client that sends `note` without `closeAs` on an archive is refused (`unknown-close`) — intended: a note with no meaning is a client bug. A plain `archive` (no close fields) is still accepted, so existing clients keep working. No legitimate tap that worked before is refused.

## 2. Under-block

**A documented departure from §6:** a plain `archive` (no note) is still accepted, although §6 says "Closing a card needs a closeout note." It stays because every shipped client (dashboard, iPhone, Mac) has an Archive button that sends no note; refusing it would break them on update. The Done / Not important buttons are the way a person closes a card going forward, and retiring the noteless Archive from the clients is tracked under CMT-1803 <!-- tracked: CMT-1803 -->. A plain archive never becomes a lesson.

The note is only checked for presence, length and credentials; a one-word note ("ok") passes. That is the person's own choice and a judgment we do not second-guess. A machine on an older build folds a close as a plain archive (it drops the two fields), so until it updates it shows the card under Archived without the note; both builds agree the card is closed and not workable.

## 3. Level-of-abstraction fit

The close is data on the existing tap record, folded by the existing fold, authorized by the existing person-tap paths. Lessons are derived from the replicated card store, not a new store. The conversation inside the card names the existing app-conversation routes, which already decide per reader what may be shown (pool merge, origin verification, pins, team scoping), instead of copying messages into the card read and duplicating that logic.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface.

The only authority touched is the existing person-tap requirement, unchanged. The lessons are a signal the agent reads (and receives on create); nothing blocks a card on a lesson.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Untouched first" is presentation order; `started` is a factual derivation (a person tap, a hand-over, evidence or a claim exists). Whether a new card repeats a dismissed one is left to the agent's judgment, informed by the lessons.

## 5. Interactions

- **Pickup controller:** a close is an archive, so the existing workable→not-workable `stop` cause and stop brief fire exactly as for an archive on every build (no divergence between old and new machines). The stop brief already tells the session to read the card, which now carries the note.
- **hiddenConversationKeys:** the code is unchanged, but note the effect: a Done close is an archive, so its conversation leaves the default conversation list (as every archived card's does), while a card the agent finished and the owner confirmed keeps its conversation listed. Hiding the Done close's chat matches spec §3.2 ("A done card's conversation leaves the default conversation list"); the agent-finished case not being hidden is pre-existing and is left as it is here.
- **Board order and the soft cut:** "untouched first" is a display order only. Which "Waiting on you" cards survive the soft cut is still chosen oldest first, exactly as before; only the shown slice is reordered (a test pins this). Source: the Work Board plan Justin told us to proceed with (2026-11-17 22:35, topic 134088) lists "Untouched cards first" as "a design detail, no approval needed"; it is not spec text.
- **`started`:** derived from the fold (person taps, evidence and claims that passed the store's checks) plus the pickup controller's hand-over records.
- **Signed line:** `tapActionLine` adds the close fields to the digest only when present; a test pins the old digest byte-for-byte.
- **Open PRs:** #3374 edits `workBoardRoutes.ts` (single-card read, `afterCardCreate`), `mobilePermissionsRoutes.ts` (`buildAction` after the work-card-tap branch) and the same `CapabilityIndex` endpoints line; #3377 edits `workBoardRoutes.ts` and the old integration/e2e work-board tests. Expected textual conflicts are small and mechanical; this PR adds new test files instead of editing the shared ones.

## 6. External surfaces

- **Phone builds the line itself:** the challenge answer returns no line, so each app computes `tapActionLine` locally. Every app must reproduce the new digest exactly: `closeAs` and `note` are in the canonical JSON only when a close is sent, and the label reads `close as done` / `close as not important`. The PR body and the awareness entry give the exact shape; a mismatch fails closed (presence-invalid), never applies a different note.
- **Mixed versions on writes:** a new app's close sent to a machine still on the old build is refused there (its line has no close fields, so the signature fails: safe). A console close sent to an old-build machine is saved as a plain archive WITHOUT the note, because the old `tap()` ignores the two fields; the card still closes. This window ends when that machine updates; the console is served by the machine it talks to, so it is the machine being updated.
- Card JSON gains fields (additive). `status` values are unchanged (no new enum value a Swift decoder could reject); the Done close uses the existing `done` lane value.
- Board order changes inside the open lanes (untouched first).
- Operator surface: the close is a person action. Phone: Face ID over the signed line (route exists; the app needs the two buttons). Console: the PIN tap route accepts it; the dashboard buttons and the chat inside the card page are owned by the dashboard session (handoff sent). The agent never closes a card.
- No Telegram/Slack/external sends. The close adds one `Work board:` line to the card's own conversation (existing line path, credential-guarded).

## 6b. Operator-surface quality

No operator surface file (no `dashboard/` file) is changed here — not applicable. The card JSON gives clients plain words: `needLine` reads "Done: <note>" / "Not important: <reason>".

## 7. Multi-machine posture

**Replicated.** The close and its note live on the tap record in the replicated work-card store (coherence-journal kind `work-card`), so every machine folds the same `closeout`, the same lessons and the same `started`. Lessons are derived per machine from its replicas (unified by derivation, as §4.5 of the spec requires); a machine behind shows its existing `behind` signal. Phone taps stay machine-local by design (`physical-credential-locality`, inherited from work-board-asks). Mixed versions: an old build folds the close as a plain archive (fields dropped, card still closed and not workable), never as an unreadable card. No new notices (the conversation line already exists per tap), no URLs (the conversation paths are relative and served by whichever machine answers). No status surface changes.

## 8. Rollback cost

Revert and ship a patch. Records written with close fields stay in the journal; a reverted build folds them as plain archives (the old validator drops the two fields), so no data repair is needed and no card becomes unreadable.

## Conclusion

The slice reuses the tap path, the fold, the replicated store and the existing conversation routes; it adds no gate, no store and no status value. Deferred to later slices, tracked under CMT-1803 (stage 3) <!-- tracked: CMT-1803 -->: the "To" picker and the card following whoever is addressed (plan slice 8), and quiet check-ins / drafts on cards. Client buttons (dashboard, iPhone, Mac, Android) are separate client work.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose), round 1
**Independent read of the artifact: concern**

- Untouched-first has no spec text and changes which cards survive the soft cut. **Resolved:** the cut is chosen oldest first as before and only the shown slice is reordered (test added); the source (the plan, "design detail, no approval needed") is cited in §5.
- A plain archive still closes without a note. **Resolved:** stated in §2 as a documented departure, with the reason and the CMT-1803 tracking.
- A Done close hides its conversation while an agent-finished card does not. **Resolved:** documented in §5 (matches spec §3.2 for done cards).
- The phone builds the line itself; old-build machines treat a console close as a plain archive. **Resolved:** both documented in §6.
- `startedAt` read raw records. **Resolved:** it now reads the fold plus hand-over records.

**Round 2: Concur with the review.** All five round-1 points verified fixed in the code and the artifact; authority, note binding on both phone routes, the unchanged old digest, old-validator field dropping and privacy remain sound.

## Evidence pointers

- `tests/unit/work-card-closeout.test.ts` (17 tests, pass locally).
- Existing `WorkCardStore`, `WorkBoardService`, `WorkBoardRuntime`, `WorkBoardPickupController`, `ProjectAppCustomSource` unit files pass unchanged (137 tests).
- `tests/integration/work-card-closeout-routes.test.ts`, `tests/e2e/work-card-closeout-alive.test.ts`: typechecked locally; run by Local Verify (integration/e2e are not run on this machine).
