---
change_type: fix
---

<!-- internal-only -->

## What Changed

`.github/workflows/ci.yml` gains a `pull_request_review` trigger (`submitted`, `dismissed`), and The Root's self-wiring contract in `scripts/standards-coverage.mjs` pins it.

The constitutional direction guard accepts the operator's approving review as proof that a registry change was authorised. CI fired on `push`, before any approval could exist, so the guard ran, correctly found none, and failed — and approving afterwards changed nothing, because the check had already finished. Approval had no event to re-run it.

## Evidence

Observed live on PR #1960: approved at 22:03 with the standards check red and finished; a manual re-run of the same job then passed with no other change. That difference was the defect.

`dismissed` is pinned alongside `submitted` so withdrawing an approval re-runs the guard and turns the check red again — a gate that re-evaluates only toward passing is not a gate. Ratchet suite 38/38, including the negative controls asserting that a workflow missing the required triggers FAILS; their fixtures and expected error text moved with the contract.

## Known Limits

A review EDITED in place does not re-trigger (`pull_request_review` fires on submit/dismiss). The guard binds to the head sha, so the exposure is an edited review body rather than a state change, and any new push re-runs everything via `synchronize`.

More broadly: this closes the gap for the review path only. Any other check whose inputs are not repository content has the same shape, and nothing enumerates those.
