# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Added `CollaborationRedriveEngine` — a small, off-by-default monitor that fills the one verified gap in cross-agent collaboration continuity: nothing today proactively re-engages a counterpart when **they** go silent on an unfinished objective. Spec `docs/specs/collaboration-redrive-on-counterpart-silence.md` (approved by Justin 2026-05-28 after a 2-round adversarial convergence). It builds on the already-shipped Threadline Conversation Keystone (`WarrantsReplyGate` loop-safety + `ConversationStore` continuity + `CompletionEvaluator` done-judgment) — it is **not** a rebuild of any of those.

The engine sweeps active `threadline-reply` commitments on its own 5-minute cadence (NOT the PromiseBeacon tick, which only schedules beacon-enabled commitments) and, for each unfinished objective whose counterpart has been silent past a threshold, sends one bounded peer nudge. The termination guarantee is a **durable, monotonic, reply-INDEPENDENT** per-commitment counter (`redriveCount` on the Commitment record) — a counterpart reply updates `lastReplyAt` but never touches the counter, closing the mutual-re-drive hole the round-1 adversarial review caught. After the per-commitment cap (default 2), the engine raises ONE Attention-queue item and goes terminal-quiet on that commitment. Independent per-peer 24h cap, engine-wide daily fuse, per-tick fuse, finite-timestamp validation, and skip-don't-increment on name→fingerprint resolution miss provide defence-in-depth.

## What to Tell Your User

- I can now nudge another agent once or twice if they go quiet on something we're working on together, then I shut up and surface it to you — never a loop.
- It ships **OFF**. To turn it on for me, flip the collaboration-redrive enabled setting in my config to true. The other tunables (silence threshold, max nudges, per-peer cap, daily fuse) all have safe defaults.
- It only triggers on commitments I already have for "I'm waiting on agent X to do thing Y", so it has no effect outside that surface.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Proactive peer re-drive on counterpart silence | Set `monitoring.collaborationRedrive.enabled: true` (defaults: 45-min silence threshold, max 2 nudges per objective, escalate to Attention queue then stop) |

## Evidence

- Tier-1 unit tests cover both sides of every eligibility boundary (terminal status, NaN/future timestamp, silence threshold, cap, spacing window, missing peer), the load-bearing reply-independent cap (the round-1 adversarial fix), restart-survival across a fresh `CommitmentTracker` load, name-unresolved skip-don't-increment, and disabled-mode no-op.
- New fields on `Commitment`: `redriveCount?: number`, `lastRedriveAt?: string`, `lastRedriveText?: string` — additive and optional; `loadStore()` backfills `redriveCount: 0` on existing rows alongside the existing `correctionCount`/`escalated` backfill.
- Side-effects review: `upgrades/side-effects/collaboration-redrive-engine.md`.
- Spec convergence: `docs/specs/reports/collaboration-redrive-convergence.md` (2 review rounds; round 1 caught a real mutual-re-drive hole reopening the ack-loop blast radius and was fixed by switching to a reply-independent durable cap; round 2 caught a fingerprint-resolution wiring bug and was fixed).
