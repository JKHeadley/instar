# Side-effects review for saving ordinary worker identity

An ordinary worker's process ID, observed start time, and observation time are written against the same execution that owns the round and item fences. The write cannot overwrite evidence or attach it to a replacement execution. The additive database upgrade keeps existing holds. A quick exit or unavailable process probe can leave the start time unknown. A crash before the evidence write leaves the fence held.

The evidence is useful to future restart recovery but grants no authority to settle or signal a process by itself. Recovery still needs proof of process-group termination and must handle PID reuse or independently detached children. No production provider, configuration change, or automatic restart is added.

## Class-Closure Declaration

The worker identity write is a one-shot record of an already started worker. It schedules no work and does not add an unbounded-self-action or change the relaunch budget.

## Second-pass review

**Reviewer:** ordinary_worker_evidence_review, independent Instar second-pass agent

Concur. The additive upgrade preserves all holds, evidence binds only to the current execution, and any gap before the write leaves the hold intact.
