---
title: "Convergence report — Live credential re-pointing rebalancer"
spec: "docs/specs/live-credential-repointing-rebalancer.md"
status: converged
rounds: 5
grounding-base: "canonical JKHeadley/main v1.3.488 (7526bb5ea)"
date: 2026-06-12
---

# Convergence report — Live credential re-pointing rebalancer

**Verdict: CONVERGED after 5 rounds.** Material-findings trend **50 → 22 → 12 → 5 → 0**. Final
round (R5): premise/mechanism reviewer "PREMISE CONVERGED"; adversarial reviewer "CONVERGED — no
new material breaks". No architecture break was found in any round; every finding was a bounded
refinement folded into the next revision.

## Panel

Each round ran grounded reviewers (read the spec AND the real code on canonical main v1.3.488),
including the LRN-007 **premise / challenge-the-mechanism** reviewer dogfooded for the first time
here. Lenses across the rounds: premise/mechanism, security/containment, concurrency/crash-safety,
code-grounding, adversarial, instar-standards/conformance.

## What the premise reviewer forced (LRN-007 in action)

The predecessor spec (`reset-proximity-drain-rebalancer.md` rev 7) spent 7 rounds hardening a
**restart-based** mechanism — which Justin then challenged and overturned. This spec opens with a
mandatory premise review (§0) and, in R1, the premise reviewer refused to accept rev-1's "PROVEN"
claims as merely-consistent-with evidence. The premise was settled by **live experiments on the
machine** (§0.c):
- **E1** per-slot probe works and is side-effect-free.
- **E2** Anthropic rotation is real (`rotated:true`, 8h access token) — confirms the "one lineage,
  one home" constraint as fact.
- **E3** a running session re-reads its credential store per request (corrupt the access token →
  next message self-heals via refresh) — the load-bearing proof that a swap actuates on the next
  API call, restart-free.
- **E4/E4a/E4b** a real swap under a live session is non-disruptive; `claude auth status` is a
  LYING oracle (reads config metadata, not the credential); `GET /api/oauth/profile` is the true
  identity oracle.

This is the LRN-007 discipline — challenge the mechanism, verify against the live system — applied
to my own work, and it replaced a heavyweight restart design with a light credential-re-pointing
one before any code was written.

## Findings by round (material+)

### Round 1 (~50) — premise + design grounding
Settled the premise via E1–E4b; consumer-census of every `configHome` reader; killed the
refresh-token-identity verify in favor of account-identity; surfaced the legacy `AccountSwitcher`
credential writer; established staging-escrow crash-safety.

### Round 2 (4 blocking + ~22 material)
- **BLOCKING** dev-gate registry: rev 2's `DEV_GATED_FEATURES`+omitted-`enabled` would resolve
  LIVE-with-credential-writes on Echo (`resolveDevAgentGate = explicitEnabled ?? !!developmentAgent`)
  → moved to `DARK_GATE_EXCLUSIONS` destructive, explicit `enabled:false`+`dryRun:true`.
- **BLOCKING** source-slot client-write strand → §2.3.1a CAS re-read before the destructive write.
- **BLOCKING** env-token applicability (would the feature be inert?) → settled with LIVE evidence
  (`config.anthropicApiKey` empty ⇒ sessions read the store ⇒ feature is real for this deployment).
- **BLOCKING** per-slot lock must be a structural funnel covering the QuotaPoller 401-refresh, not
  just the swap executor.
- Material: oracle-unavailable→quarantine-never-repair; staging retained-until-delayed-re-verify;
  legacy Frankenstein-blob writer refusal relocated to the manager; error-string token scrubbing;
  boot-recovery under the mutex; wall-rescue vs drain cooldowns; oracle MITM cross-check.

### Round 3 (~12) — the §0.g meta-pattern
Round 3's signal: each rev-3 **bypass** (wall-override, dead/quarantined-default eviction,
restore-enrollment quarantine bypass) was correct for its case but **uncapped** for the adversarial
case. Generalized into **§0.g — every guard bypass carries its own cap** (own budget + preserve
unnamed preconditions + surfaced "no safe action" terminal state). Also: env-token gate must cover
non-OAuth API keys + the live fleet; the credential-write funnel/lint must name BOTH keychain write
primitives (`defaultCredentialStore.write` AND `KeychainCredentialProvider.writeCredentials`'s
`security -i` stdin form); funneled refresh needs a bounded fetch + try-lock-with-timeout.

### Round 4 (~5) — honesty of residuals + one new guard
All bounded refinements, no mechanism change: wall-rescue "target died after last clean audit" and
the correlated-outage default floor were over-claimed → restated as honestly-bounded §6 risk rows;
restore-enrollment gained an identity-coherence check so a parseable-but-Frankenstein blob is parked
one-directionally, never exchanged into a healthy slot; the manual `force:true` lever got its own
§0.g budget. One **grounding error I introduced in rev-3's §2.10** (claiming the interactive-pool
lane sources its token from server env) was caught and corrected — all launch lanes key on the
single `config.anthropicApiKey`.

### Round 5 (0) — CLEAN
Premise reviewer verified the §2.10 correction line-by-line against `SessionManager.ts` and
declared PREMISE CONVERGED. Adversarial reviewer confirmed all R4 carry-forwards closed or
honestly-bounded with named blast radius, swept §0.g (no remaining uncapped bypass), and found no
new material break. One non-material lint-scoping note (scope the `add-generic-password` literal
match to the Claude-credentials service) folded.

## Standards posture (instar-standards reviewer: CONVERGED)

Migration Parity (config + both CLAUDE.md sites + CapabilityIndex), Testing Integrity (all three
tiers + livetest battery + wiring-integrity + Bounded-Notification-Surface burst test),
Observable Intelligence + Token-Audit Completeness (feature-metrics attribution, metered oracle
probes, no-token-material scrub funnel), Signal-vs-Authority (Tier-0 justified; manual levers are
detective+non-suppressible, not signal-mislabeled), No Silent Degradation (unknown-mode,
ordered rollback, `dark-with-divergent-ledger`), Dev-Agent Dogfood + Graduated Rollout +
Close-the-Loop (dry-run-first on Echo, maturation track).

## Build sequencing (§0.e alt-5)

One spec, two shippable increments: **A** = swap-primitive + ledger + identity oracle + manual
levers (delivers the zero-touch default-flip + reactive rescue, smallest authority surface, gated
dry-run→live first); **B** = the autonomous drain balancer (the goal-1 stock-trader loop), promoted
only after A is live-on-Echo and stable.

## Residuals stated honestly (not closed — bounded)

- At-expiry in-memory client write-back (§0.c) — the one empirically-unsettled premise; treated as
  live (scheduled identity audit detects, dogfood settles it with a disposable grant); blast radius
  one re-auth.
- Wall-rescue target dying after its last clean audit — recency gate narrows, not closes; blast
  radius = victim slot quarantined + one re-auth, surfaced.
- Correlated oracle outage — the default floor guarantees "no worse / last-known-good + attention",
  not certified liveness.
- Coordinated blob+identity MITM on `api.anthropic.com` — inherited-from-client residual (the
  client is unpinned too); pool-membership is the floor.

## Next step

Human approval gate (Justin) before build — instar self-modification. Approval authorizes the BUILD
(ships dark/off); enabling it is a separate later decision.
