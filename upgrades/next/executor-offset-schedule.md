# Feedback executor runs at :17 and :47 instead of :00 and :30

## What Changed

- `src/scaffold/templates/jobs/instar/feedback-factory-execute.md`: schedule `*/30 * * * *` → `17,47 * * * *`.

Why: the executor tick runs as a rerouted interactive session, and so do the feedback process job, the triage job (every 15 min), the health check and grading, all of which start at :00 and :30. With six rerouted sessions alive at once the executor's own admission check (`reroute-capacity`) refused every scheduled tick, live on 2026-10-23 from 20:00 PDT. Moving the tick off the shared minutes lets it start while the others are not running. A hand edit of the agent's schedule file does not survive: the server rewrites built-in schedules from this template at boot (seen 2026-10-24 03:40 PDT).

## What to Tell Your User

Nothing to tell: the feedback pipeline's fix-attempt check now runs at a quieter minute, so it is not turned away by the other background checks starting at the same moment.

## Summary of New Capabilities

None.

## Evidence

`tests/unit/feedback-triage-job-templates.test.ts` pins the new schedule (4/4).
