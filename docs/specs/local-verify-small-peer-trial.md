---
title: "Memory-bounded pull request verification on a small peer"
slug: local-verify-small-peer-trial
parent-spec: local-verify-capacity
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
ships-staged: true
status: approved
approved: true
approved-by: "Chief of Staff, November 24, 2026 at 10:20:43 PST, including all three changes raised by the final review."
review-convergence: "Six external review rounds ended at the cap with three open safety corrections. Chief approved the corrected design. See the review report for evidence and limitations."
review-iterations: 6
review-report: docs/specs/local-verify-small-peer-trial.review.md
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# Memory-bounded pull request verification on a small peer

The coordinator and peer must both opt in for a single peer identified by machine ID. The default is off. A request may use the size exception only for an ordinary pull request. Apply the existing trust, lease, signing, main-health, capacity and load rules. Leave the machine-wide heavy-job policy in force. A trial request must bind its limits into the signed request digest. Older peers that cannot affirm the limits are ineligible.

The peer must enforce one active verifier process group and require two unit workers, one integration shard and one lifecycle shard. Before accepting the request the peer reads the local memory counters. Missing data, OS pressure or available memory at or below the configured floor refuses admission. A watchdog owned by the peer samples throughout checkout, install and test execution. If memory crosses the floor or telemetry becomes unavailable, stop the whole run through the normal cancellation path. Record a capacity refusal and requeue on the coordinator. Never publish test success or failure from an aborted run. Release the slot only after all child processes have exited.

Record every sample time, minimum available memory, peak RSS across all living processes owned by the attempt and elapsed time with the exact request identity. Peak RSS is the largest observed sum across all living processes owned by the attempt, including workers in another process group. Report the sampling interval. Keep the floor unset until measurements establish it. Disable the setting to stop new trial dispatches and cancel any active trial safely. Report the first three attempts including capacity aborts.

Acceptance covers coordinator and peer disagreement, main versus PR, malformed settings, mismatched worker counts, missing telemetry, the exact floor boundary, cooldown after an abort, late results after cancellation, and disable during a running gate. Verify through the HTTP peer protocol and production construction with controlled measurements before first activation.

## Multi-machine posture

machine-local-justification: hardware-bound-resource

The peer measures RAM physically available on its own host and enforces the cutoff even when the coordinator becomes unreachable. The coordinator owns queue admission and retry. Trial measurements travel back bound to the existing attempt identity. The coordinator retains the final attempt receipt.

## Decision points touched

- Ordinary PR versus main — invariant; basis: enumerable-domain; evidence: the signed protocol has distinct main and PR request kinds, and the approved exception covers only PRs.
- Whether to admit a trial — invariant; basis: external-constraint; evidence: the operator authorized one reduced-worker PR only while the host has measured safe headroom.
- Selecting the memory floor — judgment-candidate. The operator-approved trial requires measurements. Available-memory counters, pressure events, swap changes and peak memory across all living processes owned by the attempt inform the trial owner. If the owner cannot establish a defensible floor from these observations, the setting stays off.
- Crossing the floor — invariant; basis: external-constraint; evidence: the trial explicitly requires immediate backoff. Cancel on the first observed crossing and include detection and teardown latency in the receipt.

## Frontloaded Decisions

A released binary defaults to ordinary placement. The existing reduced worker settings are fixed by the approved trial. An omitted, invalid or conflicting setting leaves the exception disabled. Exact memory readings and elapsed time belong to the run record. Only the trial owner activates it, after a measured floor exists.

## Runtime contract and measurement

Admission and ongoing execution use the same stop predicate. Stop if available memory is less than or equal to the configured floor, OS pressure is warning or critical, the native pressure status is unknown, or measurement is missing or stale. During a trial, sample every second with an independent two-second deadline from the last good sample. Refuse startup if this cadence cannot be met. The floor calibration includes measured worst-case allocation growth over this blind window plus the observed cleanup time. Preserve the timestamps of the last good sample, first low sample when one exists, expired sampling deadline for a telemetry timeout, cancellation reason and signal and last process exit. Bound the crossing time by the two observations rather than claiming an exact detection latency.

The coordinator cancels an outstanding trial on disable. If connectivity is lost the peer must stop upon expiry of a bounded renewable trial lease. Use a monotonic clock at the peer and a ten-second lease refreshed every three seconds. A peer-side disable stops on the next sample independently. Trial peers must prove they can bound the lifetime and RSS of the entire supported test process tree, including workers that call setsid. The production lifecycle fixture must include such a worker and demonstrate that cleanup waits until it exits. If the host cannot establish ownership through child reparenting, fully detached workers disqualify the host from activation. Calibrate process counts, sampling overhead and cleanup times on the physical Mini before enabling the trial.

The initial worker configuration is the operator's explicit instruction to use the Mini's current reduced settings, recorded in Chief's handoff b7f31f28-e805-4d3f-b762-869b0c9dc469 and in the November 23 capacity plan. Reconfiguration requires new measurements. The one-second, two-second and lease timings are initial test parameters that must be validated with controlled injected pressure, slow sampling and a severed connection.

## Calibration and receipt recovery

Choose the floor in bytes as the required host reserve plus the measured maximum drop in available memory from the last healthy sample through the last worker exit, plus a documented measurement margin. Record the reserve and margin with their calibration evidence. A fixture must keep allocating after cancellation; exercise a detached worker with a known resident allocation across several samples, assert its RSS is included and verify its exit before releasing the slot. If no evidence supports the reserve, worst-case drop or margin, activation is refused.

