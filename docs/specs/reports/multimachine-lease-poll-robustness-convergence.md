# Convergence Report — Multi-Machine Lease & Poll-Ownership Robustness

## ⚠ Cross-model review: UNAVAILABLE

No supported external (non-Claude) reviewer was installed/authed. `codex` is not installed (`codex-not-installed`); `gemini` is installed but returns a license error (`You do not have a valid license of this product` — `gemini-license-invalid`). Convergence ran on the six internal Claude reviewers + the Standards-Conformance Gate ONLY. Remediation to restore the external pass: `npm i -g @openai/codex && codex login`, or resolve the gemini license. The reduced-assurance state is recorded so approval is an informed choice.

## ELI10 Overview

I run as one assistant across two computers. Only one should be "awake" and listening for your Telegram messages at a time. All of June 20 that broke three ways — both computers answering, neither answering (hours of silence), and the "who's awake" badge flip-flopping. Phase 0 patched it live by hand (we named one computer the default captain, re-synced the clocks). This spec makes the fix permanent and structural.

It does five connected things: (1) tie "who listens" to "who's awake" so they can't drift apart (cautious to start a listener, instant to stop one); (2) a circuit-breaker that freezes the badge to a deliberate choice if it flip-flops too much; (3) stop the awake computer needlessly re-minting its badge every two minutes (a timing bug) — but only renew when it can actually confirm with the peer, never blindly; (4) measure clock drift between computers and warn BEFORE the 30-second cliff where they stop trusting each other (the real overnight trigger); (5) a health check that flags zero-or-two listeners, using Telegram's own "someone's already listening" signal as partition-proof ground truth.

Everything ships off-on-the-fleet / on-for-me-first, each with an instant off-switch. The deepest root cause (two computers with no shared referee for the badge) is a bigger redesign left for later; this is a correct, bounded, fail-safe workaround.

## Original vs Converged

The original draft was directionally right but had two genuinely dangerous bugs and several under-specified decisions that the review caught BEFORE any code:

- **"Keep the same badge" could have caused two captains.** Originally, an awake computer whose badge briefly lapsed would just re-stamp the same badge if it "saw no higher badge from the peer." But a computer cut off by a network split *sees nothing by definition* — so it would wrongly keep acting as captain while the other computer had legitimately taken over. The converged spec requires the renewal to be *actually confirmed with the peer over a real shared channel* first, and explicitly forbids treating a purely-local file write as confirmation. A cut-off computer now safely steps down instead.
- **A "safety" timing check would have refused to boot every computer.** The original proposed rejecting "incoherent" timing config at startup — but the default config already trips that check, so it would have refused to start fleet-wide. Converged: it's a silent auto-correct that can never block startup, on its own off-switch (not default-on).
- **Tying listening to a flappy badge could deepen the silence.** Converged spec enforces a build/rollout ORDER (fix the clock + badge first, then the flip-breaker, then listening-follows-badge LAST and only when the breaker is live) and uses Telegram's own conflict signal as partition-proof ground truth.
- **Every "decide later" became "decided now":** exact debounce (20s, skipped on genuine failover), clock-alarm threshold (20s = ⅔ of the 30s cliff), flip thresholds, staleness bounds, and the flag posture (on-for-dev / dark-for-fleet, not literal off) are all frontloaded.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware | ~30 (1 CRITICAL, ~10 HIGH) | Full rewrite: added 12 Frontloaded Decisions; corrected B3 (confirmed-renew, decoupled timer, never-throw); B1 (409-gate, fail-closed intent, Phase-0 pin migration); B2 (deterministic latch); B4 (round-trip + self-blame + routerReceivedAt migration); B5 (three-valued + 409); enforced rollout order; partition fault-injection + burst tests; migration-parity specifics. |
| 2 | adversarial, decision-completeness, lessons-aware (convergence verify) | 0 material | none (2 cosmetic polishes applied) |

