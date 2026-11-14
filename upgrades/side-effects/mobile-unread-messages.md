# Side-Effects Review — Unread messages for app conversations (server half)

**Version / slug:** `mobile-unread-messages`
**Date:** `2026-11-08`
**Author:** `echo (builder session on the Mac M5 Pro, for the coordinating Echo session, topic 134088)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Implements docs/specs/mobile-unread-messages.md (converged in 6 rounds, approved under the standing grant): a read marker per person per conversation, replicated across the agent's machines through a new replicated kind `conversation-read-marker` (store key `readMarkers`), a per-person baseline so existing conversations start quiet, unread counts (`hasUnread`, `unreadCount`, `unreadMore`, `readUpTo`) on every row of `GET /mobile/conversations` for a phone plus `unreadTotal` / `unreadTotalMore` / `unreadBeyondPage`, `readUpTo` on the three history reads, `POST /mobile/conversations/read` for the phone's read reports (with once-only forwarding to the machine that holds the conversation), `GET /mobile/conversations/read-markers` (Bearer only) as the boot catch-up between machines, and `aps.badge` on reply pushes. Telegram and Slack expose no per-user read state to a bot, so Instar's marker is the source and a person's own reply counts everything before it as read.

Files: new `src/core/ConversationReadMarkers.ts` (positions, refs, reader keys, the store, the kind, the counting walk), `src/core/ConversationUnreadService.ts` (sources, counts, reports, badge, catch-up, gc), `src/core/ConversationReadMarkersWiring.ts` (boot wiring). Modified: `mobileConversationRoutes.ts` (list fields, the two routes, browse `readUpTo`), `mobileSlackRoutes.ts` (`platformUserId`, the shared tail cache, `readUpTo`, the unread source), `routes.ts` (Telegram history `readUpTo`, `RouteContext.conversationUnread`), `mobilePairingRoutes.ts` (`isMobileUnreadEnabled`, `personOfReaderKey`, `readerRemovedHere`, the allowlist rule and team tier), `AgentServer.ts` (service construction, push badge dep, start/stop), `commands/server.ts` (kind registration, stateSync injection, commit-observer landing, store wiring, peer-back hook), `CoherenceJournal.ts` (the kind), `MobilePush.ts` (`badgeFor`, `aps.badge`), `AppConversationStore.ts` (`senderPerson` on browsed rows, `eventAt`, `newestIngestSeq`), `BackupManager.ts`, `CapabilityIndex.ts`, `PostUpdateMigrator.ts` (CLAUDE.md line + migration), `types.ts`, `state-coherence-registry.json`. Tests: one unit file, one integration file, one e2e file, plus two existing unit files updated for the new route and kind.

**Proportion:** Tier 2, 26 files and about 2,900 lines (about 850 of them tests), 6 spec rounds, 2 commit attempts (the first was refused by the self-action convergence gate until both loops were registered), 1 second-pass round with five findings fixed before the commit. In line with a feature that adds a replicated store, three routes and a push field.

## Decision-point inventory

- `mayUse(person, ref, 'read')` on every read field, mark and badge entry — pass-through — the existing conversation-access check, reused unchanged; no new authorization logic.
- `ConversationReadMarkerStore.advance` / `setBaseline` (forward-only, earliest baseline) — add — a merge rule over a total order, not a gate.
- `ConversationReadMarkerStore.ingestReplicated` refusing on local removal evidence — add — refuses a record only on positive evidence stored on this machine (tombstoned conversation, a person missing from a readable registry or a healthy team log, a Slack ref this machine dropped); "not known here yet" is kept.
- The read route's holder rule (store the holder's own position for a held message; limit an unheld position to the holder's newest message, or to now when it holds none) — add — no report can mark a future message read; it can only lower that reader's own count.
- Forwarding a mark once to the machine the phone names; `reader=` never forwarded again — add — bounded, lossless (`pending` keeps the mark on the phone).
- The device allowlist rule for `POST /mobile/conversations/read` (own 60/min bucket, `read-marks`) and the team tier `guest` — add — a rate floor and an access tier, both deterministic.
- `isMobileUnreadEnabled` — add — a configuration switch, read live.

---

## 1. Over-block

- A phone whose person does not resolve on a machine (an MSP user registered on another machine) gets no read fields from that machine's rows and `reader-unknown-here` on marks it forwards there; the phone keeps its own marker. Stated in the spec (§3.5).
- A read report naming a message older than the Telegram tail (500 rows) or the Slack tail is limited to the holder's newest message: it can only mark older messages read, for that reader only.
- Until the first boot catch-up has settled (every reachable peer answered or failed once; on a pool whose registry has not named a peer yet, the second attempt five minutes later), a phone's list read creates no baseline, so rows show no count. On a single machine this settles on the first run.
- Over 60 read reports a minute from one phone are refused with 429; the app's ~1.5 s debounce stays under 40/min, and a refused mark is kept and resent.

## 2. Under-block

- A message that reaches a machine late (replicated after a peer was offline) with a time earlier than the reader's marker is shown but not counted as unread: an undercount, documented in §3.4.
- After a Telegram topic moves between machines, rows sitting only in the previous holder's log are not counted, and app-typed rows logged there do not trigger the own-reply rule: an undercount, documented in §3.4.
- `hasUnread` for rows beyond the page uses a one-second margin without a walk, so a conversation whose newest message is exactly the marker can read `hasUnread: true` there (a "+" on the tab total, never a wrong number on a row).
- A Slack row typed in Slack by the owner before the owner's Slack user id was set has no `platformUserId` match and counts as unread until the owner's next reply or report.
- The count is exact to 100 and a floor beyond it: a conversation with 350 unread shows "100+". Deliberate (§4).

## 3. Level-of-abstraction fit

The store is a lean consumer of the existing replicated-record substrate (emitter, kind registry, HLC envelope, peer streams, commit observer), the same layer the app-conversation and topic-pin stores use; nothing in the journal machinery changed except the kind list. Counting sits in the service next to the three message sources and reads only what the list already loads (the app store's newest page, the Telegram in-memory tail, the Slack log tail now parsed once per list request). The routes stay thin: resolve the reader, call the service, shape the answer. The push badge is a dependency on `MobilePushService`, computed at send time, so the fold and dedupe logic is untouched. The config switch rides `mobilePairing.native`, where native chat's own switches live.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface beyond the existing conversation-access check it reuses.

The feature produces a signal (counts, a badge, a divider position). It blocks, filters and gates nothing. The only refusals are the existing access check (reused), input validation (400 on a malformed body), a rate floor with the phone keeping the mark, and the forward-only merge, which is a convergence rule rather than a decision about information flow.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The spec's `## Decision points touched` classifies each rule: who may read or write a marker (invariant, the existing check), the holder's own position for a held message and the limit for an unheld one (invariant, lookups on the holder), forward-only / earliest-baseline (invariant, a total order), exact-to-one-page counting (invariant, the history routes' page bound), and three judgment candidates with declared floors and arbiters: the once-only forward (floor: never twice, never stored without the holder's check, unreachable ⇒ `pending`), "no marker ⇒ count after the baseline" (floor: never more than the messages since the baseline), and "own reply marks earlier messages read" (floor: only lowers a count; only for rows the platform attributes to this reader).

