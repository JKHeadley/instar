# Convergence Report — A peer's Local Verify result is signed, and a peer green on main has bounded authority (SEC-113)

## Verdict: CONVERGED at round 6 (Tier 2 security cap). All three reviewers at design 0 in round 6.

Each round used the same three reviewers: an internal security/adversarial/decision-completeness reviewer and an internal integration/multi-machine/scalability/lessons reviewer (both Claude subagents, fresh context, read-only, re-asked each round to mark prior findings), and the cross-model reviewer codex-cli:gpt-6-astra (cross-family; spec text only, no repo access). The Standards-Conformance Gate ran on rounds 2, 3 and 6 (round 2: Judgment Within Floors and Self-Heal Before Notify, both fixed; round 3: clean; round 6: Judgment Within Floors on the refresh-age floor and No Deferrals on the residuals, both fixed). `lint-machine-local-justification` is clean.

## ELI10 Overview

When a helper machine runs the tests for the machine in charge, the answer used to be trusted on its word. Now the helper signs it, and even a signed "pass" on the main code only counts for a limited time before the machine in charge checks for itself.

## Iteration Summary

| Round | Design findings (sec / int / cross-model) | Spec changes |
|---|---|---|
| 1 | 7 / 9 / 2 | request digest signed with the result; raw-body verification after field checks; receive-time key lookup; local pin check before dispatch; peer greens never write the green-main record or flaky history; second clock peers cannot move; same-head-only disagreement; owner clear route; observability; awareness; tests |
| 2 | 1 / 2 / 2 (+2 conformance) | no anchor → no peer main; refresh age derived from measured durations; local-run trigger; third-machine self-heal before notifying; quarantine cleared on lease loss; posture section citing the parent ratification |
| 3 | 2 / 1 / 3 | separate arbitration attempt kind outside the health gates and main slot; trigger loop guards; unconditional one-time migration; lease-epoch binding of all new state; bound qualified to one continuous lease; console wording and PIN-unlock pattern |
| 4 | 0 / 0 / 1 | read-time origin check on the green-main record (replaces a one-time migration that a rollback could defeat); unreadable lease reads skipped; arbitration plumbing; flaky-history type extended |
| 5 | 1 / 0 / 0 | state bound to unbroken holding (a server takes a new epoch every boot, so raw-epoch binding reset state on each restart); uncached key lookup factory; bound wording |
| 6 | 0 / 0 / 0 (+2 conformance) | refresh age without a floor, local until measured; residuals as owned ledger rows; dispatch pause vs durable deletion separated; null epoch / null holder; restart-with-gap wording; arbitration consequence stated |

## Original vs current

Originally: sign the peer's result, run main locally when the local anchor is older than 2 h, quarantine a peer on a red that followed its green. Now: the signature covers the request as well as the result, is checked on the raw body after the field checks, with the coordinator's receive time and a fresh pinned-key lookup; a peer green writes neither the isolation baseline nor flaky history; a second clock that peers cannot move gives a hard 3 h bound within one continuous lease; local corroboration is routed and triggered from measured durations; disagreement counts only on the same head and is first arbitrated by a third machine through a separate attempt kind that cannot touch main health; all new state is bound to unbroken holding; the owner clears a quarantine from the console with the operator session.


## After round 6

Precision-only edits from the round-6 verdicts were applied without a further round (no design change): a dedicated `state/local-verify/peer-trust.json` instead of the restart-hold file, state-coherence registry entries, null-epoch holding on a single machine, distinct dispatch pause vs durable deletion, restart-with-gap wording, and the arbitration consequence. Reviewer totals: security 12 + 7 + 6 + 3 + 1 + 2 findings, all resolved; integration 13 + 6 + 6 + 2 + 0 + 2, all resolved; cross-model 3 + 3 + 4 + 2 + 3 + 2, all resolved.

## Requested
Approval to build (Tier 2, security). Build follows the Tests section; it ships behind the existing dark `mainOnPeers` switch except D1, which also hardens PR verifies on peers.
