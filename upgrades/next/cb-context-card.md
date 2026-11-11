<!-- bump: patch -->
## What Changed

The console gets a **Settings → Context** page (context-budget-layered-summaries §11; Phase 1 S14). It is read-only and shows, for this machine:

- each conversation's running summary: whether it is current, cost per turn, and how much of the operator's own writing is still word for word in the session (sizes, repeated work and message counts in the tap-through detail);
- whether recovery after a compression actually works, per AI app and version (the compaction canary);
- what keeping the summaries current costs against its daily allowance;
- the "send only what changed" trial (`/context-budget/delta-shadow`, when the server has it);
- the watcher's own upkeep: last check, refreshes settling, leftover pauses cleared.

It reads `GET /context-budget/layers`, `/metrics`, `/sentinel` and `/delta-shadow`. When the feature is off (503) the page says so in one sentence, and a route this version lacks (404) is "not on this version yet", never an error.

**Home's count** gains a `context` source (`needs-model.js`, reading only `/context-budget/sentinel`): a memory refresh stuck past the 15-minute reconciliation bound, an unreadable refresh record, or a compression-recovery check that has gone `diverged` (one row per machine). The page leads with these, each with a link to ask the agent. Stuck and unreadable rows are matched to the watcher's own Attention item by fold id, so one incident counts once; the unreadable-record notice title now names its fold for that. A watcher that has stopped checking in makes the count read "can't tell" rather than "nothing". Rolled-back folds, breaker trips, pending Anchor confirmations and `checkpoint-unreachable` events join the count once their backends exist.

## What to Tell Your User

There is a new page under Settings called Context. It shows what I keep in each conversation's running summary, whether it is up to date, what our conversations cost per reply, and whether my memory recovers properly when a long conversation gets compressed. If something there needs you, it shows up on Home too. It only covers the machine the dashboard is running on for now.

## Summary of New Capabilities

- Console Settings → Context page (read-only).
- Home's count includes stuck memory refreshes, unreadable refresh records, and broken compression recovery.

## Evidence

- Unit: `tests/unit/console-context.test.ts`; `tests/unit/console-needs-first-screen.test.ts` (the new source leads its page and reaches Home).
- Integration: `tests/integration/console-static-serving.test.ts` (both assets served).
- E2E: `tests/e2e/console-context-page-alive.test.ts` (the page model reads the real routes' answers; fleet agent reads "switched off").
