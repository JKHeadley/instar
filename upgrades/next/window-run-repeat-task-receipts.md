<!-- bump: patch -->

## What Changed

Long autonomous runs can now record several separate pieces of work against a checklist task that is still open. The window watcher keeps preferring a task without a prior receipt, then falls back to the first open task when all open tasks have one. Recovery and cadence checkpoints use the same selection. The file must contain work never receipted earlier in the run before another receipt is accepted, and completed tasks remain ineligible.

## What to Tell Your User

- “I can keep working through a long task and show fresh, saved progress throughout the run. Finishing the checklist still ends the work normally.”

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Repeated progress on a live task | Automatic during an autonomous run |

## Evidence

During the 2026-10-30 Echo run in topic 18330, five changed versions of one saved evidence file received five receipts for five open tasks in 29 minutes. The next request was guaranteed to fail under the old selector because every open task was in the used set, even though all five remained open. The unit, HTTP integration, and production lifecycle tests reproduce the boundary with a changed artifact after all open tasks have one receipt. Their exact-head results and a live after-deploy receipt are recorded in the PR and side-effects review when available.
