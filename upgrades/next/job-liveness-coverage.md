# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Jobs screen has an opt-in local schedule observation controlled by `jobScheduleCoverage.enabled`. It can show whether a scheduled callback reached the scheduler by the time shown, whether the available evidence leaves the outcome unknown, or whether coverage is out of date. A manual activity record is separate. The view can observe a scheduler without triggering a job. Peer and lease-dependent schedule evidence stays unknown until there is a verified continuity path.

## What to Tell Your User

When local schedule observation is on, Jobs can show whether the scheduler was seen responding to the schedule. The view shows the time of the observation and says when it cannot establish what happened. When available, it also shows the next scheduled time and an earlier schedule observation alongside the recorded run history.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Local Jobs schedule observation | Enable the test cohort configuration and open a job’s Schedule coverage details. |

## Evidence

TypeScript and all twelve focused tests passed. The tests cover the read-only observer, the authenticated Jobs API the production server and scheduler wiring, and the shipped Jobs detail view. Fleet rollout and independent peer proof are separate from this local increment.
