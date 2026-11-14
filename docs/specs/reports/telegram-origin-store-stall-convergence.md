# Convergence Report — Telegram Origin Store Stall

**Spec:** [docs/specs/telegram-origin-store-stall.md](../telegram-origin-store-stall.md)
**Slug:** `telegram-origin-store-stall`
**Iterations:** 2
**Final-round design findings:** 1, fixed

## Cross-model review: codex-cli:gpt-6-astra

Codex ran on both rounds, with the source diff inline. Gemini was unavailable (not signed in). One independent internal reviewer read the code and ran one probe, standing in for the six separate internal reviewers: the urgency of held replies was the reason for the shorter form. This is less review than the full skill describes, and it is stated here so that nobody reads more into the tag.

## ELI10 Overview

Before a Telegram message goes out, Instar writes it down in a small database. A job added the day before compared each reply with every receipt ever kept, which took 39 seconds on the real data and blocked every message behind it. Separately, a connection timer was too short, one slow read of the settings stopped all sending, and retries could wait 15 minutes after one bad moment. All four are fixed. No new way of sending exists, and a message whose delivery is uncertain still never retries by itself.

## Original vs Converged

Review changed three things. The connect window went from process-wide to a dispatcher used only for Bot API requests. Recovery now skips a send whose first pass is still running, because a tick landing during its review could retire the reply before it was tried. A config snapshot's age now counts from before its bytes were read. Review also forced the replacement query to be measured with a concurrent store probe and a worst-case page.

## Iteration Summary

| Round | Design findings | Outcome |
|---|---|---|
| 1 | Codex 2, internal 6 (3 fixed, 1 corrected registry bound, 2 accepted) | Dispatcher, first-send skip, age stamp, forward bound, measured timings |
| 2 | Codex 1 | Forward model's move from quick steps to reservations aligned |

## Proportion

Tier 2, 9 source files, about 135 lines. Two rounds, each of which found something real.

## Left behind

Accepted risks, stated in the spec:

- Under a failure that keeps being proven unsent, all 9 transport attempts are used by about 3h53 instead of 4h45.
- The notice observer keeps its own 2 s read budget, so alerts can be withheld while sends continue. It fails closed.
- `/health` reports healthy with a read-unavailable reason during a timeout, inside the 30 s bound.
- Boot's first config read can take 10 s rather than 2 s on a saturated host.
- A single store step cannot be interrupted, and the timings hold at this store's size, not as a general bound.
- What uses the 2 s inside the server during config reads is not measured.

## Full Findings Catalog

Every finding is in the table above and resolved in the spec, or listed under Left behind.

## Convergence verdict

Converged at round 2 on the shorter review form described above.
