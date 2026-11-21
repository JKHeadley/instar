# Side-Effects Review — Agent work cards by default, slice 1 (the request-to-card core)

**Version / slug:** `agent-work-cards-slice1`
**Date:** `2026-11-21`
**Author:** `echo (Instar Agent)`
**Second-pass reviewer:** `reviewer subagent (required: approval gates, pickup lifecycle, a self-triggered holder pass)`
**Tier:** 2 (converged + approved spec `docs/specs/agent-work-cards-default.md`, PR #3594). **Size:** ~25 files, ~2,100 LOC added/changed (source ~1,200; tests ~900). **Effort:** 1 spec (converged in its own PR), 1 commit attempt expected; 4 fixture repairs during the build (the intended behaviour changes), 2 defects found by the new tests before commit (the holder pass yielding before the first card loop; the `refIndex` not dropping stale entries on refold) and fixed.

## Summary of the change

Slice 1 of agent-work-cards-default builds the request-to-card core: `POST /commitments` from an operator conversation writes a Work Board card (id derived from `(originMachineId, id)`, idempotent, swept by the lease holder), the requester is read from the durable message row per adapter arm, the team owner's own request carries approval (locked `need`, deterministic labels), an agent-work card needs no `recommendation`/`whyYou` and defaults `outward: false`, an unapproved agent-work card is `not-started` (no per-card row; one aggregated Needs-you row with the owner's two PIN controls), progress notes land in the card's conversation first (`appendWithEmit`) with paced pointer records, a gate-written card is held for the recording conversation and lifted once per tick, a quiet card gets one automatic re-pickup before the quiet row, deliver writes to the card, `/feedback` requires a `source` and refuses operator conversations, and the trust-request queue gains the undelivered cap, the bounded flush and `DELETE /trust/requests/:id`. Files: `src/core/WorkCardStore.ts`, `WorkBoardService.ts`, `WorkBoardRequestGate.ts` (new), `WorkBoardRuntime.ts`, `WorkBoardPickupController.ts`, `workBoardViews.ts`, `AppConversationStore.ts`, `CommitmentsSync.ts`, `PostUpdateMigrator.ts`, `WriteDomainRegistry.ts`, `trustJourney/AccountPathService.ts`, `src/monitoring/CommitmentTracker.ts`, `src/server/{workBoardRoutes,routes,AgentServer,memorySessionGuard,CapabilityIndex}.ts`, `src/commands/{server,init}.ts`, `src/scaffold/templates.ts`, `src/data/awareness/agent-work-cards.md`, `dashboard/console/{work-model,needs-model}.js` (model only), tests in three tiers.

**Overlap noted (claim check + coordinator):** open PR #3547 (work-front-doors stage 2, project label) touches `workBoardViews.ts` (`cardJson` signature gains `projectTitle`), `workBoardRoutes.ts` deps and `routes.ts`. This slice's edits to those files are additive (new optional `extra` fields on `cardJson`, new optional deps, new routes, a new `placeKey` on the session caller) and do not touch the `projectTitle` lines, so either PR merges first; a textual merge of `cardJson`'s `extra` type is the one expected conflict and is mechanical. #3590 and #3594 do not touch these files.

**Explicitly deferred to slice 2/3 of the same spec (tracked):** <!-- tracked: wc_65c9f55755696498 --> the generalised live-only inject of held-card causes into Telegram/Slack sessions and the `[telegram:… system:work-board]` / `[slack:… system:work-board]` tags (slice 1 lifts the hold into one paced pickup instead; the app form uses the existing `injectLive`); `POST /work-board/cards/:id/asks` and the `blocked-by`/`unblocked`/`blocker-reopened` records and the holder's reverse index (§9); member carriers, visibility by carrier/requester, `carrier-departed` and passes (§8); the one-time `policy-offer` after `caughtUpWithAllPeers` (§5, the boot offer; the row control raises the same request today); the signed `andPolicy` phone tap (§5); the B27 `tookOnWork` tone-review field, the `b27-check` records and the `res.once('finish')` seams on app and Slack replies (§3 "Chat-only requests"); the `AGENT_WORK_CARDS_MIN_VERSION` version floor and the 503 `mixed-versions` refusals (§Multi-machine; slice 1 writes four new kinds, which an older peer reads as `unknown`, see §7/§8 below); the Slack durable-row seam in production wiring (the gate's `slackRow` arm exists and is unit-tested; `server.ts` leaves it absent, so a Slack-sourced request verifies as `unproven-provenance`, treated as a member's); the iPhone screens (§7). Each is named in the spec; the work card above carries the list.

