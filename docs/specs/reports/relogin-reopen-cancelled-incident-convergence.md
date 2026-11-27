# Convergence Report — Sign-in repair: reopen an incident that admission bookkeeping cancelled while the account is still signed out

**Spec:** [docs/specs/relogin-reopen-cancelled-incident.md](../relogin-reopen-cancelled-incident.md)
**Slug:** `relogin-reopen-cancelled-incident`
**Converged at:** 2026-11-27T00:22:00.000Z (round 3, the Tier 1 cap)
**Iterations:** 3
**Final-round design findings:** 0 safety; 1 other, accepted (see "Left behind")

---

## Cross-model review: codex-cli:gpt-6.2-astra

A GPT-tier external pass ran in all three rounds. A clean-door Claude read also ran every round; it is recorded separately and not counted as cross-model. Standards-Conformance Gate: ran every round, with 1, 1 and 3 flags; all were engaged.

## ELI10 Overview

A sign-in repair can start only from an open "incident", the record that an account's login failed on that machine. When an account briefly dropped off the tracked list, its incident was closed as "cancelled", and nothing reopened it while the account stayed signed out. So no repair could start again. That happened to account A on the Mac Mini. Now such an incident is reopened as it was, when the pool still says the account is signed out and nothing has read it clean since. A repair that the closing cancelled mid-run is given one more start.

## Original vs Converged

- The first draft reopened any cancelled incident whenever the account was still signed out. Review added: no clean read since the cancellation; the event keeps the closure it undid; and the stated reliance on pool status, which every accepted recovery path sets active.
- An age bound, a read-type rule and a 30-minute blip rule were each tried and dropped. None had a derivation, and the pool status already carries continuity.
- Review found that a repair running at the drop-out stayed cancelled for good. It is now re-admitted, once per row, with its own event.
- The cases still not reached are tracked: a signed-out cell with no incident at all, and a row cancelled a second time (CMT-041). So is the root fix, not cancelling on a single missed poll (CMT-040).

## Experience fit

- **Goal and source:** the Chief of Staff handoff of 2026-11-26, that every account stays signed in on every machine by itself.
- **Ordinary journey:** a stuck cell's "no open incident" blocker clears on the first poll after the update, and its repair resumes about 6 to 7 hours later through the slow retry, or right away if it was cancelled mid-run.
- **Asks:** this change adds none.
- **Contrasting cases:** a cell that recovered, or that has no incident, is unchanged.
- **Evidence limit:** whether the live Mac Mini cell's coverage shows no clean read since the cancel is checked on that machine at the live proof (CMT-039).

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | codex, clean-door, internal panel; SCG | 6 | 6 | Change, Risks, Testing, posture |
| 2 | codex, clean-door, internal panel; SCG | 6 | 8 | evidence rule, re-admission once, Alternatives |
| 3 | codex, clean-door (liveness), internal panel (0 safety); SCG advisory | 1 internal (non-safety) + external liveness | 5 | blip rule dropped, Risks, tracked gaps |

## Proportion

Tier 1: 3 source files, about 80 lines plus tests, 3 rounds against a cap of 3. The review effort was large for the size, because the change restores authority-bearing state (an incident that admits unattended repairs), and the reviewers kept finding adjacent paths.

## Left behind

- **Accepted (non-safety):** the re-admission marker resets an earlier challenge on that row, once (stated in Risks).
- **Accepted (liveness, external round 3):** a cell that drops out before each scheduled retry can keep pushing its next try later; a `mixed` bucket straddling the cancel blocks the reopen. Both fail toward today's behaviour and are tracked with CMT-040 and CMT-041.
- **Later:** a close reason instead of relying on the single `cancelled` writer; a cancel event for flap visibility (CMT-040).

## Full Findings Catalog

- **Round 1:** recovery between cancel and reopen; stale evidence; the running-repair cancel never recovering; the cancel writer; the event keeping the closure; the pool-status source; the expected wait; read windows; churn signal.
- **Round 2:** re-admission bypassing retry limits (bounded to once per row, with its own event); evidence-ordering in buckets; budget across cycles; the cause-to-coverage mapping; the debounce alternative (CMT-040).
- **Round 3:** the age/blip rules rejected as underived; the challenge reset on re-admission accepted; unreached cases tracked (CMT-041); wording on what "clean" means.

## Convergence Verdict

Converged at round 3, the Tier 1 cap. The final round found nothing that touches safety, security or data loss. One other design point and two liveness points are accepted and tracked. The spec is ready to approve and build. Its tests run in Local Verify, because the M5 is reserved.
