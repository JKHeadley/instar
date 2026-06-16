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

## NEXT: ROUND 3 (Phase 3 convergence check)
- Externals are MANDATORY (spec body changed since round-1 external pass — codex+gemini were active <7d).
- Re-run: conformance gate + 6 internal reviewers + codex + gemini on the UPDATED spec.
- Convergence criteria: (1) no material NEW findings, (2) Open questions already = none ✅.
- Watch specifically: does §4.5's per-attempt timeout design hold up adversarially? is the `job` exclusion + CartographerSweep reasoning airtight? any NEW issue from the rewrite?
- If converged: Phase 4 report (docs/specs/reports/provider-fallback-default-policy-convergence.md) + author the ELI16 companion (docs/specs/provider-fallback-default-policy.eli16.md, ≥800 chars — REQUIRED for the tag) + write-convergence-tag.mjs with --cross-model-review "codex-cli:gpt-5.5" --frontloaded-decisions 4 --cheap-tags 0 --contested-cleared 1.
- Then: user handoff (publish-spec-review.mjs) for `approved: true` before /instar-dev build.
