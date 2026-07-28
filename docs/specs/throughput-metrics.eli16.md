# Worker blocker lifecycle, in plain English

## What changes

Workers already update a durable commitment when work becomes blocked. They call the guarded transition for the exact commitment they are working on and declare whether it is waiting on an external dependency, user input, or authorization. This v1 treats that existing explicit transition as the beacon. It does not add a Stop hook, guess a commitment from a chat session, or ask a new focus registry to choose one.

The current tracker hides file-write failures, so v1 first repairs that foundation: the store replacement reports whether its authoritative rename completed. A failure before rename rolls memory back and returns a typed failure instead of reporting success. When the named commitment moves from unblocked to blocked, its acknowledged record starts one blocker episode. When it moves back to unblocked—or reaches any terminal state—the same authoritative record closes that episode once. Closed episodes remain in a bounded history until their clear row is confirmed, so reopening cannot erase telemetry awaiting reconciliation.

## Three measurements

The first measurement is `request-to-persist`: monotonic server time from accepting the worker's transition request to the acknowledged authoritative rename. It is honestly best-effort: a crash in the tiny gap after rename but before SQLite can lose that sample, and coverage shows the loss rather than reconstructing a fake duration. The second is `clear-latency`: how long the acknowledged blocker episode remained open. Callers cannot provide either timestamp.

The third measurement is `deliverable-completion`: one tally for each commitment whose durable state is delivered. It reuses the same ledger and reconciles missed delivered events after restart without double-counting. Its trend compares only complete zero-count UTC days in the older and newer halves to say climbing, flat, declining, or insufficient data. Additive live fields also show today's unfinished tally and the cumulative total, so a delivery is visible immediately without letting a partial day distort the direction.

The summary and trend deliberately answer different time questions. Summary defaults to a rolling 24 hours; trend defaults to a rolling seven days and renders complete UTC-day buckets plus the partial current day. Each deliverable-completion result labels that window beside its count, so independently selected scopes cannot masquerade as contradictory measurements.

The API returns raw per-factor timing or count data, sample coverage, missing/excluded counts, and per-factor trends. Its response schema is version 2; old schema-v1 peers are shown as unsupported rather than zero. It does not create a combined score, productivity rank, worker comparison, or throughput index. Parallelism utilization, rework rate, and any combined index remain tracked follow-ons.

## Failure behavior

The commitment transition remains authoritative. SQLite metrics are written only after persistence, and a database failure never blocks or rolls back the worker's state change. A bounded reconciliation pass repairs clear rows; request latency remains best-effort because its exact monotonic completion duration cannot be written inside the file replacement it measures. Reconciliation has exponential backoff, a breaker, and deduplicated logs, so permanent database failure cannot create an unbounded retry storm.

Large commitment stores are scanned in groups of 64. During startup or recovery, the service now yields to the event loop and promptly continues with the next group until the whole store has been checked; it waits five minutes only after a complete sweep. This keeps each turn bounded while preventing a recent delivery near the end of a mature store from remaining invisible for five minutes per group.

Legacy blocked records without a trustworthy start time remain missing instead of receiving an invented good value. Negative or implausibly long wall-clock spans are excluded. Commitment mutations always route back to the record's origin machine; peer copies are read-only, so replicas cannot reopen or conflict with the authoritative episode.

## Multi-machine and rollout

Episodes replicate through the existing commitment path. Metric rows, reconciliation, and retry state stay with the origin machine whose disk they measure. A bounded authenticated pool read lists each origin's raw summary without computing a cross-origin score; missing machines make the result explicitly incomplete. This gives every machine one unified read surface without mistaking a partial number for fleet throughput.

The feature is measure-only, live through the development-agent gate and dark on the fleet. It sends no notice, takes no autonomous action, changes no governor or latch, and adds no dashboard control. Existing guard health shows telemetry degradation. Disabling the feature leaves additive episode fields and metric rows inert.

## What remains outside this increment

A focus-binding convenience is only a named follow-on if real wrong-id or ambiguous-id incidents justify it. Parallelism utilization, rework rate, and any combined throughput index wait for their named follow-ons. This schema-v2 surface intentionally exposes two blocker-latency measurements plus one honest delivered-completion count. All three remain descriptive signals with no authority to choose work, pressure a worker, notify, block, grade, or act.
