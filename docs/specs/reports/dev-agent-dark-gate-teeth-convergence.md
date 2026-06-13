# Convergence Report — Dev-Agent Dark-Gate Teeth (CMT-1438)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI, gpt-5.5) ran in **every** round and
succeeded in rounds 1–6; the Gemini-tier pass (gemini-2.5-pro) degraded on a
timeout in round 1 and then ran successfully rounds 2–5. The spec received genuine
non-Claude review on its final content. No ⚠ — this is the clean RAN state.

## ELI10 Overview

Instar ships new features "dark" (off) for everyone but "live" for development
agents like Echo, so they get dogfooded before the whole fleet gets them. There's a
registry that files every off-by-default feature into one of two drawers: "dogfood
on dev" (safe to run live on Echo) or "off even on dev" (with a reason — it deletes
things, spends money, etc.). The problem this spec fixes: the "off even on dev"
drawer had a junk slot literally meaning "off because we said so," with no
requirement to prove the feature is actually unsafe there — so safe features kept
getting hidden in it by accident.

This spec deletes that junk slot, adds an honest new reason ("action-bearing" — it
sends a message or merges a PR when live), and re-files the 11 features that were in
the junk drawer. Crucially, before moving any feature to "dogfood on dev," the build
*reads its actual code* to confirm it really is harmless — and that check caught 3
of the 7 candidates that turned out NOT to be harmless (one quietly spends money on
AI summaries; two auto-send Telegram alerts). Those 3 stay off with an honest label.
The 4 verified-safe ones go live. A migration is added so the change actually takes
effect on Echo (whose config had stale "off" values baked in), and the CI lint grows
teeth so the junk slot can never be used again.

## Original vs Converged

The original spec was sound on its core idea (retire the catch-all, add
`action-bearing`, reclassify) but had three gaps the review process closed:

1. **It said no migration was needed — that was wrong.** Echo's on-disk config
   already persists `enabled: false` for two of the four "go-live" features
   (a stale artifact of the old default). Because config-merge only *adds* missing
   keys, removing the default would have left those two **dark on the very agent
   meant to dogfood them**. The converged spec adds **D5**: a dev-agent-only,
   run-once, allowlisted migration that strips the stale `false` (mirroring the
   proven `migrateCartographerDevGate`), plus its test tier — so the change actually
   lands. This was the single most important finding.

2. **The "observe-only" labels were hypotheses, not proof.** The converged spec
   makes **D4 code-grounding** explicit and records its result: 3 of 7 candidates
   (`correctionLearning` — per-message LLM spend; `apprenticeshipCycleSla` and
   `geminiCapacityEscalation` — auto-send Telegram topics) were held back as honest
   `cost-bearing` / `action-bearing` exclusions, and the deviation from the
   operator's "move all 7" approval was reported to topic 12476 before building.

3. **It over-claimed and under-disclosed.** The converged spec is honest about
   scope: the lint closes the *unclassified-category* hole (Signal vs. Authority —
   it adjudicates spelling, not honesty); the *miscategorization* and
   *capability-drift* holes are closed by D4 + the GrowthMilestoneAnalyst R6 runtime
   cross-check, with a durable capability-seam lint named as a follow-up. It also
   fixed a real CI bug found in review (a backtick-reason exclusion entry silently
   skipped category validation → a count-match guard now fails loud), sharpened the
   `action-bearing` definition, made the `releaseReadiness` two-switch dependency
   explicit + test-pinned, and added a `lessons-engaged` frontmatter block.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | adversarial (minor), integration (**SERIOUS**), decision-completeness (minor), lessons-aware (2 crit/4 high), codex (minor, 5), gemini (degraded/timeout); security + scalability CLEAN | migration gap (P3/P4), backtick-reason lint skip, D1 framing, signal-vs-authority over-claim, missing lessons-engaged, action-bearing under-defined | Added D5 migration + test tier; D2 count-match guard; D1 unsafe-vs-not-runnable framing + sharpened action-bearing; softened "can't recur"; residual-risk disclosure; `lessons-engaged` block |
| 2 | integration (RESOLVED), adversarial (converged), lessons-aware (0 blocking), decision-completeness (clean), codex (**SERIOUS**, 4), gemini (minor) | D5 lossy-tradeoff not stated; releaseReadiness composed-activation (two-switch); optional-integration teeth not enforced; parser brittleness | D5 cartographer-parity tradeoff paragraph + parent-object guard; releaseReadiness two-switch entry; optional-integration = review convention (not lint-enforced); parser-brittleness residual + why-custom-not-LaunchDarkly |
| 3 | security CLEAN, scalability CLEAN, codex (minor, 5), gemini (minor) | migration should report stripped paths; two-switch deserves a test; action-bearing reason-quality; parser follow-up ownership | D5 logs/reports stripped paths; two-switch test added to Testing; action-bearing reasons name type + bounded/deduped; parser follow-up given an owner; runtime-warning named as follow-up |
| 4 | codex (minor, 5), gemini (minor) | marker-wording precision; promote classification rule to general | Reworded marker bullet as explicitly lossy; added general "classify by reachable-under-normal-config" rule to D1 |
| 5 | codex (minor — residuals + drift-guard), gemini (minor — "acknowledged residuals") | two-switch test should also assert job-default-off (drift guard) | Hardened two-switch test to assert the job's shipped default is `enabled: false` |
| 6 | codex (minor, 4 — all non-material) | 0 material | none (converged) |

