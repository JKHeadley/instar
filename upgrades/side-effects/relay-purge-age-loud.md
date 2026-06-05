# Side-Effects Review — Restore-purge: 60-min default + loud victim reporting

**Version / slug:** `relay-purge-age-loud`
**Date:** `2026-06-05`
**Author:** `instar-echo`

## Summary

Two changes to the delivery-failure sentinel's boot-time restore-purge (spec §3h): (1) `restorePurgeAgeMs` default 5min → 60min; (2) before deleting, the sentinel lists victim rows via new `PendingRelayStore.listStaleClaimable(cutoff)` and emits per-row warns + one DegradationReporter report naming them. The DELETE itself (`purgeStaleClaimable`) is unchanged.

## Decision-point inventory

- `DEFAULTS.restorePurgeAgeMs` — modified — 300000 → 3600000. Config override unchanged; absence preserves the (new) default.
- `purgeStaleRows()` — modified — list-then-purge with per-row warns + degradation report; early-return when no victims; report wrapped in its own try/catch (per-row warns are the floor).
- `PendingRelayStore.listStaleClaimable` — added — read-only SELECT mirroring the purge's WHERE clause exactly; Buffer text decoded utf-8.
- Purge cadence/one-shot semantics, state machine, drain mainline — untouched.

## Direction of failure

- Old failure: silent outbound loss — queued-undelivered messages >5min old deleted at every boot with a count-only log; agent believed them delivered (5 live losses today, incl. a user milestone report).
- New behavior: 12× longer survival window; any actual purge is individually traceable + reported.
- Conservative failure direction: messages are KEPT longer and losses are LOUDER. The purge still exists (genuinely ancient rows after a long outage are still dropped — redelivering hours-old chatter is the harm §3h guards against).

## Side-effects checklist

1. **Over-keep:** a 59-min-old message now redelivers after recovery where it previously vanished. Acceptable by design — an hour-old undelivered milestone/report is still wanted; the stampede-digest path (existing) already coalesces if many accumulate.
2. **Over-report:** a genuinely-long outage purging many rows produces one degradation report naming all victims (single report, not per-row) — bounded.
3. **List/purge atomicity:** a row enqueued between LIST and DELETE inside `purgeStaleRows` could be deleted-but-unlisted only if its `attempted_at` predates the cutoff — impossible for a fresh enqueue (attempted_at = now > cutoff). A row delivered between the two steps leaves `state != queued/claimed` and is skipped by both. No torn outcomes.
4. **Level-of-abstraction fit:** the store owns the SQL (listing mirrors the delete's WHERE clause in one file, keeping the two queries in lockstep); the sentinel owns the policy (when to purge, how to report) — matches the existing split.
5. **Signal vs authority:** no LLM; reporting only. The purge's authority is unchanged (it already deleted; now it also tells the truth about it).
6. **External surfaces:** no routes/config-shape changes. New log-line shape + one new DegradationReporter feature key (`delivery-restore-purge`).
7. **Rollback cost:** revert the commit. The store method is additive; old code ignores it.

## Scope not taken

- No 'expired' terminal state / escalation-to-topic for purge victims (candidate follow-up if hour-scale losses ever recur — today's evidence says the window fix removes the live class).
- No auto-resend of the 5 already-purged messages (the milestone was manually resent; others were status chatter).
- No change to the inbound lifeline path (that is PR #839, the inbound twin).
- No migrateConfig entry — `restorePurgeAgeMs` was never written into agent configs (code default only), so the new default applies fleet-wide on update with no migration needed.

## Rollback

Revert the commit. Default returns to 5min and purges return to count-only logging.
