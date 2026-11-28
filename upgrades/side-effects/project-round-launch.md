# Side-Effects Review — Project round launcher

**Version / slug:** project-round-launch
**Date:** 2026-11-24
**Author:** echo
**Second-pass reviewer:** independent launcher review

## Summary of the change

Tier 1 scoped bug fix. Project rounds use the existing conversation profile and SessionManager policy. The project's latest child result records the framework, model, actual exit code or signal, and a local diagnostic reference. The worktree retains the existing round loop and owner approval rules.

## Decision-point inventory

- Read the project conversation profile or the agent defaults.
- Use existing SessionManager billing, account placement, model compatibility and framework restrictions.
- Before starting the child, recheck the round's halt marker, membership and observed versions.
- Keep bounded scrubbed stderr on the runner and attach only the matching direct local read.

## 1. Over-block

Claude profiles whose policy requires an interactive session receive a start failure because the round requires a direct child. The prior invocation used an unsupported Claude option. The runner also refuses Grok inside the Instar source tree under the existing SessionManager policy.

## 2. Under-block

The diagnostic cannot recover output already discarded by an older executor. stderr may be empty even for a failed child. The latest complete capture is available on the runner; an incomplete capture carries a withheld indicator. A lost local file leaves the structured outcome readable.

## 3. Level-of-abstraction fit

The project runner owns a detached child, its stop conditions and merge verification. SessionManager supplies the launch. The authenticated project detail uses the existing project record.

## 4. Signal vs authority compliance

The new child result describes the process. It cannot change project approvals or satisfy the separate requirements for completing an item.

## 4b. Judgment-point check

There is no new authorization judgment. Routing follows the configured profile and existing launcher policy.

## 5. Interactions

Existing round locks, ownership checks, retry bounds and the git merge verifier remain. A real process fixture exercises the normal command, account and child exit paths.

## 6. External surfaces

The authenticated project detail adds child result data. Direct local reads can join stderr from a private file. Forwarded reads receive the structured result only.

## 6b. Operator-surface quality

The record distinguishes a process that did not start from one that started and exited. It names the selected framework/model and offers the existing project detail as the place to investigate.

## 7. Multi-machine posture

The structured result and its unique diagnostic reference use the existing project record. The local stderr is written with mode 0600 into the existing GitSync-excluded logs root. The diagnostic may carry local credential or path details, so it remains on the runner. The verifier neither stores nor forwards that text.

## 8. Rollback cost

The record fields are optional. The earlier software ignores them. A rollback removes projection of local diagnostics. No persistent setting, migration or launch authorization is added.

## Conclusion

Run the targeted unit, HTTP and scheduled lifecycle checks before handing the patch to release verification.

## Second-pass review

See the independent source inspection on the launcher-only worktree.

## Evidence pointers

- tests/unit/ProjectRoundExecution.test.ts
- tests/integration/projects-api.test.ts
- tests/e2e/project-round-executor-alive.test.ts

## Class-Closure Declaration

The unbounded-self-action class does not apply to the changed launch preparation and diagnostics. They belong to one invocation of an already-authorized round and create no new retry trigger. The existing child retry loop keeps its finite maxResumeAttempts cap, covered by the executor's nonzero-exit test.