Standards-Conformance Gate: ran (0 flags) on round 1.

## Full Findings Catalog (round 1 → resolution)

- **CRITICAL — B3 blind same-epoch renew → split-brain** (adversarial): resolved — Decision 3 requires confirmed-medium renew, excludes `LocalLeaseStore.refresh()`, preserves the monotonic self-fence, staleness-bounded.
- **HIGH — renew "tick" is a hardcoded 120s constant; default TTL 60s; a reject invariant breaks fleet boot** (integration F-CLAMP1): resolved — Decision 2 dedicated renew timer `clamp(TTL×0.5,[5s,60s])`, never throws.
- **HIGH — B1 partition dual-poll** (adversarial B1-F1): resolved — Decisions 4/11 gate on peer-poll-state + the partition-immune Telegram 409.
- **HIGH — B1 stale/prior-boot intent file** (adversarial B1-F2, security F1/F6): resolved — Decision 5 PID/bootId/ts freshness, atomic write, fail-closed-to-mute, boot writes false.
- **HIGH — B2 latch into uncorrelated snapshot → 0-or-2 awake** (adversarial B2-F1, scalability F8): resolved — Decision 8 deterministic latch to preferredAwakeMachineId + hard cap + HIGH Attention terminal.
- **HIGH — B4 N=2 skew mutual-blame; EWMA hides step-skew; measurement channel dies past 30s** (adversarial B4-F1/F2/F3): resolved — Decision 9 round-trip + own-NTP self-blame + max(ewma,last) + pre-verification read.
- **HIGH — B4 lease liveness uses skew-contaminated lastSeen (flap root)** (adversarial B4-F4): resolved — Decision 10 routerReceivedAt migration (PRIMARY) + offset-subtraction fallback.
- **HIGH — flag posture "default off" vs dev-gate idiom** (decision F11): resolved — Decision 1 omit-enabled + dryRun.
- **HIGH — B3 clamp default-on = uncaged fleet timing change** (decision F9, integration F-RB2): resolved — flag-gated, not default-on.
- **HIGH — B1 truth table + Phase-0 pin reinterpretation** (decision F6): resolved — Decisions 4/7 explicit dual-poll-prevention.
- **HIGH — B1 couples to flappy lease; 20s can't damp 2-min flap** (lessons F2, scalability F1): resolved — Decision 12 B1-requires-B2+B5 + runtime no-op guard.
- **MED — migration parity (applyDefaults framing, guard-manifest lint, generateClaudeMd+migrateClaudeMd)** (integration F-MP1/2/3): resolved — Testing/migration section specifics.
- **MED — coherence postures undeclared (poll-intent machine-local, B5 pool-scoped dark-peer-tolerant, B4/B2 postures)** (integration F-CC1..4): resolved — each item declares posture.
- **MED — Attention flood / dedup keys / burst test** (lessons F3, decision F12): resolved — stable dedupKeys + burst-invariant test.
- **MED — B5 derives poll state from server belief not lifeline actual; wire-compat missing field** (adversarial B5-F3, decision F10): resolved — Decision 6 lifeline-poll-active.json + Decision 11 missing-field=unknown.
- **MED — P14 temporary-success framing** (lessons F1): resolved — B3 "Foundation honesty" paragraph.
- Lower-severity (security F5 unauth /health leak, scalability F4 side-effect amplification, decision F1 no-loss): resolved/addressed via the decoupled timer, Bearer-only raw fields, and immediate-failover-start.

## Convergence verdict

Converged at iteration 2. Three independent convergence reviewers (adversarial, decision-completeness, lessons-aware) each verdict CONVERGED, verified against the v1.3.632 code: no material findings in the final round, all round-1 CRITICAL/HIGH genuinely resolved, no new material issues introduced. `## Open questions` is empty. Spec is ready for build under the operator's standing pre-approval (24h autonomous run); the rendered ELI16 is delivered to the operator for visibility.
