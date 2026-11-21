# Side-Effects Review — main-loop freezes from the conversation list

**Version / slug:** `main-loop-freeze-conversation-list`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog, session lifecycle or messaging block/allow surface)`

## Summary of the change

Fixes fb-52447f16-7d3: the Echo Studio server froze for 20-30 s at a time because the app's conversation list (`GET /mobile/conversations`) called `TelegramAdapter.getTopicHistory(topicId, 1)` once per topic, and for every topic without a live session that was a synchronous read + parse of the whole Telegram message log. Spec: `docs/specs/main-loop-freeze-conversation-list.md`.

Files touched:
- `src/messaging/TelegramAdapter.ts` — new last-entry index (`topicLastEntry`), `getTopicLastEntries()`, streamed single-flight `buildLastEntryIndex()` with braked retry; legacy `maybeRotateLog` uses `RotationLineCount`; one comment corrected.
- `src/server/telegramListRows.ts` (new) — the list's Telegram row producer (one index call, TopicMemory gap-fill) and `cachedTelegramHistory`, the unread counter's non-blocking Telegram source.
- `src/core/ConversationUnreadService.ts` — `UnreadTelegramSource.history` may answer null ("not loaded"); `sourceRows` then answers null (the existing unknown-count path).
- `src/messaging/TelegramAdapter.ts` also gains `getCachedTopicHistory` (cache-only) and `warmTopicTails` (batched background tail load).
- `src/server/AgentServer.ts` — `conversationFlatDeps.telegramTopics` uses the new producer; the unread service's Telegram history uses `cachedTelegramHistory`.
- `tests/unit/conversation-fallback-title.test.ts` — its source-text wiring assertion follows the moved `topicDisplayName` call.
- `src/messaging/shared/MessageLogger.ts` — `RotationLineCount` + `countNewlines`; `maybeRotate` no longer reads the log on every append.
- `src/core/CartographerTree.ts` — `scaffoldChunked` writes a node file only when its bytes change.
- `src/commands/setup.ts` — `probeNodeNativeCompat` (async candidate resolution + bounded parallel ABI probes), `assembleNodeCandidates` shared by sync/async; `ensureStableNodeSymlink` accepts pre-probed answers and candidates.
- `src/commands/server.ts` — boot awaits the async probe and hands its answers to the symlink step.
- Tests: 5 unit files, 1 integration, 1 e2e (listed in the spec).

Tier 1 (small, reversible: a revert fully restores prior behavior; no state, config or migration). Size: 8 source files (~450 lines incl. comments), 8 test files. Effort: spec review 3 rounds (the Tier-1 cap); each round found a real design issue one layer further out (partial-read merge and Cartographer race; per-append rotation read; the unread pass's scan), which is why it used the full cap.

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

- **Shadowing:** the tail cache wins over the index for a topic both hold; both are fed by the same append, so they agree. TopicMemory is consulted only for a topic the adapter has no entry for and never overrides it.
- **Double-fire:** none. The streamed build is single-flight; concurrent list requests share one promise.
- **Races:** an append during the streamed build is already in the index and is never overwritten (the build fills only absent topics). A read that fails part-way is discarded whole, so it cannot pin a stale entry. Log rotation mid-stream is safe (rename; the open stream finishes the old file). The Cartographer read-compare-write stays in one synchronous turn so a `setSummary` cannot land between them (an async draft had that lost update; review caught it and a test now guards it).
- **Feedback loops:** none. A persistently unreadable log is retried with backoff (1 min doubling, 30 min cap), not per poll.
- `getTopicHistory` and every other caller of it are unchanged.
- Unread counts: a topic whose tail is not loaded answers "unknown" for one request (shown as unread without a number, through the existing unknown-count path) and is loaded by one background pass; tails loaded this way follow the existing tail-cache rules (appends maintained, evicted on `unregisterTopic`). Appends that land while a topic loads are kept, de-duplicated by the log's dedupe key.

---

## 6. External surfaces

- Other agents / install base: every agent gets a faster list (rows and unread counts), no per-append full-log read above 20 MB, and a quieter boot. No API shape change: `/mobile/conversations` rows are identical, except that during the first moments after a boot a topic with no TopicMemory row shows no preview for that request instead of stalling the server.
- External systems: none.
- Persistent state: none added. Cartographer node files are rewritten only on change (same contents format). Rotation behavior (when and what it keeps) is unchanged.
- Timing: the streamed index build runs once in the background after the first list request.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read. The index is derived in-memory state over this machine's own Telegram log, with no durable store (same as the existing tail cache); the pool-wide list is served by the existing `?scope=pool` merged read that calls each machine's producer. No notices, no URLs, no durable state; nothing strands on topic transfer. Cartographer node files and the node symlink are per-machine files, as before. Status surfaces: none new or changed.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state, config, or migration; no user-visible regression during the rollback window beyond the old freezes returning.

---

## Conclusion

Spec review (3 rounds, codex external + internal lenses + the Standards-Conformance Gate) changed the design materially: it found the per-append rotation read (folded in), the partial-read merge and the Cartographer lost-update race (both fixed and tested), the warm-up preview flip (gap-fill made unconditional), the posture marker (now proxied-on-read), and the unread pass's own synchronous scan (now cache-only with a background load). Clear to ship.

---

## Second-pass review (if required)

Not required: no messaging block/allow, session lifecycle, compaction, coherence/trust, sentinel, guard, gate or watchdog surface.

---

## Evidence pointers

- Freeze profile: run scratchpad `freeze-profiles/CAPTURED-2026-11-21T09:46:44.txt` (list chain 19.3 % self time).
- E2E verified to fail against the old producer: 81 synchronous log reads for 80 topics; 0 after.
- Rotation: 200 appends above the size threshold → 1 read (was 200).