## Decision-point inventory

- `askFieldsRefusal` (`WorkBoardService`) — modify — required only for an ask at creation or on the record that makes one (outward / person carrier / owner-confirms item / waiting-on a person).
- `outward` default (`createCard`) — modify — `false` for the agent, `true` for a person.
- Gate-only fields (`gateOnlyRefusal`) — add — `requester`, `requestTextHash`, `recordedAsHash`, `pickupHold` only from the server principal.
- Request approval (fold) — add — `requester.isOwner` ∧ inward ∧ agent-carried ∧ not withdrawn ∧ `need` locked ⇒ `approvalValid`.
- `need-locked-to-request` (edit + fold) — add.
- `not-started` (deriveStatus) and its refusals (`notStartedRefusal`, `noteRefusalFor`) — add.
- Requester verification (`WorkBoardRequestGate.verifySource`) — add — per-arm lookups against recorded rows and the device record held here.
- Operator-conversation resolution (`AgentServer.attachWorkBoardRequestGate`) — add — Telegram adapter present / Slack adapter present / app conversation exists here.
- Card identity and "has a card" (`requestCardId`, `refIndex`, `cardFor`) — add.
- Terminal vs retryable `cardReason` (`TERMINAL_CARD_REASONS`) — add.
- Hold lift (`liftOneHold`) and quiet re-pickup (`repickupOneQuiet`, `agentChurn` repickup rule, `quietParked`) — add/modify — the pickup controller's brakes.
- Quiet clock (`newestAgentRecordAt`, `QUIET_CLOCK_GRACE_MS`) — modify.
- `/feedback` source rule — add — enumerable kinds.
- Trust request caps and withdraw (`AccountPathService.propose`, `withdraw`) — modify/add.
- Scoped-session admission for notes/records/card read via the SOURCE conversation (`sessionMayUse`, `bindingNamesConversation`) — add.
- Aggregated-row controls (`/work-board/not-started/*`) — add — owner PIN only; per-card signed approve taps.

---

## 1. Over-block

- **A request whose Telegram row is logged with `forwarded` undefined** (older rows, or an app-mirrored row read as native) verifies `unproven-provenance` and is treated as a member's request: it waits `not-started` under the strict policy even when the owner typed it. By design (Know Your Principal): a row that cannot prove the sender's words carries no approval. Visible in the aggregated row and the commitment's `sourceUnverifiedReason`; the owner's one tap starts it.
- **A device record on another machine** makes an app-sent owner message `unproven-provenance` on the recording machine. Spec'd (physical-credential locality). Same recovery.
- **The `need` lock** refuses an agent edit of `need` on a request-approved card even when the agent only wants to fix a typo. Spec'd; the agent refines title/items/links instead. A person's edit of `need` is also ignored by the fold (the fold is the authority and reads the field as immutable); a person who wants different work writes a new card. Named here as the one place this slice is stricter than the spec's prose ("the agent refines…"): the spec makes `need` immutable without excepting a person, and a person-editable locked need would let an edit on one machine void the anchor the approval rests on.
- **`/feedback` with the board on but no `source`** is refused for every Bearer caller. Every shipped Bearer caller (the agent instructions, the built-in skill, its migration) carries the field in the same release; the job scripts that post feedback were checked: the feedback-factory scripts post to `/feedback-factory/*` and `/feedback-inbox/*`, not `/feedback`; `promise-review` only reads `GET /feedback`. A third-party Bearer script that posts feedback without `source` answers 400 with the exact body to send.
- **A scoped session's commitment whose body names another conversation** is `source-mismatch` (403). Spec'd.
- **The daily card ceiling** refuses a gate card (retryable); the request stays `cardPending` and the sweep writes it after the reset. A member of a very active team sees a card appear a day late; the commitment is still in promise-review meanwhile.

## 2. Under-block