---

## 5. Interactions

- **Shadowing:** the read fields are added after `visible()` filters rows, so the people-and-roles filter still decides what a phone sees and counts are computed only for visible rows. The browse, Slack history and Telegram history routes add `readUpTo` after their existing checks; none of their refusals changed.
- **Double-fire:** an own message found while counting advances the marker as an ordinary local advance; the read route may advance the same key moments later. Both go through the forward-only `advance`, and the emitter folds them into one emit per 10 s window. Landing a record never emits, so two machines cannot ping-pong.
- **Races:** the count cache is keyed on the stored position and the source's local revision (app `ingestSeq`, the Telegram tail counter, the Slack file size and mtime); a message landing between a list read and a report invalidates it. The store flushes at most every 5 s and on shutdown; memory is authoritative while running.
- **Feedback loops:** the baseline is set once per reader and never advances; it cannot chase new messages. The catch-up merges with the same forward-only rule and never emits; `emittedPosition` is raised on landing, so a machine never re-sends what it learned from a peer.
- **Rate buckets:** the read route has its own `read-marks` bucket; the shared device read allowance the emergency stop relies on is untouched (tested).
- **Failure containment:** a source that throws while counting leaves that row without read fields and the list still answers (one degradation report a minute per site); the badge is left out and the push still sends.

