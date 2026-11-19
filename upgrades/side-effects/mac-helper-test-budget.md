# Side-Effects Review — Mac desktop helper waits scale in tests

**Version / slug:** `mac-helper-test-budget`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** an independent reviewer agent read the commit cold on 2026-11-18 and concurred; see the Second-pass review section at the end. The merge gate requires it because the change edits the shared test setup file.

## Summary of the change

Tier 1. 5 files of code and tests, about 190 added lines, one review round, one commit attempt.

`src/core/MacDesktopHost.ts` waits a fixed time for its native helper at five places. The unit tests replace the helper with a Node script, and beside a full suite a Node process can take longer than the 2 s ordinary budget to start, so tests failed with `mac-desktop-host-timeout` on unrelated changes (two in the merge line on 2026-11-18, `desktop-displays.test.ts > reports the main display as current until another is chosen`).

New import-free module `src/core/MacDesktopHelperBudget.ts` holds one process-wide scale (default 1) and the per-command base table that was inline in `run()`. All five waits now read `macDesktopHelperBudgetMs(base)`:

- `run()` spawn timer: base 15,000 / 4,000 / 10,000 / 2,000 by command, unchanged.
- `capturePacket` frame wait: 4,000.
- `sendInputLine`: its caller's 2,000 (input) or 20,000 (secret typing).
- `startIndicator` ready wait: 3,000.
- `waitForInputExit`: 2,000.

`tests/vitest-setup.ts` (the one setup file all four vitest configs load) sets the scale to 10. `tests/unit/MacDesktopHostCapture.test.ts` sets it back to 1 inside the one test that asserts the capture timeout, so its 7 s bound and its assertion are unchanged.

Not scaled, on purpose: `OWN_PROBE_GRACE_MS` and `PACKAGED_PROBE_RETRY_MS`. They are cache and retry windows, not waits on a helper.

## Decision-point inventory

No decision point is added or changed. The timers already existed; at scale 1 each fires at the same millisecond count as before.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface. A related miss: a stand-in helper that really hangs in a test now takes ten times longer to fail (20 s for an ordinary command). The unit test timeout is 120 s, so it still fails with the same named error rather than a bare test timeout, except secret typing (200 s), which no test leaves hanging.

## 3. Level-of-abstraction fit

Same shape as the existing precedent, `OriginStageDeadlines.ts` (PR 3157): a small module with no imports holding a process-wide default the setup file raises. It is a module rather than a static on the `MacDesktopHost` class because the setup file must not import `MacDesktopHost`: that would cache `node:child_process` ahead of test files' `vi.mock`, the incident recorded in `tests/vitest-setup.ts`.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The cap of 20 and floor of 1 are bounds on a test-only setting.

## 5. Interactions

- At scale 1, `macDesktopHelperBudgetMs` returns its argument untouched (no arithmetic), so production timers are identical.
- A test that changes the scale must restore it; the two that do use `afterEach` / `try…finally`. Vitest isolates module state per test file, so a leak could not cross files.
- A child process a test spawns does not run the setup file and keeps scale 1. The Node stand-in is the helper itself, not a host, so this does not matter here.
- Integration and e2e configs load the same setup file. The e2e desktop tests use the real helper, which answers well inside either budget.

## 6. External surfaces

None. No route, config key, stored state, message or log line changes. Nothing reads an environment variable: the scale can only be set by code that imports the module, and a source scan test pins that no file under `src/` does.

## 7. Multi-machine posture

Machine-local by design: a per-process, in-memory test setting. Nothing is stored or replicated.

## 8. Rollback cost

Revert the commit. No data, config or agent state to repair.

## Second-pass review

**Reviewer:** independent reviewer agent (a separate general-purpose agent with no part in writing the change), started by the session echo-increasing-throughput on 2026-11-18

**Verdict:** Concur with the review. Nothing blocking.

What the reviewer read: the commit 50f9a968e in full (the new budget module, every call site in MacDesktopHost.ts, the test setup change, both test files) and this note.

Its findings, as recorded in the pull request description at the time:

A separate reviewer read the commit cold and concurred, nothing blocking. It confirmed production equivalence per call site, that nothing but the test setup can raise the scale, and that a wait can never be shortened. Two wording points it raised about the side-effects note, recorded here instead of changing the commit: the note says a hung stand-in still fails with the named error because the test timeout is 120 s, but the push configuration uses 10 s, so there it fails as a plain test timeout; and the note says five places where there are six timers behind five wrapped expressions.

This section was added after the first Local Verify pass, when the merge was refused for lack of a recorded second pass: the review had been done and written into the pull request description, but not into this note or the trace. No source or test file changed in this commit.
