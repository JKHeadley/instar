# W25 Lane 4 - Integration-Introduced Failures

Worker: Codey worker session dispatched by Echo/Pathway, topic 29723.

Scope source: `.instar/w25/CHARTER.md`, read on DaBombs-Mac-Studio.local at 2026-08-23T23:05:59Z with `sed -n '1,220p' .instar/w25/CHARTER.md`. Salient charter constraint: Window 25 is CONVERSION; no push, PR, merge to main, deploy, live config change, or server restart.

Deliberately not doing: no push, no merge to `main`, no PR, no deploy, no live configuration change, no server restart, and no mutation of the existing integration candidate. The only live-tree write is this report artifact because the lane brief requires this exact path.

Scratch clone measurement: on DaBombs-Mac-Studio.local at 2026-08-23T23:06:26Z, command:

```bash
SCRATCH=/private/tmp/w25-lane4-integration-$(date +%s); git clone --no-local /Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/integration "$SCRATCH" && git -C "$SCRATCH" fetch /Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/integration 'refs/w24-preserve/*:refs/w24-preserve/*' && git -C "$SCRATCH" switch -c w25-lane4-bisect 8e5b0d2c1 && printf '%s\n' "$SCRATCH" > /private/tmp/w25-lane4-scratch-path && hostname && date -u +%Y-%m-%dT%H:%M:%SZ && git -C "$SCRATCH" rev-parse --short HEAD
```

Salient output: clone path `/private/tmp/w25-lane4-integration-1787526383`; fetched `refs/w24-preserve/lane-a-fix-1`, `lane-c`, `lane-b2`, `lane-a-fix-3`, `lane-e-sessions-read`, `lane-f-reap-outcome`, `lane-k`; branch `w25-lane4-bisect`; HEAD `8e5b0d2c1`.

Control: fetching explicit `refs/w24-preserve/*` could have failed or omitted refs; the output listed the refs used by the lane.

## Bisect Table

Literal merge rebuild control: on DaBombs-Mac-Studio.local at 2026-08-23T23:07:42Z, command `git -C "$SCRATCH" merge --no-edit refs/w24-preserve/lane-a-fix-1` from `8e5b0d2c1` failed before tests with conflict in `tests/unit/standards-coverage-ratchet.test.ts`. Because silently resolving branch disagreement is forbidden, I measured the exact first-parent merge-result commits already present in the integration candidate. Control: a direct merge could have produced a clean tree; it produced `CONFLICT (content)` instead.

First-parent merge-result states from candidate, measured with `git -C /Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/integration log --first-parent --reverse --oneline 8e5b0d2c1..70e896ab4` on DaBombs-Mac-Studio.local at 2026-08-23T23:08Z:

| Ref/state | Commit measured | Unit ratchet result | Crash-startup e2e result |
|---|---:|---|---|
| base control | `8e5b0d2c1` | true: 496 fallbacks, `Test Files 1 passed`, measured 2026-08-23T23:07:07Z | true: passed in 359ms, measured 2026-08-23T23:07:24Z |
| `lane-a-fix-1` | `9690aea66` | true: 496, exit 0, measured 2026-08-23T23:08:12Z | true: passed, 256ms, exit 0 |
| `lane-c` | `d2be31eb6` | true: 496, exit 0, measured 2026-08-23T23:08:25Z | true: passed, 254ms, exit 0 |
| `lane-b2` | `9eacba844` | true: 496, exit 0, measured 2026-08-23T23:08:38Z | true: passed, 255ms, exit 0 |
| `lane-a-fix-3` | `3b93db9ea` | false: 497, exit 1, measured 2026-08-23T23:08:51Z | true: passed, 252ms, exit 0 |
| `lane-e-sessions-read` | `9db75a43e` | false: 498, exit 1, measured 2026-08-23T23:09:03Z | true: passed, 252ms, exit 0 |
| `lane-f-reap-outcome` | `7be5bcdeb` | false: 498, exit 1, standalone remeasure 2026-08-23T23:13:46Z | false: `waitFor timed out after 5000ms`, exit 1, measured 2026-08-23T23:13:54Z |
| `lane-k` | `56bf4fa98` | false: 498, exit 1, measured 2026-08-23T23:14:14Z | false: exit 1, duration 8.15s |
| final candidate | `70e896ab4` | false: 498, exit 1, measured 2026-08-23T23:14:39Z | false: `waitFor timed out after 5000ms`, exit 1, measured 2026-08-23T23:14:45Z |

Verdicts: the unit ratchet has two introduction points: `lane-a-fix-3` introduced the first additional scanner match, and `lane-e-sessions-read` introduced the second. The e2e startup-crash failure is introduced by `lane-f-reap-outcome`.

