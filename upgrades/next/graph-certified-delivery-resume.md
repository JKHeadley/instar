<!-- bump: patch -->
## What Changed

Conversations: an owner change that was certified but whose final proof did not reach every machine in the first attempt (a slow or briefly unreachable machine, a restart) is now finished by the 15-second background pass. Before, that pass only resumed changes without a certificate, so a certified-but-undelivered change stayed "saved, pending" for good, and the dashboard's Accept waited on it forever. The writer resumes at the delivery steps only; it never prepares or certifies the same change twice. Records already stuck this way finish on the first passes after the update.

## What to Tell Your User

- "If a change in Conversations pauses at 'saved, waiting for your other machine', it now finishes by itself once that machine answers. A few older changes that were stuck this way will complete after the update."

## Summary of New Capabilities

- Certified Conversations changes with unfinished delivery are completed automatically instead of staying pending.

## Evidence

- `tests/integration/conversation-graph-replication-runtime.test.ts` (new: a certified change whose commit proof was dropped stays pending while the member is silent, commits on the next pass once it answers, without a second prepare or certify, and is then left alone).
