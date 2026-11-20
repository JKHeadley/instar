<!-- bump: patch -->
## What Changed

The building blocks for the context budget's practice folds (Phase 2), and the record they will fill:

- **The switch.** `contextBudget.fold.shadow` is registered as dev-gated: live on development agents, dark on the fleet. Nothing runs yet.
- **`GET /context-budget/fold-shadow`.** Graded practice folds toward the 40-fold exit, the would-be loss rate, folds that would roll back, and why others were skipped. Counts only; 503 while off.
- **Clean stop and ask brakes** (`foldCleanStop.ts`). The checks that a conversation is at a safe stopping point (any unknown counts as not safe), including unfinished background tasks. The brakes cap asks at 2 per hour, back off for 30 minutes, and sample 1 in 3 stops.
- **The handoff audit** (`foldAudit.ts`). Checks the session's handoff note against open PRs and red tests in both directions, plus a fenced model check against the topic's purpose and decisions. One re-ask, a second only for a lost decision.
- **The handoff request turn**, with a message index the session can name stretches by.
- **Fold coordinator.** It can renew its lock and record the lock window. One session's tool-policy marker can now be removed on its own.
- **Per-prompt hook.** A conversation is no longer muted while its practice quiz is graded off to the side.
- An awareness note tells agents how to read the record.

## What to Tell Your User

Nothing changes yet. These are the safety checks and the scorecard for the practice runs: shrinking only ever happens at a calm stopping point, rarely, and every attempt is recorded. The practice runs themselves come in the next update.

## Summary of New Capabilities

- `GET /context-budget/fold-shadow`: the practice-fold record toward the Phase 2 exit (503 while `contextBudget.fold.shadow` is off).

## Evidence

- Unit:
  - `fold-clean-stop` (25): every clean-stop check on both sides, the check-in boundary, background starts with and without completions, the reproducible 1-in-3 sample, the hourly cap and rolling window, the backoff, a private and torn brake file.
  - `fold-audit` (12): both signal directions, the enumerated verdict, fencing, no-judge, the send-back policy.
  - `fold-runner-prereqs` (11): lock window and renew including refusals, single-marker removal, a prepared fold muting and a shadow-probing one not, log summary, rotation and torn lines, the handoff request's bounded index and parseable schema, switch registration.
- Integration: `fold-shadow-route` (3): 200 on a dev agent with the real log, 503 on the fleet and with `shadow:false`, 401 without the token.
- 962 neighbouring unit tests pass (`fold-*`, `FoldCoordinator`, `context-budget-*`, `context-layer-*`, `capability*`, `devGated*`). Lint 54/54.
