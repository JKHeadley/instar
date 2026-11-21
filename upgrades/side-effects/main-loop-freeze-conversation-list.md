# Side-Effects Review — main-loop freezes from the conversation list

**Version / slug:** `main-loop-freeze-conversation-list`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog, session lifecycle or messaging block/allow surface)`

## Summary of the change

Fixes fb-52447f16-7d3: the Echo Studio server froze for 20-30 s at a time because the app's conversation list (`GET /mobile/conversations`) called `TelegramAdapter.getTopicHistory(topicId, 1)` once per topic, and for every topic without a live session that was a synchronous read + parse of the whole Telegram message log. Spec: `docs/specs/main-loop-freeze-conversation-list.md`.

Files touched:
- `src/messaging/TelegramAdapter.ts` — an in-memory log view replaces the per-topic file scan (`loadHistory`, `waitForHistory`, `whenHistoryLoaded`), `getTopicTailRows`, `getTopicHistoryBeforeAsync`; legacy rotation uses `RotationLineCount`.
- `src/server/AgentServer.ts`, `src/server/routes.ts`, `src/server/mobileConversationRoutes.ts` — list, read-report and chat-history routes wait (bounded) for the view; the list and unread counter use unjoined tail rows; the graph inventory starts after the first load.
- `src/messaging/shared/MessageLogger.ts` — `RotationLineCount` + `countNewlines`; `maybeRotate` no longer reads the log on every append.
- `src/core/CartographerTree.ts` — `scaffoldChunked` writes a node file only when its bytes change.
- `src/commands/setup.ts` — `probeNodeNativeCompat` (async candidate resolution + bounded parallel ABI probes), `assembleNodeCandidates` shared by sync/async; `ensureStableNodeSymlink` accepts pre-probed answers and candidates.
- `src/commands/server.ts` — boot awaits the async probe and hands its answers to the symlink step.
- Tests: 5 unit files, 1 integration, 1 e2e (listed in the spec).

Tier 1 (small, reversible: a revert fully restores prior behavior; no state, config or migration). Size: 8 source files, 7 test files. Effort: spec review 3 rounds (the Tier-1 cap); each round found a real design issue one layer further out (partial-read merge and Cartographer race; per-append rotation read; the unread pass's scan), which is why it used the full cap.

## Decision-point inventory

No decision-point surface. The change adds, removes and modifies no gate, filter, block or allow decision; it changes how existing reads are served (memory instead of a synchronous file scan) and how much boot I/O happens.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The remaining synchronous costs that are NOT fixed here (the limit-1000 `getTopicHistory` callers, the one-time dedupe seed, synchronous tmux probes) are listed in the spec and queued as fb-9193b40c-880.

---

## 3. Level-of-abstraction fit

Right layer. The index lives in `TelegramAdapter` next to the existing tail cache and is maintained by the same single append path (`rememberLoggedEntry`), so there is one writer for both. The list producer was moved out of an inline AgentServer closure into a small pure module so it can be tested with a real adapter; it consumes the adapter's non-blocking read and the existing indexed store (TopicMemory) rather than inventing a new store. Rotation counting sits in the one shared module both logging paths already import.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It is a read-path and boot-I/O performance repair. Nothing it computes gates, filters or blocks anything.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The two new fixed values (probe concurrency 4; index-retry backoff 1 min doubling to 30 min) are tuning brakes on internal work, declared with floors in the spec's Decision points section; neither chooses between competing signals.

---

## 5. Interactions

- **Shadowing:** none. The tail cache, its eviction and the unread service are unchanged; the view only replaces the file scan beneath them.
- **Double-fire:** the load is single flight.
- **Races:** rows appended during a pass are merged by dedupe key; a pass that read a replaced file is discarded and re-read; a failed pass publishes nothing. The Cartographer read-compare-write stays in one synchronous turn.
- **Feedback loops:** a persistently unreadable log is retried with backoff (5 s doubling to 5 min).
- The conversation-graph inventory starts after the first load, so it cannot publish a partial view.

---

## 6. External surfaces

- Other agents / install base: every agent gets a faster list (rows and unread counts); first requests after a boot wait up to 15 s for one background read, then get a retryable 503, no per-append full-log read above 20 MB, and a quieter boot. No API shape change: `/mobile/conversations` rows are identical, and that is verified by an old-versus-new client diff.
- External systems: none.
- Persistent state: none added. Cartographer node files are rewritten only on change (same contents format). Rotation behavior (when and what it keeps) is unchanged.
- Timing: the streamed index build runs once in the background after the first list request.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read. The log view is derived in-memory state over this machine's own Telegram log, with no durable store (same as the existing tail cache); the pool-wide list is served by the existing `?scope=pool` merged read that calls each machine's producer. No notices, no URLs, no durable state; nothing strands on topic transfer. Cartographer node files and the node symlink are per-machine files, as before. Status surfaces: none new or changed.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state, config, or migration; no user-visible regression during the rollback window beyond the old freezes returning.

---

## Conclusion

Spec review ran 3 rounds. Whole-diff outside code review then found serious problems in two successive designs; both were replaced. The shipped design leaves the tail cache unchanged and swaps only the file scan beneath it. Merge stays held for outside re-review and real-client proof.

---

## Second-pass review (if required)

Not required: no messaging block/allow, session lifecycle, compaction, coherence/trust, sentinel, guard, gate or watchdog surface.

---

## Evidence pointers

- Freeze profile: run scratchpad `freeze-profiles/CAPTURED-2026-11-21T09:46:44.txt` (list chain 19.3 % self time).
- E2E verified to fail against the old producer: 81 synchronous log reads for 80 topics; 0 after.
- Rotation: 200 appends above the size threshold → 1 read (was 200).