- **Slack-sourced requests** cannot verify in production in this slice (no `slackRow` seam wired): never approved from the request, always `not-started` under the strict policy. Honest, conservative; slice 2 wires the row.
- **A live Slack recording session cannot be checked** (`recordingSessionLive` returns null ⇒ treated as live): a held card whose Slack session died lifts only by the quiet lift (`quietAfterHours`), never by a person's cause. Conservative; no second worker ever starts on a guess.
- **A long silent tool run in the recording Telegram session** looks live, so a person's approve on a held `not-started` card is not injected (slice 2) and the card is not lifted until the quiet lift. The brief says so. The agent in that session still sees the approve through its normal reads.
- **`projectKey` resolution** uses the Chief of Staff's project list; an app conversation that is "inside" a project but not its front door lands in `general`. The agent can move it (`edited.projectKey`).
- **The clock-based `quiet` fallback** remains for a card no holder has re-picked-up (after `quietAfterHours + 5 min`); with a dead lease holder a quiet card still reaches the owner's row by the clock, which is the pre-existing behaviour kept as a floor.
- **Any owner row within the scan window can be cited.** A Bearer caller passes `(sourceConversationKey, sourceMessageId)` itself, and the gate verifies THAT row (within the Telegram log's 30-day floor), so approval anchors to the cited row's text, not to the inbound message the session's turn was dispatched for: a short affirmative owner row ("ok, do it") can anchor a request-approved card whose title and milestones are the agent's. The locked `need` (the row's words, shown as "Asked: …") and the "recorded in the agent's words" label are the floors; the spec dropped the age cap deliberately because a stale row approves only its own words. Slice 2's B27 work introduces the per-turn dispatch record, which is the right anchor for a scoped session's `sourceMessageId`. <!-- tracked: wc_65c9f55755696498 -->
- **The needs-card set** is recomputed from the open commitments on each tick (not the spec's incremental set): O(open commitments) per minute, cheap at today's sizes; it misses nothing. Named so a future size signal has a place to look.

## 3. Level-of-abstraction fit

The gate and the sweep are pure lookups over recorded fields in a dedicated module (`WorkBoardRequestGate`), fed by seams (`telegramRow`, `appRow`, `deviceRecord`, team links) rather than reading adapters directly, so the arms are unit-tested in isolation and the wiring in `AgentServer` is thin. Request approval and `not-started` are fold derivations (the same place every other approval fact lives), so every machine computes them identically from replicated records. The hold and the re-pickup are the pickup controller's brakes expressed as records (`hold-lifted`, `quiet-repickup`) that `derivePickupCauses` and the churn brake already read, rather than a parallel scheduler. Notes reuse the app-conversation store (one copy of the words) and a pointer record (small journal). The feedback and trust rules sit in the routes/service that already own those decisions. No new authority was added beside an existing one.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no *judgment* block/allow surface: every refusal is a hard-invariant check against recorded fields (an enumerable domain the spec's table classifies as invariants), which the principle exempts.

Narrative: `askFieldsRefusal`, gate-only fields, the `need` lock, `not-started`, `source-required`, `too-many-undelivered`, `withdrawn-recently`, `source-mismatch` are all structural validators over typed fields with closed value sets. The requester arms are lookups (a row exists, a flag is `false`, a device record is `active`); nothing reads the message's meaning. The only judgments the spec names (milestones, whether two requests are one, whether a reply took on work) are either the recording session's (it supplies `milestones[]`) or hints (`possibleDuplicateOf`) with no blocking power. No LLM gate was added or changed in this slice (B27 is slice 2/3).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The two places where signals could compete are declared in the spec's "Decision points touched": `outward` (a judgment-candidate whose floor is the structural default plus the external-operation gate on real sends; arbiter the recording session) and "whether two cards are one request" (code never merges; `possibleDuplicateOf` is a hint in the brief; arbiter the agent's session). The quiet clock reading agent records only, with a 5-minute grace so the holder's self-heal comes first, is an enumerable rule, not a heuristic over competing signals.

## 5. Interactions

- **Shadowing:** `notStartedRefusal` runs before `serverKey`/`not-approved` in `addEvidence`/`claimDone`, so an unapproved agent-work card answers `not-started` where it used to answer `not-approved`; an outward card still answers `not-approved` (tested both sides). `gateOnlyRefusal` runs before the text checks so a hand-written `requester` never reaches the store. `waitingOnAskRefusal` runs in the route before `setWaitingOn`.
- **Double-fire:** the gate runs on the origin after the response (`res.once('finish')`) AND the sweep runs on the holder's tick; both derive the same card id and `createCard(serverCard)` answers `card-exists` on the second, which links rather than creates (tested). The holder pass runs inside the controller's tick, guarded by the same `running` flag, so it never overlaps a pickup pass. `liftOneHold` and `repickupOneQuiet` each write at most one record per tick and only while no work pickup is pending, so a bulk approve or a dead session yields one hand-over per tick, never a wave.
- **Races:** the holder pass is synchronous by contract (a boot tick that yielded before the first card loop dropped the first poke; found by the runtime suite and fixed). `appendWithEmit` reserves the emit before the durable append, so a rate-capped note is written nowhere; the pending set is reconciled by event id against the pointers, so a note replicated after a takeover is not lost and a same-timestamp pair is not confused (tested). A refold now drops the card's stale `refIndex` entries (found by the sweep test and fixed).
- **Feedback loops:** a `quiet-repickup` is itself a system record, so it must not reset the quiet clock — it does not (only agent records, note pointers, creation and delivered hand-overs do), and its key is the newest AGENT record, so a park's own record cannot mint a new key (tested). The churn brake budgets re-pickups against earlier re-pickups only, so the first runs and the second parks (tested); the park derives `quiet`, which is the row.

## 6. External surfaces

- **Other agents on the same machine:** none; the Work Board store is per agent.
- **Install base:** behaviour change for every agent with the board ON (development agents today; the fleet default for the board is unchanged, dark): agent cards default `outward: false`, an inward agent card reads `not-started` instead of `needs-approval` and leaves the owner's Waiting-on-you lane; `/feedback` requires `source` where the board is on. With the board off nothing changes (tested: every new route 503, `/feedback` unchanged).
- **External systems:** none new. Telegram/Slack are read (durable log), never sent to. The trust path's chat card gets a threaded reply on withdraw (the port has no edit verb; stated in the fragment).
- **Persistent state:** four new record kinds in the replicated `work-card-record` journal (`note`, `hold-lifted`, `quiet-repickup`, `enabled-at`) and new fields on `created`/`edited` (`refs`, `requester`, `requestTextHash`, `recordedAsHash`, `pickupHold`, `by.isOwner`); new fields on commitments (`source*`, `requester*`, `requestText`, `milestones`, `outward`, `recommendation`, `whyYou`, `card*`), `requestText` added to the sync redaction list and clamped at 64,000 on receive; `work-board-note` events with `writerBinding` in the app-conversation store; config defaults added by migration.
- **Timing:** the gate's lookup of the Telegram log is a bounded backward scan (16 MB budget, 30-day floor) on the request path AFTER the response is sent; the sweep and drain are paced per tick and clamped to the journal bucket.
- **Operator surface (Mobile-Complete):** the two owner controls are reachable from the console (PIN) through the aggregated Needs-you row (`needs-model.js` → `#/work/board?s=not-started`); the per-card Approve is the existing tap route (console and phone). The phone's signed `andPolicy` line is slice 2 (tracked above); until then "Approve and widen" from the phone is the console's. `DELETE /trust/requests/:id` is the agent's own action (not operator-facing).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Touched operator-surface files: `dashboard/console/work-model.js` and `dashboard/console/needs-model.js` — MODEL files only (pure functions the pages draw): a status word ("Not started"), the card's Approve action, and one Needs-you row with fixed words.

1. **Leads with the primary action?** Yes: the row's main line is the count and the ask ("N internal cards are waiting for your approval or board setting"), its sub line names the two actions, and it opens the board's not-started view; the card's own Approve is its primary action.
2. **Zero raw internals as primary content?** Yes: no ids, hashes or slugs in the row words; `not-started` is rendered as "Not started" and the needLine reads "Not started: waiting for your approval or board setting".
3. **Destructive actions de-emphasized?** No destructive action added; Approve is `primary`, as on `needs-approval`.
4. **Plain language + phone width?** The words are a non-engineer's; the row reuses the existing Needs-you row renderer (already phone-width). The dedicated not-started VIEW on the board page (the expanded per-card approval fields and the two buttons drawn from `boardJson.notStartedCards.shown`) is console work this slice does not draw: the read-side data and the two PIN routes exist and are tested, the page draws them in the next slice <!-- tracked: wc_65c9f55755696498 -->; until then the row opens the board page, where each not-started card shows its own Approve.

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated**, through the existing `workBoard` replicated store (`work-card-record` journal kind, whole-record HLC merge, fold per card on every machine): cards, `refs`, `requester`/hashes/`pickupHold` on `created`, `note` pointers, `hold-lifted`, `quiet-repickup`, the team's `enabled-at`. Note TEXT replicates through the existing app-conversation store (journal kind `app-conversation-event`), written only after the journal emit is reserved, so a note exists on every machine or on none. Commitments and the verified request text replicate through `commitments-sync` with identity `(originMachineId, id)`; the card id is derived from that identity, so the origin's gate and the holder's sweep write the SAME `created` record; `commitment.cardId`/`cardPending`/`cardReason`/`cardRefused` are origin-written bookkeeping (added to the tracker's BOOKKEEPING set so they do not re-ship the row); the card index is the truth. Sender verification runs once on the recording machine and its verdict replicates, never upgraded elsewhere.

