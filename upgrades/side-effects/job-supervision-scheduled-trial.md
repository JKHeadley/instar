# Side-Effects Review — Isolated scheduled-run trial

**Slug:** `job-supervision-scheduled-trial`  
**Date:** 2026-10-28  
**Author:** Echo  
**Second-pass reviewer:** not required

## Summary of the change

A standalone script under `scripts/` runs one synthetic job through the real scheduler in a nested workspace of an expiring throwaway agent. The runner requires OS-denied outbound networking, checks that the real agent remains unable to schedule jobs, and records the scheduled result and durable supervision attempt. It touches no production gate or installed agent file. Fresh `JKHeadley/instar` worktree, version 1.3.1499.

## Decision-point inventory

- Trial preconditions — added only to the standalone runner: expiring temp agent, no real scheduler override, OS egress denial, and exactly one synthetic job.
- Production rollout — passed through: the script result remains `unchecked:triage-dark` with the code-owned gates off.

## 1. Over-block

The runner refuses a legitimate trial without macOS sandboxing or an expiring temporary agent. This is intentional for this OS-specific isolation proof. Production jobs are unaffected.

## 2. Under-block

The network probe checks outbound TCP in both parent and child; it does not attest every possible OS-mediated communication channel. The private scheduler override would allow a second job if a future edit loaded one; the script asserts the loaded set is exactly one synthetic job before triggering. The run does not prove the server-owned worker path, certificate revocation, or provider race handling.

## 3. Level-of-abstraction fit

This is a test harness using the real scheduler and OS sandbox primitive. The existing code-owned rollout gates continue to own production admission. The runner does not add another production decision authority.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`, the preconditions are finite structural safety checks over this test process. They do not infer the meaning of a real result or block production work. The real worker remains the model judgment path when its separate gates eventually open.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. The trial has one synthetic expected result.

## 5. Interactions

- **Shadowing:** no production hook invokes the runner; it cannot shadow the live scheduler.
- **Double-fire:** the synthetic job has a far-future cron schedule and is manually triggered once in a unique nested workspace.
- **Races:** the actual agent's config and installed job definitions are untouched. Each trial run has a unique directory.
- **Feedback loops:** the runner writes only trial state and no user-facing notice.

## 6. External surfaces

The runner creates a child Node process under the inherited OS sandbox. It makes no external call and starts no session. Its durable state is local to an expiring temp agent. No production user, agent, or provider behavior changes. No operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: this is macOS-specific test evidence for one temporary agent. It emits no notice, carries no conversation state across machines, and generates no URL.

## 8. Rollback cost

Remove the test runner and report. Existing production state needs no migration; the temporary workspace expires with its agent.

## Conclusion

The trial proves isolated scheduled script execution and record-only supervision while model decisions remain off. It does not graduate the test cohort.

## Class-Closure Declaration

No prior artifact defect is fixed. The trial checks both sandboxed success and unsandboxed refusal, including a realistic fake credential-shaped output in durable storage.
