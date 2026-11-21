# Side-Effects Review — main-loop freezes from the conversation list

**Version / slug:** `main-loop-freeze-conversation-list`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog, session lifecycle or messaging block/allow surface)`

## Summary of the change

Fixes fb-52447f16-7d3: the Echo Studio server froze for 20-30 s at a time because the app's conversation list (`GET /mobile/conversations`) called `TelegramAdapter.getTopicHistory(topicId, 1)` once per topic, and for every topic without a live session that was a synchronous read + parse of the whole Telegram message log. Spec: `docs/specs/main-loop-freeze-conversation-list.md`.

Files touched:
- `src/messaging/TelegramAdapter.ts` — an in-memory log view replaces the per-topic file scan (`loadHistory`, `waitForHistory`, `whenHistoryLoaded`), `getTopicTailRows`, `getTopicHistoryBeforeAsync`; the legacy rotation is the old code, plus a notice so the view follows each rotation.
- `src/server/AgentServer.ts`, `src/server/routes.ts`, `src/server/mobileConversationRoutes.ts` — list, read-report and chat-history routes wait (bounded) for the view; the list and unread counter use unjoined tail rows; the graph inventory starts after the first load.
- `src/messaging/shared/MessageLogger.ts` — only an `onRotated` callback, called after a successful rotation; the rotation code is the old code, unchanged.
- Tests: 5 unit files, 1 integration, 1 e2e (listed in the spec).

Tier 1 (small, reversible: a revert fully restores prior behavior; no state or migration; one new optional setting, `telegramHistoryView.enabled`, defaults on and needs no migration). Size: 5 source files, 4 test files. Effort: spec review 3 rounds (the Tier-1 cap); each round found a real design issue one layer further out (partial-read merge and Cartographer race; per-append rotation read; the unread pass's scan), which is why it used the full cap.

**Split:** the boot-time changes (Cartographer scaffold, async Node ABI check) moved to their own pull request, #3601. This change covers only the conversation-list, chat-history and message-save paths.

**Off switch:** `telegramHistoryView.enabled: false` (default on; read live through LiveConfig where available) returns every read to the old path with no code change. Tested in `tests/unit/telegram-log-view.test.ts` and `tests/integration/conversation-list-no-log-scan.test.ts`.

## Known limits (accepted by the operator, 2026-11-21)

- **Replacing the log file by hand while the server runs** is unsupported: the view and rotation line count follow the file the server writes, and catch up at the next rotation or restart.
- **A warming peer beyond 4 s** (round 5, finding 6) is reported as `loading` for that request rather than listed; the forwarded read-report wait is 4 s, inside the sender's 5 s budget.
- **The 15 s wait racing a shorter server request timeout** (round 5, finding 7) produces the timeout answer; the data is unchanged.
- **The graph inventory waiting for the first load** (round 5, finding 9) starts after the first load or its first failure, so coverage is late, never wrong.

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

No new static heuristic at a competing-signals decision point. The new fixed values (history-load retry backoff 5 s doubling to 5 min; request waits of 15 s and 4 s; a 60 s bound on the inventory's first wait) are tuning brakes on internal work, declared with floors in the spec's Decision points section; neither chooses between competing signals.

---

## 5. Interactions

- **Shadowing:** none. The tail cache, its eviction and the unread service are unchanged; the view only replaces the file scan beneath them.
- **Double-fire:** the load is single flight.
- **Races:** a pass reads to the confirmed end of the file and publishes in that turn, so no append falls between; a rotation drops the view; a pass that read a replaced file, or an append onto a torn last line, causes a fresh read; a failed pass publishes nothing.
- **Round 6 fixes (2026-11-21):** finding 2: resolved by restoring the old rotation code in both logger paths, byte for byte, plus a notice so the log view follows each rotation. Measured on the Studio (2026-11-21): the old per-save check (stat, full synchronous read, split, filter) takes a median 87 ms and at most 136 ms on Echo's real 30.8 MB, 36,029-line log, and a median 190 ms and at most 587 ms on an 88 MB, 100,000-line log (the largest size before a trim). Echo saved about 98 messages a day over the last week, at most 8 in any one minute. Each check stays under the one-second goal, so the old trim is kept rather than changed. Earlier attempts (c8b9a0f50, 26832b0ab) are superseded. Finding 8: switching `telegramHistoryView.enabled` off releases the background inventory wait and every request wait, which then take the old read path; a request wait that times out re-checks the switch, and the inventory's first wait is bounded at 60 s, so a stalled load or a switch turned off with nothing reading it cannot hold either.
- **Failure handling:** a rotation during handle close is re-read in the same load; a part-failed append drops and re-reads the view; rotation is the old code, unchanged; a loading peer is reported as `loading`.
- **Feedback loops:** none. No timer retries the load; a later request may start another pass after 5 s, doubling to 5 min.
- The conversation-graph inventory starts after the first load, so it cannot publish a partial view.

---

## 6. External surfaces

- Other agents / install base: every agent gets a faster list (rows and unread counts); first requests after a boot wait up to 15 s for one background read, then get a retryable 503, no per-append full-log read above 20 MB, and a quieter boot. No API shape change: `/mobile/conversations` rows are identical, and that is verified by an old-versus-new client diff.
- External systems: none.
- Persistent state: none added. Rotation behavior (when and what it keeps) is unchanged.
- Timing: the streamed index build runs once in the background after the first list request.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read. The log view is derived in-memory state over this machine's own Telegram log, with no durable store (same as the existing tail cache); the pool-wide list is served by the existing `?scope=pool` merged read that calls each machine's producer. No notices, no URLs, no durable state; nothing strands on topic transfer. Status surfaces: none new or changed.

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

---

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action`: n/a. The history load is started only by a request or once at boot, with a time brake between failed attempts and no timer. The node compatibility probe is a one-shot boot step over a bounded candidate list. Neither is a self-triggered loop.