## Full Findings Catalog

### Round 1
- **Integration — SERIOUS (migration gap).** Spec claimed no migration needed, but
  Echo persists `enabled:false` for `parallelWorkSentinel` + `releaseReadiness` →
  they'd stay dark. Resolution: D5 migration (mirrors `migrateCartographerDevGate`,
  `src/core/PostUpdateMigrator.ts:512-579`) + test tier. **Resolved (round 2).**
- **Lessons-aware — CRITICAL P3 / P4.** Same migration gap + no test for it.
  Resolution: D5 + Testing item 7. **Resolved (round 2).**
- **Lessons-aware — HIGH P2 (Signal vs. Authority).** "Can't recur" over-claimed the
  lint's authority. Resolution: scoped to the unclassified-category hole; D4 + R6
  named as the miscategorization backstop. **Resolved (round 2).**
- **Lessons-aware — HIGH P17 / P7 / P14-16 / L6.** Missing `lessons-engaged`
  engagement. Resolution: `lessons-engaged` frontmatter block. **Resolved (round 2).**
- **Adversarial — MINOR (backtick-reason silent skip).** A template-literal `reason`
  bypasses `entryRe` so category validation is skipped. Resolution: D2 count-match
  assertion (`exclusionEntries.length === exclusionPaths.length`), fail-loud.
  **Resolved (round 2); round-2 adversarial verified the invariant is fail-safe.**
- **Codex — MINOR (5).** D1 framing (unsafe vs inert); D4 durable-enforcement gap;
  migration for persisted false; action-bearing boundaries; partial-context caveat.
  **All resolved/disclosed (round 2).**
- **Security + Scalability — CLEAN** (re-confirmed CLEAN in final pass).

### Round 2
- **Codex — SERIOUS (4).** (1) D5 can erase a deliberate pre-migration `false` →
  documented as the accepted cartographer-parity lossy tradeoff + Echo-specific
  nil-risk + logged. (2) Parser still hand-rolled regex → disclosed residual +
  follow-up. (3) `action-bearing` "when merely enabled" misses composed activation
  (two-switch) → releaseReadiness two-switch dependency made explicit + later
  test-pinned. (4) optional-integration teeth not enforced → clarified as a
  review/D4 convention, not lint-enforced. **All resolved/disclosed (rounds 2–3).**
- **Gemini — MINOR.** Architectural complexity / jargon / manual D4 → why-custom
  justification added; ELI16 is the plain-language entry; D4 residual disclosed.

### Rounds 3–5
- Findings converged to recurring **disclosed residuals** (regex-parser brittleness;
  point-in-time D4 / capability drift) plus incremental hardening requests, each
  addressed: D5 now reports stripped paths; the two-switch invariant is test-pinned
  AND drift-guarded (asserts job default stays off); action-bearing reasons must name
  action-type + bounded/deduped; the parser + capability-seam fixes are named
  follow-ups with an owner. Gemini round 5 explicitly characterized its remaining
  findings as "acknowledging and managing residual risks that the spec itself
  astutely identifies" — i.e. non-material.

### Round 6 (final confirmation)
Codex returned 4 MINOR findings, **all non-material** (none require a spec change):
(1) state the dev-agent-accepts-dev-gated-defaults premise — already the documented
contract of `resolveDevAgentGate` (`devAgentGate.ts`); (2) split `action-bearing`
now — a design preference contrary to the spec's deliberate, documented decision to
defer the split; (3) name the dependent job in the `releaseReadiness` *registry
justification string* — a build-time wording note (D4 + the drift-guard test already
cover it; honored when writing the `DEV_GATED_FEATURES` entry); (4) regex-parser
brittleness — a re-statement of the already-disclosed residual + follow-up. The
finding set has been stable and disclosed since round 2; nothing new is material.

### Residual risks (disclosed, non-blocking, named follow-ups)
- **Hand-rolled regex registry parser.** The D2 count-match guard closes the
  parsed-path-without-a-parsed-entry class (fail-safe), but a structural fix
  (TS-compiler / built-module / pure-data registry) is a tracked follow-up.
- **Capability drift after D4.** D4 is point-in-time; R6 is the partial runtime
  backstop; a durable per-feature capability-seam lint is a named follow-up.

## Convergence verdict

Converged at iteration 6. The design has been stable since round 2; rounds 3–6 were
honesty/clarity/test-hardening refinements with monotonically decreasing severity
(SERIOUS → SERIOUS → MINOR → MINOR → MINOR-residuals → none). The final round
produced no material findings — both external reviewers' remaining notes are
disclosed residuals the spec openly carries as named follow-ups, not changes the
spec requires. Zero unresolved user-decisions remain (O1 + O2 RESOLVED). The spec is
ready for build.
