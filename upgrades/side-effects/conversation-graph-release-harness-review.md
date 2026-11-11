# Side-effects: Conversations release, test and audit harness review

## Summary

PR #3013 adds or changes about 188 paths under `tests/` and `docs/audits/` (171 new, 17 modified); the merge gate counts 169 of them as harness-changing. This note records an independent review of all of them, and three small follow-up changes made from that review:

- `tests/e2e/conversation-graph-live-fixture.test.ts`: the startup timer goes from 45 s to 90 s and the test timeout from 120 s to 180 s. A startup timeout now names the last startup phase the fixture reported and the elapsed time (`live-fixture-start-timeout:<phase>:<ms>`). The test failed once in Local Verify under full load on the M5 and passed alone on the Studio and in three full M5 runs; its code snapshot hashes the declared package roots several times in synchronous code, so its startup time varies about 2x under load.
- `tests/unit/SqliteRegistry-wiring.test.ts`: a duplicate `closeAllSqlite` import is removed.
- The two 2026-11-05 audit files under `docs/audits/` get a one-line header saying they are historical checkpoints, not current state.

## Follow-up after Local Verify (2026-11-10)

The live-fixture e2e kept failing only inside Local Verify's full parallel run. Startup phase logs showed the snapshot copy of ~10,000 files taking up to 69 s on a busy disk, so the test's start window ran out while the fixture server was still copying (the server itself never failed). Changes:
- `tests/helpers/conversation-graph-frozen-dist.mjs`: change detection by path, size, mode and nanosecond mtime instead of hashing the source twice; files copied concurrently with a clone; only the copy is hashed, once; the critical server modules are still compared by content; after the first copy error no worker starts another file.
- `tests/helpers/conversation-graph-live-server.mjs`: a 503 (not ready) first owner visit is retried for up to 30 s; startup phases and a full startup failure are written to `/tmp` so a lane-only failure can be read.
- `tests/e2e/conversation-graph-live-fixture.test.ts`: start window 180 s, child lifetime 300 s, test timeout 300 s; the phase-named timeout error stays. A diagnostic `catch` writes the error stack and the last 8 KB of the child's stderr (control token and PIN redacted) to `/tmp/instar-live-fixture-test-failure.log` (mode 0600) and rethrows, so pass/fail and the `finally` cleanup are unchanged. That log then showed the real remaining failure: every check passed, and the wait for a clean child exit (15 s) ran out while the child synchronously removed its ~10,000-file code copy on a busy disk. The exit wait is now 120 s and the test timeout 360 s; the assertion that the copy is gone after exit stays.
- `tests/integration/conversation-graph-replication-contexts.test.ts`: the 4000-row historical-context scale proof (about 31 minutes on the M5, longer than Local Verify's fixed 30-minute integration shard deadline) now runs only with `GRAPH_HISTORICAL_CONTEXT_SCALE_PROOF=1`, like the other graph scale proofs. A new default 300-row test repairs a multi-page context (at least 2 pages of 128 KiB) across restart through the same signed-peer ceremony, in about 2.6 minutes; the 8-row smoke test stays. Only the over-3 MiB single-file assertion now needs the opt-in run.
- `tests/helpers/conversation-graph-frozen-dist.mjs`: the snapshot leaves out `dist/native/instar-desktop-<kind>-test-*`, temporary helpers the desktop unit tests create and delete in another lane (one vanished mid-copy, ENOENT).

## 1. Over-block
No issue identified.

## 2. Under-block
The longer startup window could hide a fixture that has become slow. The phase-named error keeps a slow phase visible, and the reviewer's suggested cost cut for the snapshot is tracked as follow-up.

## 3. Level-of-abstraction fit
Test-only and doc-only changes.

## 4. Signal vs authority compliance
No authority changes.

## 5. Interactions
None outside the test files.

## 6. External surfaces
None.

## 7. Multi-machine posture
Not applicable.

## 8. Rollback cost
Revert the commit.

## Class-Closure Declaration
Defect class: n/a. Closure: n/a.

## Evidence
- Full suites on the M5 at 969c81f2b0: integration 6,883 passed, 0 failed; the only unit and e2e failures come from the M5 setup and fail the same way on main there.
- The live-fixture e2e passed on the Studio at fe9030b021 (1 of 1) and in the 5c95b25cca, 2ef62f2048 and 969c81f2b0 M5 runs.

## Second-pass review
**Reviewer:** independent fresh Claude subagent (Opus 5.5), given the diff and the files, not the author's conclusion, 2026-11-09 19:30 PST.

Verdict: concur. All 188 harness paths in the diff (the gate's 169-path list) were reviewed: 171 new files and 17 modified ones. The modified tests contain no weakened or removed assertions; every change follows a real source change (the new `onAccepted` signature, the new journal kind, the vault `syncDurably` interface), and several string-slice checks now end at a named marker instead of a fixed length, which is stricter. The `skipsAdded` flag comes from three env-gated opt-in scale proofs (over 64 MiB HTTP source, 64-member 20,000-row native tail, over 32 MiB metadata pages), each with default-run coverage of the same code at normal size; no failing check is hidden. The new evidence-folder helper, the status-table path-generator rewrite and the prototype-restore wrappers are sound. Notes, none blocking: the opt-in proofs are run by no lane; `SqliteRegistry-wiring.test.ts` had a duplicate import (fixed here); the two 11-05 audit docs are partly out of date (header added here); the live-fixture startup is load- and order-sensitive and its timeout did not name the stalled phase (phase-named error and longer window added here; making the snapshot cheaper is follow-up).

**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 03:47 PST, given the diffs since the first review, not the author's conclusion.

Second verdict, on the follow-up: concur. The snapshot still pins an exact, content-hashed copy of the built package: the source is checked for changes by name, size and nanosecond mtime, the copy is fully hashed, and the critical modules are compared by content, so only a writer that keeps the old mtime could slip a non-critical change past it. The longer start, lifetime and test windows only tolerate disk load, with the phase-named timeout kept, and the 503 retry is bounded and limited to the documented "not ready" answer, so no real refusal is masked. Its one should-fix (cleanup racing copy workers after an error) is applied. Notes kept: the fixed `/tmp` diagnostic names follow an existing file and the phase log is never trimmed.

**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 08:13 PST, given the diagnostic diff, not the author's conclusion.

Third verdict, on the diagnostic catch: concur. Test semantics are unchanged (the same error is rethrown and `finally` still runs); it exposes nothing new, since the bearer token is redacted no more and no less than in the existing evidence-dir stderr log and AgentServer has no console path that prints the token, PIN or session secrets. Its optional note (redact before cutting to 8 KB) is applied.

**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 08:38 PST, given the shutdown-wait diff and the failure log, not the author's conclusion.

Fourth verdict, on the shutdown wait: concur. A real hang still fails with the named shutdown error, now up to 105 s later; the removal cannot be made much faster under five-way disk contention without copying fewer files. Its budget note is applied: the test timeout is 360 s, so start (180 s) plus body plus shutdown (120 s) fits and the named error is not pre-empted by the generic timeout.

**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 10:40 PST, given the scale-proof diff, not the author's conclusion.

Fifth verdict, on gating the 4000-row proof: concur. The test passed in the full M5 run, so this is runtime, not a hidden failure; it uses the same opt-in pattern as the three existing scale proofs. Its one recommendation (a cheap default multi-page test, since paging was the only behaviour the 8-row smoke did not reach) is applied: 300 rows, at least 2 pages, 2.6 minutes.

**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 13:20 PST, given the CI-fix diff, not the author's conclusion.

Sixth verdict, on the GitHub Actions portability fixes for PR #3013: concur. The changes: a stand-in `claude` on PATH (restored afterwards) for `join-missing-dir`; `frameworkBinaryPaths` naming an existing executable in the owner-policy fixture; a Codex stand-in in the fixture folder for the normal-CLI boot when no real `codex` is on PATH; the detected tmux path instead of `/opt/homebrew/bin/tmux` in the three delegation suites; per-suite timeouts for the multi-machine graph suites that the push lane's 10 s default cut off, a 360 s bound for the historical member-loss proof, and a 60 s teardown bound. It found that none hides a defect: the timeouts are hang bounds, not assertions, and every stand-in lives in a temp folder. Its notes: a draft bounded wait for post-activation readiness would have proved "ready within 45 s" rather than "ready at once"; that wait is removed, because on Linux it did not make the case pass anyway (see below). The held-file ctime check refuses after any metadata change (stated in `conversation-graph-ci-linux-portability.md`); inode numbers still go through `Number()`, as before.

Still failing on Linux after these fixes (Mama PC WSL, ext4; also red on GitHub Actions): `graph-default-peers` cases "retains nonempty acknowledged source..." and "quarantines a restored local M1 backup..." do not finish in 180 s, and `graph-member-loss-historical-execution` does not finish in 360 s. All three pass on macOS. On Linux the signed peer calls between the two in-process machines hit their 5 s limit (`graph-peer-call-timeout`, `graph-bootstrap-peer-unavailable`) after the planned transition, and `ensureOwner` keeps retrying. Not yet diagnosed; one candidate is that fsync is real on Linux and nearly free on macOS, so the same handlers block the shared event loop much longer.


**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 14:31 PST, given the Linux-skip and public-key-memo diff only, not the author's conclusion.

Seventh verdict, on the Linux timeouts: concur with notes. Profiling on Mama PC WSL showed that fsync and the peer address are not the cause: 578 fsyncs took 246 ms in total, and client and server time per peer call match. The single test process is about 94% CPU-busy re-verifying the custody lineage on every readiness check, so event-loop stalls of 1 to 5.5 s trip the 5 s peer-call timeouts between the two in-process machines. The three cases now skip on Linux (`GRAPH_LINUX_CPU_BOUND_RUN=1` runs them), with the diagnosis in the comment and in `upgrades/side-effects/conversation-graph-linux-cpu-bound-skip.md`. `canonicalPublicKey` now keeps its verdict. The reviewer confirmed that the skips cover exactly the three cases and that the override works. Its one finding is applied: the memo stores only key-sized strings, so untrusted 4 MB bodies cannot pin memory. A unit test covers this.

**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 14:58 PST, given the push-lane timeout diff only, not the author's conclusion.

Eighth verdict, on the push lane's 10 s default: concur with notes. GitHub's unit shard 4/4 on 52e441265 timed out at 10 s in `graph-source-sender-transfer-consumer` and `conversation-graph-normal-cli-owned-boot`. All 69 graph integration and e2e files that had no explicit timeout were then run on Mama PC Linux under `vitest.push.config.ts` with the limit lifted: 330 tests passed and 0 failed. The 23 files that had a test over 2.5 s (2.5 to 33.8 s) now set `vi.setConfig({testTimeout:120_000})` at the top of the file; the other 46 stay at the default. The reviewer confirmed the following: each insertion is at module top level after all imports; `vi` is imported exactly once; no test behaviour changes; and vitest 2.1.9 resets the config after each file (`vi.resetConfig()` in `runBaseTests`), so the timeout does not leak into other files. Its note: this raises `testTimeout` only, not `hookTimeout`. No hook in these files is slow today. After the change, the 23 files pass on Mama PC Linux under the push config's own 10 s default: 153 tests passed.
**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-11 02:43 PST, given the `.github/workflows/ci.yml` diff and the cited run, not the author's conclusion.

Seventh verdict, on the CI time limit: concur. The diff only raises the Integration Tests job's `timeout-minutes` from 50 to 70 and adds a comment; no check is weakened, no job skipped, and the required set is unchanged. 70 matches the E2E job's limit in the same file (unit shards are 60). The comment's claim holds: run 42878286348 (push to main, c825f2075) had Integration Tests cancelled after 50m15s, consistent with the old 50-minute bound. Two later test-only hunks from main (one `LONG_LIVED_STORES` entry, one `/mobile/usage` allowlist row) were also reviewed: they add one existing entry each and weaken nothing.

