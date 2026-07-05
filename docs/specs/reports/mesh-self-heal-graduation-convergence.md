# Convergence Report — Mesh Self-Heal Graduation

## Cross-model review: codex-cli:gpt-5.5

A real GPT-5.5 external pass ran through the agent's codex CLI on every round (r1–r6). **Honest model posture (per operator directive, 2026-07-03):** codex GPT-5.5 external RAN (the strongest *accessible* OpenAI model — GPT-5.6 "Sol" is gated to ~20 orgs); the Gemini door was **UNAVAILABLE** (gemini-cli retired 2026-06-18 → Antigravity/OpenRouter reroute is tracked in spec `spec-review-model-door-currency`); internal reviewers ran on **Opus 4.8** (Claude Fable 5 is gated until ~Jul 7). This is "the strongest AVAILABLE model on each REACHABLE door," which is exactly what the directive requires — recorded here so the assurance level is an informed choice.

## ELI10 Overview

This spec turns ON (carefully) the already-written-but-dark machinery that lets one machine take over another's conversations when it dies, and hand them back when it returns — without both machines ever answering you at once. The hard part is telling "truly dead" from "temporarily unreachable" with only two machines and no referee, which is provably impossible to do perfectly. So the converged design only acts on its own when a machine is *provably dead*, hands every ambiguous case to the operator, and makes a machine that loses its connection stop serving before the other is allowed to take over. Nothing goes live without the operator's explicit, per-layer, evidence-gated go-ahead, and the final real-pair test honestly waits on the currently-offline Laptop.

## Original vs Converged

- **Originally:** a thin 4-layer plan that would force-claim a machine after "5 minutes no heartbeat + unreachable." Review showed this **force-claims a machine that is alive but merely partitioned → both machines serve you → double replies + duplicated irreversible actions.** It also named config keys that **don't exist** (would have silently no-op'd), described the 2026-06-19 zombie incident without actually solving it (that machine's heartbeat was still *advancing*), had no multi-machine-posture or self-heal-before-notify structure, no frontloaded decisions, and graduated on a calendar timer rather than evidence.
- **After convergence:** autonomous takeover is restricted to a **provably-dead** peer (heartbeat stopped beyond the max-sync-lag window); every ambiguous case (alive-partitioned, zombie, fork, asymmetric partition) is **operator-mediated**. A machine that can't confirm its lease **self-quiesces** (a hard chokepoint invariant: no serving without a recent sync-confirm) so "heartbeat stopped" becomes a safe proxy for "not serving." Epoch minting is holder-serialized with sync-confirm-before-act and fail-closed-on-fork (honestly admitting Git is not a distributed lock, with a named cloud-arbiter as the future closer). All config keys are re-grounded to real code; hand-back uses epoch-bound single-use Ed25519 consent tokens with a **bounded** (pruned) nonce ledger; a runtime double-serve detector sits at the send chokepoint; graduation is evidence-gated (objective CORRECT/WRONG/UNKNOWN soak labels, UNKNOWN ≤20%, synthetic ≤40%, ≥1 real episode) and operator-authorized per layer; the three foundation specs' prerequisites are bound as blocking gates; and the Laptop-offline live-verify blocker is stated honestly.

## Iteration Summary

| Round | Reviewers | Material findings | Key changes |
|-------|-----------|-------------------|-------------|
| 1 | 6 internal + codex | 5 critical + 2 mandatory-check fails | full rewrite: positive-death/zombie/alive predicates, epoch fence + double-serve detector, multi-machine posture, self-heal-before-notify + P19, 16 frontloaded decisions, evidence gates, foundation prerequisites, correct config keys |
| 2 | codex (MINOR) | 5 | explicit consistency model, N=2 tradeoff, zombie corroboration window, objective soak labels, etcd rationale |
| 3 | codex (SERIOUS) | 1 real (epoch overclaim) + refinements | holder-serialized minting + sync-confirm-before-act; zombie→operator-confirmed; UNKNOWN label; glossary + dependency table; cloud-arbiter comparison |
| 4 | codex (SERIOUS) | 1 contradiction (self-introduced) + 1 subtlety | fixed zombie contradiction; authority scoped to provably-dead-only + operator-mediated-otherwise; availability SLO; fault-injection soak; appendix |
| 5 | 6 internal + codex (MINOR) | 1 (nonce-ledger retention) | bounded nonce prune; self-report epoch+freshness binding; F2 full path — internal panel converged on all 6 lenses |
| 6 | codex (MINOR) | refinements (all addressed) | self-quiesce as hard invariant + named test; concrete soak numbers; zombie self-report → operator-mediated; flap denominator source |

## Full Findings Catalog

Round 1 (internal, 5 critical): (1) force-claim on alive-but-partitioned → double-serve [4 reviewers]; (2) wrong config keys → silent no-op; (3) zombie predicate missing (2026-06-19 heartbeat was advancing); (4) no multi-machine posture + no self-heal-before-notify/P19 on Layer 4 (both mandatory checks failed); (5) 16 stop-and-ask decisions with no Frontloaded Decisions section; plus timer-gated graduation contradicting the foundations, dropped foundation prerequisites, and the Laptop-offline blocker. Codex r1 independently corroborated (lease authority/fencing, split-brain, QuotaTracker-under-partition, consent→atomic-transfer, reconciler idempotency).

Rounds 2–6 (codex-driven refinement, all resolved): explicit git-store consistency model; the epoch-minting serialization gap (Git ≠ lock) → holder-serialized + sync-confirm + fail-closed-on-fork + scoped to dead-peer-only; zombie evidence is absence-style → operator-confirmed; serving-while-sync-wedged double-serve vector → self-quiesce hard invariant; soak repeatability → objective labels + UNKNOWN class + concrete thresholds; nonce-ledger unbounded growth → bounded prune; availability SLO + user-visible degraded behavior; complexity budget + F18a-promotion-trigger; glossary/appendix for legibility. Internal round-5 panel: security / adversarial / integration+mandatory / decision-completeness / lessons-foundation all returned "converged"; scalability returned one LOW-material finding (nonce retention), now fixed.

## Convergence verdict

**Converged at round 6.** The internal six-reviewer panel converged in round 5 (its sole material finding fixed); the external codex pass settled into the MINOR band across rounds 5–6 with each finding a progressively narrower refinement, all addressed. Remaining codex observations are documented accepted-tradeoffs (the 2-node-no-arbiter consistency-over-availability limit, closed only by the future cloud arbiter F18a) or implementation details owned by the bound foundation specs — not unaddressed defects. The spec is ready for operator review and `approved: true`.

**Operator note before approval:** this graduates REAL cross-machine authority (moving live conversations, handing back leases). Per F1 the dark→live flip is the operator's action alone, per-layer, evidence-gated. The final real-pair live-verify (Phase 4) is BLOCKED until the Laptop is online.
