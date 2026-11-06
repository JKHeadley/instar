# Side-Effects Review — Watchdog test-runner floor covers identity-checked Xcode test runs

**Version / slug:** `watchdog-xcodebuild-test-floor`
**Date:** `2026-11-05`
**Author:** `echo (builder echo-watchdog-xcodebuild, hub 136110)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

`classifyTestRunnerCommand` (src/monitoring/SessionWatchdog.ts) now also returns `test-runner` for Xcode test runs, so they get the existing bounded test-runner floor: 60 min, extended to 3 h only while subtree CPU advances. A run qualifies only when the ps command column starts with the exact path `<active developer dir>/usr/bin/xcodebuild` or `/usr/bin/xcodebuild`, and xcodebuild's arguments contain `test` or `test-without-building` as an action word. Option values are skipped using a list of options known to take no value; `KEY=VALUE` build settings are skipped. `<active developer dir>/usr/bin/xctest` qualifies when given a `.xctest` bundle. The active developer dir is `DEVELOPER_DIR`, else `/usr/bin/xcode-select -p` on darwin. It is cached: a found dir for the life of the process, a missing one for 10 min before it is re-checked (2 s timeout). A bare `.app` is normalised to `.app/Contents/Developer` and symlinks are resolved. When there is no dir, only the SIP shim path matches. The function gained an optional second parameter, which tests use to supply the developer dir. CLAUDE.md template + PostUpdateMigrator gain one awareness line. Driving evidence: fb-412e8332-ee1.

## Decision-point inventory

- `classifyTestRunnerCommand` — modify — recognises identity-checked Xcode test runs.
- `classifyTestRunnerProtection` / `classifyProtectedWait` / stuck-kind labelling — pass-through — consume the classifier unchanged; ancestor protection (`test-runner-ancestor`) now also applies above an Xcode test run.

---

## 1. Over-block

The floor holds back an interrupt; it never blocks user input. A truly hung `xcodebuild test` is now spared for up to 60 min (or up to 3 h while it burns CPU) before the judge sees it, where before it could be interrupted after the stuck threshold. That is the same trade already accepted for vitest, and it is bounded. The ps command column is split on whitespace, so a quoted option value containing the word `test` (`-scheme "My test" build`, `-destination '...,name=UI test' build`) can leak out as a bare action word. A real xcodebuild build can then be spared too, still only within the same 60 min / 3 h bounds. The identity check on the executable still applies.

## 2. Under-block

Not covered: an Xcode test run launched from an Xcode outside the active developer dir (a second Xcode chosen per-session via a `DEVELOPER_DIR` the server does not share). It stays judged as before, so the failure there is unchanged rather than new. Also not covered: `swift test`, `xcrun simctl` operations and the simulator-side UI test runner. The runner is launched by launchd, not under the session, so the watchdog never sees it. The CPU-progress extension from 60 min to 3 h measures xcodebuild's own process subtree. The simulator-side UI test runner is outside that subtree, so for a UI suite longer than 60 min the subtree may look idle and be released to the judge at 60 min. For UI suites, 3 h is a ceiling, not an expectation. A bare `xcodebuild` in the ps column (argv[0] not absolute) is not protected. In practice the binary's ps column shows the full developer-dir path, as in the killed run.

## 3. Level-of-abstraction fit

Right layer: it extends the existing deterministic argv-contract classifier that already feeds the floor, and follows the esbuild-service pattern of matching the full contract rather than a basename. No parallel mechanism is added.

## 4. Signal vs authority compliance

The floor is a deterministic safety guard on an irreversible action (interrupting a run destroys its results). It can only withhold an interrupt within a stated bound. It holds no new authority to act.

## 4b. Judgment-point check (Judgment Within Floors standard)

This adds no new static heuristic at a competing-signals point. It widens an existing floor below the judge to one more enumerable runner identity. Past the bound the judge decides exactly as before.

## 5. Interactions

The ancestor rule now protects a shell or wrapper with an Xcode test run below it, and only while the run is live in the snapshot. The interruption notice (`stuckCommandKind: test-runner`) now also labels an Xcode run that is interrupted past the bound, which is correct. The `xcode-select` spawn happens once, synchronously, on the first classification. It costs about 10 ms and has a 2 s cap. No other check is shadowed.

## 6. External surfaces

One CLAUDE.md awareness line (template + idempotent migration, sniffed by its heading). No API, config or notice-text change.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface changes. The user-facing effect is that iOS test runs are no longer cut short.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's watchdog classifies its own processes against its own Xcode.

## 8. Rollback cost

A revert restores the old behaviour. There is no state, no migration of data and no config.

## Conclusion

A narrow, bounded extension of an existing floor with both-sides tests. Ship.

## Second-pass review (if required)

Required (watchdog). An independent reviewer subagent read the diff and this artifact on 2026-11-05 at 20:07 PST.

Reviewer findings, and what was done about each:
1. Inline-value options (`-only-testing:X test`) swallowed the action, a false negative. **Fixed**: `-opt:value` and `-opt=value` are now treated as self-contained; there are tests on both sides.
2. Valueless test flags were missing (`-retry-tests-on-failure`, `-run-tests-until-failure` and others), a false negative. **Fixed**: they are added, with tests.
3. A quoted value containing `test` can produce a false positive. **Documented** under Over-block; bounded.
4. Developer-dir edge cases (bare `.app`, symlinks, a permanently cached null). **Fixed**: the dir is normalised and realpath'd, and null is re-checked after 10 min.
5. For UI suites, the 3 h extension is a ceiling, not an expectation. **Documented** under Under-block.

Reviewer concurred on: the identity check (suffix, lookalike and path-with-spaces cases), callers (no index-passing), host-independent tests, preserved bounds, and the template line matching the migration line byte for byte. With the fixes above, concur.

## Evidence pointers

- fb-412e8332-ee1 (kill at 2026-11-06T02:55:06Z, 1013 s, 48/69 tests ran).
- tests/unit/session-watchdog-xcodebuild-floor.test.ts: protected real argv, including a developer dir with spaces; lookalikes not protected (basename, other paths, other Xcode, `-wrapper` suffix, `-scheme test build`, `build`, `archive`, `-list`, `KEY=test`, `echo`/`grep`, `xctest -h`); bounds at 60 min / 3 h; ancestor rule.
- tests/unit/PostUpdateMigrator-commandWatchdogAwareness.test.ts: migration adds the template's exact line, idempotent.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: the defect is in TypeScript classifier code. The change modifies a kill controller only by removing kill candidates within an existing absolute bound (`MAX_TEST_RUNNER_ABSOLUTE_MS`). It adds no action, so it introduces no new control-loop edge. Steady state is unchanged, and the settling brake is the existing 3 h bound (ratchet: tests/unit/self-action-convergence.test.ts unchanged).
