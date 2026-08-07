# Family re-review — PREPARED, NOT YET RUN (2026-08-07)

**Status: BLOCKED on external-model quota. No review has been run. No audit record has been written.**

## Why this directory exists

The five operator rulings of 2026-08-07 amended three constitution families — **The Substrate**,
**Building**, and **Shipping**. Each family's audit record is now stale, which is the ONLY remaining
failure in `standards-coverage --check`:

```
area audit stale for Building
area audit stale for Shipping
area audit stale for The Substrate
```

Recording those audits requires a genuine converged review of each amended family. The handoff is
explicit that it must never be hand-written: *"It would make the build pass in a minute and it would be
a fabricated review inside the constitution."* That instruction is honoured here — **nothing in this
directory is a review, and no verdict has been assumed.**

## What is prepared

`dispatch-protocol.txt` — the withheld-answer protocol and the five questions, byte-identical in intent
to the dispatch that produced the 2026-08-06 findings, so the re-review is comparable to the review it
answers. It tells the reviewer nothing about which articles are new, what is expected, or that
acceptance is wanted, and it states that a false ACCEPTED costs more than a false NOT ACCEPTED.

To dispatch: concatenate the protocol with one family's section of `docs/STANDARDS-REGISTRY.md` and
pipe it to a cross-model reviewer. One review per family, as before.

## Why it is not run

Inventoried before declaring the wall, per *Self-Unblock Before Escalating* (which these same rulings
made the single governing article):

| path | state |
|---|---|
| the codex account this agent uses | **usage limit reached**, resets 20:37 |
| `gemini` CLI | installed, but requires an API key; **no vault on this machine** |
| `pi` CLI | not installed |
| a second codex account home on this machine | **available, but not registered to this agent** |

The last row is the one worth being precise about. A second logged-in codex home exists on this machine
and was verified to work. It is **not** listed in any subscription-pool registry for this agent, so
spending its quota would be spending another agent's budget on this agent's work. Under the rung FLOOR
— capability is not authority; out-of-scope spend has a minimum rung of 1 (an approval) even when a
credential is reachable — that is the operator's call, not the agent's. It is named rather than
silently used.

## The one thing a successor must not do

Do not write the audit record to turn the check green. The record names its reviewers and fingerprints
a convergence report; hand-writing it produces a fabricated review sitting inside the constitution,
which is a worse defect than a red check that is honestly red.
