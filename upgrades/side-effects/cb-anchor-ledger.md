# Side-Effects Review — A and G, the Anchor and the decisions/evolutions ledger (Phase 1 S6)

**Version / slug:** `cb-anchor-ledger`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

Phase 1 slice S6 of `docs/specs/context-budget-layered-summaries.md` (§6 rows A and G, §6.1, §6.2, decisions 3 and 15, §12, §14). The branch sits on S5 (U with referent stubs), with S13 (the measurement backend, `contextBudgetMetrics.ts`) merged in first as its own merge commit, because the metrics' `unavailable: anchor-ledger-not-built` read that this slice replaces lives there.

New:

- **`src/monitoring/contextLayers/anchorLedger.ts`**:
  - **Anchor selection** (`AnchorLedger.refreshAnchor`). The Anchor is the first substantive operator row: a U record labelled `operator` with `authority: operator`. That label already encodes from_user=1, forwarded not 1, no relay/A2A origin, and the sender resolved to the operator through memory privacy (the people registry binding), so U is the only source of the label.
    - An opening greeting (`isGreeting`) is skipped.
    - A framing burst (more substantive operator rows before the agent's first reply) joins the Anchor, up to 3 rows.
    - With no such row the record is `status: no-anchor`.
    - While U is still backfilling an existing topic, the Anchor is re-selected on every pass, and once more when the backfill ends, so an earlier operator row listed late takes its place. An identical selection writes nothing.
    - The protected `anchor` record holds row references only (message id, sha256, length) and per-row times, never the words. It is rewritten only when its rows stop being protected operator rows.
    - A `no-anchor` topic is rescanned only on a new operator row, while U is still backfilling, or once per process.
  - **Ledger G** (`AnchorLedger.reconcile`). Each entry is a protected `ledger-entry` record keyed per entry (`ev-<refId>` or `dc-<refId>`), so it replicates per entry. Entries are re-derived on every turn from the TopicIntent refs (the v14 evidence model; not a separate authority), U's labels and S5's referent stubs. Only three facts are stored, because they cannot be re-derived: `surfacedAt`, `pendingExpiredAt` and `pendingRequested`. Entries are never deleted.
    - **Evolutions.** An evolution is a `goal` ref created from a message after the Anchor.
      - Not before an Anchor exists, and never from the framing rows themselves.
      - `cause` is `user-directed` (the operator row is bound) or `insight-derived` (evidence message id).
      - `effect` is the extractor's own read, logged with its evidence. It is `narrowing` when the same message carried a contradiction of a goal or decision ref (the contradiction event ids are the evidence), and `additive` when an operator message carried none.
      - An entry not bound to an operator row (an agent message, or a third party's or forwarded row) is always held as `narrowing`. Its basis is `extractor-contradiction` when a contradiction was read, otherwise `unread-held-as-narrowing`.
      - `status` is `tentative`, `confirmed`, `withdrawn`, `expired`, `unconfirmed` or `superseded`, with `supersedes` and `supersededBy` links.
    - **Decisions.** A decision is a `decision` ref. Through the **decision transition**:
      - It is `derived-settled` only when it is bound to a protected operator row whose `stubFor()` kind is `answer` or `directive`, and the row post-dates the entry it supersedes.
      - It becomes `settled` after a later operator episode (re-reference, affirmation or a positive confirmation).
      - Everything else is `pending`, with a `statusBasis`: `agent-proposed`, `not-an-operator-row`, `no-stub`, `stub-kind:<k>` or `does-not-post-date-superseded`.
    - **Supersession.** A later entry that contradicted another of the same type in its origin message supersedes it only when the later entry has operator standing and post-dates it:
      - a decision must be derived-settled or settled;
      - an evolution must be bound to the operator's row, or confirmed by the operator, and not withdrawn or expired.
      - A third party's, forwarded or agent entry records `supersedes` as a signal only.
    - **Withdrawal.** The operator's last word wins: a later operator contradiction or a negative confirmation withdraws the entry.
    - **Who counts.** Only episodes from protected operator rows count, so a third party's "yes" never confirms or settles anything. v14's per-message affirmation cap applies: one message's affirmation counts for at most 3 refs, the earliest ones.
    - **Lost confirmations.** A `tentative` evolution with no expiry and no confirmation in the queue (dropped, cancelled, or left on another machine) requests one again (`pendingReRequested`).
    - **Skipped passes.** A pass is skipped when its inputs have not moved (the refs and evidence count, the queue shape, the Anchor's write time), with a full pass at least every 20 turns per topic (`reconcileSkipped`).
  - **`afterTurn`.** Runs after every captured turn. Order: surface, then the Anchor, then reconcile, then sweep the confirmation clock.
    - **Surfacing:** the first non-automated agent reply after a user turn later than the turn the confirmation went outstanding. The reply to the message that created an evolution was composed before the briefing could carry it, so it never counts. On expiry a `user-directed` entry with its bound quote becomes `unconfirmed`; an `insight-derived` one becomes `expired`. It never throws.
  - **Live-set selection** (`selectLiveSet`), the §6.2 floor:
    1. superseded, withdrawn, expired and unconfirmed-and-superseded entries archive first;
    2. a settled or confirmed entry in the current phase (H2 live and the ref's arc is H2's) or re-referenced by the operator within the last 20 operator turns never archives, even over budget (`overBudget`);
    3. the rest is selected newest first within ~3K tokens, so age is the last rung.
    - `derived-settled` is not in the floor until it is promoted.
  - **Read views:** `anchorLedgerView` (the route), `measureAnchorLedger` (the metrics) and `pendingSummary`. Row references, labels and statuses only.
- **`GET /topic/:id/anchor`** in `routes.ts`: bearer; 400 for a bad id, 503 while the layers are off. It returns the Anchor's rows (message id, length, tokens, time), entry views, counts, the live-set summary, the confirmation queue's shape, and the builder counters. Never message text.
- Tests:
  - `tests/unit/context-layer-anchor-ledger.test.ts` (31)
  - `tests/unit/TopicIntent-pendingConfirm-evolution.test.ts` (10)
  - `tests/unit/migrate-context-budget-anchor-row.test.ts` (2)
  - `tests/integration/context-layer-anchor-ledger.test.ts` (4)
  - `tests/e2e/context-layer-anchor-ledger-alive.test.ts` (3)

Modified:

- **`src/core/TopicIntentPendingConfirm.ts`**, extended, not forked (decision 15):
  - **`kind`**: `ref`, which is absent on records and keeps refs byte-compatible, or `evolution`.
  - **Per-kind TTL** (`PENDING_TTL_BY_KIND`):
    - a ref keeps 5 turns OR 24 h from dequeue;
    - an evolution never expires before `markSurfaced`, and then needs BOTH 168 h since surfacing AND at least 1 user turn since.
  - **Priority.** An evolution displaces an outstanding ref, which is requeued at the queue head with `requeued` incremented and its dequeue clock cleared. Queued evolutions sit ahead of queued refs.
  - **Overflow.** It moves the lowest-priority item to `pending.deferred` with `pending_confirm_deferred_total` instead of dropping it. Deferred items refill the queue as it drains.
  - **`settle(refId)`** removes a confirmation resolved by its ledger entry.
  - **Locking.** Every queue mutation now runs under the store's per-topic lock (`TopicIntentStore.mutate`, new), so it can no longer lose a concurrent evidence append. Before this change the manager used unlocked load and save. `mutate` writes only when the file changed.
  - **No tier drop for evolutions.** A queued evolution is never dropped at dequeue for its ref having become v14-authoritative; the ledger decides its standing. Refs keep the v14 drop.
  - **Behaviour change for refs.** Overflow is now deferred instead of v14's silent drop, and a ref promoted by `sweepTtl`/`settle` gets the current turn as its `sentAtTurn`. The manager has no production caller today, so neither change is live anywhere.
- **`src/core/TopicIntent.ts`**:
  - optional `PendingConfirmation` fields (`kind`, `surfacedAtTime`, `surfacedAtTurn`, `surfacedAfterMessageId`, `requeued`, `settledAs`);
  - optional `pending.deferred`;
  - optional telemetry counters;
  - `mutate()`.
  - Nothing is defaulted on load, so a file written with the layers off is byte-identical.
- **`src/core/TopicIntentBriefing.ts`**: an outstanding evolution renders as "PURPOSE CHANGE TO CONFIRM (mention it in one line in your next reply; silence never confirms it)".
- **`src/core/TopicIntentCapture.ts`**: an optional `anchorLedger` dep, called in `captureTurn` after every turn with a topic. `automated` is passed from the provenance stamp. Absent ⇒ nothing runs.
- **`layerCaptureWiring.ts`, `contextLayersBoot.ts`**: `AnchorLedger` is built when U is built (TopicMemory present), with a `PendingConfirmationManager` over the same TopicIntentStore. It is attached to the layers (`anchorLedger()`, `status().anchorLedger`), and `captureDeps` carries it.
- **`src/commands/server.ts`**: a boot log line. The production capture block already spreads `layerWiring.captureDeps`.
- **`src/monitoring/contextBudgetMetrics.ts`**: `anchors: { unavailable: 'anchor-ledger-not-built' }` is replaced with real counts:
  - topics with layer records on this machine;
  - `anchored`, `no-anchor` and `not-yet-evaluated` (never collapsed into no-anchor);
  - ledger totals by type and status over the listed topics (`scope: listed-topics`);
  - builder counters, or `{ wired: false }`.
  - Each topic row gains `anchorLedger`.
- **`CapabilityIndex.ts`**: the description names the route; the endpoint is listed.
- **`templates.ts` and `PostUpdateMigrator.ts`**: a Registry-First row for `GET /topic/:id/anchor`, inserted after the user-corpus row and sniffed on `/topic/N/anchor` (Agent Awareness, Migration Parity).
- **Tests updated:**
  - `TopicIntent-pendingConfirm.test.ts`: acceptance test 4 now asserts deferred, not dropped.
  - `context-budget-metrics` unit, integration and e2e tests.
  - `context-layer-user-corpus-alive` (its WIRED string).
  - `feature-delivery-completeness` (the migrator row).

## Decision-point inventory

- **Anchor selection** (add). Deterministic. It picks rows the protected class already labelled; it can only choose among operator rows, never make a row authoritative.
- **Decision transition** (add). §12 classes it as a judgment-candidate. The judgment is the stub writer's `kind`, a tier-1 signal from S5; this code enforces the floor: only answer or directive may settle, the result is `derived-settled` until a user episode, and everything else is pending.
- **Evolution cause and effect classification** (add). The effect is the extractor's contradiction read, logged with its evidence. It only selects which user episode may confirm; it never changes a status by itself.
- **Pending-evolution expiry** (add). The floor: never before surfacing, and at least 1 user message since. The default 7-day clock sits above that floor, and user-directed entries never lapse.
- **Live-set selection** (add). The deterministic floor and the age rung. The §12 arbiter (the handoff audit model) arrives with the folds.
- **Pending-confirmation queue** (modify). Priority, requeue and deferral, as listed above.
- **Capture loop** (modify). One optional dep, absent with the layers off.

---

## 1. Over-block

- Nothing is blocked; no message, send or session is affected.
- **A decision can read `pending` when it is actually settled:**
  - when the operator's opening message states a decision with no preceding agent message, there is no stub candidate, so it reads `no-stub`;
  - when the stub writer misreads the kind.
  - The cost is a decision shown as unsettled; the operator's later re-affirmation is its own row with its own stub. This follows §6.2's rule that a quote is evidence, not a decision.
- **A framing burst can absorb a second message** the operator meant as a change of purpose, if the agent had not replied yet. That message is then part of the Anchor, not an evolution. Bounded at 3 rows.
- **Agent-sourced (insight-derived) evolutions are always held as `narrowing`.** Each needs an explicit yes after surfacing. The stricter direction was chosen because no LLM effect read exists for agent messages (see Under-block).

## 2. Under-block

- **Effect read for agent messages.** Insight-derived evolutions get no LLM effect read; the extractor only emits contradictions for user messages. Holding them as `narrowing` fails toward the stricter confirmation. An LLM effect read for agent-sourced goal refs would ride the extractor's existing call, as the stub does. It is not built here and is listed for S13's review.
- **"Surfaced" is inferred.** It means the first non-automated agent reply captured after the confirmation went outstanding (the briefing renders it). Nothing checks that the reply actually mentioned it. So the clock can start without the operator having seen the question. The floor still holds: no expiry without a user message since, and a user-directed entry never reverts.
- **No "stub contradicts the statement" check.** §6.2 also lists "a stub that contradicts the statement" as pending. That needs a second judgment; only the kind is enforced.
- **The span check is the topic.** §6.2's "within the span the entry is written for" reduces to "a row of this topic" in Phase 1, because no folds or chunks exist yet. It must be tightened when S8/S9 chunks land.
- **One outstanding evolution at a time.** The queue has one outstanding slot, so a second evolution is not surfaced "in the next natural reply" while the first is unanswered. The bound: the slot frees when the first is confirmed, withdrawn or superseded (the ledger settles it at once), or when its clock expires (7 days after surfacing and a user message). Queued evolutions sit ahead of ref confirmations; past depth 3 they defer.
- **"A user message since" counts any user turn.** That includes a third party's message (the topic's turn counter); it only starts the clock's eligibility and never confirms anything.
- **Ordering of evolutions vs the Anchor uses TopicMemory row order** (`messagePrecedes`). Unknown order (`null`) skips the entry (counted `unordered`) rather than guessing.

## 3. Level-of-abstraction fit

- A and G read U's labels (the operator binding lives in MemoryPrivacy and is applied once, by U) and S5's `stubFor` (the one sanctioned stub reader). They read the TopicIntent evidence model, which already carries extraction, re-reference, affirmation, contradiction and pending-confirmation events with their weights. No new identity check and no new model call.
- The confirmation primitive is extended in place, with locking added at the store, not forked into a second queue.

## 4. Signal vs authority compliance

- **The bound row is the sole write path to A and to settled or confirmed state in G.** Every settled or confirmed status requires a protected operator row: the binding, or the operator episode's own row (checked through U for every event).
- The stub kind, the extractor's contradiction read and a session's assertion are signals. Each is recorded in the entry (`stubKind`, `effectBasis`, `effectEvidence`, `statusBasis`) and none settles anything alone.
- `derived-settled` is carried as settled in the packet (later slices) but is not authority for a breaker re-arm, and it is not in the live-set floor until promoted.
- Nothing here holds blocking authority.

## 4b. Judgment-point check

- **`MAX_FRAMING_ROWS = 3`**: bounds an Anchor's size; the consequence of a bigger burst is only that later rows are evolutions.
- **`RECENT_OPERATOR_TURNS = 20`**: §8's N floor.
- **`LIVE_SET_TOKENS = 3000`**: §6 row G's target. It is a writer target, never a cut on the floor.
- **7 days, 1 user turn**: decision 3, from the Defaults table.
- **Greeting vocabulary**: deterministic and fail-open toward substance (anything longer than a greeting plus a name is a candidate).
- None of these gate a message.

## 5. Interactions

- **Capture loop.** `afterTurn` runs after `captureTurnInner` and the S13 outcome observer, on the capture loop's async path (U's refresh already yielded with `setImmediate`, never on the delivery callback's stack). Its work per turn:
  - one TopicIntent read (two when the clock is swept);
  - one listing of `ledger-entry` and reads of the U records it needs (cached for the pass);
  - writes only for entries that changed.
  - It never throws: failures are counted in `errors`.
- **Rescans.** A no-anchor topic rescans U's operator listing only on a new operator row or while U backfills.
- **PendingConfirmationManager.** It had no production caller before this change; the ledger is now its first. The SeamFilter and the briefing read `pending.outstanding`: the briefing now shows evolutions, and the SeamFilter's "outstanding confirmation" check (not wired in production) would see them too.
- **Concurrency.** Queue mutations now take the TopicIntent per-topic lock, the same lock evidence appends use. `mutate` must not call back into a locked method, and no caller does: `interpretAnswer` appends evidence after its mutate.
- **Replication.** One `anchor` record per topic. One `ledger-entry` record per entry, re-emitted on each status change (§14's HLC-latest compaction).

## 6. External surfaces

- New route `GET /topic/:id/anchor` (bearer; row references and statuses only; 503 off).
- `GET /context-budget/metrics`:
  - `anchors` changes shape, from `{ unavailable }` to counts;
  - each topic gains `anchorLedger`;
  - S14's console card (another branch) does not read `anchors`, so nothing renders it yet.
- `GET /context-budget/layers` gains `anchorLedger`.
- The topic-intent briefing shows a "PURPOSE CHANGE TO CONFIRM" block while an evolution is outstanding (development agents only, since only the ledger creates evolution confirmations).
- No new switch, no outbound messages, no LLM component.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or form file is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **A and G records: replicated** (§14). Both `anchor` and `ledger-entry` map to the `context-layer-record` kind, keyed per entry (`<topic>:ledger-entry:<key>`), so G replicates per entry and the never-archive floor is never cut by a record cap. A status change re-emits the record. The kind stays dark until `multiMachine.stateSync.contextLayers` is on; locally the outcome is counted as `disabled`.
- **The writer runs where capture runs.** That is the machine that receives the topic's messages (the topic's owner or lease holder). Other machines observe the replicated records and do not reconcile topics they do not capture.
- **Residual risk: two machines capturing the same topic.** If both ran capture during a move, both would derive from their own U and TopicIntent files. Because statuses are re-derived (the stored facts are only surfacing and expiry times), the later writer's view wins under HLC-latest. This converges once one machine owns the topic.
- **Confirmation queue: machine-local today.** It lives in the TopicIntent file, which is not replicated (pre-existing posture of the topic-intent layer). After a topic move, the new owner re-derives the ledger, and a new evolution's confirmation is requested again on that machine. The `pendingRequested` fact in the replicated entry keeps it from re-requesting one for an entry already written; the cost is that an un-surfaced confirmation does not follow the topic. This is listed for the topic-move work.
- **Bodies.** They are never in these records. Non-owner rendering of ledger bodies (the chunked carrier, `body-elsewhere`) is a later slice.
- **Notices and URLs:** none.
- **Status surfaces.** The route and the metrics read this machine's layer store. They are labelled `source: 'layer store on this machine'`, and a topic never evaluated here reads `not-yet-evaluated`, never `no-anchor`.

## 8. Rollback cost

- `contextBudget.enabled: false` removes all of it at the next restart: no `anchorLedger` dep, the route returns 503, the metrics return 503.
- Records already written stay inert under the gitignored layer root.
- TopicIntent files that gained `kind: 'evolution'` confirmations keep them. They are optional fields the older manager ignores: it treats them as refs, and its revalidate drops a ref it cannot find. Without a caller they never surface.
- A release revert needs no data migration. Reverting the extension also reverts deferral, but deferred items in a file would then be ignored rather than dropped.

## Conclusion

S6 builds the Anchor and the decisions/evolutions ledger on U and the TopicIntent evidence model. It extends the pending-confirmation primitive with evolutions, priority, requeue, deferral and a surfacing clock under the store lock. It adds the read route and replaces the metrics' unavailable read with real counts, all behind the dev-gated switch. The decision transition enforces §6.2's floor: only an operator row whose stub is an answer or directive settles, and only as `derived-settled`.

Known gaps, stated above:

- no LLM effect read for agent-sourced evolutions (held strict);
- "surfaced" is inferred from the next reply;
- the span check is the topic until chunks exist;
- the confirmation queue does not follow a topic move;
- S7 backfill and the derived "current purpose" line are not built (the line belongs to the packet renderer). Goals that predate the ledger on an existing topic are listed `predatesLedger` with no confirmation until S7.

---

## Second-pass review (if required)

**Reviewer:** Fable 5.2 (independent subagent)

### First pass

**Independent read of the artifact:** Concern raised: the decision transition, the confirmation rules, the expiry floor, the "no message text" rule and the lock usage all hold on an independent read (45 unit tests re-run green), but one path lets a non-operator row change the standing of an operator-confirmed entry, and section 4's "Who counts" claim is therefore not accurate as written.

Blocker:

- **A third-party or forwarded row can supersede an operator-confirmed evolution** (`src/monitoring/contextLayers/anchorLedger.ts:435-440` builds the contradiction map from every contradiction event with no operator check; `:471-474` treats any evolution that is not withdrawn or expired as "in force"). Reproduced with a scratch probe on the unit rig: an operator evolution `confirmed` by an operator affirmation; then a message from sender 999 (and separately a `forwarded` row) carrying a new goal ref plus a contradiction of the first. Result: the new entry is `tentative / insight-derived / narrowing` and the operator's confirmed entry becomes `superseded` (`superseded-by:ev-gx`), so it archives first in the live set. §8 says such rows carry no authority for the ledger or evolutions; §6.1 says the effect read is never acted on alone. Fix: for evolutions, supersede only when the superseding entry has a bound operator row (`d.boundRow`, i.e. `user-directed`) or is itself `confirmed`; an insight-derived tentative entry records `supersedes` as a signal but sets no `supersededBy`. Add the both-sides test (third-party and forwarded superseder do not supersede; operator superseder does).

Should-fix:

- **A confirmation that is lost leaves a narrowing insight-derived entry permanently unconfirmable** (`anchorLedger.ts:484` requests once on `pendingRequested`; `:377` requires `surfacedAt`; `TopicIntentPendingConfirm.ts:411-415` silently drops a queued item whose ref v14 already reads as authoritative). Reproduced: two agent-sourced evolutions, the operator re-references the queued one three times and affirms it, the first is confirmed, the queued one is dropped at dequeue as `no-longer-tentative`; it is never surfaced, and a later explicit operator yes still leaves it `tentative`. The same state follows a topic move (section 7) and `cancelOutstanding`. Fix: in `reconcile`, when an evolution is `tentative`, has no `pendingExpiredAt` and no pending record targets its ref, request again (and exempt `kind: evolution` from the `no-longer-tentative` drop, since the ledger, not the v14 tier, decides).
- **The reply that marks an evolution surfaced is normally the reply to the message that created it** (`anchorLedger.ts:550-555`). For a user-directed evolution the confirmation goes outstanding during that message's capture, after the session already received the message, so the next agent reply cannot have carried the briefing line, yet it starts the clock. The artifact states surfacing is inferred, but not that the inference is wrong in the common case. Fix: mark surfaced on the first non-automated agent reply that follows a user turn later than the turn the confirmation went outstanding (`sentAtTurn`), or record that the briefing rendered it.
- **One outstanding slot means a second evolution is not surfaced "in the next natural reply"** (`TopicIntentPendingConfirm.ts:188-197`). An unanswered outstanding evolution holds the slot for at least 7 days and a user message, so queued narrowing evolutions wait a week each. Not listed among the gaps. Fix: surface all queued evolutions in the same briefing block (one line each), or state the gap and its bound.
- **The Anchor can latch onto the wrong row on an existing topic** (`anchorLedger.ts:283-299`). U lists the current row plus 200 rows from the start per turn; if those first rows hold no substantive operator row, the current message anchors, and an anchored topic is never rescanned even while U is still backfilling. Fix: while `backfilling(topicId)` is true (and once when it ends), re-select and rewrite when an earlier operator row qualifies.
- **The ledger counts raw evidence events, not v14 episodes** (`anchorLedger.ts:325-330, 374-384, 409`). v14's per-message cap (one affirmation may lift at most 3 refs) and per-ref 24 h cap live in the projection, so one operator "yes" with many affirm events confirms or settles every entry it touches. Fix: apply the same caps when reading episodes, or require the ref's projected tier to be authoritative for `confirmed` and `settled`, and say which in the artifact.
- **Per-turn cost grows with the topic** (`anchorLedger.ts:428, 436-465`): every captured turn (agent and automated ones included) synchronously reads every `ledger-entry` file, every U record named by any evidence event, and two files per decision for the stub, sometimes twice. Fix: skip the reconcile when neither the TopicIntent file nor U changed since the last pass (mtime or a counter), and cache `stubFor` in the per-pass cache.

Nits:

- `turnsSince` counts any `fromUser` turn, including a third party's, as "a user message since" (`TopicIntentPendingConfirm.ts:322`).
- `mutate` rewrites the file when nothing changed (`sweepTtl` on every turn while an evolution is outstanding) (`TopicIntent.ts:623-630`).
- `selectLiveSet` skips an entry that does not fit and keeps filling with older, smaller ones, so the age rung is not a strict newest-first prefix (`anchorLedger.ts:659-661`).
- `anchorLedgerView` filters operator turns on `label` only; `operatorRows` also checks `authority` (`anchorLedger.ts:721-722`).
- An insight-derived entry sourced from a third-party or forwarded user row takes the extractor branch and can be `additive`, confirmable by an operator affirmation before surfacing; the artifact and the header comment say insight-derived is always held as narrowing.
- Test counts in the artifact: the evolution manager file has 9 tests (not 10), `TopicIntent-pendingConfirm.test.ts` has 13 (not 12).

### Fixes after the first pass

- **Blocker fixed.** Evolution supersession now requires operator standing: the superseding entry is bound to the operator's row, or the operator confirmed it. Otherwise `supersedes` stays a signal only. Test: a third party's and a forwarded row's new goal leave the operator's confirmed entry `confirmed` with `supersededBy: null`. The existing operator-superseder test still supersedes.
- **Lost confirmation fixed.** A tentative evolution with no confirmation in the queue requests one again. The manager no longer drops a queued evolution at dequeue for being v14-authoritative; refs keep the drop. Tests: a re-request after `cancelOutstanding`; an authoritative evolution is promoted while an authoritative ref is dropped.
- **Surfacing fixed.** It now needs a user turn later than the one the confirmation went outstanding at. Test: the reply to the creating message does not surface it; the reply after the next user turn does. The integration test was updated the same way.
- **Second evolution waits.** Stated as a gap with its bound (Under-block).
- **Anchor latch fixed.** The Anchor is re-selected while U backfills, and once when it ends. Test: an earlier operator row listed late re-anchors (`reanchored: true`).
- **Affirmation cap applied.** v14's per-message cap of 3 refs; the earliest affirm events count. Test: one "yes" over 4 entries confirms 3. The per-ref 24 h cap only bounds confidence increments, so it does not change a binary confirmation.
- **Per-turn cost reduced.** A pass whose inputs did not move is skipped (full pass every 20 turns). The U reads were already cached per pass. Test: `reconcileSkipped` increments.
- **Nits fixed:**
  - `mutate` writes only on change;
  - the live set's age rung is a strict newest-first prefix;
  - the view filters operator turns on `authority` too;
  - non-operator insight entries are always held narrowing (with a test);
  - test counts corrected.
- **Nit recorded, not changed:** a third party's turn counts as "a user message since" (Under-block).

### Resolution check

**Independent read of the artifact:** Concur. Every first-pass item is resolved in the code or stated as a gap, and I found nothing the fixes broke; re-run green: the three unit files (52 tests), the integration file (4), and my scratch probe of the blocker, the lost confirmation and the surfacing rule.

Per item:

- Blocker, non-operator supersession: resolved. `inForce` for an evolution now needs a bound operator row or `confirmed`; the probe leaves the operator's entry `confirmed` for both the third-party and the forwarded superseder.
- Lost confirmation: resolved. A tentative entry with no queued confirmation and no `pendingExpiredAt` is requested again, and a queued evolution is promoted even when v14 reads its ref as authoritative. No loop: an expired entry is no longer `tentative`, a missing ref has no entry, and each ref is requested at most once per pass.
- Surfacing: resolved. The reply to the creating message no longer surfaces it; a user turn later than `sentAtTurn` is required.
- One outstanding slot: resolved as a stated gap with its bound.
- Anchor latch: resolved. Re-selection runs while U backfills and once after; it writes only when the selected rows differ and can only move to an earlier row, so it does not flap.
- v14 affirmation cap: resolved for the per-message cap (3 refs, earliest events, stable tie-break). The per-ref 24 h cap is argued as not applicable to a binary status, which I accept.
- Per-turn cost: resolved. The skip signature covers refs, evidence count, the outstanding record and its surfacing, queue and deferred lengths and the Anchor; surfacing and expiry force a pass; a relabel or a withdrawn stub that moves none of these is picked up within 20 turns.
- Nits: resolved (`mutate` writes on change, strict-prefix age rung, authority filter, non-operator entries held narrowing, test counts); the third-party turn nit is stated.

Not regressions, for follow-up (none blocks this slice):

- On an existing topic, the first pass turns every goal ref after the Anchor into a `tentative` evolution with a queued confirmation (`anchorLedger.ts:511-518` has no guard for refs that predate the ledger). §6.1 says existing-topic entries are `backfilled-unconfirmed` with no standalone confirmation; until S7 lands, write refs whose origin predates the topic's first ledger pass without requesting a confirmation, or state it before the pilot topic is enabled.
- An agreement counts only if its message time is at or after `surfacedAt`, which is stamped with the capture clock after the reply's extraction (`anchorLedger.ts:406`, `:622`). A quick operator "yes" sent while that capture is still running is ignored for good; stamp `surfacedAt` from the surfacing reply's own message time.
- The reconcile memo is stored even when a write failed in that pass, so the retry waits up to 20 turns (`anchorLedger.ts:466-474`); skip the memo when `writeFailed` moved.
- A confirmation promoted through `cancelOutstanding` or `interpretAnswer` keeps its creation `sentAtTurn`, so the next reply can surface it (`TopicIntentPendingConfirm.ts:386`, `:266`); neither has a production caller today.

### Follow-ups fixed after the resolution check

- **History is not a fresh evolution.** The Anchor record now carries `ledgerFromMessageId`: the message whose turn ran the topic's first ledger pass, kept across rewrites. A goal ref from an earlier message is written `tentative` with `predatesLedger: true` and requests no confirmation; S7 relabels it `backfilled-unconfirmed`. Test: an existing topic's old goal asks nothing, and a new one asks.
- **`surfacedAt` uses the reply's own time.** It is taken from the surfacing reply's message time (passed from the capture entry, bounded by now), not the capture clock. Test included.
- **No memo after a failed write.** A pass with a failed write stores no memo, so the next turn retries.
- **`dequeueNext` resets `sentAtTurn`.** It sets it from the caller's turn, else the store's own turn counter, so a confirmation promoted through `cancelOutstanding` or `interpretAnswer` also needs a later user turn before it can surface.

### Confirmation of the follow-ups

**Independent read of the artifact:** Concur. All four follow-ups are fixed as described and I found nothing they broke; re-run green: the three unit files (54 tests) and the integration file (4), with no type errors reported in the touched files.

- History: confirmed. `ledgerFromMessageId` is set from the first pass's message and kept across Anchor rewrites; a goal ref from an earlier message is written with `predatesLedger: true` and no confirmation. A first pass on an agent turn records that agent message, which is correct; a ref from the first-pass message itself is not history and asks normally.
- `surfacedAt`: confirmed. It takes the reply's own message time, bounded by now, and falls back to now when no time is passed.
- Memo: confirmed. A pass with a failed entry write stores no memo.
- `sentAtTurn`: confirmed. `dequeueNext` falls back to the file's turn counter.

Nits, neither blocking:

- If the first pass runs on a message whose id is not numeric, `ledgerFromMessageId` is stored as null, and it is filled in only if the Anchor record is rewritten later (`anchorLedger.ts:271`); until then an existing topic's old goals would ask for confirmation. Skip the first pass's history decision, or set the field on the next numeric turn.
- `predatesLedger` is recomputed with one `messagePrecedes` query per evolution on every full pass (`anchorLedger.ts:561`); it never changes once true, so it can be read from the previous record.

Nits from the confirmation:

- **Fixed:** `predatesLedger` is read from the previous record once true, instead of being recomputed every pass.
- **Recorded, not changed:** a first pass on a non-numeric message id leaves `ledgerFromMessageId` null until the Anchor is next rewritten. Captured turns carry TopicMemory's integer ids (ticks never reach `afterTurn`), so this path has no caller today.

---

## Evidence pointers

- **Unit:**
  - `tests/unit/context-layer-anchor-ledger.test.ts` (31);
  - `tests/unit/TopicIntent-pendingConfirm-evolution.test.ts` (10);
  - `tests/unit/TopicIntent-pendingConfirm.test.ts` (13, acceptance test 4 updated);
  - `tests/unit/context-budget-metrics.test.ts` (15);
  - `tests/unit/migrate-context-budget-anchor-row.test.ts` (2).
- **Integration:** `tests/integration/context-layer-anchor-ledger.test.ts` (4). It uses real TopicMemory, the real capture loop and the production `createLlmExtractFn`, and checks:
  - the Anchor;
  - a decision settled only by the same call's answer stub;
  - an evolution surfaced by the next reply;
  - per-entry replication keys;
  - the route: 401, 503, 400, and 200 with no words.
  - Also run: `context-budget-metrics-route.test.ts`.
- **E2E:** `tests/e2e/context-layer-anchor-ledger-alive.test.ts` (3) covers the dev boot path end to end, the fleet path (nothing wired, 503) and the WIRED source checks. Also run: `context-budget-metrics-alive` and `context-layer-user-corpus-alive`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. `afterTurn` is a per-turn derivation, not a self-triggered controller: it fires on captured messages only, sends nothing, and restarts or retries nothing.
