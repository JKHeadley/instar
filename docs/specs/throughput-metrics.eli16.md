# Worker blocker lifecycle, in plain English

## What changes

Workers already update a durable commitment when work becomes blocked. They call the guarded transition for the exact commitment they are working on and declare whether it is waiting on an external dependency, user input, or authorization. This v1 treats that existing explicit transition as the beacon. It does not add a Stop hook, guess a commitment from a chat session, or ask a new focus registry to choose one.

The current tracker hides file-write failures, so v1 first repairs that foundation: the store replacement reports whether its authoritative rename completed. A failure before rename rolls memory back and returns a typed failure instead of reporting success. When the named commitment moves from unblocked to blocked, its acknowledged record starts one blocker episode. When it moves back to unblocked—or reaches any terminal state—the same authoritative record closes that episode once. Closed episodes remain in a bounded history until their clear row is confirmed, so reopening cannot erase telemetry awaiting reconciliation.

## Exactly two measurements

The first measurement is `request-to-persist`: monotonic server time from accepting the worker's transition request to the acknowledged authoritative rename. It is honestly best-effort: a crash in the tiny gap after rename but before SQLite can lose that sample, and coverage shows the loss rather than reconstructing a fake duration. The second is `clear-latency`: how long the acknowledged blocker episode remained open. Callers cannot provide either timestamp.

The API returns only raw per-factor medians, p95s, sample coverage, missing/excluded counts, and per-factor trends. It does not create a combined score, productivity rank, worker comparison, or throughput index. Parallelism utilization, deliverable rate, rework rate, and any combined index need real producers from the separate throughput-floor runtime, so they remain one tracked post-floor increment.

## Failure behavior

The commitment transition remains authoritative. SQLite metrics are written only after persistence, and a database failure never blocks or rolls back the worker's state change. A bounded reconciliation pass repairs clear rows; request latency remains best-effort because its exact monotonic completion duration cannot be written inside the file replacement it measures. Reconciliation has exponential backoff, a breaker, and deduplicated logs, so permanent database failure cannot create an unbounded retry storm.

Legacy blocked records without a trustworthy start time remain missing instead of receiving an invented good value. Negative or implausibly long wall-clock spans are excluded. Commitment mutations always route back to the record's origin machine; peer copies are read-only, so replicas cannot reopen or conflict with the authoritative episode.

## Multi-machine and rollout

Episodes replicate through the existing commitment path. Metric rows, reconciliation, and retry state stay with the origin machine whose disk they measure. A bounded authenticated pool read lists each origin's raw summary without computing a cross-origin score; missing machines make the result explicitly incomplete. This gives every machine one unified read surface without mistaking a partial number for fleet throughput.

The feature is measure-only, live through the development-agent gate and dark on the fleet. It sends no notice, takes no autonomous action, changes no governor or latch, and adds no dashboard control. Existing guard health shows telemetry degradation. Disabling the feature leaves additive episode fields and metric rows inert.

## What is explicitly deferred

A focus-binding convenience is only a named follow-on if real wrong-id or ambiguous-id incidents justify it. The three floor-dependent factors and any combined throughput index wait for their named follow-ons. This v1 is intentionally only the existing explicit commitment-transition beacon plus two honest, floor-independent blocker-lifecycle measurements and their bounded per-origin read surface.
