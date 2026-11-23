# Side-Effects Review — Telegram send timing

**Version / slug:** telegram-send-timing
**Date:** 2026-11-23
**Author:** Instar Agent (echo)
**Second-pass reviewer:** telegram_timing_review; implementation concurrence received 2026-11-23.

## Summary of the change

Tier 1, SMALL, reversible diagnostics. A helper observes sendMessage at the existing egress network closure. It logs fixed start and headers/error records with elapsed time, event-loop histogram samples and overlapping process utilization. The source and tests are isolated from the running install. The governing parent is **Observability — you can't tune what you can't see**: measure actual transport behavior before changing it. No runtime deployment is part of this artifact.

## Decision-point inventory

Origin authorization, visibility checks, native deadlines and known-unsent versus unknown-outcome classification pass through unchanged. The method match selects diagnostics only. The sixteen-histogram cap limits observation resources, not sends. There is no new authority or delivery decision.

## 1. Over-block

No block/allow surface — over-block not applicable. Logging/probe failure must not reject a request.

## 2. Under-block

No block/allow surface — under-block not applicable. Measurements do not identify DNS, TLS, queueing or a specific synchronous caller. Headers do not prove a body or receipt arrived. Zero histogram samples do not prove responsiveness; event-loop utilization is process-wide overlap. No transport cause or recovery is claimed.

## 3. Level-of-abstraction fit

The existing network closure is where origin work is finished and the caller's per-request deadline starts. Measuring here separates transport from earlier admission work without parallel policy. Native perf_hooks supply observations; no heuristic decides a send's fate.

## 4. Signal vs authority compliance

Required reference: [signal vs authority](../../docs/signal-vs-authority.md). This change has no block/allow surface and adds signals only. Existing receipt and uncertainty authorities remain in control.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The numerical histogram cap is a resource bound and never a delivery verdict.

## 5. Interactions

Observations begin after visibility and origin pre-dispatch checks. Probe setup and start logging precede the unchanged deadline creation, which remains adjacent to fetch inside a synchronous callback. No response body is read or cloned by diagnostics. Each invocation has independent correlation and probe state; slots release before completion logging. No notifier, retry, cleanup or recovery controller consumes the logs automatically. Existing dispatcher fallback remains untouched.

## 6. External surfaces

The only changed surface is process-local console diagnostics. Records accept no request metadata, URL, body, destination or error object. There is no new API, setting, persistent queue or operator-facing action. Native histogram allocation and two diagnostic lines add small request overhead; concurrency is capped at sixteen histograms. No external request is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: event-loop behavior belongs to the sending process. Each event includes its PID and process-local id; neither is a pool-wide identity. There are no changed status/health/capability verdicts, durable state, generated URLs, or user-facing notices. No one-voice or cross-machine replication rule changes.

## 8. Rollback cost

Revert helper, wiring and awareness text in a normal patch. There is no data migration or agent state repair. Existing log records can remain as historical observations.

## Conclusion

Independent review found unguarded diagnostic clock reads, which are now guarded and tested for exact result/error preservation and slot release. It also requested the positive 15000ms deadline/composed-signal case and removal of a fragile utilization comparison; both changes are included. The reviewer concurs with the implementation. Allocated focused tests passed: 64 unit cases, 4 real-HTTP integration cases and 5 production-bootstrap lifecycle cases, with unchanged source/test hashes. Complete coordinator verification remains required. This is diagnostic instrumentation, not a fix for delayed sends.

## Second-pass review

**Reviewer:** telegram_timing_review
**Independent read of the artifact: concur.** The reviewer independently read all nine files and confirmed fixed-schema privacy, bounded probe cleanup, unchanged dispatch/retry/deadline/uncertainty behavior, real adapter/lifeline egress wiring, and the substantive production bootstrap test. Clock concerns were resolved before concurrence. The reviewer ran no tests and made no pass or deployment claim.

## Evidence pointers

Unit: tests/unit/telegram-send-timing.test.ts plus existing egress boundary/dispatcher tests, 64/64 passed. HTTP: tests/integration/telegram-send-timing-http.test.ts plus existing HTTP/1 regression cases, 4/4 passed. Lifecycle: tests/e2e/telegram-send-timing-alive.test.ts plus production-origin bootstrap regressions, 5/5 passed. All three allocated enforcing invocations exited zero. The HTTP tier waited normally for shared admission; no skipped execution or extra waiter is represented as a pass. Full coordinator verification and production evidence are not supplied by these focused results.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. The unbounded-self-action class is not applicable: this adds no self-triggered controller or autonomous retry/notify/restart action. Native histogram sampling produces no actions; each request emits at most two records and at most sixteen histograms are active. Existing transport and recovery limits are unchanged.
