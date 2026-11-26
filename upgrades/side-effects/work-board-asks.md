# Side-Effects Review — Work Board, phase 1 (asks)

**Version / slug:** `work-board-asks`
**Date:** `2026-11-12`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see "Second-pass review")`

## Summary of the change

Builds phase 1 of the Work Board from the converged, approved spec `docs/specs/work-board-asks.md`: a card for every decision, answer or sign-off the agent needs from a person, whose chat is a real app conversation. Tier 2. Size: 53 files, about 6,900 added lines (roughly 2,300 of them tests), 37 removed. Effort: 6 spec review rounds (the cap) plus one verification read; this is the first commit attempt.

New modules: `src/core/WorkCardStore.ts` (the `work-card-record` replicated kind, the fold, the material hash, approval, finishing, pickup derivation), `src/core/WorkBoardService.ts` (index and write rules), `src/core/WorkBoardPickupController.ts` (the hand-over loop and its brakes), `src/core/WorkBoardRuntime.ts` (joins the parts), `src/core/workBoardViews.ts` (read shapes), `src/server/workBoardRoutes.ts` (routes), `dashboard/console/work.js` + `work-model.js` (the Work page), and the `work-board-graduation` job template.

Changes to existing code, each additive: `CoherenceJournal` (one more kind in every per-kind map), `JournalSyncApplier` and `ReplicatedStoreReconcilerWiring` (the store's flag path and allowlist row), `WriteDomainRegistry` (two route prefixes), `AppConversationStore` (an optional `systemSource` on a message; an optional hidden-keys filter in `listConversations`), `appInboundDispatch` (a structured `detailed` result beside the unchanged one; a system-origin tag; `admissionKind: automatic` for a system spawn), `SessionManager` (a pure `interactiveSpawnCapacity` read), `PeerPresencePuller` (an optional `onJournalExchange` observer), `mobilePermissionsRoutes` (a `work-card-tap` action kind and the phone tap route), `mobilePairingRoutes` (two device rules, one team tier row), `memorySessionGuard` (two rows), `SharedStateLedger` + `types` (the `work-board` emitting subsystem), `BackupManager` (the work-card journal files), `PostUpdateMigrator` (config defaults), `templates.ts` (three CLAUDE.md lines), `CapabilityIndex` (one entry), `selfActionRegistry` (the pickup controller), `feature-ladders.json` (`workBoard.asks`), and the server wiring in `server.ts`, `AgentServer.ts`, `routes.ts`.

The iPhone card screen is a separate commit (`97040ec`, branch `work-board-cards`) in the app repository on the Mac Studio; it is not in this diff.

## Decision-point inventory

Every one of these is declared in the spec's `## Decision points touched`, with its floor.

- `workBoardRoutes` caller resolution — add — invariant: a request is the agent (server token), a scoped session (its token), a device, or the owner (server token plus the dashboard PIN, or the owner phone plus Face ID). Read from the middleware, never from the body.
- `WorkBoardService.tap` + the fold's approval test — add — invariant: an approval covers the card when its material hash equals the fold's and no material change is ordered after it.
- `foldCard` "approval required" — add — invariant: a function of recorded facts and one person-written policy record.
- `WorkBoardService.checkText` credential refusal — add — invariant: the existing deterministic outbound credential detector, applied to every card text field.
- `cardJson` / `boardJson` visibility — add — invariant: the shared conversation check on the card's one conversation.
- Scoped-session confinement — add — invariant: equality of the card's conversation and the session's place.
- `WorkBoardPickupController` attempt budget and parks — add — invariant shape (No Unbounded Loops): attempts counted from replicated records, a park is a settling state, one ownership re-arm per park.
- `appInboundDispatch` system branch — modify — a system brief is admitted as `automatic` and never replaces a session that does not take it.
- `AppConversationStore.listConversations` hidden filter — modify — pass-through when no card store is wired; shows everything when the card store cannot be read.
- Judgment candidates (the agent's, each with a floor in the spec): whether work is `outward`, whether evidence meets a done item, when to ask or replace a question, which items the agent may certify, whether a card is a project's own finish, whether to open a card at all.

---

## 1. Over-block

- **A person's approve tap can be refused `stale-card` when the card changed between loading and tapping.** That is the design (the tap must cover what was shown); the refusal names the current hash and the page reloads the card. Cost: one more tap.
- **The credential check refuses card text that merely looks like a key** (the same false positives the outbound guard has). The refusal names the field and the kind; the writer rewords or uses Secret Drop. Nothing is truncated or stored.
- **Owner-set length limits refuse a long need or title** with the field and limit named. The writer shortens it, attaches the material as a file in the card's chat, or the owner raises the limit.
- **The daily ceiling (200 agent-written cards) refuses the agent** with the reset time and two ways through. Person-written cards are not counted.
- **A new owner waits up to ten minutes for the previous owner's stream** before acting on a pickup it inherited, and then parks an `outward` card for the person. A legitimately idle previous owner that is asleep causes that wait. It applies only to causes that existed before ownership arrived (or at boot), never to cards first seen while already owning.
- **An attachment link on a card that is being created is refused** (`attachment-not-in-card`): the card has no conversation yet, so it cannot cite a file in it. The writer creates the card, attaches the file in its chat, then adds the link by an edit.
- **A tap that permits something is refused `title-hash-required` without the title's hash.** The console page and the iPhone screen always send it; a hand-written request must too.
- **A malformed write is refused `400 invalid-record`** by the store's own schema before anything is emitted (a missing need, an `http:` link, duplicate done-item ids, a bad due date).
- **Phase 1 refuses a member as carrier, as the person waited on, and as a tapper.** This is the spec's stated one-person scope with its reason (the only presence proof that exists is the owner's).

