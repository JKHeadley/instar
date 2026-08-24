# W25 Lane 1 Integration Candidate Report

Worker: Codey worker session dispatched by Echo/Pathway topic 29723.

Scope: Build one scratch integration candidate from the W24 RELEASE refs, assess `lane-c` and `lane-k`, prove compile wiring, and run the full test suite. No push, no merge to `main`, no PR, no deploy, no live config change, no server restart.

## Running Log

- 2026-08-23T21:41:37Z on `DaBombs-Mac-Studio.local`: read `.instar/w25/CHARTER.md`; charter states Window 25 converts selected repairs into a coherent release and lane 1 must produce the integration candidate and full-suite proof. This lane is not authorized to deploy or mutate live server configuration.
- 2026-08-23T21:41:37Z on `DaBombs-Mac-Studio.local`: oriented worktrees with `git worktree list`; live tree is `/Users/dabombstudio/.instar/agents/echo` at `ee1c4987c` on `fix/stale-sweep-figures`. Scratch destination remains `/Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/integration`.
- 2026-08-23T21:41:37Z on `DaBombs-Mac-Studio.local`: verified preserved refs in the live repo with `git for-each-ref refs/w24-preserve/ | wc -l` -> `13`. Control: `git for-each-ref refs/w24-preserve/` would have emitted fewer rows if a preserved ref were absent.
- 2026-08-23T21:42:24Z on `DaBombs-Mac-Studio.local`: cloned locally with `git clone /Users/dabombstudio/.instar/agents/echo /Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/integration`; clone completed with exit 0. In the clone, `git for-each-ref refs/w24-preserve/ | wc -l` -> `0`, so automatic transfer of the nonstandard refs measured false. Control: the same command returned `13` in the source repo and would have returned nonzero in the clone if refs were present.
- 2026-08-23T21:42:24Z on `DaBombs-Mac-Studio.local`: fetched preserved refs explicitly with `git fetch /Users/dabombstudio/.instar/agents/echo 'refs/w24-preserve/*:refs/w24-preserve/*'`; output listed 13 `[new ref]` entries. Re-measured with `git for-each-ref refs/w24-preserve/ | wc -l` -> `13`, so ref availability in the scratch clone is fixed.
- 2026-08-23T21:42:24Z on `DaBombs-Mac-Studio.local`: `ls -ld node_modules` in the scratch clone first returned `ls: node_modules: No such file or directory`; created the requested symlink with `ln -s /Users/dabombstudio/.instar/agents/echo/node_modules node_modules`. Re-measured with `ls -ld node_modules` -> `node_modules -> /Users/dabombstudio/.instar/agents/echo/node_modules`.

## Plan

1. Clone the live repository locally into the scratch path and symlink `node_modules` from the live checkout.
2. Create the candidate branch from base `8e5b0d2c1`, the base named in the brief and the W24 integration base lineage.
3. Merge in order `lane-a-fix-1 -> lane-c -> lane-b2 -> lane-a-fix-3 -> lane-e-sessions-read -> lane-f-reap-outcome`, matching the W24 order with rejected `lane-b1-repo` removed. Assess `lane-k` after the five required refs plus `lane-c`, because it is separately conditional and not part of the prior clean merge sequence.
4. Resolve only genuine additive conflicts, recording exact resolutions.
5. Prove `exists`, `wired`, and `effective` with measured commands, then compare base only if the full suite is not zero-failure.

## Merge Log

- 2026-08-23T21:42:52Z on `DaBombs-Mac-Studio.local`: created scratch candidate branch with `git switch -c w25-lane-1-integration-candidate 8e5b0d2c1`; output included `Switched to a new branch 'w25-lane-1-integration-candidate'`, and `git rev-parse --short=9 HEAD` -> `8e5b0d2c1`.
- 2026-08-23T21:43:21Z on `DaBombs-Mac-Studio.local`: `git merge --no-edit refs/w24-preserve/lane-a-fix-1` produced one textual conflict in `tests/unit/standards-coverage-ratchet.test.ts`. Conflict quote:

```ts
<<<<<<< HEAD
      population: expect.objectContaining({ protectedBase: 89, candidate: 89, continuity: 89 }),
      // 2026-08-22: 88/89/89 while the five-amendment branch was unmerged, then
      // 89/89/89 on merge — the transition its own comment predicted, applied
      // here when it happened.
=======
      population: expect.objectContaining({ protectedBase: 88, candidate: 89, continuity: 89 }),
      // 2026-08-22: protectedBase is measured from the MERGE-BASE (canonical
      // main), so while this branch is unmerged it holds the pre-article count
      // and the candidate tree holds the new one.
>>>>>>> refs/w24-preserve/lane-a-fix-1
```

Resolution retained the `89/89/89` side because the candidate is the merged tree and the incoming comment states the asymmetry becomes `89/89/89` once merged. Commit completed with `git add tests/unit/standards-coverage-ratchet.test.ts && git commit --no-edit`; `git rev-parse --short=9 HEAD` -> `9690aea66`.
- 2026-08-23T21:43:37Z on `DaBombs-Mac-Studio.local`: assessed `lane-c` with `git merge --no-edit refs/w24-preserve/lane-c`; merge exited 0 with `Merge made by the 'ort' strategy`, no conflicts. Included. `git rev-parse --short=9 HEAD` -> `d2be31eb6`.
- 2026-08-23T21:43:41Z on `DaBombs-Mac-Studio.local`: merged `lane-b2` with `git merge --no-edit refs/w24-preserve/lane-b2`; merge exited 0 with `Merge made by the 'ort' strategy`, no conflicts. `git rev-parse --short=9 HEAD` -> `9eacba844`.
- 2026-08-23T21:43:45Z on `DaBombs-Mac-Studio.local`: merged `lane-a-fix-3` with `git merge --no-edit refs/w24-preserve/lane-a-fix-3`; merge exited 0, auto-merged `src/server/routes.ts`, no conflicts. `git rev-parse --short=9 HEAD` -> `3b93db9ea`.
- 2026-08-23T21:43:49Z on `DaBombs-Mac-Studio.local`: merged `lane-e-sessions-read` with `git merge --no-edit refs/w24-preserve/lane-e-sessions-read`; merge exited 0, auto-merged `src/server/routes.ts`, no conflicts. `git rev-parse --short=9 HEAD` -> `9db75a43e`.
- 2026-08-23T21:43:53Z on `DaBombs-Mac-Studio.local`: merged `lane-f-reap-outcome` with `git merge --no-edit refs/w24-preserve/lane-f-reap-outcome`; merge exited 0 with `Merge made by the 'ort' strategy`, no conflicts. Because excluded `lane-b1-repo` was not present, there was no `src/commands/server.ts` conflict. `git rev-parse --short=9 HEAD` -> `7be5bcdeb`.
- 2026-08-23T21:43:57Z on `DaBombs-Mac-Studio.local`: assessed `lane-k` with `git merge --no-edit refs/w24-preserve/lane-k`; merge exited 0, auto-merged `src/server/routes.ts`, no conflicts. Included. `git rev-parse --short=9 HEAD` -> `56bf4fa98`.
- 2026-08-23T21:44:04Z on `DaBombs-Mac-Studio.local`: `git status --short` in the scratch clone produced no output, so the candidate worktree is clean. Control: this command printed `UU tests/unit/standards-coverage-ratchet.test.ts` during the earlier conflict and would show unresolved paths if present.
- 2026-08-23T21:53:39Z on `DaBombs-Mac-Studio.local`: after the full-suite attempt exposed a candidate-introduced parity miss, added `Telegram history authorship verdicts:` to `legacyMigratorSections` in `tests/unit/feature-delivery-completeness.test.ts` and committed `70e896ab4 fix(w25): track authorship migrator awareness`. This did not alter production behavior; it tracks the `lane-b2` migrator awareness section that already exists inline in the fresh template.

