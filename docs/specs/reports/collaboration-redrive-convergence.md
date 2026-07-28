# Convergence Report — Collaboration Re-Drive on Counterpart Silence

**Spec:** `docs/specs/collaboration-redrive-on-counterpart-silence.md`
**Converged:** 2026-05-28T18:38:23Z · 2 review rounds · owner: echo
**Status:** converged, awaiting Justin's `approved: true`.

## What this is (plain English)
The agent already won't loop (WarrantsReplyGate kills ack-storms — verified live, 32 suppressions on Echo's node) and already resumes an unfinished conversation when the other side replies. The one missing piece: if the OTHER agent goes silent on a shared unfinished objective, nothing pokes them. This adds a small, off-by-default engine that sends at most a couple of bounded nudges to a silent collaborator, then escalates to the operator and stops — never spinning.

## Why it was specced, not just built
Autonomously sending unprompted messages to another agent is the exact blast radius behind past incidents (echo↔codey ack-loop; the $452 runaway-LLM cost). So it gets the full review-then-approve gate. The review earned its keep — see round 1.

## Round 1 — adversarial / loop-safety (9 findings, 3 blocking)
The draft asserted loop-safety the code didn't provide. Blocking findings folded:
1. **`redriveCount` didn't exist** as a durable field → cap unimplementable. Fixed: enumerated all write sites + `loadStore()` backfill + `(redriveCount ?? 0)`.
2. **Restart amnesia** — cap/spacing must persist to `commitments.json` via `mutate()`, never PromiseBeacon hot-state. Fixed + reload-survival test required.
3. **Mutual re-drive defeated a silence-gated cap** — a nudge engineered to pass the peer's WarrantsReplyGate provokes a reply that refreshes `lastReplyAt`, so a cap that only increments after silence never trips → reopened the ack-loop. **Fixed (load-bearing):** the cap is now a durable, **reply-INDEPENDENT, monotonic** per-commitment counter; a reply resets the silence clock ONLY. Added per-peer 24h cap + engine-wide daily fuse + per-tick fuse.
Plus should-fix: evaluator-throw never produces an uncounted send; finite-timestamp validation + sleep/wake per-tick fuse; the novelty guard demoted to a decorative tiebreaker (an LLM peer can reword to evade Jaccard, so it is NOT relied on for termination); and the engine runs its OWN sweep (the beacon only ticks beacon-enabled commitments, which most threadline-reply commitments are not).

## Round 2 — loop re-check + standards + integration (1 blocking, foldable)
- **Loop-bound RE-CHECK: PASSES.** Mutual re-drive provably terminates — each side emits ≤ maxRedrives on the objective regardless of replies; total traffic bounded; multi-objective amplification capped by the per-peer 24h + engine-wide fuses. This was the convergence signal.
- **[BLOCKING, fixed] `relatedAgentFingerprint` was a phantom field.** The commitment stores `relatedAgent` as a display NAME; `sendPlaintext` needs a fingerprint. v3 adds an explicit name→fingerprint resolution via `known-agents.json` (inverse of the server.ts:7535-7547 resolver) with a skip-don't-increment-don't-send failure mode.
- **[fixed] Testing Integrity** — all three tiers now named explicitly (Tier-3 flagship is N/A with no routes → substituted a production-init harness), both-sides-of-boundary cases enumerated, plus restart-survival + reply-independence regression tests.
- **[fixed] Agent Awareness** — added `generateClaudeMd()` + `migrateClaudeMd()` as shipping deliverables.

## Verified-real integration anchors (grounded against fresh main v1.3.63)
`commitmentTracker.getActive()` (CommitmentTracker.ts:629), `mutate()` CAS (1158), `markReplyArrived()` updates only lastReplyAt (541-548), `threadlineRelayClient.sendPlaintext(fingerprint,text,threadId)` (ThreadlineClient.ts:263; precedent server.ts:7560), Attention queue + `CollaborationSurfacer` real. `redriveCount`/`lastRedriveAt` are genuinely new (3 write sites + backfill).

## Open questions for Justin (Part 4 of the spec)
1. `maxRedrives` = 2 or 1? 2. silence threshold 45m fixed or objective-cadence-scaled? 3. nudge text template-only vs one-line LLM restatement? 4. its own small initiative vs folded under CMT-493?

## Recommendation
Approve to build (set `approved: true`), or steer the four open questions first. Ships OFF; dogfood on Echo before any fleet rollout. Estimated build: one `CollaborationRedriveEngine` + commitment-field additions + config + 3-tier tests + CLAUDE.md template note — a single bounded PR.
