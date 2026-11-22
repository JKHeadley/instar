# Side effects: stored Secret Drop copies have a 24-hour age limit (SEC-157)

In plain words: a submitted Secret Drop is persisted encrypted (`secretDrops.<token>`) so it survives a restart before use. Nothing removed an unused copy, and the retrieve fallback returned any copy regardless of age, so an unused secret stayed on disk, retrievable, forever. Now a stored copy older than 24 hours is gone.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size: 1 new source file (`src/server/secretDropDurable.ts`) plus changes to `src/server/routes.ts` and `src/server/SecretDrop.ts`. Tests: 1 new unit file and new cases in 1 integration file and 1 end-to-end file.

## What changes for running agents
- **Age rule.** `durableDropExpired(receivedAt, now)` is true when the copy is more than 24 hours old, or when its `receivedAt` is missing, unparseable, or more than 5 minutes in the future (a clock that jumped back). Every copy written since store-first persistence began has a `receivedAt`. A copy from before that, with no `receivedAt`, is removed by the first sweep. The old fallback treated a missing time as "now".
- **Retrieve fallback.** An expired copy is deleted and the route answers 404 (`No submission found`), on peek and on consume. A copy within the limit behaves as before. The in-memory path is unchanged, with its 15-minute idle window and 30-minute cap.
- **Sweep.** `sweepExpiredDurableDrops(store, now)` reads the whole store once, removes expired `secretDrops` entries, and writes once, only if something was removed. It runs when the routes are built, and only if `persistDrops` is on, `stateDir` is a non-empty string, and the store file already exists, so it never creates a store or key and never throws during route setup. It also runs on each new submission before the new copy is written. Both run synchronously with no await between read and write, like the existing `store.set`. `SecretStore.read()` returns `{}` only when the file does not exist, and otherwise throws, so a failed read never leads to a write that empties the store. No timer is added.
- **Session context file.** The Secret Drop session's thread-history file (`ctx-<topic>-<time>.txt`) is written with mode `0600` instead of the default.
- **Form wording.** "It is not stored on disk" is replaced. A normal request says "It stays only on this computer until the agent uses it, and never longer than 24 hours." That is true whether `persistDrops` is on (the encrypted copy) or off (memory only, at most 30 minutes). A browser-only request says "It is never saved to disk."

## Signal vs authority
Not applicable: retention only. Nothing about who may retrieve changes.

## Not in this change
- Retrieve still does not consume by default; that is the designed retry behavior. The age limit bounds what a skipped consume can leave behind.
- The ordinary Telegram session's own `ctx-*.txt` file is outside this finding and unchanged.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the finding, the diff and this note), 2026-11-22. Verdict: CONCUR. It confirmed every stored-copy path is now bounded. The fallback checks age before the consume branch, and the in-memory path is untouched. The other readers of `secretDrops` only filter, count, or exclude it from peer sync. On data safety: the sweep is synchronous like `set()`, so it cannot interleave in-process. A failed read throws and never reaches `write()`. A missing file writes nothing. Only the `secretDrops` subtree changes. On setup safety: route setup cannot throw or create a store. Its notes, all taken: the form said "encrypted", which is false on a `persistDrops: false` agent, and the wording is now true either way. A far-future receive time now counts as expired. Tests were added for the sweep on submission and for an unreadable store left untouched. The removal of legacy undated copies is now stated above. Recorded, not changed: the context file's `0600` mode has no assertion.

## Rollback
Revert the commit. Copies already swept are gone. They were unused secrets over a day old, which the sender can send again.

## Tests
- `tests/unit/sec157-drop-copy-age-limit.test.ts` (new, 6 cases): the boundary, bad and far-future times, an unreadable store left untouched, a sweep that removes only expired copies in one write and keeps other secrets, the empty-branch cleanup, no write when nothing expired, and the form wording for both kinds.
- `tests/integration/secret-drop-store-first.test.ts` (4 new cases): expired and undated copies give 404 and are deleted. Route setup sweeps and keeps a fresh copy. A new submission sweeps too. Route setup with no store creates none.
- `tests/e2e/secret-drop-store-first-lifecycle.test.ts` (1 new case): a real server start removes the expired copy and still serves the fresh one.
- Run here: the new unit file, `SecretDrop` and `secret-sync-drops-machine-local` (3 files), all passing. Typecheck is clean. Integration and end-to-end coverage comes from Local Verify, because this machine does not run them by hand.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. Two bounded one-pass sweeps: at route setup and on a person's submission. No timer, retry or loop.