## 2. Under-block

- **The console PIN is not a body at a keyboard.** An agent session can read the PIN from the machine's secret store and could post a tap with it. This is the existing Approvals posture, stated in the spec (§4 "Limits of the proof") and on the docs page; each tap records which path proved it. The phone path (Face ID over a single-use challenge) does not have this gap.
- **A redact hides text from every read but leaves the bytes** in the journal files until phase 2's compaction, and in earlier backups. The page says so beside the button.
- **A stop brief is an instruction, not a mechanical halt.** A session that ignores it can keep working; what the store enforces is that the card cannot be claimed done and gets no further work pickup, and every send or spend still passes the outbound gates.
- **An agent that touches a card to look busy holds it out of `quiet`.** Accepted and stated in the spec; phase 2's leases are the remedy (CMT-1420).
- **A material edit on another machine that has not replicated yet cannot void a pickup here.** The window is the replication lag. When the edit arrives the delivered hand-over gets a stop (covered by a test: an edit ordered before the approval still produces the stop).
- **Under `outward-only` the agent's own `outward` flag is the only thing that asks for approval.** The agent can set it to false on any card, including one a person wrote, and start. The spec accepts this and the settings screen says so in those words; every real send or spend still passes the outbound gates.
- **Under `outward-only` each agent-written internal card starts its own session,** bounded only by the daily ceiling of agent-written cards and by session capacity (a system pickup is admitted as automatic work and waits when the machine is full).
- **A scoped session reads `source` and `projectKey` on its own card.** It is the agent's session for that card, so it is treated as the agent for that one card.
- **The lanes other than Waiting on you and Done are not paged.** At thousands of open cards `GET /work-board` grows large; the soft budget keeps the first lane short, and paging the rest belongs with phase 3's boards.
- **The approval of a web link covers its address, not what the address serves later.** Shown beside every web link.
- **The store cannot tell whether evidence is true.** Agent-attested finishes are labelled and one reopen undoes them; the graduation record names this as a person's reading.

## 3. Level-of-abstraction fit

The card store is a new replicated store in the `ChiefOfStaffStore` pattern (immutable event records, a pure fold), not a new mechanism. The card's chat is an ordinary app conversation: no second transcript, no polling job, no new conversation role or event kind. Person proof reuses the two existing paths (`createMandatePinCheck`, the `mobilePermissionsRoutes` write gate with its closed action set). Delivery reuses `appInboundDispatch`; the capacity pre-check is a read of the same limits `spawnInteractiveSession` enforces, not a parallel admission system. The hand-over note reuses the shared ledger. Nothing here duplicates a lower-level primitive; the one new low-level thing is the store's own fold.

The single-home table in the spec (and in the CLAUDE.md line) keeps the board from becoming a seventh place for needs: authorization requests, secret requests, plans, the blocker ledger, the attention queue, Chief of Staff bindings and commitments are unchanged.