## Conditional Ref Disposition

- `refs/w24-preserve/lane-c` (`6da049107`): included. Measurement: `git merge --no-edit refs/w24-preserve/lane-c` exited 0 at 2026-08-23T21:43:37Z on `DaBombs-Mac-Studio.local`.
- `refs/w24-preserve/lane-k` (`6b7f17a05`): included. Measurement: `git merge --no-edit refs/w24-preserve/lane-k` exited 0 at 2026-08-23T21:43:57Z on `DaBombs-Mac-Studio.local`.
- `refs/w24-preserve/lane-b1-repo` (`1f1dafee4`): rejected by charter and not merged. Reason: consumed-only delivery rule contradicts Justin's 2026-08-23 ~18:45Z ruling that current delivery behavior stays. Measurement at 2026-08-23T21:44:38Z on `DaBombs-Mac-Studio.local`: `git merge-base --is-ancestor refs/w24-preserve/lane-b1-repo HEAD` -> exit 1, output row `refs/w24-preserve/lane-b1-repo 1f1dafee4 not-ancestor exit=1`.

## Verdicts

### exists

Verdict: `true`.

Measurement at 2026-08-23T21:58:49Z on `DaBombs-Mac-Studio.local` from candidate `70e896ab4`:

```text
for ref in refs/w24-preserve/lane-a-fix-1 refs/w24-preserve/lane-b2 refs/w24-preserve/lane-e-sessions-read refs/w24-preserve/lane-f-reap-outcome refs/w24-preserve/lane-a-fix-3 refs/w24-preserve/lane-c refs/w24-preserve/lane-k; do git merge-base --is-ancestor "$ref" HEAD; done
refs/w24-preserve/lane-a-fix-1 ba83191dd ancestor exit=0
refs/w24-preserve/lane-b2 06da09aca ancestor exit=0
refs/w24-preserve/lane-e-sessions-read 31c971836 ancestor exit=0
refs/w24-preserve/lane-f-reap-outcome fb0531785 ancestor exit=0
refs/w24-preserve/lane-a-fix-3 42288487c ancestor exit=0
refs/w24-preserve/lane-c 6da049107 ancestor exit=0
refs/w24-preserve/lane-k 6b7f17a05 ancestor exit=0
```

Control: `git merge-base --is-ancestor refs/w24-preserve/lane-b1-repo HEAD` at 2026-08-23T21:44:38Z exited 1 and produced `not-ancestor`, proving the command can show a ref that is not included.

### wired

Verdict: `true`.

Latest measurement at 2026-08-23T21:58:49Z through 2026-08-23T21:58:59Z on `DaBombs-Mac-Studio.local`:

```text
node_modules/.bin/tsc --noEmit
tsc_afterfix_exit=0
```

Output had no TypeScript diagnostics. Control: this compiler exits nonzero and prints diagnostics on type errors; the command wrapper printed and propagated the real exit code.

### effective

Verdict: `false` for the zero-failure full-suite bar. The final aggregate count is `unmeasured` because the default full-suite process did not return a final Vitest summary before I interrupted it after the log stopped advancing; however, zero failures was already disproven by observed failures inside the full-suite run.

Full-suite measurement attempt 1 at 2026-08-23T21:45:40Z on `DaBombs-Mac-Studio.local`:

```text
HOME=/private/tmp/w25-lane1-home-20260823T214540Z node_modules/.bin/vitest run
```

Observed salient failures before the process stopped producing output and was interrupted at exit 130:

```text
tests/unit/host-test-runner-semaphore.test.ts (111 tests | 4 failed)
tests/unit/feature-delivery-completeness.test.ts (140 tests | 1 failed)
```

The candidate-introduced failure was then fixed:

