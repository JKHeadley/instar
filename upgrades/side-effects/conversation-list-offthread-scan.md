# Side-Effects Review — conversation list and first chat read scan the Telegram log off the main thread

**Version / slug:** `conversation-list-offthread-scan`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow, session lifecycle or messaging gate); one strict external review is run on the pull request`

## Summary of the change

The freeze fix for fb-52447f16-7d3, Option C, chosen by the Chief of Staff in place of the in-memory
log view (pull request 3602, which stays a draft). Spec: `docs/specs/conversation-list-offthread-scan.md`.

**Files:**
- `src/messaging/TelegramAdapter.ts`: `warmTopicTails` and `scanTailsOffTurn` (new, additive). The
  old read (`getTopicHistory`, `scanLogForTopic`, `seedTailCacheFromLog`, `getTopicHistoryBefore`)
  and the trim (`maybeRotateLog`) are byte-for-byte unchanged; `MessageLogger` is untouched.
- `src/server/AgentServer.ts`: `routeCtx.telegramHistoryWarm` (the live off switch
  `telegramHistoryScan.offMainThread`) and the list's `telegramWarm` dependency.
- `src/server/mobileConversationRoutes.ts`: the list awaits `telegramWarm` before its unchanged code.
- `src/server/routes.ts`: a chat read without `before` awaits `telegramHistoryWarm([topicId])`.

**Tier:** 1 (additive, behind a live switch, a revert fully undoes it, no state written).
**Proportion:** 4 source files, about 150 added lines; tests 4 files. One measurement round per
design, one strict external review on the pull request.

## Decision-point inventory

No decision-point surface. Nothing is blocked, filtered or gated; the change decides only whether a
cache fill is saved, and every "no" falls back to the old read.

## 1. Over-block

No block/allow surface — not applicable. The nearest analogue: a scan that gives up (busy file,
replaced file) costs a cold request the old synchronous read, which is today's behavior.

## 2. Under-block

No block/allow surface. Correctness misses considered:
- A same-length rewrite during the main read: caught by the hash re-read (tested, mutation-checked).
- A rewrite during the re-read: caught by the change-time check (tested, mutation-checked); relies on
  the file system moving change time on every write (stated in the spec's limits).
- A same-size file renamed into place: caught by the dev/ino check (tested, mutation-checked).
- An external process writing between the final check and the save: the save is in the same
  synchronous turn as the check; the old cache never sees external writes either, so the result
  equals the old read at the moment of the check.

## 3. Level-of-abstraction fit

The fill sits in the adapter beside the cache it fills and reuses its parse. The routes only await
it. No second store; every reader still goes through `getTopicHistory`.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 5. Interactions

- `rememberLoggedEntry` pushes appends only into cached topics; an uncached topic's append during a
  scan is read from the file by the scan (tested). A topic cached by another path during the scan
  keeps that copy (tested).
- `seedTailCacheFromLog`/`tailCacheSeeded` are untouched: a later miss on a live topic still seeds
  as before.
- `unregisterTopic` drops a topic's cache; a scan that started earlier may save that topic again.
  That holds the same rows the old read would load on the next read; no difference in answers.
- The trim renames a new file into place; a scan in flight gives up and the next request scans the
  new file.
- Pool list reads: the peer's list route awaits its own scan inside the asker's 5 s budget (see the
  spec's limits).

## 6. External surfaces

No response shape changes. Latency: a cold list or chat waits for the shared scan (measured below);
warm requests do not wait. One new config key, `telegramHistoryScan.offMainThread`, absent = on; no
migration needed because absence is the default.

## 7. Multi-machine posture

Machine-local BY DESIGN: the tail cache is per machine because the Telegram log it mirrors is per
machine. Pool reads reach the owning machine's routes and therefore its own scan.

## 8. Rollback cost

Set `telegramHistoryScan.offMainThread: false` (read live, no restart) or revert the pull request.
Nothing is persisted.

## Evidence

- Unit: `tests/unit/telegram-offthread-history-scan.test.ts` — replay against a fresh adapter's old
  read; read error, replaced file, same-size rename, same-length rewrite during the read and during
  the re-read, append during the scan, a cache filled during the scan, no log file, a log changing
  through every round, concurrent callers sharing one scan.
- Integration: `tests/integration/conversation-list-offthread-scan.test.ts` — list and cold chat
  through the HTTP routes, on versus off identical, off switch live, one scan for concurrent lists.
- E2E: `tests/e2e/conversation-list-offthread-scan-alive.test.ts` — production constructor, ~25 MB
  log, cold list and cold chat with the longest stall under 1 s measured in-test; fails with the
  switch off (about 6 s).
- Real-log comparison on a private copy of Echo's log: see the pull request body.
