# Side-Effects Review — Anchor and ledger backfill (Phase 1 S7)

**Version / slug:** `cb-backfill`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

Phase 1 slice S7 of `docs/specs/context-budget-layered-summaries.md` (§6.1 backfill paragraph, decision 9, §12 "Backfill daily cap", §14, §15 row "Anchor/ledger backfill", §17, §18). The branch sits on S6 (A and G). Existing topics get their Anchor and ledger rebuilt from TopicMemory history; history entries are `backfilled-unconfirmed`; one confirmation per topic is folded into a later reply.

New:

- **`src/monitoring/contextLayers/backfillLane.ts`** (`BackfillLane`, `topicOwnerCheck`):
  - **Owner only.** `topicOwnerCheck`: pool placement not live ⇒ this machine owns every topic only when it is the agent's only machine (§14, "a single machine is trivially the owner"; server: no mesh identity, or one pool machine); a dark pool of several machines reads `unknown`. Live ⇒ the ACTIVE ownership record must name this machine (`placing`/`transferring` skipped). No record, no registry, no mesh id, or a throwing read ⇒ `unknown`, skipped like `false` (counted apart). Never "the lease holder".
  - **Recency order.** TopicMemory's `last_activity`, newest first. A topic already `in-progress` goes first so it finishes.
  - **Daily cap.** `BACKFILL_DAILY_TOPIC_CAP = 20` topics started per UTC day (§12). A topic resumed on a later day counts on that day once.
  - **Resumable.** One file, `server-data/context-budget-backfill.json` (0600): the day, the topics started today, and a per-topic record (`in-progress | done | failed`, attempts, the history bound taken at the first attempt, result). A restart neither redoes a done topic nor skips one cut off mid-way. An unreadable file restarts the bookkeeping with a degradation record (every step is idempotent).
  - **Bounded and background.** A timer (first tick after 2 min, then every 10 min). At most 2 topics per tick, at most 5 U pages (200 rows each) per topic per tick with a yield between pages; the rest resumes next tick. Skips a tick under quota pressure (`critical`/`stop`). Never on a reply's path; sends nothing.
  - **Failures.** A topic failing 3 attempts is parked `failed` with one `DegradationReporter` record; a topic still listing U after 40 ticks is parked `failed` (`topic-stalled`); others proceed. featureEvidence rows (`contextBudget.backfill`): `fired` per topic done with entries, `outcome` per Anchor-only topic, `error` per failed attempt (the ladder's metrics).
  - **A replicated backfill.** A topic whose Anchor record already carries `backfilledAt` (a former owner did it) is marked done without spending the cap.
  - **No model call.** The lane reads the refs and referent stubs the extractor already wrote inside its own budgeted calls (the integration test asserts zero provider calls during a tick). See Under-block for what this leaves out.
- **`AnchorLedger` (S6) extended**, behind a live switch read (`backfill: () => boolean`; absent or false ⇒ S6's behaviour exactly):
  - **History.** Messages before the ledger's first live pass (`ledgerFromMessageId`, S6), or, for a topic the lane reached first, up to and including `historyThroughMessageId` (the topic's latest message at the lane's first attempt). The predicate is shared by both rules and memoised per pass. A live pass never moves a lane-set bound (`writeAnchor` keeps `ledgerFromMessageId` null when `historyThroughMessageId` exists).
  - **§15's validator.** A history ref not bound to a protected operator row (an agent proposal, a third party's or a forwarded row) is not written as an entry (`backfill.skippedNotOperator`). An entry already written keeps being derived.
  - **`backfilled-unconfirmed`.** An operator-bound history entry gets that status, with its normal derivation kept beside it (`backfillDerivedStatus`, `statusBasis: backfilled:<status>`, `fromHistory: true`). A withdrawal or a supersession still applies. The first operator episode after history (re-reference, affirmation, positive confirmation, from a protected operator row) gives the entry its normal status. A history episode does not.
  - **No per-entry confirmation for history.** S6's `predatesLedger` rule now also covers the lane's bound, so a history evolution never asks on its own.
  - **One confirmation per topic** (`kind: backfill`, refId `backfill-<topic>`). Requested while any entry is backfilled-unconfirmed and none is queued (again if lost), never after it expired. Settled when none is left. Its facts live on the replicated Anchor record: `backfillConfirmRequestedAt`, `…SurfacedAt`, `…ExpiredAt`, `…SettledAt`, kept across Anchor rewrites. The proposition names up to 3 backfilled refs (the extractor's own distilled text, already in the TopicIntent file) and counts the rest.
  - **Asked once.** Surfaced by the first non-automated agent reply after a user turn later than the turn it went outstanding (S6's rule, now for `backfill` too); that reply removes it from the queue (`settled: asked`), so it is asked exactly once and never re-requested. It reads `asked` for 7 days, then `expired` (derived from time). The entries stay backfilled-unconfirmed, usable and labelled, until the operator's own words after history move them.
  - **`backfillTopic(topicId, { historyThroughMessageId })`**: the lane's step. Keep the Anchor, bind history only on a topic no live pass reached, stamp `backfilledAt`, force a re-derive.
  - **Views.** `backfillView` (store-only: state, bound, count, confirmation `none | pending | asked | expired | settled`; `asked` = asked within 7 days with entries left). `measureAnchorLedger` gains `backfill`. `pendingSummary` counts `backfill` and reports `awaitingUserActivity`. `entryView` gains `backfillDerivedStatus`.
- **Tests:** `tests/unit/context-layer-backfill.test.ts` (21), `tests/unit/migrate-context-budget-backfill-row.test.ts` (2), `tests/integration/context-layer-backfill.test.ts` (5), `tests/e2e/context-layer-backfill-alive.test.ts` (5).

Modified:

- **`src/core/TopicIntentPendingConfirm.ts`** (extended, decision 15): `kind: backfill`.
  - **Rank.** evolution 2 > backfill 1 > ref 0 (`insertAt` places by rank, FIFO within one).
  - **Displacement.** A backfill never displaces an outstanding confirmation. An evolution displaces an outstanding ref or backfill, requeues it ahead of its own rank, and clears its surfacing so it is surfaced again.
  - **Clock and dequeue.** The evolution clock (`PENDING_TTL_BY_KIND.backfill`). Never dropped at dequeue for naming no ref.
  - **Refill.** From `deferred`, the highest rank first.
  - Ref records stay byte-identical (no `kind` stamped).
- **`src/core/TopicIntent.ts`**: `PendingConfirmKind` gains `backfill`.
- **`src/core/TopicIntentBriefing.ts`**: an outstanding backfill confirmation renders, as "REBUILT FROM EARLIER HISTORY, UNCONFIRMED (fold one line into this reply …; never a separate message; silence never confirms it)", only when the topic's user-turn counter is past the turn it went outstanding. Before that it is not rendered at all, and `pendingOutstanding` reads false.
- **`contextLayersBoot.ts`**: `attachBackfillLane` / `backfillLane()`, and `status().backfillLane`.
- **`layerCaptureWiring.ts`**: a `backfillEnabled` option passed to the ledger, and `startBackfillLane(...)` building the lane over U and the ledger (null without them).
- **`src/commands/server.ts`**: the switch read live, `contextBudget.backfill.enabled` (default false); the lane started with the server's owner rule (`topicOwnerCheck` over `multiMachine.sessionPool`, `sessionOwnershipRegistry.ownerOf`, `_meshSelfId`), `listTopics`, `getRecentMessages(…,1)`, quota shedding, and degradation records.
- **`src/monitoring/contextBudgetMetrics.ts`**: `anchors.backfill`, over every topic with layer records here:
  - `topicsBackfilled`, `backfilledUnconfirmed`;
  - `pendingConfirmations` and `pendingTopics` (≤ 50), which is what the dashboard card and Home's count read;
  - `expiredConfirmations`;
  - `lane`, the lane's status or `{ wired: false }`.
- **Registration:**
  - `guardManifest.ts`: a `contextBudget.backfill` config entry, `defaultEnabled: false`, `liveConfig: true`, component `BackfillLane`.
  - `feature-ladders.json`: a sensitive ladder entry with dev-agent and fleet rungs on featureEvidence `fired` and `error`.
- **Awareness:**
  - `templates.ts` gets a Registry-First row (sniffed on `anchors.backfill`), and `PostUpdateMigrator.ts` inserts the same row after the anchor-ledger row.
  - `CapabilityIndex.ts`: description text.
  - `feature-delivery-completeness.test.ts` tracks the migrator row.

## Decision-point inventory

- **Lane admission** (add): owner check, cap, recency order, shedding. Deterministic.
- **History classification and §15's operator-bound validator** (add). Deterministic over TopicMemory order and U's labels.
- **`backfilled-unconfirmed` override and its exit** (add). Deterministic: an exit needs an operator episode after history.
- **Backfill confirmation request, render gate, surfacing, expiry, settle** (add). Deterministic.
- **Pending-confirmation rank and displacement** (modify): a third rank.

---

## 1. Over-block

- Nothing is blocked; no message, send or session is affected.
- **A history entry reads `backfilled-unconfirmed` even when the operator did settle it in history** (for example a confirmed evolution, or a derived-settled decision). This is §6.1's rule: the label is the point, and `backfillDerivedStatus` keeps what it derived. The entry is "fully usable"; the packet renderer (a later slice) is where usable-and-labelled is rendered.
- **History refs not bound to an operator row are left out of G entirely** (agent proposals, third-party and forwarded rows). This follows §15's validator. The refs stay in TopicIntent, and the briefing still shows them by their own tiers.
- **The lane skips every topic while pool placement is live and the topic has no ownership record**: inactive topics in a pool may never be backfilled. That is the safer side (`unknown` never reads as yes) and is counted (`skippedOwnerUnknown`).

## 2. Under-block

- **No model call, so no recovery of what the extractor never saw.** A topic whose history predates the topic-intent capture loop has no refs, so its backfill is the Anchor only. Decisions from before the layers have no referent stub, so their derivation reads `pending` (`no-stub`). Replaying history through the extractor (and the stub writer) under the background lane's cap is NOT built. §6.1 and decision 9 say "from TopicMemory only … background lane", and §15 lists the backfill as tier 1 with an operator-row validator, which is implemented. A replay would be the tier-1 model step. Listed for the Phase 1 review.
- **"Asked inside a reply" is a render gate, not a check of the reply.** The briefing shows the line only after user activity since the request, and the instruction says fold it in, never standalone. Nothing verifies that the reply carried it. "Surfaced" is inferred from the next reply, as S6's evolutions are. The floor still holds: silence never confirms, and expiry only removes the question.
- **The race between the briefing fetch and the turn bump, now with ask-once.** Capture bumps the user-turn counter after a yield, and the prompt hook fetches the briefing. If the fetch wins (or the agent ignores the line), the next reply still counts as the asking reply and the question is settled `asked` without having been shown. The window is small, nothing is lost (the entries stay `backfilled-unconfirmed`, usable and labelled, and the operator's own later words still move them), and it never appears early. Hardening (render-proof before marking asked) is listed for the packet renderer slice.
- **A positive answer to the backfill question is not interpreted.** There is no production answer interpreter (`interpretAnswer` has no caller, as in S6). The entries leave `backfilled-unconfirmed` through the extractor's own episodes on their refs (re-reference, affirmation, contradiction) from the operator's reply.
- **One outstanding slot.** A live evolution displaces the backfill confirmation, which waits behind it (S6's stated bound applies).
- **The history bound is taken at the lane's first attempt.** A message that arrives between the first attempt and completion counts as history unless a live pass binds `ledgerFromMessageId` first, and a live pass does, because the first live turn writes the Anchor.

## 3. Level-of-abstraction fit

- The lane only schedules. The derivation stays in `AnchorLedger.reconcile` (one place for the history rule, S6's settle rules and supersession). The confirmation stays in the extended `PendingConfirmationManager` (a kind, not a new queue). The render gate sits in the briefing, beside the evolution block. The owner rule is one exported helper used by server.ts and the e2e test.

## 4. Signal vs authority compliance

- No new authority. `backfilled-unconfirmed` is a weaker reading than anything S6 derives. Its exit needs a protected operator row's episode after history (the bound row stays the sole write path to settled or confirmed state).
- The lane's owner check only withholds work. The confirmation only asks.

## 4b. Judgment-point check

- **`BACKFILL_DAILY_TOPIC_CAP = 20`**: the §12 Defaults value.
- **2 topics and 5 U pages per tick; 10-minute tick; 3 attempts**: event-loop bounds on file work, with no irreversible consequence (all resumable).
- **3 named refs in the proposition**: keeps the line one line.
- None gates a message.

## 5. Interactions

- **Capture loop.** The live `afterTurn` path gains the history rule and the confirmation only while the switch is on. Off, the ledger writes S6's data byte-for-byte (the new fields are added only when on), and the memo signature gains the switch so a flip re-derives.
- **U.** The lane calls `userCorpus.refresh(topic)` with no message id: the same bounded page a turn lists. The watermark is shared, so the live path and the lane never re-list rows.
- **Pending queue.** A backfill confirmation can be outstanding in an idle topic until the next reply after user activity (then it leaves the queue). A ref confirmation created meanwhile queues behind it for that long; a live evolution displaces it.
- **TopicIntent file.** The lane writes only through the manager's locked `mutate` (`create`, `settle`).
- **Server load.** The lane is file IO only, two topics per 10 minutes, and yields between pages.

## 6. External surfaces

- `GET /topic/:id/anchor` gains `backfill` (and `pending.outstanding.awaitingUserActivity`, and `queued.backfill` / `deferred.backfill`).
- `GET /context-budget/metrics` gains `anchors.backfill`. `GET /context-budget/layers` gains `backfillLane`.
- The topic-intent briefing can show one new block, inside a reply, after user activity.
- New config switch `contextBudget.backfill.enabled` (default off, live). No outbound messages; no new routes.
- S14's dashboard card and Home's count (another branch) are not touched. They read `anchors.backfill.pendingConfirmations` once wired.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or form file is touched (the card is S14's).

## 7. Multi-machine posture (Cross-Machine Coherence)

- **The lane: owner-acts.** It runs only where `topicOwnerCheck` says this machine owns the topic. §14's write domain lists "backfill confirmation … owner-only, PIN or reply-bound"; this one is reply-bound.
- **Backfill facts: replicated.** They live on the `anchor` record (the `context-layer-record` kind, already replicated per S6), so a new owner sees `backfilledAt` and does not redo the topic or spend its cap. The confirmation's clock facts move with it.
- **The lane's state file: machine-local** (`machine-local-justification: scheduling bookkeeping`). It is a cap counter and resume pointers for work this machine does; losing it only means idempotent redo. After a topic move, the new owner's lane sees the replicated `backfilledAt`.
- **The confirmation queue: machine-local** (S6's posture, TopicIntent is not replicated). After a move, the new owner's reconcile re-requests it while entries are still backfilled-unconfirmed and it has not expired.
- **Status surfaces** read this machine's layer store and lane, labelled as such (`scope: all-topics-with-layer-records`).

## 8. Rollback cost

- `contextBudget.backfill.enabled: false` (live, no restart): the lane stops at its next tick; the ledger's next pass on a topic returns its entries to S6's derivation and settles a waiting backfill question (`switch-off`). Idle topics keep `backfilled-unconfirmed` records on disk until their next pass, so `anchors.backfill` can stay non-zero for them.
- `contextBudget.enabled: false` removes everything at restart, as in S6.
- The release revert needs no migration. Records carry optional fields older code ignores. An older manager treats a `backfill` record as a ref: queued, it is dropped at revalidate (`ref-missing`); outstanding, the older briefing shows it as an ordinary pending confirmation until the ref clock sweeps it (its stored TTL is 1 turn).

## Conclusion

S7 adds the backfill lane: owner only, recency order, 20 topics a day, resumable, background, no model call. It extends the ledger's history rule so operator-bound history entries are `backfilled-unconfirmed`, and closes S6's gap: old purpose changes now get one backfill confirmation per topic, asked only inside a reply after user activity. It extends the confirmation primitive with a `backfill` kind, and exposes pending backfill confirmations on the anchor route and the metrics for S14's card and Home. All behind a new default-off switch registered on the ladder.

Known gaps, stated above:

- no history replay through the extractor (pre-capture history yields an Anchor only; pre-layer decisions have no stub);
- "asked inside a reply" is a render gate plus the next-reply surfacing inference;
- no answer interpretation for the backfill question;
- pool topics without an ownership record are skipped;
- S14's card and Home are on another branch.

---

## Second-pass review (if required)

**Reviewer:** Fable 5.2 (independent subagent)

### First pass

**Independent read of the artifact:** Concern raised: one blocker (the backfill line is asked in every reply for at least 7 days, and stalls ref confirmations for that time) and five should-fix items. The rest of the artifact matches the code.

Read independently: spec §6.1, §12, §13 decision 9, §14, §15, §18; the full diff against 244005734 and the new files; S6's artifact. Ran with `--maxWorkers=1`: the four S7 test files plus the S6 ledger, pending-confirm and briefing suites (unit 84/84, integration 5/5, e2e 5/5, all green). Findings marked "reproduced" come from a temporary probe built on the unit test's own rig (real TopicMemory, U, store, ledger, manager, briefing), since deleted.

**Checked and found sound**

- A non-operator row cannot lift an entry: `operatorEpisodes` keeps only episodes whose message is a protected operator row (`anchorLedger.ts:408-414`), and the exit at `:631` reads only those. A history episode does not lift (`!predates(...)`).
- History refs not bound to an operator row are left out (`:596`); a withdrawal or supersession still applies (`:630`).
- No render and no surfacing without user activity: `TopicIntentBriefing.ts:84` and `anchorLedger.ts:794` both need `turn > sentAtTurn`; a dequeue resets `sentAtTurn` (`TopicIntentPendingConfirm.ts:433`).
- Switch never on ⇒ S6 data unchanged: new entry fields are written only when on (`:670`); ref records carry no `kind`; rank and insert positions for evolution and ref are the same as S6 when no backfill record exists.
- Lane: cap counted once per topic per day and persisted before work; a restart resumes an in-progress topic first with its original bound; `unknown` owner and a throwing owner read both skip (`backfillLane.ts:221-223`).
- No model call: acceptable for this slice, not a blocker. The §15 validator (operator-bound row, status `backfilled-unconfirmed`) is implemented deterministically. See S1 for what must be stated.

**Blocker**

- **B1. The backfill question is put to the agent on every reply for at least 7 days, and blocks ref confirmations meanwhile.** `TopicIntentBriefing.ts:84` gates only on user activity, not on `surfacedAtTime`, so after it is surfaced the block ("fold one line into this reply asking the user…") keeps rendering. It leaves only by settle (every backfilled entry individually re-referenced by the operator; there is no answer interpreter) or by expiry, which needs 7 days and a user turn (`TopicIntentPendingConfirm.ts:336`). §6.1 says the confirmation is requested "when the agent next replies", once. While it is outstanding a ref confirmation can only queue (a ref never displaces), so v14 ref confirmations stall for a week in every backfilled topic. After the first user turn the block is also in the briefing of non-user prompts in that topic. Reproduced: after surfacing, the block was still rendered at the next user turn, the third, and at day 6.9; a ref `create` returned `queued`; outstanding stayed `backfill`. Fix direction: stop rendering once surfaced (or render a non-asking "already asked" line), and let a ref pass or shorten the hold. The artifact's Interactions line ("a later ref confirmation queues behind it") does not state the duration.

**Should-fix**

- **S1. No-model-call lane: state the deviation where it gates, and fix the ladder metric.** With no replay, a topic that predates topic-intent capture gets an Anchor only, yet `backfillLane.ts:282` records `fired` for it, so the ladder's "ran" metric (`feature-ladders.json`, `topics-backfilled`) can pass on topics with zero ledger entries. The entries come from TopicIntent refs, not "from TopicMemory" as §6.1 words it. Record this as a named Phase 1 exit item (or a spec note), and count `fired` only with the entry count visible to the metric.
- **S2. Lane starvation without a report.** In-progress topics go first (`backfillLane.ts:215`) and the tick stops at 2 worked (`:218`). A topic whose U listing never completes (a row write that keeps failing leaves `backfilling` true, `userCorpus.ts:443`) returns at `:273` without throwing, so it is never parked. Two such topics hold both slots forever. Reproduced: 5 topics, 2 never completing, 8 ticks worked `[104,103]` each time; the other 3 never started; `failed: 0`, no degradation, `attempts: 8`. Related: `attempts` counts resume ticks (`:242`), so a large topic that needs more than 3 ticks is parked `failed` on its first real error.
- **S3. Owner check is open on a multi-machine agent whose pool placement is dark** (`server.ts:18761`, `backfillLane.ts:134`). "Not live ⇒ owns every topic" is right for one machine, but a standby machine with pool stage `dark` also passes and will rebuild every topic in its TopicMemory, writing the replicated Anchor record and its own confirmation queue. Not reproduced (read from code). Also, `SessionOwnershipRegistry.ownerOf` (`:235-239`) returns the owner for any non-released record; §14 asks for the record to be active, so a topic mid-transfer is still worked.
- **S4. The relabel changes what S6 already derived, in both directions, and the artifact covers only one.** `anchorLedger.ts:629-635` overrides every non-withdrawn, non-superseded status. (a) A history decision the operator settled drops out of the live-set floor (`:907` protects only `settled`/`confirmed`). Reproduced on an S6 topic: `d1` `settled`, floor 1 with the switch off; `backfilled-unconfirmed`, floor 0 with it on. (b) A history decision that derives `pending` (no stub, or a non-settling stub: a quote that is evidence, not a decision per §6.2) becomes `backfilled-unconfirmed`, which the spec calls "fully usable", and is counted as a "decision" in the confirmation line. Reproduced (`d3:backfilled-unconfirmed`, derived `pending`). Decide whether `pending` should be relabelled at all, and whether the floor should read `backfillDerivedStatus`; state both in the artifact.
- **S5. The live path is not under the daily cap.** With the switch on, any topic's next live turn relabels its history entries and requests the confirmation (`:686`), whether or not the lane has reached it. The cap bounds lane work only. The artifact should say so (combined with B1, flipping the switch asks in every active topic at once).

**Nits**

- `server.ts:18766`: the history bound is the latest message by timestamp (`TopicMemory.ts:586`), but `messagePrecedes` orders by row id (`:738-742`). A late-inserted older message makes the two disagree; use the highest row id.
- `backfillLane.ts:275-279`: a topic is recorded `done` when the Anchor write failed (`anchor: not-yet-evaluated`) or the bound was not stamped; it is never retried. `failed` topics are also never retried.
- `anchorLedger.ts:631`: an episode whose order is unknown (`messagePrecedes` null) counts as after history. It is still an operator row, so low risk.
- Rollback (§8): with the switch off, nothing settles an outstanding backfill confirmation (`:686` is switch-gated), so it keeps rendering and holding the slot until expiry; idle topics keep `backfilled-unconfirmed` on disk, so `anchors.backfill.pendingConfirmations` stays non-zero with the feature off. The artifact calls this harmless; a settle-on-off would be cleaner.
- `backfillLane.ts:298`: the first-tick timer is not cleared by `stop()`.
- `contextBudgetMetrics.ts`: `pendingConfirmations` is read from the replicated store, so two machines each report the same topic; a pool-wide Home count would double it.

### Fixes after the first pass

- **B1 fixed: the backfill question is asked once.**
  - The reply that surfaces it removes it from the queue at once (`settle(…, 'asked')`, anchor `backfillConfirmSurfacedAt`). It is never re-requested afterwards.
  - The briefing also never renders a surfaced one.
  - So it holds the slot only from the request to the next reply after user activity; a ref confirmation is no longer held behind it.
  - `backfillView` adds `asked`: asked, entries still unconfirmed, within 7 days of asking (`BACKFILL_ASKED_WINDOW_MS`). After that it reads `expired`, derived from time with no write.
  - The metrics' `pendingConfirmations` counts `awaitingAsk + asked`, reported apart.
  - Tests: asked once, never rendered again, view `asked`, a ref goes outstanding; the integration test checks the same through the briefing route and the metrics.
- **S1 fixed in the evidence, and stated.**
  - The ladder's `fired` row is recorded only for a topic finished with ledger entries. An Anchor-only topic records `outcome`. Test included.
  - **Named Phase 1 exit item (CMT-1536):** the backfill reads refs and stubs the extractor already wrote. History that predates topic-intent capture yields an Anchor only, and pre-layer decisions have no stub. Replaying history through the extractor under the background lane's cap (§15's tier-1 step) is the open item, reviewed at Phase 1 exit. §6.1's "from TopicMemory only" is met in that every entry is bound to a TopicMemory operator row; the refs themselves are TopicIntent's.
- **S2 fixed.**
  - `attempts` counts only failures; resume ticks are counted in `ticks`.
  - A topic still listing U after `BACKFILL_MAX_TICKS_PER_TOPIC = 40` ticks (40,000 rows) is parked `failed` with one `topic-stalled` degradation, so it frees its slot.
  - Test: a never-finishing topic is parked and reported once, and the other topics finish.
- **S3 fixed.**
  - `topicOwnerCheck` gains `multiMachine`. With pool placement not live, only a single-machine agent owns every topic (server: no mesh identity, or one pool machine). A dark pool of several machines reads `unknown` and does no work.
  - The live-pool owner comes from the ACTIVE record only (`read(k).status === 'active'`), so `placing` and `transferring` are skipped.
  - Tests: the owner-rule table (unit) and a dark two-machine pool (e2e).
- **S4 fixed.**
  - Only a status that asserts something is relabelled: a decision `derived-settled` or `settled`, an evolution `tentative` or `confirmed`. A history decision that derives `pending` stays `pending` (with `fromHistory`), and is neither counted nor named in the question.
  - The live-set floor reads `backfillDerivedStatus` for a backfilled entry, so a history decision the operator settled keeps its floor.
  - Test covers both.
- **S5 stated (not changed).** With the switch on, any topic's next live turn relabels its history and requests the question. The daily cap bounds the lane's work only. Since the question is now asked once and only after user activity, flipping the switch adds at most one line to the next reply in each active topic. That is the intended rollout (dev agent first, per the ladder).
- **Nits:**
  - **Fixed: row order.** The history bound is now the topic's last row in insertion order (`TopicMemory.lastMessageIdByRow`, the order `messagePrecedes` uses).
  - **Fixed: missing Anchor record.** A topic whose Anchor record was not written is retried (counted as a failed attempt), never recorded `done`. Test included.
  - **Fixed: unknown order.** An episode whose order is unknown no longer counts as after history (`afterHistory` needs a positive order against every bound).
  - **Fixed: switch off.** A queued or outstanding backfill question is settled `switch-off` on the next pass. Test included. Idle topics keep `backfilled-unconfirmed` on disk until their next pass, so the metric can stay non-zero for them; stated.
  - **Fixed: timers.** `stop()` clears the first-tick timer.
  - **Stated: pool count.** `pendingConfirmations` reads the replicated store, so each machine counts the same topic. A pool-wide count must take the owner's figure, never a sum (noted in the code for S14).
  - **Not changed: `failed` topics are not retried automatically.** They are reported once; a restart with a cleared state file, or a later slice, retries them.

### Resolution check

**Independent read of the artifact:** Concur. B1 and S1 to S5 are resolved in the code; nothing blocks. Three small items remain (R1 to R3), none of them a blocker.

Checked against `git diff 244005734` plus the untracked files. Tests, `--maxWorkers=1`: `tests/unit/context-layer-backfill.test.ts` 21/21, the S6 ledger, pending-confirm (both files) and briefing suites and the migrator row test green; integration 5/5; e2e 5/5. The first-pass probes were re-run on the unit rig (temporary file, deleted).

**Resolved**

- **B1.** The surfacing reply stamps `backfillConfirmSurfacedAt` and settles the question `asked` (`anchorLedger.ts:824-825`); a surfaced-at fact blocks any re-request (`:719`); the briefing does not render a surfaced one (`TopicIntentBriefing.ts:85`). Probe: rendered at the first user turn, not at the next two; outstanding `null`, queue 0, view `asked`, `confirmReRequested: 0`. A ref `create` then goes `outstanding` (unit test).
- **S1.** `fired` only when `entries > 0`, else `outcome` (`backfillLane.ts:317-318`); the Phase 1 exit item is named in the fixes.
- **S2.** `attempts` counts throws only (`:322`), `ticks` counts resumes (`:266`), and a topic still listing after 40 ticks is parked with `topic-stalled` (`:299-304`). Probe: two never-finishing topics parked at tick 40 with `attempts: 0`; the other three started at tick 41 and finished. The hold is bounded at 40 ticks (under 7 hours at the default tick), not removed.
- **S3.** A dark pool of several machines reads `unknown` (`backfillLane.ts:152-157`, `server.ts:18763`); the live-pool owner comes from the active record only (`server.ts:18765`). Unit owner table and the e2e dark two-machine case cover it.
- **S4.** Only `derived-settled`/`settled` decisions and `tentative`/`confirmed` evolutions are relabelled (`anchorLedger.ts:124-127`, `:643`); the floor reads `backfillDerivedStatus` (`:935`). Probe on an S6 topic: `d3` stays `pending`, `d1` is `backfilled-unconfirmed` (derived `settled`) and the floor stays 1; the question names only `d1` and `g1`. Switching off again restores S6's statuses and settles the question.
- **S5.** Stated. With ask-once, the exposure is one line in the next reply of each active topic.
- **Nits.** Row-order bound (`TopicMemory.ts:712`, `server.ts:18769`), missing Anchor record retried (`backfillLane.ts:310`), unknown order no longer "after history" (`anchorLedger.ts:571-573`), switch-off settle (`:700-702`), `stop()` clears both timers (`backfillLane.ts:341-345`): all present.

**Remaining (not blockers)**

- **R1 (should-fix, one line). A stalled topic is reported with the wrong words.** `server.ts:18774-18776` maps only `topic-failed` and `state-unreadable`; `topic-stalled` falls through to the persist-failure text ("Kept rebuilding without saving progress … nothing is lost"), though the conversation's rebuild has stopped. Read from code.
- **R2 (should-state, or harden). Ask-once changes what the fetch-versus-bump race costs.** Under-block still says the line "appears one user turn later". Now, if the prompt hook fetches the briefing before capture bumps the turn, the reply is still taken as the asking reply (`anchorLedger.ts:813`), the question is settled `asked` and is never shown. The same holds when the agent ignores the line. Probe: briefing fetched before the user turn, then user message and reply: never rendered, outstanding `null`, view `asked`. The window is small (the bump follows one `setImmediate` and a U page, `TopicIntentCapture.ts:367-391`), and the entries stay labelled, so this is a statement fix; recording that the briefing actually rendered the block before a reply may surface it would close it.
- **R3 (nit). "No mesh identity" is read as "single machine"** (`server.ts:18763`). `_meshSelfId` is assigned late in boot (`:29413`); a multi-machine agent whose mesh wiring did not complete would read as the only machine. A positive single-machine fact would be safer than an absent one.
- **Artifact body not updated to match the fixes (nits):** the "Owner only" bullet (still "not live ⇒ owns every topic"), the "Views" bullet (no `asked`), the test counts (unit is now 21), and §8 Rollback (still says the question keeps rendering after switch-off).

### Follow-ups after the resolution check

- **R1 fixed:** a `topic-stalled` degradation now says the rebuild of that conversation stopped (`server.ts`), with the same impact line as `topic-failed`.
- **R2 stated:** the Under-block race bullet now says what ask-once concedes (a question can be settled `asked` without having been shown) and why it is bounded. Render-proof hardening is listed for the packet renderer slice.
- **R3 stated, not changed:** a multi-machine agent whose mesh wiring did not complete has no mesh identity and reads as a single machine. Then every topic in its TopicMemory is rebuilt there, which is idempotent and labelled. The pool list is preferred whenever it exists.
- **Artifact body:** the Owner-only, Views, test-count and Rollback text now match the code.

---

## Evidence pointers

- Unit: `tests/unit/context-layer-backfill.test.ts` (21), `tests/unit/migrate-context-budget-backfill-row.test.ts` (2); regression: the S6 ledger, pending-confirm, briefing, capture and metrics suites, plus the ladder and guard-manifest suites.
- Integration: `tests/integration/context-layer-backfill.test.ts` (5): real TopicMemory, the real capture loop and production extract function for history, the real lane from `wireLayerCapture`, the real briefing route, `/topic/:id/anchor` and `/context-budget/metrics` behind the bearer middleware.
- E2E: `tests/e2e/context-layer-backfill-alive.test.ts` (5): the dev boot path with the switch on, off and with pool placement live, the fleet path (503), and WIRED source checks.

---

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action`: not applicable (`closure: n/a`, declared in the trace). The pre-commit detector matches `UserCorpus.refresh()`, which is a bounded read of TopicMemory rows into local derived records, not an external self-action. The lane that calls it sends nothing and restarts or kills nothing. Its bounds: at most 2 topics per tick, 20 topics started per UTC day (persisted), and 5 pages per topic per tick. A topic is parked after 3 failures or 40 ticks with one report, and done topics are never redone. An always-failing topic yields at most 3 attempts and then stops.
