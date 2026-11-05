# Convergence report: session-pool-no-silent-drop

**Outcome: converged in 2 rounds.** Outside reviewer: serious issues, then minor issues, both fixed.

| Round | Standards-Conformance Gate | Internal | Outside (codex-cli, gpt-6-astra) | Result |
|---|---|---|---|---|
| 1 | not run | code-reading survey of the step 2 list | serious issues, 4 | duplicate guard added; hop and mixed-build claims corrected |
| 2 | not run | not rerun | minor issues, 3 | checks paired in one object; guarantee limited to what it covers |

The main catch: checking before the receipt meant a processed message, retried after the machine went dark,
would be handed back and run twice. A read-only receipt check closes it.

## Limits left behind

- An old receiver still drops. Nothing relies on this until step 2, which activates new pairs only.
- Telegram placement still does not avoid a peer that cannot serve; one extra hop, no loss.
