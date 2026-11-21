# Convergence Report — One PIN attempt policy for every place the PIN is checked

**Spec:** [docs/specs/identity-security-piece1c-pin-policy.md](../identity-security-piece1c-pin-policy.md)
**Slug:** `identity-security-piece1c-pin-policy`
**Converged at:** 2026-11-18 (round 3 delta)
**Iterations:** 3 (it was also section 2 of piece 1, reviewed in round 5)
**Final-round design findings:** 0 internal. The cross-model reviewer's remaining items are recorded as scope rulings in the spec.

---

## ELI10 Overview

Your dashboard PIN protects sign-in and several owner actions. Only sign-in was properly protected against guessing. Some actions had no limit at all, some counted every internet visitor as one person, and a restart wiped the counts. Now every place uses one policy with separate allowances:
- **Public:** places anyone on the internet can reach. Each visitor is counted on their own, and an overall cap survives a restart.
- **Approval links:** each link has its own small allowance.
- **Owner actions behind sign-in:** each sign-in has its own allowance, so a stranger's guessing can never lock you out of your own actions.

If the counts get damaged, guessing from unknown browsers pauses for five minutes rather than restarting from zero. With the right PIN, nothing changes.

## Original vs Converged

- **Originally:** one verifier with one shared budget across every route.
- **Round 1:** both internal reviewers found that a shared budget would let strangers lock the owner out of actions they cannot even reach today. The fix split it into public and signed-in budgets. The round also folded in:
  - unattributable callers count toward the overall cap only;
  - the damaged-file hold got an end: quarantine plus one paused window;
  - store pruning and a row cap;
  - one PIN read path;
  - the list of tests that change.
- **Round 2:** approval links got their own per-request budget. Signed-in keying uses the session family, then the remembered-browser cookie, before the shared agent key. The shared signed-in cap was dropped.
- **Building:** two corrections came from the code itself.
  - Step-up turned out to be reachable without a bearer, so it is on the public budget with sign-in.
  - The paused window is written back to disk, so a restart cannot end it.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security+adversarial, integration+lessons+decision-completeness, Astra | 1 + 1 (same) + 7 | ~25 | two budgets, counters, sites. Standards-Conformance Gate: ran (3 flags) |
| 2 | security+adversarial, Astra (integration converged) | 2 + 6 | ~12 | per-request budget, keying order. Standards-Conformance Gate: ran (3 flags, answered in the decision points) |
| 3 | none (security delta converged) | 0 | 2 | per-request durability, alert-only count |

## Full Findings Catalog

All answers are in the build state folder: `reviews/r5`, `reviews/p1c-r1`, `reviews/p1c-r2`, `reviews/p1c-r3`.

## Proportion

Tier 2. Eleven source files, about 400 lines, plus two test files.

## Left behind

- One credential holder for a synced PIN: piece 4.
- A minimum PIN length and PIN non-disclosure: piece 1d.
- `PrivateViewer`'s per-view PINs.
- A live run through a real tunnel: Cloudflare refused a quick tunnel during the proof.

## Convergence Verdict

Converged at round 3 (80/20: internal design findings fell to zero; the cross-model items left are sequencing owned by pieces 1d–1f and 4). The spec carries `approved: true` under the approved umbrella and Justin's standing guidance. No constitution text changes.
