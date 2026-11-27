# Convergence Report — Unroutable-owner release

## Cross-model review: codex-cli:gpt-6.2-astra (all 6 rounds)

## ELI10 Overview

When a computer in Echo's group is wiped and comes back with a new identity, the conversations the old identity "owned" used to be stuck forever: every message to them went to a computer that no longer exists. This change teaches the machine in charge to notice an owner that can never answer (its identity was cancelled, or it is unknown here and has been silent for hours) and to take the conversation over, so messages get answered again. Moving such a conversation by hand also works now.

## Original vs Converged

The first draft let an unknown owner be taken over after 9 minutes of journal silence, bypassed the engine's dry run and the transfer's run-state question for every unroutable owner, and let a refused takeover fall through to the normal re-place path. The converged design: revoked owners are recovered immediately; unknown owners only on a sane registry, after 6 h of journal silence AND 9 min of continuously watched absence (monotonic, gap-resetting, error-resetting), with an online majority; only revoked owners bypass dry run; the transfer keeps its run-state confirmation; every router entry point (fresh inbound, drain retry, failed forward) uses one eligibility rule and keeps a refused takeover in custody; local placement policy and a version + lease check guard every claim. It also fixes a latent bug: the U4.2 mirror check read the journal with the wrong key and saw every owner as quiet.

## Iteration Summary

| Iteration | Reviewers | Material/Design findings | Changes | Cross-model |
|-----------|-----------|--------------------------|---------|-------------|
| 1 | internal (6-angle) + codex | internal 3 MATERIAL; codex 5 | registry sanity, 6 h bound, quorum, wiring test, placement check, version-conditioned CAS, unavailable registry | ok |
| 2 | internal + codex | internal 0 (converged); codex 4 | continuous-absence clock, custody on refusal, unknown-self, equal-epoch note (fb-cf44899b-73f) | ok |
| 3 | codex | 4 | one eligibility rule, forceReplace takeover, registry-error reset, explicit two-clock policy | ok |
| 4 | codex | 4 | monotonic gap-resetting clock, dryRun bypass revoked-only, malformed-timestamp = unknown, app scope | ok |
| 5 | codex | 3 | failed-forward fallback guarded, transfer targets sampled, transfer run probe kept | ok |
| 6 (cap) | codex | 3 | target-liveness precedence fixed in passing; 2 recorded below | ok |

Internal reviewer model: claude-opus-5-5 (subagent), rounds 1–2.

## Proportion

Tier 2; ~10 files, ~900 LOC incl. tests; 6 of 6 rounds used. The round count reflects a takeover-authority change on a live outage, not wording.

## Left behind

- **Queue refusal (codex r6):** if the durable inbound queue itself refuses (dark / storage failure), the router returns `acked:false` and the caller's existing fall-through delivers locally — the same as every other router custody path today. Accepted: not new behaviour, and local delivery on the lease holder is the intended degraded mode.
- **Overlapping execution on a revoked machine (codex r6):** a revoked/rebuilt machine might still run a session that produces external effects; automatic recovery accepts a possible duplicate turn there in exchange for answering the operator. No execution fence exists for a machine this pool can no longer authenticate. Accepted risk; the transfer route keeps the run-state confirmation for operator moves.
- **Equal-epoch tie-break (codex r2):** pre-existing for every force-claim path; filed fb-cf44899b-73f.
- **Precision (codex r6):** wording that the 6 h is journal age and custody is bounded — applied in passing.

## Full Findings Catalog

Recorded in the iteration log above; raw reviewer outputs kept in the authoring session scratchpad (codex-r1..r6.json).

## Convergence verdict

Converged at the Tier-2 cap: remaining design findings are accepted risks (not security or data-loss), recorded above.
