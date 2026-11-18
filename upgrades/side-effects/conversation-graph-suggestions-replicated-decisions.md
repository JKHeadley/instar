# Side-Effects Review — Conversations suggestion decisions on every machine

**Version / slug:** `conversation-graph-suggestions-replicated-decisions`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (multi-machine state, high risk)`

## Summary of the change

The owner's decisions on Conversations suggestions (rejected, accepted, an Accept in progress) become immutable rows on the WS2 replicated-record path, kind `conversation-graph-suggestion-record`, store `conversationGraphSuggestions` (spec `docs/specs/conversation-graph-suggestions-replicated-decisions.md`, closes CMT-1650). New module `src/core/ConversationGraphSuggestionDecisions.ts` (schema, fold, outbox store, drain, boot wiring). `src/server/ConversationGraphSuggestionService.ts` overlays the folded decisions in `load()`, never writes the overlay to its own file (`withoutOverlay` in `save()`), records each local decision, backfills earlier decisions once, and derives the create request id from the suggestion id (`suggestionCreateRequestId` in `src/core/ConversationGraphSuggestions.ts`). Wiring: kind registration, forced-on store flag with kill switch, peer-commit observer line, store construction and AgentServer option in `src/commands/server.ts`; the option flows through `src/server/AgentServer.ts` and `src/server/ConversationGraphSurface.ts` (the default surface passes its options through). Tables: `CoherenceJournal.ts` (kind, retention 2 MiB rotate-never-delete, seq, rate cap), `JournalSyncApplier.ts` (evidence label), `ReplicatedStoreReconcilerWiring.ts` (allowlist). Tier 2; 6 spec review rounds (the Tier-2 cap): each round still found design issues, mostly in the draft code built alongside the spec, all fixed.

## Decision-point inventory

- Fold rule: which `accepting` row wins — add — invariant total order (legacy beats derived, then earliest `atMs`, then record key).
- Suggestion hidden when any machine holds rejected/accepted — modify (extends the parent's per-machine rule to every machine) — invariant.
- Emitter outcomes that count as sent — add — `emitted` and `dropped:deduped` only.
- Running-Accept test (`activeAccept`: started and neither rejected nor accepted) — modify — the build's busy filter, project refresh and keep rule now ignore an Accept that ended.

No gate on an owner action, message, session or dispatch. Rows hide or continue advice only.

---

## 1. Over-block

No block/allow surface on any owner action. The only "hide" is advice: a suggestion rejected or accepted on any machine is not offered. A mis-tapped Reject now hides that grouping on every machine (the parent spec has no un-reject; the owner can still group those conversations by hand). A row from a misbehaving machine of the same agent could hide advice; within the same-agent trust boundary.

---

## 2. Under-block

- A decision made on a machine that is lost before its row leaves is lost; others may offer that suggestion again (same window as every WS2 store).
- A peer on an older build ignores the kind and may re-offer until it upgrades.
- Mixed-version race: an upgraded machine and an old one starting the same suggestion before either knows can make two groups; after the upgrade, the legacy row wins and the other group stays as ordinary owner state.
- A legacy `suggestion-<uuid>` request id cannot be bound to its suggestion, so a misbehaving machine could point Continue at another suggestion's older group (same-agent trust boundary; legacy rows exist only for pre-upgrade Accepts).

---

## 3. Level-of-abstraction fit

Right layer. It is one more consumer of the existing replicated-record path (emitter, kind registry, journal, peer reader, sync applier) in the exact shape of the conversation-list-pins store; no new transport, route or peer protocol. The decisions live under the suggestion service (the only writer), and the accept orchestration (dashboard on main; `ConversationGraphSuggestionAccept.ts` in the parallel conversation-groups-phone change) is untouched: it reads the service, which now sees the union.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The rows carry the owner's own decisions; they hide or continue advice and never place, move, hide or send a conversation, nor gate an owner action. Validation of incoming rows refuses malformed data (a data-integrity check on replicated input, not an authority over behavior).

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The fold is a convergence order over an enumerable set of rows for one id (every machine must compute the same answer; no judgment is wanted). The snapshot limits (12 members, 60 characters) are the producer's own output domain (`SUGGESTION_LIMITS`). The drain cadence, report point and per-pass cap are operational brakes, not behavioral limits.

---

## 5. Interactions

- **Shadowing:** `load()` is the single read path for every service method, so the overlay reaches `view`, `refresh`/`start` (busy filter), `build` (prompt rejected filter and keep rule), `beginAccept`, `reject`, `accepted`, and (in the parallel change) `acceptTarget`/`acceptProgress`/`saveAcceptProgress`/`closeAccept`.
- **Double-fire:** the commit observer and boot landing both call `ingestReplicatedAll`; landing is idempotent (winner per slot). The boot check re-sends only own rows missing from the own stream, so restarts do not append duplicate lines (a blind re-send would, because the journal's duplicate key includes the HLC).
- **Races:** `build()` awaits the model; a peer's start landing meanwhile is handled by the publish-time overlap filter. The overlay ledger is keyed per loaded state object (`WeakMap`), so interleaved `load()` calls never share it.
- **Feedback loops:** a landed row is never emitted again; the drain only sends own unsent rows, rotating its start so refused rows cannot starve others.
- **Parallel change (conversation-groups-phone, unmerged):** expected textual conflict in the service (`beginAccept`, `accepted`, `load()`, header). Whichever merges second adds a `recordDecision` rejected row to `closeAccept` and passes `result` through `accepted`; `suggestionCreateRequestId(id)` equals its `acceptRequestId(id, 'create')` (pinned by a unit test).

---

## 6. External surfaces

- Other machines of the same agent: receive rows (suggestion id, decision, time, request id, group name and conversation refs). No message text.
- Older builds: skip the kind (not in their `JOURNAL_KINDS`).
- Persistent state: new outbox `state/conversation-graph-suggestion-decisions.json` (0600) and a new journal stream (rotate, never delete; bounded by owner taps). The service's existing file keeps its format and only decisions the owner made on this machine (including a tap here on a suggestion another machine had already decided).
- Dashboard: the Continue card on a machine that never built the suggestion reads "Started on another of your machines." with member names from the topic registry.
- **Operator surface:** no operator-facing action added; the existing Reject/Accept/Continue buttons work as before. No phone surface needed.
- Request id format changes from `suggestion-<uuid>` to `sga-<40 hex>`; the owner-changes route and the dashboard already accept it.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface file changed — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **replicated** — the owner's decisions, the snapshot of a suggestion an Accept works on, and a finished Accept's result: journal kind `conversation-graph-suggestion-record` (store `conversationGraphSuggestions`), emitted by `ReplicatedRecordEmitter`, landed at boot from `ReplicatedPeerStreamReader` and afterwards by the `journalSyncApplier` commit observer; read through the service's overlaid `load()`.
- **machine-local** — the built suggestion list (operator-ratified in the parent spec, commit d85721679; a cache of advice rebuilt from unified inputs) and the parallel change's Accept progress cache (derived request ids make it a resumption hint).
- Notices: none. Durable state does not strand on topic transfer (decisions are agent-wide). No URLs generated.
- Single-machine survivability: every machine keeps landed rows in its own outbox, so honoring a decision never needs a peer to be up.
- **Status surfaces:** none added or changed.

---

## 8. Rollback cost

Set `multiMachine.stateSync.conversationGraphSuggestions.enabled: false` (boot-read) or revert the release. The service's file holds only this machine's own decisions, so either returns every machine to machine-local behavior with no data repair; journal rows are inert to builds without the kind; the outbox file is unused. The derived request id needs no replication and stays correct. No user-visible regression during rollback beyond re-offers of suggestions rejected on another machine.

---

## Conclusion

The review and six spec rounds reshaped the design substantially: the `accepting` row carries an integrity-checked snapshot (another machine may never have built the suggestion), record identity is the full row hash, the create request id is derived (removing the second-group case at its source), the overlay is never persisted, the boot check replaces a blind re-send, the drain has backoff, a per-pass cap and fairness, legacy rows win the fold, and an ended Accept no longer holds members out of builds. Clear to ship pending the second-pass reviewer.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (code reading; its own test run was stuck in the shared suite-lane queue and was stopped)
**Independent read of the artifact: concur**

Concur with the review. The multi-machine section matches the code (kind registered, flag forced on with the journal and an explicit `enabled: false` respected, boot landing plus commit-observer landing, table entries present); nothing gains blocking authority; this machine's own decisions are not lost (`withoutOverlay` restores by object identity on both rebuild and project-refresh paths, peer rows are non-local and never re-sent, identical rows come back `held`, `reconcileLocal` reads the own stream so restarts do not re-send); both graph surface paths reach the store; no boot crash path (safe wiring, try/catch backfill, caught outbox errors). Two minor notes, both resolved: the artifact's "only this machine's own decisions" was slightly too strong (reworded to include a local tap on a peer-decided suggestion), and an unused exported helper (`suggestionDecisionsKillSwitchOn`) was removed.

---

## Evidence pointers

- `tests/unit/conversation-graph-suggestion-decisions.test.ts`, `tests/unit/conversation-graph-suggestions.test.ts`, `tests/unit/CoherenceJournal.test.ts`
- `tests/integration/conversation-graph-suggestions-replicated.test.ts`
- `tests/e2e/conversation-graph-suggestion-decisions-alive.test.ts`

## Follow-up fix after Local Verify (2026-11-18)

Local Verify failed `tests/unit/chief-of-staff-store-wiring.test.ts`: it pins the exact order of the stateSync early-return chain in `src/commands/server.ts` (`_staleOwnerReleaseResolved || _chiefOfStaffStoreOn || _stateSyncStoresBase`). This change had inserted `_suggestionDecisionsOn` between them. The fix moves `_suggestionDecisionsOn` earlier in the same OR chain. Boolean OR is order-independent here (every term is a side-effect-free value), so behavior is unchanged; only the pinned text order is restored. Over-block / under-block / signal-vs-authority / interactions / external surfaces / multi-machine posture / rollback: unchanged from the review above.
