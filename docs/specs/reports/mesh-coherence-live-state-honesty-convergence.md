# Convergence Report — Mesh Coherence: Live-State Honesty

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex-cli, gpt-5.5) AND a Gemini-tier pass (gemini-cli, gemini-2.5-pro) ran on every round. Both returned MINOR ISSUES on the final round (no design defects); all of their material points were folded in. Clean cross-model posture.

## ELI10 Overview

Instar can run across two machines, and a config flag (`meshTransport`) decides whether the cross-machine "ropes" (Tailscale/LAN) are live. There's a startup check that's supposed to warn the operator when the config and the *actual running state* disagree — but it only ever read the config, so it could cheerfully report "all clear" while the live server was in a worst-of-both state (e.g. the operator flipped the flag off without restarting, so the process is still bound wide). An advisory that lies is worse than silence.

This spec makes that check honest: a small, signal-only, dark-gated periodic check compares the **config's intent** against the **live running state** (the resolved bind host + whether the machine is actually advertising mesh endpoints) and logs a truthful warning when they diverge — never blocking anything, just telling the truth. It also fixes a long-dead config check that validated a key (`priorities`) that never existed, replacing it with validation of the real rope-priority keys.

Nothing changes for users unless an operator turns the dark flag on; then they get accurate warnings instead of a false "all clear." The tradeoff weighed across review: keep it strictly signal-only and self-healing (it never stops observing, even under a corrupt registry) rather than adding heavier machinery.

## Original vs Converged

The original spec had the right intent but several real defects that three review rounds caught and fixed:

- **Originally** it kept a "latch" to know when the mesh first advertised — but the advertise function returns nothing, so the latch could never be set reliably. **Converted** to a monotonic `process.uptime()` warmup grace (no latch needed).
- **Originally** "mesh is up" meant the bind host was a wildcard (`0.0.0.0`/`::`). **Converted** to "not loopback," because an operator can bind a specific non-loopback host — the wildcard-only test would have stayed silent on exactly the flip-without-restart case the check exists to catch.
- **Originally** the dev-gate flag was read wrong (the whole config block was passed where a boolean was expected), which would have turned the feature ON for the entire fleet the moment any tuning knob was set — defeating the dark gate. **Fixed** to read `.enabled`.
- **Originally** the failure path (corrupt registry) was swallowed silently. **Converted** to a transition-gated `error` metric + a half-open breaker (backoff that re-probes and self-heals) — observable and bounded, but never goes blind.
- **Originally** tuning knobs (`warmupGraceMs`/`emitCap`) were declared but never read. **Fixed** to actually thread them through.

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Spec changes |
|-------|-----------------------|-------------------|--------------|
| 1 | conformance gate, security, scalability, adversarial, integration, decision-completeness, codex, gemini (lessons clean) | 9 (de-dup deferral, latch unworkable, boundHost plumbing, no-leak invariant, b.2 overclaim, dead priorities dict, anchors, configPath) | M1–M9: undefer de-dup → transition-only emit + metric; drop latch → monotonic uptime; b.1 boundWide-primary + no-leak; reword b.2; drop dead dict + retype; fix anchors; nested configPath + types add |
| 2 | conformance gate, scalability, adversarial, integration, lessons (security/decision-completeness/gemini clean-ish) | 5 (3 HIGH wiring-snippet bugs + dead knobs + failure-path) | M8 gate `?.enabled`; M9 `let` outer-scope bindHost; M10 boundWide=not-loopback; M1 failure metric+backoff; M2 wire knobs |
| 3 | conformance gate, lessons, codex (adversarial/integration/decision-completeness = CONVERGED) | 2 small (transition-gate error metric; recomputed-boundHost doc) + advisory breaker framing | Transition-gate the error metric (half-open breaker framing); document recomputed-boundHost limitation; de-defer prose. Gate → 0 violations. |
| — | (converged) | 0 | none |

## Full Findings Catalog

Round-1 (M1–M9) and Round-2 (M1/M2/M8/M9/M10 + docs) findings + resolutions are recorded in `SPEC-CONVERGE-SYNTHESIS.md` and `SPEC-CONVERGE-R2-FINDINGS.md` (worktree root). Round-3 (final):

- **lessons (MATERIAL):** error metric was emitted per-attempt → unbounded-rate. **Resolved:** transition-gated to one `error` row per healthy→failing episode (`_meshCoherenceFailing` latch); recovery visible via the next success tick. emitCap-on-error thereby moot.
- **lessons + adversarial + gate (breaker question):** verdict = keep capped backoff, NOT a hard-stop breaker (a signal-only observer that stops goes blind). **Resolved:** framed as a half-open breaker (backoff + breaker + cap) with the blind-observer rationale recorded in-code; conformance gate then cleared.
- **codex external #1 (boundWide loopback breadth):** **Resolved/affirmed** — boundWide mirrors the canonical `isLoopback` (`MeshUrlAdvertiser.ts:229`), which integration confirmed uses the same literal set; documented as a deliberate mirror.
- **codex external #2 (recomputed-not-observed boundHost):** **Resolved** — documented as an accepted limitation of a boot-constant signal.
- **adversarial:** all 5 fixes (M8/M9/M10/M1/M2) traced CORRECT against real source; no new material; "CONVERGED — ship."
- **integration:** every code anchor (devAgentGate.ts:40, server.ts:4188/18192/18464, MeshUrlAdvertiser.ts:223-230, types.ts:2170-2189/4206, FeatureMetricsRecorder) verified-correct; "converged."
- **decision-completeness:** Open questions `*(none)*`; 11 frontloaded decisions; no stale decision; all constants internal/cheap; "decision-complete."
- **conformance gate (final):** 0 violations.

## Convergence verdict

Converged at round 3. Final round: conformance gate 0 violations; both external models MINOR (all material points folded in); 4/4 internal reviewers converged (adversarial + integration explicitly "ship", decision-completeness "decision-complete", lessons' two edits applied). Open questions `*(none)*`. The feature is signal-only and dark-gated (`monitoring.meshCoherenceLiveCheck.enabled`, omitted from ConfigDefaults → dev-gate resolves live-on-dev / dark-on-fleet). Ready for user review and `/instar-dev` build.
