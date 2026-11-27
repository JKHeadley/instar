# Convergence Report — signed requests between machines name their route and the machine they are for

## Cross-model review: codex-cli:gpt-6.2-astra

Eighteen rounds. GPT never returned a clean verdict: every round after the design was simplified found a smaller edge case, and every finding was applied. The Chief of Staff decided on 2026-11-21 at 14:47Z to stop reviewing and build step one only, with steps two and three coming back for separate approval.

## ELI10 Overview

Your agent's computers sign the messages they send each other, but the signature does not say which computer a message is for or what it asks. Someone who copies a message could send it to another of your computers as a different request. The fix adds a second signature that names both, in three releases: first every computer checks it, then every computer sends it, and last they refuse messages without it.

## Original vs Converged

The first draft switched the whole pool from the old signature to the new one at runtime, coordinated between machines. Review showed that switch needed its own agreement protocol (who writes, how decisions are ordered, how a removed machine's decisions are checked), which is far more than a medium finding warrants. The converged design advances the three stages by release defaults, so no machine has to agree with another while running, and every mix of versions keeps working.

## Iteration Summary

- Rounds 1-11: per-peer capability adverts, a sticky record of having seen the new form, and then a runtime pool switch with evidence reports, probes and a policy chain. Each was replaced after review.
- Round 12: the release-staged design. Internal reviewer: CONVERGED from round 13 on, re-confirmed at the final head.
- Rounds 12-18: GPT findings on the stage-3 owner path, the lead exemption, replay state, exception delivery and wording, all applied.
- Standards-Conformance Gate: ran every round (final rounds 1-2 flags, all addressed in text or recorded below).

## Proportion

Step one, the only part built now, adds acceptance of a new header and refuses nothing an old machine sends. The owner-facing machinery in the design belongs to stage 3 and is not built until the Chief of Staff approves it.

## Left behind

GPT round 18, each with how it was handled:
- Authorization can change during the lease pull: the post-pull recheck now includes the sender's active status and key (section 2).
- An old lead needs a working return path: a failed pull is reported as "couldn't reach the lead machine to check", separately from a verified old lead, and the asymmetric case is in the mixed-pool test.
- Acknowledged approvals can be lost on same-identity recovery: a machine restored from a snapshot reconciles exception records with a peer before admitting anything under an exception.
- Session selection trust: the update request names a listed session; the target machine is authenticated by the relay's envelope signature and signed ack, so a wrong id from the unsigned list can at most misdirect within that machine.

Constitution flags at the final round: Security Fixes Keep the Experience Whole (stage 3 adds an owner step for a medium finding; the Chief of Staff's decision to refuse the old form at stage 3 is the basis, and stage 3 needs his separate yes), and Judgment Within Floors (fixed exception lengths and wait; an owner-picked end date was added).

## Full Findings Catalog

Recorded in the session handoff ledger and the commit history of the branch, one commit per round.

## Convergence verdict

Internal reviewer converged; GPT not clean after 18 rounds, all findings applied. Building step one on the Chief of Staff's decision of 2026-11-21 14:47Z.