---

## 6. External surfaces

- **The Instar iPhone app** (the only consumer): new optional fields on the list, the history reads and the push payload; two new routes. An older app ignores the fields; an older agent answers 404 on the read route and the app keeps phone-only markers (§3.7).
- **Other agents / users:** none. A machine's Bearer token already reads every conversation; the only new exposure is read positions, which the catch-up route and the `reader=` forwarding carry to another machine of the same agent over the existing pool peer path.
- **External systems:** none. No Telegram or Slack API call is added; no read state is written to either platform. APNs receives one more field (`aps.badge`) on reply pushes.
- **Persistent state:** `state/conversation-read-markers.json` per machine (registered, retention `fixed-cardinality`, backed up), and the `conversation-read-marker` journal kind with the ordinary bounded window.
- **Timing:** a push's badge may differ briefly from the app's own total (replication lag, Telegram and Slack left out); stated in the spec (§3.6).
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action is added. The app is the surface; the agent's CLAUDE.md line tells it how to read a count the operator asks about.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, approval page or grant form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Read markers and baselines: replicated.** Live advances travel through the `conversation-read-marker` kind on the coherence journal (forward-only merge in the store's own ingest; the furthest position and the earliest baseline win, order-independent). State that rotated out of the journal window reaches a machine through the boot catch-up: `GET /mobile/conversations/read-markers` paged at 2,000 records to the end from any reachable peer, with a saved cursor per peer and a 5-minute retry, resumed when a peer comes back (`onPeerBack`). Turned on with native chat wherever native chat is on.
- **Telegram history: machine-local by design** (`physical-credential-locality`, as today): the log is written by the machine whose bot token polls Telegram. Counts over it reach every phone through the pool read: the asking machine forwards the reader as `reader=` and keeps each peer's Telegram count; app rows are counted by the asking machine, which holds every app conversation.
- **Unread counts: proxied-on-read** (the pool list), with `unreadBeyondPage` ORed across peers and set for rows the merge dropped past the page.
- **Badge: unified.** Computed from replicated app conversations and replicated markers on whichever machine pushes.
- **Notices:** none are emitted. **Durable state:** the marker file follows the person through replication, not the topic, so a topic transfer strands nothing. **URLs:** none generated.
- **Status surfaces:** none added or changed (`/health`, `/status`, `/capabilities` and `/channels` are untouched beyond the CapabilityIndex description).

---

## 8. Rollback cost

- **Hot-fix release:** revert the code. Nothing else to undo.
- **Config switch first:** `mobilePairing.native.unread.enabled: false` turns the counts, the badge and the two routes off alone; native chat off turns everything off, as today.
- **Data migration:** none. The state file and the journal records are left unread by an older build; no migration, nothing rewritten.
- **Agent state repair:** none. The CLAUDE.md line is one bullet, added by the content-sniffed migration.
- **User visibility:** the app falls back to phone-only markers on a 404 and shows no counts; no wrong number is shown during a rollback.

---

## Conclusion

