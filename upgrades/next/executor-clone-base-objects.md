# Feedback executor: attempt clones get the base commit; a failed setup stops the run

## What Changed

- `src/feedback-factory/execute/executorPorts.ts`: `fetchBase` also refreshes a local branch `feedback-execute/base` and reads the base from it. An attempt clone copies only objects reachable from the checkout's branches, so a base that only `origin/main` reached failed every attempt with "unable to read tree".
- `src/feedback-factory/execute/FeedbackExecutorService.ts`: the claim loop stops after the first failed preparation; the scrubbed failure message is kept in executor state and shown as `status.lastPrepareFailure`, and the audit row carries a `step` label (the id-only audit had blanked the message to `[text:300]`).

Why: live 2026-10-23 18:33 PDT, one tick failed 8 work items in two minutes for the same machine-level reason.

## What to Tell Your User

Feedback fixes can start again: a setup step was failing for every item. If setup ever fails again, the pipeline stops after one item instead of working through the whole queue, and the reason shows on its status page.

## Summary of New Capabilities

- `GET /feedback-factory/execute/status` → `lastPrepareFailure` `{ at, attemptId, reason, step, detail }`.
- Audit `execute:prepare-failed` carries `step`.

## Evidence

`execute-attempt-git.test.ts` (base reachable only from origin/main still checks out; fails without the fix), `execute-reroute-capacity.test.ts` (one failed preparation per tick, readable reason). Executor unit 145/145, integration 9/9, e2e 2/2, lint clean.
