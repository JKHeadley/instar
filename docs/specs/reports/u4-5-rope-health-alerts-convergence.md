# Convergence Report — U4.5 Rope-Health Alerts

## Cross-model review: codex-cli:gpt-5.5

Real GPT-tier external passes ran in rounds 1, 2, 3, and 4 (round 1 SERIOUS —
folded; thereafter MINOR); gemini-2.5-pro passed in rounds 1, 3 (MINOR) and 4
(CLEAN). Clean RAN state.

## ELI10 Overview

Transport degradation between the agent's machines is silent today — a Tailscale
key can expire, a rope can die, a genuine partition can brew, and the operator
learns about it only when messages start failing. This adds a small in-server
monitor: routine degradations become one calm line in the existing daily digest;
only a verified partition to a machine that should be online raises one attention
item per episode; and a laptop lid-close can never page anyone.

## Original vs Converged

The original draft bolted alerting onto a once-daily audit script that lives
outside the product — structurally unable to deliver a prompt partition alert,
unable to remember state between runs, and unshippable to other agents. The
converged design is a productized in-server monitor with durable episode memory.
The hardest catch (round 2): the signal the draft used to distinguish "laptop
asleep" from "genuine partition" does not exist in the codebase — the converged
discriminator is the slow heartbeat each machine writes through a channel
independent of the mesh: still advancing while every rope is down means alive but
unreachable (a real partition); stopped means asleep or off (a digest note, never
an alarm). Round 3 forced the definition of "advancing" to be onset-anchored —
a fresh-LOOKING pre-sleep heartbeat immediately after a lid-close classifies as
offline, never urgent — and forced the spec to state its honest detection latency
(a genuine partition is confirmed in roughly 30-90 minutes, bounded by the
heartbeat and sync cadences; the 60-second debounce is only a flap filter). Round 3
also caught a factual error about the job-template precedent this spec cites: the
real precedent ships disabled, and this spec now states its enabled-with-silent-
fallback posture as a deliberate, argued divergence. Round 4 verified everything
and found only two leftover sentences still crediting the wrong precedent — fixed
and deterministically re-verified (every remaining mention states the divergence).

## Iteration Summary

| Round | Reviewers | Material findings | Changes |
|---|---|---|---|
| 1 | 6 internal + codex(SERIOUS) + gemini(MINOR) + gate (2 flags) | ~5 | Productized monitor; sleep-aware urgency; honest partition semantics; U4.3 hard dependency — commit e85f75365 |
| 2 | 2 combined panels + externals | 6 deduped | Heartbeat discriminator (the named sleep signal doesn't exist); monitor-owned loop; tailscale exec source; digest topic config; persistence discipline — commit 2737fc4b5 |
| 3 | all-lens panel + externals (MINOR) | 2 | Advancement-since-onset semantics + honest ~30-90 min urgent latency; truthful job-template precedent with argued divergence — commit 5c9fc1da3 |
| 4 | confirm panel + codex(MINOR) + gemini(CLEAN) | 1 (mechanical residue) | Two stale precedent attributions reworded; index sketch marked historical — commit d0d465093 |
| 5 | deterministic verification | 0 — CONVERGED | none (grep-verified: every remaining precedent mention states the divergence; the round-4 panel had specified the exact fix) |

## Convergence verdict

Converged at iteration 5. Round 4's single finding was a two-sentence wording
residue whose exact fix the panel specified; it was applied and verified
deterministically (all sites now consistent with §2's corrected precedent
paragraph). Externals: codex MINOR, gemini CLEAN on the final body class. Zero
open questions. Ready for approval.

Decision-completeness evidence: frontloaded-decisions 7 · cheap-tags 0 ·
contested-then-cleared 2.
