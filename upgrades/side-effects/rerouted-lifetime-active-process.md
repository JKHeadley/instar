# Side-Effects Review — expired rerouted sessions release capacity

## Summary of the change

Tier 2 session lifecycle repair under the approved `docs/specs/june15-headless-spawn-reroute.md`. The configured hard lifetime is supposed to end a rerouted one-shot and record a timeout. On the operated host, `dashboard-console-default` passed its 480-minute limit while the session manager repeatedly printed “Killing”; durable `logs/reap-log.jsonl` instead recorded `skipped:active-process`, leaving the session running and the subscription lane at 6/6. This patch gives only the rerouted-session monitor a private capability to pass process-activity KEEP checks after it rechecks the saved lane and elapsed lifetime at the termination boundary. Other KEEP reasons still apply. The log now says “Killed” only after termination succeeds.

## Decision-point inventory

The existing decision is whether a rerouted interactive one-shot has passed its saved hard deadline. The monitor and termination boundary both check that fact. A new private capability affects only `active-process`, `main-process-active`, and `process-uninspectable` reasons; it cannot be supplied through the public `terminateSession` method. Normal sessions, unexpired reroutes, and other termination reasons use the previous guard path.

## 1. Over-block

An expired rerouted one-shot with an active tmux child was previously always retained, defeating the lifetime and leaving capacity occupied. A real `ReapGuard` unit test covers the active child and active main-process signals and now expects `killed/rerouted-lifetime`. The existing hard-lifetime test had no installed guard, which is why it missed the production failure.

## 2. Under-block

The patch intentionally allows an active process to be stopped at its explicit hard deadline. It does not bypass protected sessions, standing sessions, recovery, pending injection, relay lease, recent user interaction, open commitment, active subagent, or structural long work. A second real-guard test verifies a recent user message still blocks termination. The private symbol, literal reason, lane, completion mode, positive finite lifetime, valid start time, and elapsed-time check all must agree before the process-activity bypass applies.

## 3. Level-of-abstraction fit

The session manager already owns the hard-lifetime monitor and termination guard. The fix stays there, rather than changing the global ReapGuard or raising the host-wide session cap. It uses the same private termination entry point and durable session state as other lifecycle authorities.

## 4. Signal vs authority compliance

The printed “Killing” line was a misleading signal: it preceded the guarded termination result. The durable reap log showed the actual `skipped:active-process` decision. The patch moves the message after success and keeps the termination guard authoritative. The new capability is not inferred from a log; it is minted by the monitor and independently checked against the saved session and clock.

## 4b. Judgment-point check

No model or operator decision is replaced. The configured 480-minute limit is an existing deterministic policy. Timeout still produces the existing degradation report and job retry semantics only after termination succeeds.

## 5. Interactions

A rerouted one-shot that reaches its hard limit may be stopped even if its process tree is still active. That frees one subscription slot for queued work, including the feedback executor. The job scheduler sees `killed` and records a timeout. If another KEEP reason applies, the session stays running and `reapBlocked` remains durably logged; the timeout line no longer claims it was killed.

## 6. External surfaces

`GET /sessions` reflects the real terminal state after a successful kill. The reap log remains the audit surface for a skipped termination. No API shape, Telegram format, GitHub permission, or credential access changes.

## 6b. Operator-surface quality

The operator can distinguish a completed hard-timeout kill from a blocked attempt. This addresses the observed repeated false “Killing” message and the feedback executor’s unexplained 6/6 admission refusal.

## 7. Multi-machine posture

A rerouted tmux session is machine-local. The existing lease-holder and local session state checks still run before termination. The private capability cannot be sent over the API or another machine. A peer observing the session after owner transfer remains subject to the same lease gate.

## 8. Rollback cost

Revert this small source and test change in a patch release. No stored schema, config, or migration changes. A session already killed at its hard deadline cannot be resumed automatically, which is the pre-existing specified timeout consequence.

## Conclusion

The live 6/6 cap is caused by a hard-lifetime attempt blocked by `active-process`; it is not a phantom counter. Focused real-guard unit tests (49 in file), build, and lint are the current local evidence. Full three-tier verification and CI remain required before shipping.

## Second-pass review

**Reviewer:** rerouted_lifetime_review

Concur with the review. The module-private capability is accepted only for the literal timeout reason, saved rerouted lane and pattern mode, a finite positive limit, and an elapsed deadline. It bypasses three process-activity reasons; lease ownership and the other ReapGuard protections still apply. The real-guard expiry test fails on the old code, and the recent-message test checks a surviving higher-priority veto. The reviewer did not edit files or run broad tests.
