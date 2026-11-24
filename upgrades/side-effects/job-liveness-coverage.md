# Side-Effects Review — Independent local Jobs schedule observation

**Version / slug** `job-liveness-coverage`
**Date** 2026-11-23
**Author** Echo
**Second-pass reviewers** discovery and quick_review

## Summary of the change

Tier 2, with an additive authenticated Jobs field and production scheduler lifecycle instrumentation. The local-only observer uses the existing Croner schedule, monotonic health time and actual scheduled callback entry. The Jobs view separates dated observation from recorded activity and unverified peer evidence. The local slice is opt-in.

## Decision-point inventory

- The existing scheduler callback increments a registration memory counter at entry.
- The observer records due and sample times and invalidates evidence on continuity, generation, or freshness changes.
- The Jobs API verifies local evidence again at read and withholds unsigned peer coverage. Existing Jobs access rules apply.
- The Jobs view labels observation, recorded activity and inability to verify as separate facts.

## 1. Over-block

The observer does not gate execution. Missing identity or continuous samples can make an otherwise legitimate job’s schedule evidence unavailable. The local slice leaves lease-dependent coverage unavailable without consulting the lease provider. The view reports this without changing the job.

## 2. Under-block

A registration can count a callback without proving which particular occurrence it belongs to. The result reports unknown in that case. Direct run and skip history are outside this increment's observation. Remote evidence remains unavailable.

## 3. Level-of-abstraction fit

The registration owns callback evidence. The server-owned observer runs independently from jobs. The route checks freshness and existing scope, and the user interface renders the supplied evidence.

## 4. Signal vs authority compliance

Coverage is a read-only signal. The scheduler's existing placement and execution authority is unchanged. [Signal vs. Authority](../../docs/signal-vs-authority.md)

## 4b. Judgment-point check

Registration version, elapsed time and counter differences are deterministic evidence boundaries. The observer reports an unknown outcome when assignment to a specific due time is uncertain.

## 5. Interactions

Existing cron claims, queue, skipped work, history and retry code keep their existing paths. One synchronous bounded observation tick runs on the server's 30-second health cadence without ledger reads. Pause and immediate resume invalidate the generation. Read-time counter and generation checks retract old local evidence even on a cached pool response. Peer observations from that response cannot substitute for a local reading.

## 6. External surfaces

The authorized Jobs API and Schedule display gain bounded timestamps and controlled status codes. The observer makes no external calls, notifications or persistent writes. The test slice is explicitly opt-in.

## 6b. Operator-surface quality

Open Jobs and select a machine-specific job to see its coverage. The detail shows the current sample, earlier evidence and next observed schedule on separate lines. Existing run and pause controls remain the primary actions. The new content uses the existing wrapping detail layout, including on phones, and adds no approval or destructive controls.

## 7. Multi-machine posture

Machine-local by design. The callback counter and samples live only on the machine with the registration. The requested peer supplies no usable schedule coverage without machine-bound evidence. No user-facing notice or new durable state follows a conversation or lease transfer.

## 8. Rollback cost

Turn off the opt-in and restart the server or revert the increment. No state migration or repair is required.

## Conclusion

TypeScript, JavaScript syntax and the diff check passed. Twelve focused tests passed across the unit, HTTP and production lifecycle cases. They exercise a genuine Croner callback, immediate pause and resume, a delayed earlier callback, daylight-saving, independent row and observer freshness, recoverable observer failure on Jobs, timer teardown, callback suppression before entry, a hold after entry, unverifiable peer coverage on the pool cache path, and the shipped Jobs detail view with distinct current coverage, previous evidence, upcoming time and run activity. The adjacent Jobs console file passed 35 cases. Independent review concurred on scheduler containment, current versus historical evidence and the shipped Jobs rendering. A development cohort canary remains pending.

## Class-Closure Declaration

This increment is a read-only watcher. It does not create a self-triggered action or repair controller.
