# Convergence Report — The lease holder trusts only trust grants it wrote itself (SEC-088, part 2)

## Cross-model review: codex-cli:gpt-6-astra

A GPT-tier external pass (codex-cli, gpt-6-astra) ran successfully in all six rounds. A clean-door Claude read (claude-code, claude-fable-5-2; not cross-family, recorded separately) also ran every round.

## Verdict: CONVERGED at round 8 (cut form)

Round 8 (authorized by the Chief of Staff 2026-11-18 03:24 PST, same five reviewers, scoped to holes the cut reopened or any peer-grant path) found no peer-grant path and two reopened holes (a same-epoch tie, a withdrawal made on a standby). Both were fixed and re-asked of the same reviewers, who concurred. See the round 8 log.

## History: the round 7 cut

Round 7 (authorized by the Chief of Staff, 2026-11-18 02:35 PST, same reviewers) found new design blockers in the round-6 hand-over fixes from all five reviewers, including one peer-grant path (a forged epoch-less `change` re-validating an ended legacy grant). Per the cut rule, the fixes were not patched again. The spec was cut: the holder trusts only grants it wrote itself in its current run of the lease; after any hand-over every earlier grant is absent and asked again when next needed; there is no special hand-over path. The cut removes mechanism rather than adding it, and was not reviewed again. It is not tagged converged. See the round 7 log.

### Round 6 verdict (kept for the record)

Round 6 still found design-class issues that concern safety (a revoked device or an owner's lowering not following the lease on a hand-back; a joining machine's legacy-import check losing its evidence). Fixes are written into the spec but have not been reviewed. Per the skill, the spec goes to the operator instead of a seventh round. It is NOT tagged converged and must not be built yet.

## ELI10 Overview

The agent runs on several computers, and one is in charge of approvals. They share a notebook of permission records. Today the computer in charge believes every page, even ones another computer wrote, so a stolen laptop still linked to the agent could write "the owner approved this". The fix: a page that gives permission only counts on the computer that wrote it; a page that takes permission away or marks it used counts from anyone. When a different computer takes charge it asks the owner again.

Unlike the earlier design (which failed at round 6 trying to prove who was in charge when), this one never needs that proof, and from round 2 on no reviewer found a way for another computer to create a permission. The remaining work is all about the honest path across hand-overs: making sure the owner's own "take it away" actions follow the lease back, and that one-time approvals cannot run twice.

## Original vs Converged

Originally: grants count only where written; narrowing from anyone; a forgery alarm; a signed-once ratchet. After review: two indexes (own grants, shared narrowing) with closed record and query tables; no forgery alarm except one provable, signature-gated case; no ratchet; levels per machine with an epoch-keyed exception so an owner's lowering follows the lease; one-time grants valid only in the term that wrote them, with the term tracked by a never-lowered `lastForeignEpoch` plus a gap rule and a same-epoch contest hook; legacy grants own-only, ending on any non-automatic change; honest denial and handover lines; three operator approval items.

## Iteration Summary

| Round | Design findings | Spec changes |
|---|---|---|
| 1 | 16 | own index + narrowing set; closed tables; forgery alarm dropped; ratchet dropped; full cost |
| 2 | 8 | ask-first removed; epoch in record keys; dispatch by id |
| 3 | 7 | term via lastForeignEpoch; legacy source list inverted; admission recheck; restore ownership |
| 4 | 5 | gap rule; registry decides single machine; withdrawals; decision 4 justification + item 14c |
| 5 | 4 | same-epoch contest hook; signed-only notice; local sink ownership |
| 6 | 5 | fixes written, not reviewed (cap) |
| 7 | 8 (7 hand-over + 1 legacy) | CUT: hand-over path removed; current-run grants only; peer records narrow by id only |
| 8 | 2 reopened holes, 0 peer-grant paths | foreign epochs (tie, incl. loser-first); withdrawals name every machine's acceptance ids; all re-asked: concur |

Standards-Conformance Gate: ran every round (2, 1, 2, 2, 2, 2 flags). Internal reviewers: the same three subagents every round (re-asked, never replaced).

## Proportion

⚠ Six rounds on a Tier 2 security spec of about 380 lines; the design surface shrank from round 2 on (16 → 8 → 7 → 5 → 4 → 5) and the remaining findings are on the honest hand-over path, not on peer grants.

## Approver items (decision 11 of the cut form), for the operator

(a) Re-asking after a hand-over, and once at upgrade, is an exception to *Trust Is Earned by Work*; after the cut it also covers raised trust levels, the autonomy profile and legacy kinds. (b) The fleet keeps today's behaviour for a 21-day review deadline, or ships protected from merge. (c) Trust levels and the autonomy profile stay per machine (and per run) until identity piece 2, an exception to *An Instar Agent Is Always a Multi-Machine Entity*.

## Left behind

See the round 6 log; precision items from rounds 1-5 are in each round's log.

## Recommendation

Converged. The build of the cut form is on this branch (second-pass review concurred). Bring the three approver items (decision 11: a re-ask after a hand-over and once at upgrade; b the 21-day fleet window or "ignore" fleet-wide from merge; c per-machine, per-run trust levels) to the operator with the approval request, together with the measured runs-ended rate (decision 12: the epoch moved about 100 times in an hour on the evening of 2026-11-17).