## 4. Signal vs authority compliance

- [x] Yes — but every block here is an invariant over an enumerable domain or a guard on an irreversible consequence, declared as such in the spec's `## Decision points touched`; none is a brittle heuristic judging meaning.

The blocking checks are: who the caller is (how the request authenticated), whether an approval covers the card (hash equality and ordering), whether approval is required (recorded facts), whether text contains a credential (the existing deterministic guard, irreversible-consequence basis: the store is never rotated away and replicates), whether a person may see a card (the shared conversation check), and the pickup brake (a counted cap). Everything that needs judgment (is the work outward, does evidence meet an item, when to ask) is left to the agent's session with a structural floor and a person's tap able to overrule it. No LLM call is added, and no free-text matching decides anything.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The numbers that could look like one (three attempts, 1 to 30 minute free-check backoff, 24 hours quiet, 30 open cards, 200 cards a day, 10 minutes catch-up) are declared in the spec's "Fixed limits" as owner-set defaults with a stated floor and a legitimate counterexample each; the soft budget of 30 never refuses.

---

## 5. Interactions

- **Conversation lists.** `listConversations` now skips conversations of archived or removed cards before paging. With no card store wired, or one that throws, it behaves exactly as before. Peers filter their own pages the same way because each machine folds the same records.
- **`appInboundDispatch`.** The existing return type and every existing caller are unchanged (`'delivered' | 'refused'`); the structured result is an added `detailed` function. Ordinary messages still replace a stuck session; only a system brief does not.
- **Work admission.** A system pickup's spawn is admitted as `automatic`, so it can never take the recovery slot kept for a person while the machine is overloaded.
- **Phone write gate.** `work-card-tap` joins the closed action set; the challenge store, the audit and the owner-phone check are reused unchanged. The tap has its own rate bucket (`work-card-taps`, 30), so a run of card taps cannot use up the allowance for approvals and switches; the challenge request shares the existing `permission-actions` bucket.
- **Journal sync.** One more replicated kind. A machine on an older build never registers it and never pulls it. The store is forced on with the feature, as the Chief of Staff's is.
- **Session ownership.** The controller acts only where the app conversation service says this machine serves the conversation, re-checks after its durable intent, and serialises pickups one at a time.
- **Shared ledger.** One note per hand-over per machine, by card id only. Best-effort: a ledger that is off or throws does not affect the pickup.
- **Backups.** The machine's own work-card journal files join each snapshot. No other backup entry changes.
- **Chief of Staff.** No card record advances or finishes a Chief of Staff binding; a card may only link a project key for context.
- **Self-action ratchet.** The controller is registered in `SELF_ACTION_CONTROLLERS` (bound: cap + 1 over any horizon) and carries its marker.

## 6. External surfaces

