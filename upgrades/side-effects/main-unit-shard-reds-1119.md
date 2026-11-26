# Side-Effects Review — two red unit shards on main

**Version / slug:** `main-unit-shard-reds-1119`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `not required for a test-only change unless the gate asks`

## Summary of the change

Tier 1. Test files only: two files, about 30 lines added and 2 removed, nothing under `src/`. Handed over by Dawn's ci-monitor (main runs 44528329305 through 44573376479). Unit shard 3/4 failed in `tests/unit/console-chats-page.test.ts` (`card source message navigation`), and unit shard 4/4 passed every test, then failed the "Test suite mutated the working tree" step.

### Per file

**`tests/unit/console-chats-page.test.ts`**

- Observed: across five main runs, every failure in this file was a count of `/messages?` fetch calls higher than expected: 2 vs 1, 3 vs 1, 4 vs 2, 7 and 8 vs 6. There was never a timeout. The file passes alone.
- Cause: `boot()` re-imports `dashboard/console/console.js` after `vi.resetModules()` for each test. `dom.window.close()` does not stop the previous module copy. That copy reads `fetch`, `document` and `location` as globals at call time. A request it had started before its test ended (signed with WebCrypto on the thread pool, or waiting on the fake IndexedDB's Node timers) resumes during the next test and lands in that test's `calls`. Reproduced by delaying `crypto.subtle.sign`/`digest` by 120 ms: the unchanged file failed "distinguishes exhausted history" with 2 reads vs 1, the same signature as CI.
- Ruled out: the 30 s console page refresh (the chats page registers itself as self-refreshing; a 400 ms refresh changed nothing), and the chats poll loop (cutting its intervals to 60 ms changed nothing).
- Change: `boot()` runs the whole page boot under `AsyncLocalStorage.run(generation)`. The fetch mock returns a never-settling promise, and records nothing, for a call whose store is an earlier generation. A call with no store, which is work the test body itself starts (a click, for example), is treated as the current page's. Page `BroadcastChannel`s are tracked by a subclass and closed in `afterEach`, because Node's channel outlives the JSDOM window.
- Why it is not weaker: every assertion and count is unchanged. Only calls an earlier test's page makes are excluded, and those were never the current test's subject.
- Remaining gap: a chain the test body started, which carries no store, could still leak into a later test. No CI failure matched that path.

**`tests/unit/locked-proof-watch-end.test.ts`**

- Observed: shard 4 `git status --porcelain` printed only `?? scripts/locked-proof/__pycache__/`.
- Cause: the atomic-read case loads `scripts/locked-proof/watch-end-supervisor.py` with `importlib` `exec_module`, which writes bytecode next to the source. Added in #3368 (2026-11-19 04:52 PST). macOS system Python sets `sys.pycache_prefix` to a cache folder outside the checkout, so it never showed locally.
- Change: `python3 -B`, matching `tests/unit/normal-chrome-linux-rules.test.ts`.

## Decision-point inventory

No decision-point surface. Test files only.

## 1. Over-block

No block/allow surface. In test terms, no changed case now rejects behaviour it accepted before.

## 2. Under-block

No block/allow surface. In test terms, see the remaining gap above: a chain started by the test body is still attributed to the current page.

## 3. Level-of-abstraction fit

The cause is the test harness re-importing a module per test without disposing the previous copy, so the repair belongs in the harness. Product code correctly assumes one page per browser.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

## 5. Interactions

The `BroadcastChannel` subclass is installed for this file's worker only; vitest isolates files. `AsyncLocalStorage` is scoped to this file. The shared helpers and vitest configuration are unchanged.

## 6. External surfaces

None. No agent, user, external system or persistent state is touched.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: unit tests run on whichever machine runs the suite. No notices, no durable state, no URLs.

## 8. Rollback cost

Revert the commit. Nothing else.

## Conclusion

Two test-only causes of a red main are repaired, with no assertion removed and no case skipped. Clear to ship.

## Second-pass review

**Reviewer:** not required for a test-only change unless the gate asks.

## Evidence pointers

- CI assertions from five main runs (listed above), all over-count.
- Slowed-signing reproduction: original fails with an over-count; fixed copy has no over-count (both copies also hit plain timeouts at that artificial delay).
- Python with `sys.pycache_prefix = None`: the folder appears without `-B`, not with it.
- Both changed files: 27/27 and 24/24.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
