# Jev job audit: the run-description question can now answer "completed"

## What Changed

`AUDIT_QUESTIONS.failure_class` offered only failure shapes, so every healthy
run was forced into one — on the originating agent, health checks that
correctly reported a degraded server were labelled `errored-but-exit-0` in 273
of 431 audited rows in one day. Adds `completed` ("the promised work happened
in full; a check that ran and reported problems in what it inspected counts as
completed") and the matching sentence on `false_success`.

## Evidence

`tests/unit/JevJobCompletionAudit.test.ts` — new test asserts the choice list
offers `completed` alongside the failure shapes and that both questions state
the check-job rule. Existing unit, integration and e2e audit tests pass.

## What to Tell Your User

If the scheduled-task checking trial is running, its model can now say a task
simply worked. Before, every answer on its list described a failure, so healthy
runs, like a health check reporting a real problem, were mislabelled as broken.

## Summary of New Capabilities

- `completed` value for the audit's `failure_class` answer.
