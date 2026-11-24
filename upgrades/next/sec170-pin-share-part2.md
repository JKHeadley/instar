# The agent's computers agree before any PIN share grows (part 2 of 3)

<!-- bump: patch -->

## What Changed

SEC-170, part 2 of 3 (`docs/specs/pool-wide-pin-budget.md` §4, approved). Part 1 gave each machine a fixed share of the agent's 20 unknown-browser PIN guesses per 5 minutes and let it only fall. Part 2 adds the agreement protocol, under the same dev-gated switch `security.pinBudget.poolWide`.

- **Reports by pull.** New `src/core/pinBudgetPoller.ts`. Every 30 seconds each machine POSTs `/api/pin-budget/state` (machine-signed) to every other registry machine, retired ones included. The reply is that machine's report, `{ table, applied, retired, needsShare }`, plus its contact records, signed by its own key over the caller's fresh nonce. A replayed, forged or mismatched reply counts as no answer. A failing peer backs off from 5 seconds doubling to 60, stops after 24 hours, and resumes when seen again.
- **Tables.** New `src/core/PinShareTable.ts` (pure logic). A table is `{ seq, members, hash }` and its shares are always the canonical division of its members. A table is valid only if its members equal the receiver's registry and its seq is at least the highest seen, so a proposer-only table or a replayed older table lowers nothing.
- **Raise.** A machine raises only when every member reports the same table at or below its entry, and every machine retired since the last agreed table reports retired at 0 (or carries the owner's gone-for-good with 7 days of silence everywhere). After that, one 5-minute window must pass on the monotonic clock. A newer table cancels the wait, and a restart restarts it.
- **Hand-downs.** A newcomer (a peer's table does not list it) or a machine whose records are both lost starts at 0 and asks. The lowest-id peer with a share of 2 or more durably lowers itself by half and then delivers the loan through `POST /api/pin-budget/hand-down`. The recipient uses it after 5 minutes. A raise never exceeds the table entry minus loans not yet absorbed. A loan is absorbed by the first agreed table, newer than the one it was made under, that lists the recipient.
- **Retirement.** A machine that sees itself revoked writes 0, then reports `retired`.
- **Evidence.** `pinBudgetPoolWide` fired rows (refusals caused by a spent share, at most one row a minute with a count) and error rows (settled applied shares summing above 20).

Part 3 of 3 (due 2026-11-26) adds the owner's "gone for good" tap, the single silent-machines Needs-you item and the agent-wide alert backstop. Until then a retired machine that never answers keeps the others' shares from rising, which is the safe side.

## What to Tell Your User

- **PIN limit stays agent-wide as computers come and go**: "When you add or retire one of my computers, they agree among themselves before anyone's share of the PIN guess limit grows."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| PIN-share agreement between machines | Automatic on development agents (`security.pinBudget.poolWide`) |

## Evidence

- `tests/unit/sec170-pin-share-table.test.ts` (10): validity (proposer-only, replay, forged hash, overflow); pairing with a hand-down; the raise fence; acknowledgment and retirement rules; two pairings at once; giver choice. Every scenario checks applied shares never sum above 20.
- `tests/unit/sec170-pin-share-protocol.test.ts` (11): deciding, founding, newcomer through hand-down and agreement, a single hand-down only, giver lowers before sending, raise waits and cancellation, gone-for-good with silence, self-retirement, replayed table, lost records, restart restarts the admit wait.
- `tests/unit/sec170-pin-budget-poller.test.ts` (4): signed replies accepted; replayed, wrong-key and impostor replies refused; backoff, 24-hour stop and resume; contact merge.
- `tests/e2e/sec170-pin-share-agreement-alive.test.ts`: two real servers agree over signed HTTP.
