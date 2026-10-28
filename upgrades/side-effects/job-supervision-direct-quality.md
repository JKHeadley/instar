# Side-Effects Review — direct job-supervision call quality

**Version / slug:** `job-supervision-direct-quality`  
**Date:** 2026-10-28  
**Author:** Echo  
**Second-pass reviewer:** grade_receipt_review (concurred after fixes to call-level grades, decision-point reporting, and peer validation)

## Summary

The existing `/decision-quality` read route adds a separate section built from
the job-supervision SQLite journal and the job-run history census. It exposes
bounded, content-free call rows for direct Jev and replacement calls, aggregate
cost/quality buckets, and explicit coverage gaps. It never writes a grade or
changes scheduler decisions. The result-triage code gate remains false.

## Decision-point inventory

- The route's dev-gated availability is unchanged.
- A read decides whether the job journal is available. Failure returns
  `available:false` and `coverageIncomplete:true` in the direct section while
  preserving the router meter.
- A pool read accepts only a fixed scalar allowlist from peers. Older peers
  without the section appear in `directJobSupervisionMissing`.
- No model admission, call routing, routine closure, or grade-writing decision
  changes in this increment.

## Over-block

A temporarily unavailable scheduler makes the direct section unavailable,
while the existing quality route still answers. This is a conservative audit
signal, not a scheduler block. An overlarge result window suppresses accuracy
and marks coverage incomplete; callers can narrow `sinceHours`.

## Under-block

The direct section does not itself enforce that every model call reaches the
journal. The code-owned Jev gate remains off until the independent production
grader and missing/late-call reconciliation are complete. A journal census
gap is shown as incomplete, and unknown grades never enter the accuracy
numerator. The section cannot be used as proof that the production rollout is
ready.

## 3. Level-of-abstraction fit

This is a read projection over the existing durable job-supervision store. It
does not create a second call recorder or pretend that direct TypeSafe calls
were settled by IntelligenceRouter. The router meter remains the authority for
router-enrolled points; this section reports a different source with its own
coverage state. The query uses job-run history as an independent denominator.

## 4. Signal vs authority compliance

Per [signal vs authority](../../docs/signal-vs-authority.md), this change only
produces audit signals. It cannot block, close, route, or retry a job. Structural
validation of untrusted peer fields is an API boundary invariant, and a bad
peer is marked missing in a read response rather than authorizing a decision.
There is no new static heuristic at a competing-signals judgment point.

## 5. Interactions

The new section is added after the existing dev-gated router quality view is
built. A missing scheduler does not shadow the router view: the direct section
reports unavailable while the route remains 200. Pool requests use the
existing authenticated peer fanout; old peers remain visible in a missing
list. The query performs no reconciliation write, so it cannot race or
double-fire the scheduler's recovery path. Reads may observe a call between
pre-call insertion and settlement; that row is intentionally unknown.

## 6. External surfaces

Agents and users with the existing authenticated route can see the new fields.
No new external service is contacted. The generated agent instructions and
existing-agent migration explain that the section is an audit view and that
Jev decisions remain off. It emits no user notice by itself.

## 7. Multi-machine posture

Audit writes are machine-local by design because each scheduler owns its own
call journal. Pool reads proxy to peers and tag each peer's aggregate by
machine ID. An unavailable, old, or malformed peer makes pool coverage
incomplete. No durable state is tied to a Telegram topic, no URL is generated,
and no one-voice notice is needed.

## 8. Rollback cost

Revert the read projection and migration text in a patch release. The added
SQLite index is harmless if left behind; no data backfill or agent state
repair is required. During a rollback window, clients that read the new
section will see it missing and must treat coverage as unavailable.

## Operations and privacy

The route reads local SQLite and job-run history only. It does not send model
requests or new peer requests beyond the route's existing pool read. Local
detail is capped at 500 calls and excludes raw script output, receipt tokens,
and evidence text. Pool peers receive a narrower aggregate allowlist and no
individual call detail. The audit remains machine-local for writes.

## Migration and rollback

The generated agent instructions and the existing-agent migration share one
awareness section. No config migration is needed. Rolling back removes the
read-only section; the journal and scheduler behavior are unchanged.

## Evidence and remaining gate

Focused unit, authenticated integration, and production-shaped lifecycle
tests cover read wiring, missing-record denominators, independent outcome
links, and peer stripping. Full-suite and CI results must pass before merge.
The production grader, Jev benchmark threshold, pool authority, and guarded
rollout remain separate required increments.

## Class-Closure Declaration

This adds a read surface for existing durable records. It does not create a
self-triggering action or claim a defect class is closed.
