# Convergence Report — U4.1 Pin Persistence

## Cross-model review: codex-cli:gpt-5.5

Real GPT-tier external passes ran in rounds 1, 2, 4, and 5 (all MINOR);
gemini-2.5-pro passed in rounds 1 and 2 (MINOR; rounds 4-5 timeouts covered by
codex). Clean RAN state.

## ELI10 Overview

When the operator says "run this conversation on the Mac Mini," that choice must
survive restarts, handoffs, and network hiccups. The machinery to remember it
already exists — a durable pin store, replication, and a reconciler — but ships
switched off with real bugs. This spec graduates and hardens it instead of
building a duplicate.

## Original vs Converged

Round 1's headline: don't build a new pin system — the existing one has five real
defects (unpin never propagates so a stale copy silently re-pins; a corrupt pin
file wipes every pin and saves the empty state; the replication channel drops old
pins; nothing verifies a pinned topic actually LANDED where pinned; pins to
offline machines had no honest pending state). Round 2 found the deep ones: a
machine with a future-skewed clock could mint a pin record that beats the
operator's unpin FOREVER (fixed with a clock-skew gate and quarantine), the
reconciler could churn transfer/abort cycles toward an offline pinned machine
every 2.5 minutes silently, and the replication read window silently dropped to
the newest 500 records — the original defect would have resurfaced months later
(fixed with a boot-time full-stream fold plus incremental offsets). Round 3
corrected round 2's own fixes: refusing a skewed record at the replication door
would have wedged the peer's entire pin stream (exclusion moved to the fold), the
quarantine had to become durable — a point-in-time exclusion silently expires as
wall time catches up to the skew — and the fold's cost bound was restated
honestly with a loud 64MB byte-guard. Round 4 caught one last inversion:
dismissing the quarantine ALERT also cleared the quarantine itself, re-admitting
the poison — now, acknowledging a notification never re-admits anything;
re-admission is its own explicit per-record action. Round 5: CONVERGED.

## Iteration Summary

| Round | Reviewers | Material findings | Changes |
|---|---|---|---|
| 1 | 6 internal + codex(MINOR) + gemini(MINOR) + gate | ~6 | Reframed: graduate + fix the existing machinery — commit 63329967f |
| 2 | 2 combined panels + externals + gate (2 flags) | 6 deduped | HLC skew gate; sustained-online Case-A gating; boot-fold read design; durable rollback; knob table; live-user-channel test tier — commit ee63747b2 |
| 3 | all-lens panel | 4 | Fold-side-only skew authority; sticky durable quarantine; honest fold bound + byte-guard; joint enum with u4-2 — commit 098b30f7e |
| 4 | all-lens panel + codex(MINOR) | 1 | Ack closes the notification, never the quarantine; explicit re-admit action — commit b40aaf88d |
| 5 | confirm panel + codex(MINOR) | 0 — CONVERGED | none |

## Convergence verdict

Converged at iteration 5. The round-5 panel verified the single round-4 fold at
all four sites with no contradictions and no material findings; externals
MINOR-only. Zero open questions. Ready for approval.

Decision-completeness evidence: frontloaded-decisions 10 · cheap-tags 0 ·
contested-then-cleared 0.