A terminal trial receipt stays durable on the peer across disconnection and restart until the coordinator acknowledges its attempt ID and digest. The coordinator imports it exactly once, and refuses to attach it to a replacement attempt. Test cancellation on partition, durable peer restart and eventual reconnect, followed by a completed retry. An aborted attempt can publish only a capacity outcome.

## Restart, cleanup and retry

Persist the immutable attempt ownership record before creating the runner. On supervisor startup, reconcile any running or stopping trial and its durable execution scope before advertising a slot. Verify termination of all owned identities across group changes and reparenting. Keep admission closed while ownership is uncertain and retain one terminal receipt per attempt. The lifecycle fixture kills the supervisor while a double-forked worker holds a known allocation, then verifies identity recovery, memory accounting, complete termination, durable receipt and eventual slot release. Launchd job ownership is a candidate mechanism. A PGID signal or a successful pipe close alone is insufficient evidence.

Compute the calibration drop as the last healthy available-memory reading minus the lowest reading through final process exit; capture intervening dips with higher-frequency calibration samples and include sampling uncertainty in the margin. Test a fixture that frees its allocation before exit. Record the start and expiry of a telemetry timeout without claiming a floor crossing.

After a capacity abort the coordinator may immediately send that PR to another eligible machine. Keep the Mini ineligible for new trial attempts until it completes a fresh stable headroom window, with no pressure signal or missing readings. Set that window from the observed time from cancellation to a sustained healthy state during the calibration fixture. Apply the same recovery rule after process restart. Test admission at both ends of the window and when a fresh low sample resets it.

All routes into a reduced-size peer, including direct HTTP and main arbitration from startArbitration, must pass the peer's own capacity checks. Refuse a missing trial marker wherever ordinary local heavy fit excludes the machine. After async eligibility and diagnosis calls, resample just before reserving the slot. Freeze the reduced worker configuration into the attempt input at that point and refuse if either worker settings or trial policy changed during the await.

Use a separately supervised watchdog outside the trial's dedicated launchd job. It measures the job's unique Darwin resource coalition, persists its identity with the host boot identity and attempt ID before allowing the runner to start, and continues to enforce both deadlines if the verifier server dies. In calibration, hold the server down past lease expiry and observe worker termination externally. At cancellation send TERM, allow one sample interval (one second), then send KILL to verified remaining trial identities. Continue checking for scope members before releasing the slot. An identity or measurement failure quarantines the trial, and its receipt records the failure. Validate against a worker that ignores TERM while allocating through the grace period.

Calibration defines sustained recovery as three consecutive healthy samples spaced one second apart above the admission floor. End the measured cooldown at the last of those three, and reset on any missing or unhealthy sample. Treat these timings as calibration parameters that must pass the controlled fixtures to activate. Ordinary verification never uses the trial watchdog.

The November 24 physical fixture showed the Mini's detached, reparented worker retained both coalition IDs, read independently from the parent. A dedicated-job fixture still must establish that no unrelated process shares the attempt's resource coalition. An unsupported OS interface disqualifies the host. Apple documents the kernel data structure in the XNU process information header: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h.

## Failure envelope

Available host memory is an empirical trial target. A one-second sampler cannot guarantee host isolation against instantaneous memory demand by another application. Document calibration rates and the total allocation during the worst measured blind and teardown interval. Include a bounded synthetic fast allocator and representative observed PR preparation and worker bursts when available. If the host reserve is breached, terminate as soon as observed, disable the local trial durably, retain the trace and require recalibration before reactivation. No fallback may claim host memory isolation. A sudden OS-wide stall can delay every userspace process; include that uncertainty in the calibration record and quarantine after an uncovered breach.

The verifier server independently checks the watchdog's progress by monotonic heartbeat and stops the dedicated scope at the two-second sample deadline if the watchdog stalls. The watchdog independently stops the scope on loss of its server lease. Both use durable attempt identity. Calibrate supervisor failure and watchdog suspension separately with a continuing allocator, observing elapsed time to the last exit from outside the scope. A synchronous loss of both processes is a recovery case on service restart. The combined-failure exposure must be reported as an empirical limitation before activation.

Renewals use a single-use peer nonce tied to the immutable attempt and peer-issued monotonic expiry. The reply proves current coordinator custody and binds that nonce; it cannot extend the deadline beyond ten seconds from issuance. Duplicates have no effect and expiry is terminal. Exercise delayed, replayed and post-expiration renewal. Only the local disabling of the peer setting takes effect at the next sample; remote disable under a partition is bounded by the last valid lease.

At 09:50 PST a disposable launchd job on the physical Mini produced a resource coalition distinct from its launcher. A worker that double-forked retained the job's coalition after reparenting to launchd. Both processes exited and the disposable job was booted out.

## Approved sixth-round corrections

Implement each heartbeat with the monotonic timestamp and sequence number of the last *completed valid sample*. A fresh heartbeat with stalled sample progress must cancel at the original sample deadline. Before releasing a slot, disable further launches, boot out the job, verify that the launchd label is absent and then verify zero live coalition members. Exercise a pending relaunch and require the slot to stay occupied until both checks succeed.

Use available bytes = vm_stat page size in bytes × (Pages free + Pages inactive + Pages purgeable). Reject missing, negative, unreliable or stale counters. Use the native kern.memorystatus_vm_pressure_level reading of 1 as normal; unsupported or other values deny the trial. Collect calibration and production samples through the same implementation, identify that implementation in the receipt, and invalidate calibration when definitions change. Verify redelivery after an acknowledgement is dropped following a committed receipt. Expect one receipt, one retry decision and an acknowledgement on redelivery.

The six-round design review cap was reached with findings concerning memory protection and cleanup. Chief approved all three corrections at 10:20:43 PST on November 24. Activation follows verification and release.
