# Convergence state — provider-fallback-default-policy

## Done
- ROUND 1 COMPLETE: Standards-Conformance gate (1 finding: Framework-Agnostic → resolved in favor) + 6 internal reviewers + 2 external passes (codex gpt-5.5 = SERIOUS ISSUES, gemini 2.5-pro = MINOR ISSUES). All findings in round1-*.md; deduped in round1-SYNTHESIS.md (M1–M11).
- PHASE 2 REWRITE COMMITTED: spec rewritten to address all 11 material findings. Key changes:
  - §4.5 NEW — bounded per-attempt swap timeout (the crux fix M1: longer chain can't stack slow providers into a worse stall).
  - §4.1 — `job` category EXCLUDED (M3); chain is a single named constant INTERNAL_FRAMEWORK_PREFERENCE (M10).
  - §4.2 — active-probe = buildProvider!==null (Q1); pi-cli included-if-active (M6).
  - §4.3 — HONEST self-heal semantics (M4: primary boot-frozen/restart-to-repick, tail self-heals live).
  - §4.4 — operator-set detection from boot RAW-config snapshot, mutation-proof (M5).
  - §6.2 herd analysis (M2), §6.4 garbage-output scoped out (M8), §6.5 Framework-Agnostic resolved (M10).
  - §7 — tests for M1/M3/M5/M7/M11/Q5. §5 migrateClaudeMd + multi-machine machine-local posture.
  - Frontloaded Decisions added (Q1/Q2/Q4/Q5; 4 frontloaded, 1 contested-cleared). Open questions = none.

## ROUND 2 DONE (rewrite committed): externals→MINOR (codex was SERIOUS); fixed N1 orphan-promise CRASH hazard (.catch+unref+AbortSignal), N2 cap-dominance prose, N3 garbage-output=caller-handled (resolves No-Deferrals), N4 migrateClaudeMd new-marker (old sniff no-ops+leaves wrong text), N5-N9 precision. decision-completeness+lessons already CONVERGED.

## ROUND 3 DONE (rewrite committed): externals MINOR/MINOR; CONVERGED lenses=decision-completeness+lessons+scalability. Fixed R3-2 (§4.5 simplified to Promise.race+existing timeoutMs->SIGTERM; dropped mis-grounded AbortSignal/.catch — InputGuard precedent), R3-1 (§4.6 live-read+layer computed default UNDER live override so CartographerSweep injection survives), R3-3a/b precision, R3-4 observability (swap-attempt-timeout onDegrade).

## ROUND 4 DONE — CONVERGED + APPROVED. All 6 lenses CONVERGED, 0 material (2 non-blocking hygiene notes folded: A6 PATCH/config foot-gun, 120s softened). Tag stamped (4 iters, codex-cli:gpt-5.5, FD 4/0/1, single-run-completable). ELI16 + convergence report written. approved:true (run pre-approval).

## NEXT: /instar-dev BUILD
- The spec is review-convergence + approved → /instar-dev gate will accept it.
- BUILD (rebase worktree onto current main first): (1) policy resolver computing INTERNAL_FRAMEWORK_PREFERENCE ∩ active (buildProvider, reuse this.cache) → {categories:sentinel/gate/reflector, failureSwap}; (2) §4.5 add bounded per-attempt timeout to the swap loop via Promise.race + pass swapAttemptTimeoutMs as the providers timeoutMs (SIGTERM), onDegrade reason swap-attempt-timeout; (3) §4.6 wire at server.ts router construction (~4687): boot-snapshot operator-set BEFORE CartographerSweep(11266); resolveConfig reads live + layers computed default UNDER live overrides; (4) §8 generateClaudeMd edit opt-in/heuristic sentences + migrateClaudeMd NEW marker "run off Claude by default" (NOT pi-cli token); (5) intelligence.swapAttemptTimeoutMs inline ??5000 no ConfigDefaults; (6) 3-tier tests per §7 (incl M1 stall-regression, N1 Promise.race no-crash, M3 job-excluded, M5 mutation-proof operator-set, M11 caller-fail-closed, Q5 model-size); (7) side-effects artifact, Phase-5 second-pass (touches safety routing — REQUIRED), release fragment, trace --tier 2, instar dev:preflight; (8) commit + push + gh pr merge <PR> --auto --squash (the smooth path). This is the first SUBSTANTIVE feature through the fixed auto-merge dev cycle.

## (superseded) NEXT: ROUND 4 (Phase 3 — expected to CONVERGE; trajectory M11->N9->R3-4, externals SERIOUS->MINOR->MINOR, 3 lenses already converged). If converged: Phase 4 report + ELI16 companion (>=800 chars) + write-convergence-tag.mjs --cross-model-review "codex-cli:gpt-5.5" --frontloaded-decisions 4 --cheap-tags 0 --contested-cleared 1 + publish-spec-review handoff.
- Externals are MANDATORY (spec body changed since round-1 external pass — codex+gemini were active <7d).
- Re-run: conformance gate + 6 internal reviewers + codex + gemini on the UPDATED spec.
- Convergence criteria: (1) no material NEW findings, (2) Open questions already = none ✅.
- Watch specifically: does §4.5's per-attempt timeout design hold up adversarially? is the `job` exclusion + CartographerSweep reasoning airtight? any NEW issue from the rewrite?
- If converged: Phase 4 report (docs/specs/reports/provider-fallback-default-policy-convergence.md) + author the ELI16 companion (docs/specs/provider-fallback-default-policy.eli16.md, ≥800 chars — REQUIRED for the tag) + write-convergence-tag.mjs with --cross-model-review "codex-cli:gpt-5.5" --frontloaded-decisions 4 --cheap-tags 0 --contested-cleared 1.
- Then: user handoff (publish-spec-review.mjs) for `approved: true` before /instar-dev build.