Controls: base and the first three merge-result states pass both targeted tests, proving the checks could show `true`. Later states fail, proving the same commands could show `false`.

## Silent Fallback Diff

Measured on DaBombs-Mac-Studio.local at 2026-08-23T23:15:27Z by re-running the ratchet at `8e5b0d2c1` and `70e896ab4`, extracting the emitted fallback list, and diffing. Raw `file:line` diff is noisy because generated-route insertions shift the scanner's 20-line catch windows. The load-bearing additions by code are:

1. `src/server/routes.ts`, `resolveAgentFingerprint(ctx)`: existing `catch { /* fall through to project name */ }` became newly scanner-visible after `lane-a-fix-3` inserted `parseAttentionLimit()` and its `return undefined` inside the previous catch block's 20-line scan window. Measurement: `lane-a-fix-3` ratchet count 497 vs previous `lane-b2` count 496.
2. `src/monitoring/SessionsReadDiscrepancyProbe.ts`, `recordSessionsReadDiscrepancy()`: new `catch { return false; }` added by `lane-e-sessions-read`. Measurement: `lane-e-sessions-read` ratchet count 498 vs previous `lane-a-fix-3` count 497; source shown with `git show 9db75a43e:src/monitoring/SessionsReadDiscrepancyProbe.ts | nl -ba | sed -n '1,90p'` at lines 43-44.

Control: the ratchet could have listed these as already reported/exempted; it instead emitted `server/routes.ts:1894` and `monitoring/SessionsReadDiscrepancyProbe.ts:43` in the candidate failure list.

## Failure 2 Culprit

`lane-f-reap-outcome` introduced the crash-startup e2e failure. The causal code path is in `src/core/SessionManager.ts`: the lane added `remain-on-exit failed` so failed panes remain long enough to read `pane_dead_status`, and it taught `isSessionAliveAsync()` to interpret `#{pane_dead}`. The synchronous `isSessionAlive()` path used by `tests/e2e/session-management-e2e.test.ts` still queried only `#{pane_current_command}||#{pane_start_command}`, so a retained failed pane looked alive until the test timed out.

Measurement: on DaBombs-Mac-Studio.local at 2026-08-23T23:13:54Z, `HOME=/private/tmp/w25-lane4-home node_modules/.bin/vitest run tests/e2e/session-management-e2e.test.ts -t 'should handle sessions that crash during startup' --reporter verbose` at `7be5bcdeb` exited 1 with `waitFor timed out after 5000ms`. Control: the same command at `9db75a43e` passed in 252ms at 2026-08-23T23:09:03Z, so the command could have shown otherwise.

## Fix

Scratch branch: `/private/tmp/w25-lane4-integration-1787526383`, branch `w25-lane4-fix`, based on `70e896ab4`.

Changed:

- `src/server/routes.ts`: `resolveAgentFingerprint()` now reports a `DegradationReporter` event before falling back to project name.
- `src/monitoring/SessionsReadDiscrepancyProbe.ts`: failed discrepancy-log writes now report a `DegradationReporter` event before returning `false`.
- `src/core/SessionManager.ts`: sync `isSessionAlive()` now queries `#{pane_dead}||#{pane_dead_status}`, records the retained exit code, and returns `false` for dead retained panes, matching the async path.

Fixed measurements:

- true on DaBombs-Mac-Studio.local at 2026-08-23T23:20:13Z: `HOME=/private/tmp/w25-lane4-home NO_UPDATE_NOTIFIER=1 node_modules/.bin/vitest run tests/unit/no-silent-fallbacks.test.ts -t 'no new silent fallbacks beyond tracked baseline' --reporter basic` exited 0; salient output `SILENT FALLBACKS] 496`, `Test Files 1 passed`, `Tests 1 passed | 4 skipped`.
- true on DaBombs-Mac-Studio.local at 2026-08-23T23:20:13Z: `HOME=/private/tmp/w25-lane4-home NO_UPDATE_NOTIFIER=1 node_modules/.bin/vitest run tests/e2e/session-management-e2e.test.ts -t 'should handle sessions that crash during startup' --reporter basic` exited 0; salient output `Test Files 1 passed`, `Tests 1 passed | 32 skipped`, test time 282ms.
- true on DaBombs-Mac-Studio.local at 2026-08-23T23:20:13Z: `node_modules/.bin/tsc --noEmit` exited 0.

## Must-Fail Controls

Reverted only this lane's patch with `git apply -R /private/tmp/w25-lane4-fix.patch` at `70e896ab4`, then remeasured on DaBombs-Mac-Studio.local:

