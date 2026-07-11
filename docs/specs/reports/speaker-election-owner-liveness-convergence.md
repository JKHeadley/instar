# Convergence Report — Speaker-Election Owner-Liveness

## Cross-model review: codex-cli:gpt-5.5
Ran every round (1-3); non-material throughout (alternatives-considered + terminology, both folded). No external blocker.

## ELI10 Overview
On a multi-machine setup, exactly one machine speaks for a conversation — never two (double-reply), never zero (silence). The rule "the owner wins" didn't check if the owner machine is alive, so a dead owner could silently hold the voice with nobody speaking. The naive fix ("only defer to an online owner") failed review three ways, so it was redesigned into three safe layers: fix the liveness signal so a dead peer actually expires (a real standalone bug — a dead peer's synced heartbeat file was re-stamped fresh forever); add the owner-liveness check but ship it observe-only so it changes nothing while measured; defer the actual behavior-change flip behind that soak plus a stronger "sustained dark" signal.

## Original vs Converged
The original was a one-line `pool.includes(owner)` guard. Review proved it (a) silently no-ops because the liveness signal never expires a dead peer, (b) drops `owner === self` → pool-wide silence, and (c) trades the paramount ≤1 (never double-reply) for ≥1 under split pool views. The converged design is three layers: Layer 0 (heartbeat-staleness gate, ≥2× the 30-min write cadence, lands live); Layer 1 (self-safe guard `liveOwner === self || pool.includes(liveOwner)`, dark/observe-only); Layer 2 (enforce-flip deferred to ACT-1196 behind soak + sustained-dark + downstream dedup backstops).

## Iteration Summary
| Round | Reviewers | Material findings | Conformance gate |
|-------|-----------|-------------------|------------------|
| 1 | codex + adversarial + integration | 3 (signal-pollution no-op; F2 self-silence; F1/F3 ≤1-trade) | ran (0 flags) |
| 2 | codex + adversarial/integration re-check | 1 (Layer-0 threshold mis-calibrated vs heartbeat cadence) | ran (0 flags) |
| 3 | codex(non-material) + adversarial (code-verified) | 0 material | ran (0 flags) |

## Convergence verdict
Converged at round 3. The adversarial/integration lens verified against the real code that the ≥2×-cadence Layer-0 calibration never flaps a live git-syncing peer dark while expiring a truly-dead peer, confirmed F2/F1/F3 resolved by the 3-layer redesign, checked residuals (clock-ahead dead peer fails toward online = safe; both-channel-dark is an evidence vacuum but Layer 1 is observe-only), and returned CONVERGED. codex non-material all 3 rounds; deterministic gates (Standard-A lint, conformance) clean. Zero open questions. Ships: Layer 0 live (signal honesty), Layer 1 dark/observe-only, Layer 2 (enforce) tracked ACT-1196.