- **New routes** (all 503 when the feature is off): `/work-board`, `/work-board/cards[/:id[/records|/tap]]`, `/work-board/settings`, `/work-board/graduation[/pass]`, `/mobile/work-board`, `/mobile/work-board/cards/:id/tap`.
- **A new line in an agent's session input:** `[app:<alias> "<title>" system:work-board] …`. It never renders as a person; a redacted card's stop carries the card id in place of the title.
- **A new kind of message in a card's conversation:** `Work board: …` lines, stored as agent-role messages with `systemSource: 'work-board'`. An older build drops the field and shows the line as agent text that says in its own words it is the work board's.
- **CLAUDE.md:** one Registry First row, one Feature Proactivity line (marker `instar:work-board`) carrying the single-home rule and the never-approve sentence. Existing agents receive them through the regenerated core region.
- **Config:** a `workBoard` block of owner-tunable defaults (never `enabled`).
- **A daily job** whose gate passes only when a graduation record is due (twice ever); where the board is off the gate fails and no session starts.
- **No new Telegram, Slack or push notice source.** The agent's reply in the card's conversation is the notification.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The Work page's first screen is the lane "Waiting on you"; each row carries its own buttons (Approve, the answer options, Confirm done, Try again). Checked at 1280x728 and 390x844 with fake data in a browser harness: the marked lane and an enabled button are on the first screen at both sizes.
2. **Zero raw internals as primary content?** Yes. Rows show the title and a plain need line; statuses are words ("Needs your approval before the agent starts"). Hashes and record ids are never shown; they ride in the tap body only.
3. **Destructive actions de-emphasized?** Yes. Hold and "Remove for good" appear only inside the opened card, below the constructive actions; Withdraw approval and Archive are secondary buttons.
4. **Plain language + phone width?** Yes. Labels read as a person would say them; the lanes stack at phone width with full-width tap targets. The opened card was checked in jsdom tests, and the live page is driven end to end in the throwaway-agent proof before the operator is asked to try it.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** Cards and every record (including the pickup controller's `dispatching` and `dispatched`, the approval policy and the graduation records) ride the `work-card-record` coherence-journal kind, store key `workBoard`, forced on with the feature. Every machine folds the same records into the same card, hash, status and pickup state. The card's conversation is replicated by the existing `appConversations` store, and its key is derived from the card id, so every machine names the same conversation.

Two machine-local surfaces, each with its reason (physical-credential-locality, declared in the spec): the console PIN tap needs a machine that holds a dashboard PIN; the phone tap needs the machine that holds that phone's device record and presence key. In memory only, on the acting machine: the next free-check time of a pickup waiting for capacity (a restart runs the check at once, which costs one pure read) and the per-peer exchange record used for "previous owner caught up" (a restart treats cards present at boot as inherited and waits for a fresh exchange).

- **User-facing notices:** none are added, so no one-voice gating is needed. The `Work board:` lines are conversation events with ids derived from their record, so a repeat on any machine is a no-op.
- **Durable state on transfer:** nothing strands. A new owner inherits attempt counts and parks from replicated records and never mints a new budget.
- **Generated URLs:** none.

**Status surfaces:** `/capabilities` gains a `workBoard` entry (this machine's view of agent-wide records: card count, cards waiting on the owner, policy, pickup counts). `GET /work-board` carries `behind`, naming a peer whose work-card stream this machine has not caught up with for more than a sync interval, and the page warns "this card may have changed on <machine>" for a card last written there. A dark peer shows as `behind`, never as current.

## 8. Rollback cost

Set `workBoard.enabled: false`. It is read live: every route answers 503, the console page and Home source disappear, the pickup controller hands nothing over and writes nothing, no conversation is created for a peer's card, and the conversation lists stop hiding anything. Records a peer still sends land in the index as data only. Cards and their conversations stay as inert data and come back when it is re-enabled. No data migration and no agent state repair. A code revert is clean as well: the journal kind's files would simply stop being read, and the `systemSource` field is dropped harmlessly by a build that does not know it.

---

## Conclusion

The change is large but built from existing parts, and every block it adds is an enumerable invariant or a guard on something that cannot be recalled. The tests found and fixed six real defects before any live run, and the independent second-pass review found nine more that are fixed in this same change (listed under "Second-pass review"). The first six: a policy change ignored for cards written before it; a Try again on a park counted as a second pickup; a delivered hand-over that got no stop when another machine's edit sorted before the approval; an owner that waited for a previous owner that never existed; a failed automatic re-try that could earn another one; and a mistyped setting name that would have been saved. The known limits (the PIN is not a body, redaction does not erase bytes, a stop is an instruction) are the spec's own and are stated to the operator.

## Second-pass review (if required)

Required: the change touches session spawn admission, inbound dispatch, a guard table and a self-action controller.

**Reviewer:** independent reviewer subagent (read the spec and the code before this artifact; confirmed its first three findings by running a probe against the pure fold).

**Independent read of the artifact: concern raised, then resolved.** The reviewer's closing line was: "Concern raised: the pickup derivation has two confirmed defects (a double hand-over from Try again on a capacity wait, and a spurious stop after every answer-only delivery), plus an unrecoverable `unknown` from concurrent questions and an overstated rollback claim, to fix before this is called done." Each finding and what was done:

1. **BLOCKER: a Try again on a pickup waiting for capacity handed the card over twice.** Fixed in `derivePickupCauses`: a retry is its own cause only on a quiet card, never when it names a cause that is still open. Test: "a Try again on a pickup waiting for capacity releases that same pickup".
2. **BLOCKER: every answer-only delivery was followed by a stop brief.** Fixed: the late-arrival stop considers only work hand-overs. Test: "an answer-only delivery … is never followed by a stop".
3. **Concurrent questions from two machines left the card permanently unreadable.** Fixed in the fold: the later question replaces the earlier, visibly, with a stated reason; the write route still requires `supersedes` and a reason. Test in `WorkCardStore.test.ts`, both arrival orders.
4. **Card-level uncertainty was cleared by any earlier recovery.** Fixed: uncertainty runs from the newest possibly-landed hand-over (including one whose cause is no longer derived) until a recovery delivery closes after it. Test: "an earlier recovery never clears a later uncertainty".
5. **Turning the feature off live did not stop the controller.** Fixed: the switch is read live by the controller, the runtime and the list filter. §8 above now states what is true. Test: "switched off live …".
6. **A settings request could change the policy and then fail.** Fixed: everything is validated before anything is written. Covered in the e2e test.
7. **Malformed agent input came back as 503.** Fixed: the service checks the record against the store's schema before the emit and answers `400 invalid-record`; the unreachable branch is removed. Test in `WorkBoardService.test.ts`.
8. **A server restart counted as an ownership change** and spent a failure park's one re-try. Fixed: the runtime starts from the holder as it is at boot. Test: "a plain restart is not an ownership change".
9. **One throwing card would block every card after it** (a hardening point; no reachable throw found). Fixed: per-card catch in the tick.

Notes acted on: one fold order everywhere (`foldOrder`); a permitting tap must carry the title's hash; `source`, `projectKey`, evidence attachment ids and the controller's refusal reasons pass the credential check, and evidence attachments must belong to the card's conversation; the "<name>'s <action> no longer applies" line is written when a person's pickup is voided, and the "approval no longer applies" line is written on whichever machine sees the stop; a card title's newlines are removed from the brief; a Try again on a waiting pickup runs the free check once, not on every later tick; the pickup derivation no longer folds at evidence or question records, so a long run of evidence is not quadratic; transcript line ids are computed only when a card is serialised. The under-block and over-block sections above gained the items the reviewer listed.

**Re-review after the fixes: "Concur with the review".** The reviewer re-read each fix in the code, re-probed findings 1 to 4 against the fold and found nothing the fixes broke. It left five residual points, none blocking. Two were acted on: an answer that raced a replaced question is now voided with its line instead of being delivered (test in `WorkBoardRuntime.test.ts`), and the iPhone build was checked to send the title hash on every tap (`WorkBoardData.swift`, each tap is built from the card's `titleHash`). Three stand as stated: a settings save can fail after the policy record is written (narrow; the answer says so); a card that arrived from a peer while the feature was off gets its conversation at the next restart or write; a redact can write one extra `void` record.

Notes not acted on, with the reason: the unpaged secondary lanes (stated under Under-block; belongs with phase 3's boards); the journal meta file is not in the backup (the reviewer did not verify a defect; a restored machine is brought current by its peers, and a single machine re-reads its own stream file); a narrow start-lock race in the existing dispatch that this change did not introduce (hypothesis only).

## Live proof (throwaway agent, real server, real console)

A throwaway agent (`init` from this build's dist, development agent, dashboard PIN set, port 4477) was driven on 2026-11-12, as the agent through the API and as the owner through the real console page in a browser:

- Boot: `[work-board] live` on the production boot path; `GET /work-board` returned the real lanes; `/capabilities` listed the board.
- The agent proposed cards; the agent's token on the tap route was refused; a card whose need held a key-shaped string was refused `credential-refused`.
- Console at 1280x728: first screen "2 cards are waiting on you", Approve leading each row. Approve opened "Approve: what this covers" (card, need, done items with the agent-may-certify mark, carrier, the outward line in words), then the PIN prompt. The tap was recorded as `console PIN`.
- The approved card was handed to a real session (`[app→session] spawned`), whose input began `[app:… "<title>" system:work-board]`. The session did the card's task and replied in the card's chat.
- Hold from the owner reached the running session as a stop with the system tag; the session stopped and said so in the chat.
- A restart kept every card, the hold and the approval, and handed nothing over twice.
- The agent asked a question (naming the owner as `owner`); at 390x844 the row showed the two answer options with no sideways scroll; the answer went through the sheet and the PIN, wrote its `Work board:` line and reached a session.
- Evidence, a claim refused without evidence, a claim with it, the owner's confirm (`done`), the agent's edit of a finished card refused `reopen-required`, the owner's reopen (handed over again), then an agent edit of the need: approval cancelled, the line "the card changed (need); the earlier approval no longer applies", and a stop injected into the running session.
- Archive took the card's conversation out of the conversation list while its chat stayed readable; Remove hid the title and need from every read, removed the chat (404) and refused a later agent write `card-removed`.

Three things the live run found that no test had: the board's own lines came back from the message route without their work-board marker (fixed: the row carries `systemSource` and no model-origin row; the console labels them "Work board"); the agent had to know the owner's internal person key to ask a question (fixed: `principal: "owner"`, and `carrier: "owner"`, resolved on the server); and a real session given a made-up task with full machine access starts doing it, which is the feature working, and why the proof used a task that does nothing ("say ready").

Not driven live, covered by tests only: a parked pickup and its Try again, recovery after a refused spawn, a lease-holder change between tap and pickup, and both sides of member and guest visibility (the spec's test-agent-live list names these; they need a forced spawn refusal, a second machine and a seeded team, and are exercised in `WorkBoardPickupController.test.ts`, `WorkBoardRuntime.test.ts` and `work-board-routes.test.ts`). The phone tap is proven by signed-request integration tests; the first real-phone tap is the pilot's first operator step, as the spec says.

## Proportion and a warning for the next change

Tier 2; 6 spec rounds (the cap) and one commit attempt; one independent review with a re-read. The CLAUDE.md core region is now within about 20 characters of its 80,000-character budget (it was about 1,000 under before this change). The next feature that adds a core line will fail `claude-md-reference-layout`; the lines added here were cut three times to fit.

## Where the build reads the spec narrowly

Each of these is a choice inside the spec's words, recorded so a reader can check it:

- **`multiMachine.stateSync.workBoard` is not written by the config migration.** The spec says the same migration sets it. The runtime forces the store on with the feature (as the Chief of Staff's is), so no flag in the file is what turns replication on; and a migration step that touched `multiMachine` was not a no-op on its second run (another step creates that block later in the same pass), which the migration idempotency tests caught. No existing migration writes a `stateSync` flag.
- **"Previous owner"** is the last other lease holder this machine saw, plus every other machine that wrote a record on the card. With neither, there is no previous owner to wait for. The exchange record is in memory, so after a restart a card present at boot waits for a fresh exchange.
- **The graduation records** are records in the card store (`wb-graduation:day7`, `day14`, system-written, replicated), measured from the pilot's first card. The job is a prompt job whose gate passes only when one is due.
- **Concurrent questions** from two machines: the write route enforces `supersedes` and a reason; the fold, which cannot refuse, marks the earlier question replaced with a stated reason instead of making the card unreadable.
- **A permitting tap must carry the title's hash** on both paths (the spec requires it in the phone's signed line; the console now requires it too).
- **The `Work board:` line for a voided approval** is written by the machine that writes the edit, and again (same line id, so once) by the machine that sees the stop.

## Evidence pointers

- Unit: `tests/unit/WorkCardStore.test.ts`, `WorkBoardService.test.ts`, `WorkBoardPickupController.test.ts`, `WorkBoardRuntime.test.ts`, `work-board-wiring.test.ts`, `console-work-model.test.ts`.
- Integration: `tests/integration/work-board-routes.test.ts` (production auth middleware, device authenticator, session guard, real pairing service).
- E2E: `tests/e2e/work-board-alive.test.ts` (real AgentServer, real journal, emitter and stream reader, including a rotation).
- iPhone screen: commit `97040ec` on branch `work-board-cards` in the app repository on the Mac Studio; app builds for the simulator, 576 unit tests run with 0 failures.

## Addendum (2026-11-13): CLAUDE.md size

Local Verify failed `tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts`: a standalone init
plus the first migration produced a 80,009-character CLAUDE.md against the 80,000 core budget. Main
alone measured 79,214 after migration; this PR added about 780 characters to the always-loaded core.
The detail now lives in a `**Work Board**` paragraph that the layout files under
`.instar/reference/autonomy-and-commitments.md` (listed in INDEX.md and the capability list). The core
keeps a shorter registry row and a one-line proactive trigger that still says only a person's tap
approves a card; the full never-approve sentence is in the reference paragraph. Measured after
merging main (standalone init, then the migrator): 79,540, i.e. 460 under the budget. The budget is
unchanged. Rollback: revert the commit.
