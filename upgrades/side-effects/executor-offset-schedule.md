# Side-Effects Review — feedback executor tick moves to minutes 17 and 47

**Version / slug:** `executor-offset-schedule`
**Date:** `2026-10-24`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier 1 schedule change; no gate, authority or confinement change)`

## Summary of the change

The built-in `feedback-factory-execute` job template's cron changes from `*/30 * * * *` to `17,47 * * * *`. Same cadence (twice an hour), different minutes. Live evidence (topic 18330, 2026-10-23): every scheduled tick from 20:00 PDT was refused `reroute-capacity`, because the tick itself and the feedback process, triage, health-check and grading jobs all start as rerouted sessions at :00/:30 and together reach `maxRerouted` (6).

## Decision-point inventory

None added or changed.

## 1. Over-block

None: no check is added; the tick runs as often as before.

## 2. Under-block

None: admission limits are unchanged; the tick still passes the same reroute-capacity check, it is just less likely to meet the others.

## 3. Level-of-abstraction fit

The schedule is the job's own declarative field; the server already rewrites built-in schedules from the template at boot, so existing agents receive it on update without a migration.

## 4. Signal vs authority compliance

No signal or authority change.

## 4b. Judgment-point check

No judgment added.

## 5. Interactions

Triage runs every 15 minutes (:00/:15/:30/:45) and still precedes each executor tick by two minutes, so the ranked queue is fresh when the tick reads it.

## 6. External surfaces

None.

## 7. Rollback cost

Revert the one line; the next boot rewrites the schedule back.
