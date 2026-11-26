# Side-Effects Review — bounded feedback test timeout

**Version / slug:** feedback-confined-timeout  
**Date:** 2026-11-03  
**Author:** Echo  
**Second-pass reviewer:** feedback_gate_review (concurred)

## Summary of the change

The feedback executor's confined command runner now returns a timeout or output-limit failure even when a descendant retains its output pipe. It kills the original POSIX process group, destroys its local pipes, and settles without waiting for Node's `close` event. `vitest related` gets 45 minutes; other gates remain at 20 minutes. The approved execution spec records the exception. Native Windows remains unsupported by the runner. This changes the executor's resource-bound decision, not review or merge policy.

## Decision-point inventory

- `runCapped` timeout and output cap — modified — settle with a failure at the fixed limit.
- `FeedbackExecutorService` related gate budget — modified — use 45 minutes only for this gate.
- `SandboxRuntimeRunner` platform support — modified — refuse direct `run()` on unsupported platforms, matching `available()`.

## 1. Over-block

A legitimate related test that needs more than 45 minutes still fails. That is an intentional resource ceiling inside the six-hour attempt lease. Native Windows is refused, matching the preexisting availability refusal; there is no new supported Windows execution path to block.

## 2. Under-block

A descendant that starts a new process group can continue running after the timeout result. The sandbox's filesystem and network policy still constrain it, but process-group SIGKILL cannot terminate that escaped group. The result itself is bounded. This residual needs a separate process-containment design if escaped children are observed to persist.

## 3. Level-of-abstraction fit

The runner owns process lifetime and pipe closure; the executor owns per-gate time budgets. A reviewer cannot repair a stuck low-level Promise. The change keeps the existing failed-at-limit result flowing into the executor's attempt state machine.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). This is deterministic resource-limit enforcement, not a judgment about feedback content or agent intent. The runner reports `timedOut` or `outputCapped` to the existing executor authority; it does not make a new semantic block/allow decision. The platform refusal is a safety invariant for unavailable containment.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The wall-clock budget is an explicit invariant recorded in the approved execution spec.

## 5. Interactions

- **Shadowing:** The 45-minute related budget replaces the generic 20-minute budget only at the related-test call; base, head, lint, canary, and dependency calls retain the generic budget.
- **Double-fire:** A timeout and `close` can race. The `settled` flag allows only one result; the timer is cleared when settled.
- **Races:** A detached descendant may outlive clone cleanup. It remains inside the sandbox policy, but its process lifetime is not guaranteed by this patch. The executor records the limit failure without waiting on it.
- **Feedback loops:** No new retry or auto-merge trigger is added. A failed attempt remains subject to existing caps and review policy.

## 6. External surfaces

An executor attempt that previously remained stuck in `verifying` now records a limit failure. A related test may consume up to 45 minutes. Feedback API result shapes and Telegram message formats do not change. No operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: a confined command and its process group exist on the machine that owns the attempt. The attempt's state is recorded by the existing feedback executor on the drain owner. This change emits no user-facing notices, holds no new durable state, and generates no URLs. Topic transfer does not affect the local timeout result.

## 8. Rollback cost

Revert the code and spec amendment, then ship a patch. No data migration or agent state repair is needed. Rollback restores the 20-minute related limit and the known risk of a stuck `verifying` attempt when a descendant holds output pipes.

## Conclusion

The reviewer identified two gaps in the first draft: detached pipe holders could still stall completion, and the 45-minute exception conflicted with the spec. Both are corrected. The reviewer concurred with the revised bounded-result fix. The escaped-descendant lifetime risk is explicit above and does not negate the bounded-result claim.

## Second-pass review

**Reviewer:** feedback_gate_review  
**Independent read of the artifact:** concur

The reviewer found no remaining blocker for bounded timeout completion and confirmed the escaped-descendant residual is documented.

## Evidence pointers

- Live attempt `feedback-e800bf35-6381-46e7-a769-1530c55ac7ac:a6` failed `limit:command-wall-clock` after its old runner required manual descendant termination.
- Unit regression covers ordinary and detached descendants retaining stdout. Focused runner/executor tests: 154 passed.
- Integration route tests: 9 passed. E2E executor lifecycle tests: 2 passed. Build and lint passed. Full three-stage suite is running.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. The timeout's `killTree` is a one-shot response to a single confined command crossing its fixed limit, not a self-triggered loop or retry controller. Negative declaration: `defectClass: unbounded-self-action`, `closure: n/a`, reason: one-shot per-command resource enforcement, with no action scheduled by the result itself.