- **Only the lease holder acts** (sweep, drain, lifts, re-pickups), each with idempotent keys (derived card id; `wc:<card>:n:<event>`; `wc:<card>:hl:once`; `wc:<card>:qr:<newest agent record>`; `wb-request-cards:enabled-at:<team>`), so a takeover cannot double-write. One approximation named: when the holder's first sweep runs before the origin's `created` record has replicated to it, both write the SAME key with different field values (the holder's `pickupHold: backfill`, `counted: false`; the origin's `recording-session`, counted) and the HLC merge keeps one; both are holds on an identical card, so nothing is lost, but the backfill/recording distinction on that card is whichever won; the holder's pending-note set and refs index are rebuilt from replicated records and one bounded conversation scan at boot/takeover (tested across a simulated takeover).
- **Machine-local by design (physical-credential locality):** the device record and presence key live in this machine's device registry, so a mirrored or app row is proven only on the machine holding the record; elsewhere it is `unproven-provenance` (spec'd, tested).
- **User-facing notices:** none added (no push, Telegram or Slack notice; the Needs-you row is a read).
- **Durable state on topic transfer:** cards, pointers and commitments are replicated; a held card's hold names the recording conversation by key, which the mesh routes wherever the conversation goes; `recordingSessionLive` is answered per machine, so the holder lifts only when the machine serving the conversation sees no live session (a non-serving holder treats a Telegram topic it does not serve as not live only through `listRunningSessions()` on itself — named as a slice-2 refinement: the live check should ask the conversation's serving machine; until then a holder that does not serve the recording topic may lift one tick early, into one paced pickup, which the churn brake bounds).
- **URLs:** none generated.
- **Status surfaces:** none of `/status`, `/health`, `/capabilities`, `/channels` changed. `GET /work-board` gains `notStartedCards` (the pooled board read; `behind` as today).
- **Mixed versions (honest):** the four new kinds make a card read `unknown` on an OLDER build and stop that build's peer-stream applier at the first such record until it upgrades (the spec's §Multi-machine). The spec's version floor (`AGENT_WORK_CARDS_MIN_VERSION`, 503 `mixed-versions`) is slice 2 (tracked above). In this slice the kinds are written by the holder's pass and the notes route on any machine with the board on; a pool that runs mixed versions during the rollout window will see the older machine's work-card stream wedge until it updates (auto-update closes the window). New FIELDS need no floor (the old validator drops them and folds the card normally, tested by the fold).

