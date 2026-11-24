# Side effects: the PIN-share agreement protocol (SEC-170, part 2 of 3)

In plain words: part 1 gave each machine a fixed share of the agent's 20 unknown-browser PIN guesses per 5 minutes, and only ever lowered it. Part 2 lets the machines agree, so a share can rise again, a newly paired machine gets a share, and a machine that lost its records recovers. Throughout, the shares machines actually apply never sum above 20.

Tier 2: security protocol on machine-to-machine routes, from the approved spec `docs/specs/pool-wide-pin-budget.md` §4. Same dev-gated switch as part 1 (`security.pinBudget.poolWide`). Part 3 of 3 (owner surface, agent-wide alert) is due 2026-11-26, as the Chief of Staff approved on 2026-11-22.

## What changes for running agents (switch on only)
- **Poller** (`src/core/pinBudgetPoller.ts`). Every 30 seconds it makes one signed POST `/api/pin-budget/state` to each other registry machine, retired ones included.
  - The reply is that machine's report plus its contact records, signed by its own key over the caller's fresh 128-bit nonce (domain `pin-state-v1|`). A replayed, wrong-key, impostor or malformed reply counts as no answer.
  - Reports expire after 5 minutes. `seq` is capped at 2^40.
  - Brakes: a failing peer backs off from 5 seconds doubling to 60 (in practice one try per 30-second round), stops after 24 hours, and resumes when the peer is seen. Each call has a 5-second timeout. There is an in-flight guard.
- **Routes** (`src/server/machineRoutes.ts`, under machineAuth with an active-status check, replay nonce and sequence):
  - `POST /api/pin-budget/state` (nonce shape checked).
  - `POST /api/pin-budget/hand-down` (transferId length and integer fields checked).
  - Both answer 503 when the protocol is not wired.
- **Tables** (`src/core/PinShareTable.ts`, pure).
  - A table is `{ seq, members, hash }`, and its shares are always the canonical division, so a table carries nothing a proposer could bend.
  - It is valid only if its members equal the receiver's registry and its seq is at least the highest seen, so a proposer-only table or a replayed older table lowers nothing.
- **Deviation from the spec's data shape, reviewed:** hand-downs are bilateral loans outside the table, not giver-signed table entries.
  - A loan comes only out of the giver's applied share, saved to disk before it is sent, so no third machine's share depends on it and a forged loan cannot lower anyone.
  - A raise never exceeds the entry minus unsettled loans.
  - A loan settles only on an agreed table that lists the recipient, is no older than the loan, and has the recipient's signed report confirming it holds the loan or no longer needs one.
  - A loan ends when its recipient's retirement is complete.
- **Provider** (`src/core/PinShare.ts`, protocol path).
  - First decision: a machine founds at its entry only if every other registry machine answered freshly and each is either still deciding or applies a table over exactly the same members at or below its entry. Otherwise it starts at 0 and asks (newcomer, lagging registry, unreachable peer, lost records).
  - It lowers at once on any valid table.
  - It raises only when every member acknowledges the same table, and every machine retired since the last agreed table reports retired at 0 (or the owner's gone-for-good holds with 7 days of silence everywhere and complete records), and then 5 minutes pass on the monotonic clock. A newer table cancels the wait, and a restart restarts it.
  - Giving: the lowest-id peer with a share of 2 or more gives half, after saving its lowered share.
  - Receiving: only while at 0 and asking; refused if older than the agreed table; clamped to the entry; saved before use; usable after 5 minutes.
  - Self-retirement writes 0. A re-added machine starts over at 0.
  - Records format `v: 2`, which reads part 1's `v: 1`.
- **Evidence:** a `pinBudgetPoolWide` fired row per share-spent refusal (at most one a minute, with a count). An error row when settled shares sum above 20; it is measured only when every member reports the same agreed table and no loan is in flight.
- **Not yet:** the owner's gone-for-good tap (the file it will write is read already), the silent-machines Needs-you item, and the agent-wide alert backstop (part 3). Until then a retired machine that never answers holds the others' raise back, which is the safe side.

## Signal vs authority
Deterministic floors only: tables, acknowledgments and loans can refuse or delay a raise, never admit beyond the agreed shares.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the approved spec, the deviation and the diff against part 1), 2026-11-22.
- First verdict: DO NOT CONCUR, with 3 blocking findings, all real:
  - Founding failed open (a pairing plus an unreachable peer reached 23).
  - The e2e test could not reach the routes (machine routes mount only with a coordinator) and its second round pulled nothing.
  - A loan could never be absorbed, and a retired recipient wedged everyone.
- Also 6 non-blocking findings: late delivery, send without a saved lowering, a seq overflow, reports that never expired, a re-added retired machine, and no retry.
- All were fixed as described above, with tests.
- Second verdict: the 9 fixes are sound except one remaining gap (a newcomer with a lagging registry could found over fewer machines). Fixed by requiring an exact membership match, with a test.
- Final verdict: CONCUR (founding check confirmed closed, nothing new found).

## Rollback
Set the switch off, or revert. Records stay readable by part 1.

## Tests
- `tests/unit/sec170-pin-share-table.test.ts` (10). Pure logic; every scenario checks the applied sum stays at or below 20.
- `tests/unit/sec170-pin-share-protocol.test.ts` (18):
  - deciding, founding, an unanswered peer, an over-entry peer, a lagging registry
  - a newcomer through hand-down and agreement; a single hand-down; the giver lowers before sending; no send when the save fails
  - raise waits and cancellation; gone-for-good with silence; self-retirement; a re-added machine
  - a replayed table; lost records; restart; a loan to a retired recipient ends; clamping
- `tests/unit/sec170-pin-budget-poller.test.ts` (4).
- `tests/e2e/sec170-pin-share-agreement-alive.test.ts`: two real servers agree over signed HTTP. Not run by hand on this machine (standing rule).
- Part 1's unit tests and the ladder and dark-gate tests still pass.

## Class-Closure Declaration
- `unbounded-self-action`: closure bounded. One pull per peer per 30-second round, with backoff, a 24-hour stop and a 5-second timeout. At most one hand-down per decision pass, and never twice to the same recipient.