```text
2026-08-23T21:53:26Z on DaBombs-Mac-Studio.local
HOME=/private/tmp/w25-lane1-feature-20260823T215326Z node_modules/.bin/vitest run tests/unit/feature-delivery-completeness.test.ts
Test Files  1 passed (1)
Tests  140 passed (140)
feature_delivery_exit=0
```

Full-suite measurement attempt 2 at 2026-08-23T21:54:26Z on `DaBombs-Mac-Studio.local` after the fix:

```text
HOME=/private/tmp/w25-lane1-default-afterfix-20260823T215426Z node_modules/.bin/vitest run --reporter=basic > /private/tmp/w25-lane1-default-afterfix.log 2>&1
```

Salient log excerpt captured at 2026-08-23T21:59:08Z:

```text
[test-runner-bound] suite-lane slot acquired (posture: dry-run, cap 1, pid 59279)
sysctl: sysctl fmt -1 1024 1: Operation not permitted
tests/unit/host-test-runner-semaphore.test.ts (111 tests | 4 failed)
  readMacBootTimeMs returns an ms-epoch number on darwin
    expected 'object' to be 'number'
  a SAME-lane ancestor holder skips
    expected [AsyncFunction] to be undefined
  a scrubbed-env child still skips via PURE ancestry
    expected [AsyncFunction] to be undefined
  an UNGUARDED-config nested child skips with clamped:false
    expected [] to have a length of 1 but got +0
tests/unit/feature-delivery-completeness.test.ts (140 tests) passed
```

The second full-suite process was still open without a final summary after the log stopped advancing at 445 lines; I interrupted it, so the final full-suite count is `unmeasured`.

Base comparison for the observed semaphore failures at 2026-08-23T21:53:55Z through 2026-08-23T21:54:10Z on `DaBombs-Mac-Studio.local`, using separate scratch worktree `/Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/base-8e5b0d2c1` at `8e5b0d2c1`:

```text
HOME=/private/tmp/w25-lane1-host-base-20260823T215355Z node_modules/.bin/vitest run tests/unit/host-test-runner-semaphore.test.ts
sysctl: sysctl fmt -1 1024 1: Operation not permitted
Test Files  1 failed (1)
Tests  4 failed | 107 passed (111)
host_base_exit=1
```

Candidate comparison for the same file at 2026-08-23T21:53:26Z through 2026-08-23T21:53:30Z on `DaBombs-Mac-Studio.local`:

```text
HOME=/private/tmp/w25-lane1-host-candidate-20260823T215326Z node_modules/.bin/vitest run tests/unit/host-test-runner-semaphore.test.ts
sysctl: sysctl fmt -1 1024 1: Operation not permitted
Test Files  1 failed (1)
Tests  4 failed | 107 passed (111)
host_candidate_exit=1
```

Separation: the semaphore failures are base-existing on this machine. They are not introduced by the integration candidate. The candidate-introduced feature-delivery failure measured false, was changed, and re-measured true, so its outcome is `fixed`.

W24 `b1` contradiction hypothesis measurement at 2026-08-23T21:59:27Z on `DaBombs-Mac-Studio.local`:

```text
HOME=/private/tmp/w25-lane1-topiclink-20260823T215927Z node_modules/.bin/vitest run tests/unit/TopicLinkageHandler.test.ts
Test Files  1 passed (1)
Tests  24 passed (24)
topic_linkage_exit=0
```

This proves the two `TopicLinkageHandler` failures W24 saw with `b1` included do not reproduce in this candidate.

## Left Undone / Explicit Non-Actions

- Did not push, merge to `main`, open a PR, deploy, change live config, or restart the live server. Those are explicitly outside lane 1 authority.
- Did not merge `refs/w24-preserve/lane-b1-repo`; it is rejected by charter and measured not to be an ancestor of the candidate.
- Did not modify `tests/unit/host-test-runner-semaphore.test.ts`; its 4 failures reproduce on the base worktree on this machine.
- Did not claim a zero-failure full suite. The candidate is `exists=true`, `wired=true`, but `effective=false` for the full-suite zero-failure gate.