The review confirmed the design is a signal over existing access checks with no new authority. Things that changed because of it: the Slack bridge's log tail is now parsed once per list request and cached on the file's size and modification time (the list with several Slack rows would otherwise have parsed the tail once per row); a phone's baseline waits for the first catch-up to settle (on a pool whose registry has not named a peer yet, for the second attempt five minutes later) so a fresh local baseline is very unlikely to precede an earlier replicated one, and when it does the earliest-baseline merge heals it; the boot wiring moved into `ConversationReadMarkersWiring.ts` because the server's boot function hit the compiler's control-flow bound; and the second-pass review's five findings below were fixed before the commit. Clear to ship behind `mobilePairing.native.unread.enabled` (true wherever native chat is on, which is development agents today).

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only, against the code and the diff)
**Independent read of the artifact: concern raised, then resolved; the reviewer re-read the five fixes and concurs**

Verified clean by the reviewer: landing never emits and raises `emitted`; the forwarded path never forwards again; `reader=` resolves through `personOfReaderKey` + `mayUse` on the answering machine and MSP keys return null off their machine; unread off or no store ⇒ rows stripped, 503 on both routes, no baseline; the Telegram walk stays on the in-memory tail.

Concerns and what changed because of them:
- **Team markers wiped on a transient team-log state.** `readerRemoved` treated "the key does not resolve here" as removal; a team log that is absent, unreadable or not yet opened would have refused replicated team markers at catch-up and the hourly gc would have deleted that reader's markers and baseline. Fixed: removal evidence is now a separate dependency (`readerRemovedHere`): an MSP user missing from a readable registry on its own machine, or a team person missing from a healthy, switched-on team log. Anything else is "not known here yet". Covered by a unit test.
- **A throwing source could hang the list request** (an async express 4 handler with no catch). Fixed: `rowFields` and `readUpTo` catch and report (once a minute per site); a failing row shows no read fields and the list still answers.
- **A position for a conversation with no message held** was stored unclamped. Fixed: the ceiling is now (the earlier of the wall clock and the hybrid clock). Covered by a unit test.
- **Settling with nobody to ask**: at the +15 s boot call a pool whose registry has not named a peer yet would have settled at once. Fixed: with a pool configured, an empty peer list settles only on the second attempt (the 5-minute retry now also runs while unsettled).
- **gc read only the first 2,000 records.** Fixed: it pages to the end.

---

## Evidence pointers

- `tests/unit/conversation-read-markers.test.ts` — 27 tests.
- `tests/integration/mobile-unread-messages.test.ts` — 8 tests through the production auth middleware, including a real second machine over HTTP for forwarding, the pool list and the catch-up.
- `tests/e2e/mobile-unread-messages-alive.test.ts` — production wiring through `AgentServer`.
- Type check clean; `npm run build` clean; `npm run lint:parallel` all 52 steps pass; `instar dev:preflight` passes; neighbouring suites (`mobile-native-conversations`, `app-conversations-pool`, `mobile-native-media`, push, CLAUDE.md lines, capability index, journal wiring, people-roles, CoherenceJournal) pass. The full unit lane on the M5 Pro shows only `tests/unit/desktop-displays.test.ts` failing, and it fails identically on an unrelated checkout on this machine (a native desktop-helper environment issue, not this change).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed (this is a feature). It does add two self-triggered controllers, so the `unbounded-self-action` class is declared:

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `guard`
- **`guardEvidence`:** `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: "Two controllers are registered in src/testing/selfActionRegistry.ts and driven under the pinned sustained-pressure fixture. read-marker-emit-coalesce: the outbox offers a refused key again at most once per EMIT_THROTTLE_MS (markerEmitDue is the one pacing decision), an eternal sentinel with a 10 s rate floor whose give-up is delegated to the journal's rate bucket; the ratchet proves emits never accumulate past elapsed / 10 s and do not accelerate at twice the horizon. read-marker-catch-up-retry: a peer that fails forever is asked every CATCH_UP_RETRY_MS at most CATCH_UP_MAX_FAILURES (12) times, then waits for onPeerOnline or the next boot (catchUpAttemptDue is the one decision); the ratchet proves the count settles at 12 and does not scale with the horizon." }`
- **`gap`:** none.
