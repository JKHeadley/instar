# Side-Effects Review — conversation list reads an in-memory log view (piece 1)

**Version / slug:** `conversation-list-log-view`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow, session lifecycle or messaging gate)`

## Summary of the change

This is piece 1 of the freeze fix (fb-52447f16-7d3), cut from pull request 3598 at the operator's request.

**Files:**
- `src/messaging/TelegramAdapter.ts`: the log view (`loadHistory`, `noteLogRow`, `noteLogRotated`, the `historyViewOn` switch), `getTopicHistoryForList`, and a trim notice.
- `src/messaging/shared/MessageLogger.ts`: an `onRotated` callback only.
- `src/server/AgentServer.ts`: the list producer and the unread source's Telegram history use `getTopicHistoryForList`; the off switch is wired; the background build starts where the app is on.

**What piece 1 contains:** no waits and no protocol change. When the view is not ready, the old read runs immediately. Chat history, scroll-back, other-machine requests, the first tail-cache fill and the trim are the old code. Pull request 3598 still holds pieces 2 and 3.

**Tier:** 1.

## Decision-point inventory

No decision-point surface.

## 1. Over-block

No block/allow surface — not applicable.

## 2. Under-block

No block/allow surface — not applicable.

## 3. Level-of-abstraction fit

The view sits beside the existing tail cache, and the one reader replaces only the synchronous file scan in the list path.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The build-retry brake (5 s doubling to 5 min) is a resource brake.

## 5. Interactions

- **Readers:** the view is read only through `getTopicHistoryForList`, which returns what `getTopicHistory` returns and NEVER writes the view's rows into the shared tail cache, so no chat can read the view. Every other reader uses `getTopicHistory`, unchanged.
- **Self-check:** before every use the view checks the file's inode, device, size and modification time against what it was built from. Any difference (an external append, a replaced file) uses the old read and rebuilds in the background.
- **Save path:** the view is updated only after the save's trim check, cache update and notifications, and fully isolated; a failure only drops the view.
- **Memory cap:** 64 MB of row text; over it, the old read runs.
- **Optional capability:** an adapter without the new methods (test stand-ins, older builds) keeps the old read; 36 server-constructing tests with stand-in adapters were run, targeted.
- **Races:** the view is published in the turn that confirms the end of the file. A trim, a failed save, a save onto a torn last line or any change of the file's identity drops it and rebuilds it.
- **Unread source:** it reads through the list path. Counts, the unread divider and read-mark resolution therefore get the same data from the view instead of the file.

## 6. External surfaces

- **What apps see:** faster lists; the same rows, order and unread counts. That was verified old against new on a private copy of the Studio's real log.
- **Protocol:** no protocol, config migration or persistent state change.
- **New setting:** `telegramHistoryView.enabled`, optional, default on.
- **Operator-facing actions:** none.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read. The view is derived in-memory state over this machine's own log, and the pool read is unchanged. Nothing is replicated, and no notices or URLs are added.

## 8. Rollback cost

Set `telegramHistoryView.enabled: false` (live), or revert. There is no persistent state.

## Known limits

- The old per-save trim check (a full read above 20 MB) is unchanged. Measured on the Studio: a median of 87 ms (max 136 ms) on the real 31 MB log; a median of 190 ms (max 587 ms) at 100,000 lines.
- Chat history and other readers still read the file synchronously on a cache miss, as before. Pull request 3598 covers them.

## Conclusion

Clear for review. The operator decides when it goes to the merge line.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action`: n/a. The view build is started by a list request or once at boot, with a time brake between failed builds and no timer. It is not a self-triggered loop.
