# Convergence report: session-pool-move-nudge

**Outcome: stopped after 2 rounds at the proportion rule, not by a round with zero findings.** Round 2's outside verdict was minor issues, all about what the result can be proved to be, none about ownership or lost messages. Its three findings were answered in the text and that final text was not sent for a third read.

| Round | Internal (one reviewer, all six lenses, read against the code) | Outside (codex-cli, gpt-6-astra, specs only) | Result |
|---|---|---|---|
| 1 | 1 blocker, 3 serious, 6 minor | serious issues, 3 | Nudge goes to every active peer, not just target and holder. A queue is woken only if this key advanced. Per-sender key set and a 1 s spacing replace the rerun flag. Evidence row added. Paged catch-up, late binding, maturation fields. |
| 2 | not rerun | minor issues, 3 | Nudge carries the claim's epoch and landing time so the measure names the exact claim. Backlog limit stated, not promised away. Overlap with the 30 s pull answered from the code. |

## What the reviews changed

The first draft could not meet its own pass line on a five-machine ring: the next target of a second move was never told. And "a hint cannot change anything" was untrue as written: waking a queue against a stale view retries early against the old owner and spends a message's attempts. Both are fixed in the design.

## Limits left behind

- Standards-Conformance Gate ran once on the round 2 text: 95 standards, fit verdict fit, 3 flags. Unbounded loops and capacity safety answered by an hourly budget and a failure brake; Agent Awareness answered by one template line with a migration. Not rerun after those edits.
- The internal review was one agent covering all six lenses, not six agents, and did not reread round 2. Claude-family clean-door read not run.
- The slowest-peer stall in `pullOnce` remains for everything but moves.
- The worst-case figure in the problem statement is read from the code, not measured. The cause of the 3 min 14 s leg is inferred from it.
- Which `queued` branch fired in the measured runs was not established.