- Unit must-fail control, 2026-08-23T23:19:53Z: `HOME=/private/tmp/w25-lane4-home NO_UPDATE_NOTIFIER=1 node_modules/.bin/vitest run tests/unit/no-silent-fallbacks.test.ts -t 'no new silent fallbacks beyond tracked baseline' --reporter verbose` exited 1; salient output `SILENT FALLBACKS] 498` and `expected 498 to be less than or equal to 496`.
- E2E must-fail control, 2026-08-23T23:19:59Z: `HOME=/private/tmp/w25-lane4-home NO_UPDATE_NOTIFIER=1 node_modules/.bin/vitest run tests/e2e/session-management-e2e.test.ts -t 'should handle sessions that crash during startup' --reporter verbose` exited 1; salient output `waitFor timed out after 5000ms`.

Patch was reapplied successfully afterward (`git apply /private/tmp/w25-lane4-fix.patch`, `REAPPLIED_EXIT=0`), and the fixed measurements above re-proved true.

## Full Suite

Full suite verdict: false on this machine. Measured on DaBombs-Mac-Studio.local with command:

```bash
HOME=/private/tmp/w25-lane4-home-full NO_UPDATE_NOTIFIER=1 node_modules/.bin/vitest run > /private/tmp/w25-lane4-logs/full-suite-2.log 2>&1; code=$?; date -u +%Y-%m-%dT%H:%M:%SZ; grep -E 'Test Files|Tests |Duration' /private/tmp/w25-lane4-logs/full-suite-2.log | tail -10; echo EXIT=$code; exit $code
```

Started 2026-08-23T23:32:49Z, finished 2026-08-24T00:09:04Z. Salient output:

```text
Test Files  7 failed | 3156 passed | 4 skipped (3167)
Tests       20 failed | 49829 passed | 30 skipped | 3 todo (49882)
Duration    2173.78s
EXIT=1
```

Failed files:

- `tests/unit/duplicate-build-check.test.ts` - 5 failures
- `tests/unit/host-test-runner-semaphore.test.ts` - 4 failures
- `tests/unit/test-runner-run-classifier.test.ts` - 3 failures
- `tests/integration/test-runner-bound-meta.test.ts` - 5 failures
- `tests/integration/test-runner-limiter-route.test.ts` - 1 failure
- `tests/e2e/dev-preflight-cli.test.ts` - 1 failure
- `tests/e2e/duplicate-build-guard-incident.test.ts` - 1 failure

Control for causality: the exact seven failed files were rerun on the fixed branch and on base `8e5b0d2c1`.

- Fixed-branch subset, DaBombs-Mac-Studio.local, 2026-08-24T00:09:46Z to 2026-08-24T00:11:17Z: `HOME=/private/tmp/w25-lane4-home-failed-files NO_UPDATE_NOTIFIER=1 node_modules/.bin/vitest run <seven failed files>` produced `Test Files 7 failed (7)`, `Tests 20 failed | 215 passed (235)`, `EXIT=1`.
- Base subset, DaBombs-Mac-Studio.local, 2026-08-24T00:11:35Z to 2026-08-24T00:13:11Z: same command shape at `8e5b0d2c1` produced `Test Files 7 failed (7)`, `Tests 20 failed | 215 passed (235)`, `EXIT=1`.

Verdict on the full suite: false. Verdict on whether those 20 failures were introduced by this lane's fix: false, measured by the base subset control showing the same 20 failures before any W25 integration refs or this lane patch. The control could have shown otherwise by passing on base or producing a different failure count/list; it matched.

Observed environmental/scratch factors in the full-suite log: process/ancestry-related tests fail in this sandboxed worker environment; direct process listing from this session also failed (`ps`: operation not permitted; `pgrep`: cannot get process list). `dev-preflight-cli` also fails in this scratch clone with `fatal: Not a valid object name origin/main` / `main` and a parser-registration lint warning. I did not change live config, restart the server, push, open a PR, merge, or deploy to chase those non-lane failures.

Final scratch diff check: on DaBombs-Mac-Studio.local at 2026-08-24T00:13Z, `git diff --check && git diff --stat && git rev-parse --short HEAD && git branch --show-current` exited 0 and reported:

```text
src/core/SessionManager.ts                     | 10 ++++++++--
src/monitoring/SessionsReadDiscrepancyProbe.ts | 10 +++++++++-
src/server/routes.ts                           | 10 +++++++++-
3 files changed, 26 insertions(+), 4 deletions(-)
70e896ab4
w25-lane4-fix
```