## 8. Rollback cost

- **Hot-fix release:** revert the release on every machine together (spec §Rollback). Cards carrying one of the four new kinds read `unknown` on the old build until re-upgraded, and an old build's applier stops at the first such record; cards carrying only new fields fold normally there (the old validator drops them) and are ordinary agent cards.
- **Data migration:** none. Commitments keep the new fields as ignored data; `enabled-at` survives so a re-upgrade does not re-backfill; note text stays readable in the conversations.
- **Agent state repair:** none; config defaults added by migration are harmless on the old build (unknown keys ignored).
- **User visibility:** an inward agent card that read `not-started` reads `needs-approval` again and returns to the owner's Waiting-on-you lane; the `/feedback` `source` field is ignored by the old route.

---

## Conclusion

The review changed two things during the build: the quiet clock gained a baseline (creation and a delivered hand-over count as activity) so a person-written card is never quiet at birth and a Try-again hand-over restarts the window; and the holder pass became synchronous after the runtime suite showed the boot tick dropping the first poke. It also surfaced the honest limits named above (Slack row seam, Slack liveness, the live check across machines, the version floor), each tracked to the follow-on slices on the same work card. The change is clear to ship as slice 1 with the second-pass concurrence below.

---

## Second-pass review (if required)

**Reviewer:** reviewer subagent (independent read of the artifact, the code and a fresh run of the tests)
**Independent read of the artifact: concern — none blocking; all three were artifact-accuracy issues, each resolved below before commit**

