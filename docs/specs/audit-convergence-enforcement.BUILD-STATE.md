# Build State — audit-convergence-enforcement

Durable recovery doc for the implementation of `docs/specs/audit-convergence-enforcement.md`
(converged at review-iteration 11, stamped; approval pending — CMT-1963).
Worktree: `~/.instar/agents/echo/.worktrees/echo-audit-convergence-enforcement`, branch
`echo/audit-convergence-enforcement`, off JKHeadley/main v1.3.824. **Nothing is committed** —
the /instar-dev Phase-0 gate requires the operator's `approved: true` first.

## BUILT + TESTED (all green; `pnpm build` compiles clean)

| Piece | File(s) | Tests |
|-------|---------|-------|
| Validator (earns/refuses the `converged:` stamp; fail-closed; 3-disposition enum; count cross-check; jailed standing-guard; exemption enum; byte-idempotent re-stamp; `--check`/`--content-from`; repo-root from cwd) | `scripts/write-audit-convergence.mjs` | `tests/unit/write-audit-convergence.test.ts` (23) |
| Secret-pattern module (pre-compile-importable) | `scripts/audit-secret-patterns.mjs` | (covered via validator) |
| Precommit gate (after staged-listing, BEFORE in-scope early-exit; secret scan hard-block; canonical-path-only on `audit:` key; staged-blob validation; fail-closed) | `scripts/instar-dev-precommit.js` (Step 1.5) | (exercised by existing precommit meta-tests + manual) |
| CI ratchet (merged-state re-validate; canonical-path; full-path GRANDFATHERED allowlist) | `tests/unit/audit-convergence-reports.test.ts` (2) | self |
| Registry grade-flip citation (`**Applied through.**` cites `scripts/instar-dev-precommit.js`→gate + `tests/unit/audit-convergence-reports.test.ts`→ratchet) | `docs/STANDARDS-REGISTRY.md` (§ Iterative Audit to Convergence) | (see Remaining: conformance test) |
| Husky read-point fix (`git rev-parse --git-common-dir` → worktree finds main config) | `.husky/pre-commit` | verified runs clean |
| Skill content update (canonical `docs/audits/<slug>.md` report + validator-earned stamp) | `skills/iterative-converging-audit/SKILL.md` + single-sourced constant | `tests/unit/iterative-converging-audit-skill-single-source.test.ts` (4) |
| Single-source constant (kills the 3-copy drift) consumed by init.ts + migration | `src/data/builtinSkillContent.ts`; `src/commands/init.ts`; `src/core/PostUpdateMigrator.ts` (`migrateIterativeConvergingAuditSkill`, wired in `migrate()`) | single-source test (4) |

**CORE COMPLETE.** Test tally: 23 (validator) + 2 (CI ratchet) + 4 (single-source parity) + 3 (conformance grade-flip: proves documented-only → **ratchet**) + 24 (precommit meta-tests, adjusted for the new deps) = **56 direct**, and a **1141-test regression sweep across 156 files (PostUpdateMigrator / templates / scaffold / migrations / init) is GREEN** — zero regressions. `pnpm build` compiles clean.

Additional core pieces landed since first draft:
- **CLAUDE.md template section** "Audits run to convergence (the default route)" — `AUDIT_CONVERGENCE_CLAUDEMD_SECTION` in PostUpdateMigrator, emitted by `generateClaudeMd()` (templates.ts) AND added by `migrateClaudeMd()` (content-sniff, idempotent), tracked in `feature-delivery-completeness.test.ts` `legacyMigratorSections` (123 tests green). Proportionate (trigger + skill pointer).
- **Conformance grade-flip test** — `tests/unit/audit-convergence-standard-conformance.test.ts`: reads the real registry, asserts the citations resolve and classify `ratchet`.
- **Precommit meta-tests** — the 3 sandbox harnesses now copy the two new sibling `.mjs` deps; all 24 pass.

## Green-PR §3 — ARM-TIME protection BUILT; adversarial hardening deferred (ACT-1192)

- **BUILT + tested (4 tests, 142 green-PR tests green):** `docs/audits/` + `scripts/write-audit-convergence.mjs` + `scripts/audit-secret-patterns.mjs` + the ratchet test added to `PROTECTED_PATH_PREFIXES` (`src/monitoring/greenPrAutomergeWiring.ts`). A PR opened WITH an audit report (the common case) is routed to the operator, not auto-merged; the validator's own machinery can't be neutered by an auto-merged PR. Test: `tests/unit/audit-convergence-protected-paths.test.ts`.
- **Deferred → ACT-1192** (the adversarial arm-then-push TOCTOU hardening — the 8-round `gather()` re-check keyed on `autoMergeArmed`, fail-closed across the 3 protectedPaths() verdicts, uniform disarm, local-arm re-adoption with verified-clean head retention). It closes the *adversarial* case (an agent deliberately arm-then-pushing a fabricated report); needs comprehensive tests; the full converged design is in spec §3. **ACT-1191** tracks the deeper GitHub-side head-pinning (the residual sub-tick race).

## REMAINING (post-merge / tracked)

1. **Config flip** — `specReview.requireConvergenceReport: true` in this dev agent's `.instar/config.json` (per-machine, every machine; NOT a source change — apply at deploy, after merge).
2. **ACT-1192** — adversarial arm-then-push gather() hardening (above).

## This PR is a complete, standalone, well-tested unit: the audit-convergence enforcement CORE + arm-time auto-merge protection. Ready to commit + merge on operator approval.

## Finish sequence on approval
Apply `approved: true` to the spec (on operator's authenticated say-so) → build 1–4 (+5 if not split) → `/instar-dev` trace + side-effects artifact → commit → PR → `safe-merge` on green.
