# Side-Effects Review — The layer ticker skips a fold's lock window (context budget Phase 2)

**Version / slug:** `cb-p2-lockwindow-ticker`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §10 "Suppression carrier" (the intent extractor and its ticks skip the lock window range)
**Stacked on:** #3566 (P2-4b)

## Summary of the change

A shadow fold's handoff request and the session's reply are internal turns. The fold hold already keeps them off the channel, so TopicMemory never ingests them. The transcript-growth ticker, though, reads the session's transcript directly and would feed that turn to the intent extractor as current-work awareness.

- **`dropLockWindows(lines, windows)`** (`layerTicker.ts`) drops every transcript line after a window's `fromEntry` (the last entry before the injection) up to and including its `toEntry`. A window still open (no `toEntry`) drops everything after its start.
- **`LayerTicker`** takes an optional `lockWindows(topicId)` and applies the filter before building its digest.
- **Wiring.** `layerCaptureWiring.startTicker` passes it through, and `server.ts` supplies `readLockWindows(stateDir, topic)`, the durable lock-window log from P2-4a that outlives the fold record.

**Files.** Modified: `layerTicker.ts`, `layerCaptureWiring.ts`, `server.ts`, `foldShadowRunner.ts` (`end()` stamps the window's `closedAt`), `FoldCoordinator.ts` (`LockWindowRow.closedAt`); the e2e wiring check; `fold-shadow-runner.test.ts` (+1). New: `tests/unit/context-layer-lock-window.test.ts` (7). About 90 LOC.

## Decision-point inventory

Which transcript lines feed the awareness extractor (modify). Only a recorded fold window is removed.

## 1. Over-block
A line of real work between `fromEntry` and the injected request could be dropped. `fromEntry` is the transcript's last entry when the request is injected at a clean stop (no turn in flight), so nothing real lies between the two.

## 2. Under-block
The uuid is read from the raw JSON line by pattern. A line without a uuid inside a window is dropped with it, and outside one it is kept, as today.

## 3. Level-of-abstraction fit
It sits at the one point where the ticker turns the transcript into extractor input.

## 4. Signal vs authority compliance
An input filter for a derived layer. No authority.

## 5. Interactions
The ticker's size bookkeeping is unchanged (consumed growth is still consumed), so a skipped internal turn is not re-read.

## 6. External surfaces
None.

## 7. Multi-machine posture
Machine-local by design: each machine's ticker reads its own sessions' transcripts and its own fold records.

## 8. Rollback cost
A revert.

## Second-pass review

Concern raised:

1. **A fold that ends early leaves an open window, and the ticker then hides all later real work.** `foldShadowRunner.ts:201` records `fromEntry` before the handoff turn. `toEntry` is recorded only on the success path (`:240`), and only when `lastEntryId(after)` is non-null. Every early `return end(...)` after `:201` returns without closing the window: `inject-failed`, `handoff-timeout`, `handoff-unparseable`, `no-judge`, `audit-invalid` and `fold-declined`. `end()` (`:165-180`) never calls `setLockWindow`. `readLockWindows` serves that row from the durable log, and `dropLockWindows` treats a window with no `toEntry` as "drop everything after its start". From then on, every tick for that topic drops all real work after the failed fold until `fromEntry` falls out of the 512 KB tail. That is an over-block the artifact does not mention (§1 covers only the gap between `fromEntry` and the injected request). Fix: in `end()`, close the window with the transcript's current last entry, or mark the row aborted so the ticker treats it as closed. Also add a unit test for an aborted fold.
2. **The tail can cut off a window's start.** The ticker re-reads the last 512 KB on every pass (`readTranscriptTailAsync`, `TICK_TAIL_BYTES`). If `fromEntry` has scrolled out of the tail but `toEntry` is still inside, `dropLockWindows` never opens the window. The handoff request and reply then reach `buildTickDigest` (an oversize reply makes this more likely). Fix: when a window's `toEntry` is in the tail and its `fromEntry` is not, drop from the start of the tail through `toEntry`. §2 of the artifact says nothing about this case.

Verified fine: the `await import` at server.ts:19669 is in the same async scope as the other awaits in that block (19603, 19604, 19630). The JSON-parse `uuidOf` is needed: in real Claude Code transcript lines `message` comes before the top-level `uuid`, so the earlier regex could have matched a uuid nested in content first. It now reads only the top-level key. `npx vitest run` on the lock-window and cadence unit files passes 19/19.

### Disposition (author)

Both concerns verified and fixed:
1. **A fold that ends early no longer leaves an open window.** `end()` now stamps `closedAt` on the lock window first, before the releases and while the record is still open, on every exit path. `dropLockWindows` ends a window that has no `toEntry` at the first line timestamped after `closedAt`. A window with neither end bound (a fold still in flight) still drops everything after its start, which is correct mid-fold. Tests: an early-closed window keeps the later real work, and the runner stamps `closedAt` on a handoff timeout.
2. **A start that scrolled out of the tail.** When a window's `toEntry` is in the tail but its `fromEntry` is not, the window is open from the tail's first line through `toEntry`. Tested. The uuid and timestamp are read from each line's own top-level keys (JSON-parsed).


### Reviewer re-check:

Concern raised (minor, one item; both original concerns are otherwise fixed and verified in code):

1. **A refused close stamp is silent and leaves the window open.** `end()` stamps `closedAt` through `guard('lock-window', …)`. That guard catches only throws, and the `boolean` that `setLockWindow` returns is discarded. `setLockWindow` (FoldCoordinator.ts:500-507) returns false without writing when `preconditions.isOwner(topicKey) !== true`. That is the "ownership moved" case `end()` itself plans for: the record cannot go terminal, and the owner's sweep handles it. It also returns false when `appendLockWindow` fails. In either case the durable log keeps a window with `fromEntry` and no `toEntry`/`closedAt`, so it drops everything after its start. If the session's transcript is ticked on this machine again while `fromEntry` is still in the 512 KB tail, the original over-block returns. Fix: write the `closedAt` stamp to the durable log without the owner/terminal checks (a close only narrows a window), or at least send a false return to `onDegraded` so it is not a silent "closed".

Verified: `end()` stamps first on every exit path, including success, where `toEntry` takes precedence and `closedAt` is ignored. Close-at-first-later-timestamp uses the entry's own top-level `timestamp`. The reply lines are stamped before `closedAt`, so they are still dropped. A window whose start scrolled out of the tail is opened from the top through `toEntry`. Rows from aborts before `fromEntry` carry only `closedAt` and are filtered out. A remaining, accepted edge: a window with only `closedAt` whose `fromEntry` scrolled out of the tail is not opened from the top, which needs a failed fold with more than 512 KB of transcript after its start. The lock-window, cadence and fold-shadow-runner unit files pass 31/31.

### Disposition (author), round 2

Fixed. New `FoldCoordinator.closeLockWindow(topicKey, foldId, closedAt)` writes the close stamp straight to the durable log. It skips the owner and terminal checks, because a close only narrows a window, and accepts only this machine's own record's fold id. `end()` uses it, and a false return (a failed write) is reported as `lock-window-close-failed` through `onDegraded`, never silent. Test: with the terminal transition refused (ownership moved), the window still carries `closedAt`. The accepted edge (a closed-early window whose start scrolled out of a 512 KB tail) stays as the reviewer noted.

### Reviewer re-check 2:

Concur with the review. `closeLockWindow` (FoldCoordinator.ts:518-522) needs only that the record exists and that `rec.machineId === this.o.machineId`. It skips the owner and terminal checks, so the close stamp is still written when ownership has moved or the record cannot go terminal. `mergeLockWindows` merges the stamp into the fold's earlier `fromEntry` row by `foldId`. `end()` sends a false return to `onDegraded` as `lock-window-close-failed`, so the failure is no longer silent. The new test reaches `closedAt` through a refused terminal transition, not a refused owner check, but the code path is the same. Typecheck is clean for the touched files, and the lock-window, cadence and fold-shadow-runner unit files pass 31/31.
