# Convergence Report — Every design mistake the owner points out becomes a rule, and every screen change shows its screens against the rules before it merges

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's Codex CLI in every round from 1 to 6 (round-6 model `gpt-6.2-astra`, `crossFamily: true`, prompt not truncated). Its round-6 findings were all also raised by the internal reviewers and are resolved in this revision. The confirming round 7 was internal only.

## ELI10 Overview

When the owner points out that a screen looks bad, today it depends on whichever session hears him remembering to fix it and write down a rule. This spec makes that automatic. His remark becomes a card. The card closes only when four things are true: the mistake has a written diagnosis, the design standard has a rule for it, the fix has been seen working on every app the remark concerned, and a check exists that would catch it next time. His own message approves the card, so he never has to tap anything to start it.

Every change to a screen is now drawn by our own machines before and after the change, at the standard phone, tablet, laptop and monitor sizes, with invented data passed through the real code. A change may not add problems. Where the pictures differ, a fresh reviewer that did not write the change compares them. The decision is part of the status every merge already needs, so no shortcut skips it. The native apps get the same check in each app's release script. Nothing private enters the public code repository.

The main tradeoffs: a broken drawing tool never stops merges for long, so an unchecked change can land and is caught by the next daily sweep. The owner keeps sole authority over rules his own feedback created. Waiving or loosening one needs his phone tap, and is only asked for when a session requests it with a reason.

## Original vs Converged

- **Who makes the pictures.** Originally the author committed screenshots. Review showed an old screenshot could sit next to new code, and that pictures in the public repository could leak private data. Now the gate draws both sides itself from the exact trees Local Verify tests, and stores the pictures privately.
- **Where the decision lives.** Originally a separate check that some merge paths could skip. Now it is a term of the one required status, on both merge floors, recomputed by the coordinator whenever an answer, waiver or switch change arrives.
- **Who reviews.** Originally the author could answer its own review. Now the gate starts the reviewer and hands it a one-time key in its environment, which the author cannot see.
- **The owner's rules.** Originally any loosening went to him in a way that could never be approved, because the approval was bound to the tree that had to cite it. Round 5 bound it to a request and the exact reduction. Round 6 added a widened tolerance as a kind of loosening, bound each approval to one pull request, and made each approval single-use.
- **Native apps.** Originally a static scan. Now each release needs captures and an independent review. The captures sit in a separate evidence commit with its own permanent tag, fingerprinted to the exact app uploaded.
- **Feedback cards.** Originally a card's fix could wait forever for a review nothing started. Now the daily sweep starts the missing reviews itself.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | all six lenses, external | about 60 (de-duplicated) | many | Gate renders both trees; decision moved into the required status |
| 2 | all six lenses, external | about 30 | many | Coordinator decision record; reviewer token; waivers as phone asks |
| 3 | adversarial, decision, integration, scalability, security, external | about 15 | ~25 | Persistent renderer folder; sweep renders every landed commit |
| 4 | adversarial, decision, integration, security, external | about 9 | ~20 | Native captures bound to their build; base retries |
| 5 | adversarial, decision, external | 4 | ~25 | Loosening card bound to request and reduction; evidence commit; sweep reuse narrowed |
| 6 | adversarial, decision, integration, security, external | 8 (de-duplicated) | ~30 | Optional waiver; Check-line tolerance; sweep-started reviews; base fill twice; evidence tag; wording review; loosening family wired and bound |
| 7 | (converged; one independent confirming reviewer, Fable 5.2) | 0 | 9, all folded except as listed below | Precision fixes only |

The constitution check ran on the round-6 revision in nine parts (2026-11-22 08:43 UTC), because the check reads only about 24,000 characters at a time. The cheap, real findings were folded in:
- the two rule books now align on independent review and the off-switch limits
- the first book's origin carries its source marker
- Slack live proof is required in stage 3
- unjudged messages are kept, not dropped
- a timed-out re-evaluation is `pending`, never an old allow
- off-switch rewrites update one notice
- the renderer install backs off
- the base fill is single-flight
- the over-budget capture store has a hard ceiling

The repeated Judgment-Within-Floors flags on fixed numbers were each contested in round 6's fixed-limits table and kept, with their basis stated.

## Proportion

Tier 2. The spec is about 510 lines (≈130 KB) with a 7 KB plain-English companion. It took seven rounds. That is large, but in line with a gate every interface change in two repositories must pass. Findings fell each round: about 60, then 30, 15, 9, 4, 8 and 0.

## Left behind

- The green status can rest on a comparison against an older main tip while main is healthy; the sweep renders the landed commit within 48 hours. Declared under-block, accepted.
- The 24-hour off-switch cap and the 24-hours-in-7-days budget. Contested and kept: a tool failure already allows as `unavailable`, so the cap costs no delivery.
- Team members' design feedback is not auto-detected; only the owner's words open cards. This is deliberate, because owner-request approval exists only for the owner.
- `no-data-loss-on-machine-death` and `rebuild-machine-one-step` (both approved 2026-11-21) were not read in full against the machine-local capture store and renderer folder. Both are declared re-creatable and excluded from backups. This is to be confirmed at stage 2.
- Ground-truth line numbers in the Work Board files predate pull request 3596's merge; the named functions are the reference.
- The "not-started" status 3596 added for agent-work cards does not affect waiver or loosening cards, which carry a recommendation.

## Full Findings Catalog

Every reviewer file for rounds 1 to 6 is kept privately with the agent's design-feedback notes: one per lens, the external pass, and the constitution flags. They are not committed here because they quote private messages. Round 7's confirming review is summarized below.

Round 7 (confirming): all eight round-6 DESIGN findings resolved, with the spec text quoted for each. Precision items:
- P1, stale "once per tip" sentence: fixed.
- P2, watcher wait list: fixed.
- P3, wording-review route: fixed.
- P4, quiet-skip staging after 3596: fixed, all in stage 2.
- P5, `not-started` status: noted, no effect.
- P6, CI job list: fixed.
- P7, session-end event names: fixed.
- P8, handoff clearing read a branch the mirror no longer fetches: fixed, it now clears at the first evidence-tagged release.
- P9, reviewer model versus the frontier design standard: fixed. The reviewer uses the registry's design pin, and the standard is cited in lessons-engaged.
- Lint trigger list now includes feedback entries.
- `not-applicable` and `inherited` answers are now sampled in the graduation criterion.

## Convergence verdict

Converged at round 7. The final round found nothing that changes what gets built; the items above are left behind with reasons. The spec amends the constitution (one article in each book), so its approval is the owner's.
