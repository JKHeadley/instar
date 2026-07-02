# Convergence Report — U4.4 Lease Hand-Back to the Preferred Captain

## Cross-model review: codex-cli:gpt-5.5

Real GPT-tier external passes ran in rounds 1, 2, and 3 (all MINOR); gemini-2.5-pro
passed in rounds 1 and 2 (MINOR; one round-3 timeout, covered by codex). Clean RAN
state.

## ELI10 Overview

After a failover moves "who's in charge" off the always-on Mac Mini to the
sleep-prone Laptop, nothing hands the role back when the Mini recovers — the mesh
drifts onto the wrong long-term machine until a human intervenes. This spec is the
missing reconciler: after the preferred captain has been continuously healthy for
ten minutes, the current holder offers the role back; the transfer happens at a
quiet moment with queued messages drained across; and a deliberate human move
always wins — a manual flip latches the automation off for a day.

## Original vs Converged

The original draft invented a second "preferred machine" setting in replicated
data — killed as both a competing authority (one already exists in config, and
three other subsystems key on it) and a forgeable one (an unsigned field in
replicated state). Review also found the draft's hand-off ordering could leave
ZERO machines in charge — nobody polling Telegram, the silent-loss class caused by
the healer itself — replaced by claim-before-release built on a signed, epoch-bound,
single-use consent token the current holder issues (an extension of the exact
mechanism the codebase already uses for stale-holder takeover). Later rounds added:
the offer's full wire contract with typed refusals and fail-closed version-skew
behavior; offer backoff and an episode cap so a slowly-oscillating captain can't
ping-pong the role under the existing flip breaker's radar; a mechanical definition
of "the human moved it on purpose" (the latch is written by the flip action itself,
never inferred); queue draining before step-down; a post-transfer delivery-canary
verification; and the hard dependency on poller-follows-lease so the role can never
move while Telegram polling stays behind. Ships hard-dark in the action-bearing
category like its three sibling lease-authority features, ungated only after a live
two-machine drive.

## Iteration Summary

| Round | Reviewers | Material findings | Changes |
|---|---|---|---|
| 1 | 6 internal + codex(MINOR) + gemini(MINOR) + gate (4 flags) | ~8 deduped | Reuse F4 authority; claim-before-release; operator latch; episode caps; pollFollowsLease dependency — commit e85f75365 |
| 2 | 2 combined panels + externals | 6 deduped | Consent-token canAcquire branch; full offer RPC contract; DARK_GATE_EXCLUSIONS registry correction; latch write-by-flip-action; drain-before-stepdown; offer metering — commit 2737fc4b5 |
| 3 | all-lens panel + codex(MINOR) | 0 — CONVERGED | none |

## Convergence verdict

Converged at iteration 3. The round-3 panel verified every round-2 fold against
real code (consent-token seam mirrors the shipped takeover-opts shape; the
action-bearing registry location; the real inbound queue for draining; the exact
constitutional parent heading) and found no material findings. Zero open
questions. Ready for approval.

Decision-completeness evidence: frontloaded-decisions 9 · cheap-tags 0 ·
contested-then-cleared 2.
