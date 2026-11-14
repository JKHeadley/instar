# Side-Effects Review — Isolated job supervision trial runner

**Slug:** `job-supervision-offline-trial`  
**Date:** 2026-10-28  
**Author:** Echo  
**Second-pass reviewer:** not required

## Summary of the change

A standalone script under `scripts/` runs five simulated supervision results against the real evidence projector, store, and worker in an expiring temporary agent. It refuses to run unless a loopback probe shows the process is denied outbound networking by the OS. A research report records evidence and limits. The change touches no production admission, routing, or rollout switch. Fresh worktree: `JKHeadley/instar`, package 1.3.1497.

## Decision-point inventory

- Trial preconditions — added to the standalone runner: temporary path, expiring throwaway record, scheduler prohibition, and OS network denial.
- Production result decisions — passed through the existing worker with simulated fetch and trial-only `auditReady`; no runtime gate change.

## 1. Over-block

The runner refuses a legitimate trial if macOS sandboxing is unavailable, a temporary agent lacks an expiring record, or the agent permits scheduled jobs. Those refusals are intentional for this isolation trial. Production work is unaffected.

## 2. Under-block

The probe proves outbound TCP is denied in this process; it does not prove every OS-mediated communication channel or that the separately booted server and worker share one launch boundary. Config checks do not prove no job definition can run if a future caller bypasses them. Thus this is partial test-agent evidence and the production cohort gate remains closed.

## 3. Level-of-abstraction fit

The runner is a reproducible test harness. It reuses the production projector, store, and worker, while the OS owns network isolation. Production rollout authority stays in the code-owned gates.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`, the runner checks explicit structural preconditions before creating trial records. These checks have authority over this optional trial only. They make no production block/allow decision or semantic judgment about real jobs.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals decision point. The five expected results are fixture assertions.

## 5. Interactions

- **Shadowing:** no production hook invokes this script; it cannot shadow a scheduler decision.
- **Double-fire:** simulated attempts use unique `offline:` identifiers and never execute a job.
- **Races:** each run has a unique local directory; it does not share an agent's production supervision ledger.
- **Feedback loops:** the script writes only local trial state; no operator-facing feedback loop is added.

## 6. External surfaces

There are no external network calls. The OS sandbox test denies outbound sockets; fake fetch returns local responses. Persistent trial state is local to the expiring temporary agent. No production user or agent sees a changed behavior. There is no new operator action.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: this is an OS-specific trial artifact tied to one temporary agent. It emits no user-facing notices, does not strand conversation state on topic transfer, and generates no URL.

## 8. Rollback cost

Remove the runner and report; the temporary trial directory can expire. No production state migration or hotfix is needed.

## Conclusion

The runner provides auditable, isolated mock-worker evidence while keeping the production model path dark. It does not satisfy the full test-agent-live, dev-shadow, or active rollout gates.

## Class-Closure Declaration

No pre-existing artifact defect is being repaired. The runner's unsandboxed refusal and sandboxed five-case result provide direct recurrence checks for this test harness.