Verified by the reviewer against code and a fresh run (store, gate, runtime, trust, routes, e2e and the convergence ratchet all green): `gateOnlyRefusal` runs in both `createCard` and `edit` and admits only the server principal, which no route builds, and the fold derives `requestApproved` from `created.requester.isOwner` plus the locked `need` only, so no HTTP principal mints request approval; `/work-board/not-started/*` refuse device (`owner-only`) and session callers and demand a correct PIN; the re-pickup converges (key on the newest agent record, skipped while any pending or parked pickup stands, budgeted against earlier re-pickups only, the park reads `decision:agent-churn`, a takeover refolds the same key); the holder pass is synchronous and bounded; `appendWithEmit` writes nothing before the reserve and the wiring seeds by event id; the route refusal and the fold both read `needLockedToRequest`; `/feedback` and `DELETE /trust/requests/:id` match the spec.

- *Concern 1 — the Class-Closure overstated two brakes* (`hold-lifted` was keyed by a random suffix, so its once-only came from the `pickupHeld` guard alone and a split lease could write two; the registered `work-board-pickup` ratchet models the spawn budget, not the holder pass). **Resolved:** the lift's key is now deterministic per card (`wc:<card>:hl:once`, a card is never re-held; a second writer is a duplicate, pinned in `agent-work-cards-store.test.ts`), and the declaration above now names the `pickupHeld` guard, the deterministic keys and the runtime ratchet as the evidence, and says exactly what the registered ratchet covers.
- *Concern 2 — §7 "the SAME created record" is approximate* when the holder's first sweep outruns the origin's replication. **Resolved:** named in §7 with its consequence (both are holds on an identical card; the backfill/recording distinction is whichever HLC kept).
- *Concern 3 — an under-block not named:* a Bearer caller may cite any owner row within the 30-day scan, so approval anchors to the cited row's text rather than the turn's inbound message. **Resolved:** added to §2 with its floors (the locked `need` shown as "Asked: …" and the "recorded in the agent's words" label) and tracked to slice 2, whose B27 dispatch record is the right anchor.

**Reviewer's closing read after the resolutions:** Closing read: concur — verified in code (`mintRecordKey` hold-lifted → `wc:<card>:hl:once`, fits `RECORD_ID_RE`; `liftHold` still guards `pickupHeld`; the duplicate pinned in `agent-work-cards-store.test.ts`) and in the artifact's §2 (any-owner-row under-block with floors, tracked to slice 2), §7 (backfill/recording-session same-key approximation named with its consequence) and the Class-Closure (cites the runtime ratchet, names the `pickupHeld` guard and deterministic keys, scopes the registered work-board-pickup ratchet to the spawn budget).

---

## Evidence pointers

- `tests/unit/agent-work-cards-store.test.ts`, `tests/unit/agent-work-cards-gate.test.ts`, `tests/unit/agent-work-cards-runtime.test.ts`, `tests/unit/agent-work-cards-trust.test.ts` (50 tests)
- `tests/integration/agent-work-cards-routes.test.ts` (7 tests, real AgentServer over HTTP)
- `tests/e2e/agent-work-cards-alive.test.ts` (1 lifecycle test through `AgentServer.start()`, real journal/emitter/reader/tracker, two boots)
- Fixture updates for the intended behaviour changes: `tests/unit/WorkBoardService.test.ts`, `work-board-cards-appear.test.ts`, `work-board-my-board.test.ts`, `work-board-wiring.test.ts`, `work-card-closeout.test.ts`, `tests/e2e/work-board-alive.test.ts` (rig clock made consistent).

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/agent-work-cards-runtime.test.ts, howCaught: the holder pass is a self-triggered controller (hold lifts, quiet re-pickups, the sweep, the note drain) that runs inside the registered work-board-pickup controller's tick; its control-loop edge is a recorded transition (hold-lifted / quiet-repickup records are the causes the existing churn brake reads), its steady-state bound is one lift and one re-pickup per tick only while no work pickup is pending, plus the daily card ceiling and the journal-bucket clamp on the sweep and the drain, and its settling brake is the churn park (a second quiet re-pickup parks and derives the quiet row, which only a person's Try again releases) together with the guards that make every holder record once-only (a lift only while pickupHeld, under the deterministic key wc:<card>:hl:once; a re-pickup keyed on the newest agent record and never while a park stands; a pointer keyed by event; enabled-at keyed by team), so no restart, takeover or new owner mints a second one; the runtime ratchet drives the pass across ticks and takeovers and pins one-per-tick, park-on-second and once-only; the registered work-board-pickup convergence ratchet (tests/unit/self-action-convergence.test.ts) covers the spawn-attempt budget the pass feeds, not the pass itself }`.
