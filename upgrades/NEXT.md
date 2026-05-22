# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**feat(docs-coverage): deterministic enumeration as a structural antidrift for docs.**

A multi-pass agent-driven audit (May 2026) proved that documentation drift on this codebase cannot be closed by manual audit passes. Each pass found new items the previous pass missed because the gap is large enough — only one of twenty-four `src/` subsystems has complete feature-doc coverage today — that no single pass exhaustively enumerates.

This release ships the structural answer per the codebase's Structure-over-Willpower principle: a pure-Node script that walks the source tree, enumerates every shipped capability (HTTP routes, CLI commands, scheduled jobs, hooks, skills, and top-level classes per subsystem), cross-references each against `README.md` and `site/src/content/docs/`, and produces a coverage report.

The script:

1. **Enumerates deterministically.** No model in the loop. The same source state produces the same report every run.
2. **Classifies coverage as DOCUMENTED / PARTIAL / UNDOCUMENTED.** Two-or-more doc mentions count as documented; exactly one counts as partial; zero counts as undocumented.
3. **Enforces per-category floors via CI.** A new `Docs Coverage` job runs `node scripts/docs-coverage.mjs --check` on every PR and fails if any category drops below its floor. Initial floors are calibrated to current measured coverage minus a small buffer.
4. **Ratchets upward.** PRs that improve docs raise the relevant floor. The bar moves with the codebase.
5. **Produces two artifacts.** `.instar/docs-coverage.json` (machine-readable, used by CI and future automation) and `.instar/docs-coverage.md` (human-readable, grouped by capability type with sections for undocumented and partial items). Both are git-ignored as generated artifacts; both are uploaded as CI artifacts on every run.

Initial baseline measured against current main: 15% overall coverage across 880 shipped capabilities — 36 of 457 routes mentioned in docs, 7 of 31 commands, 4 of 14 default jobs, 12 of 14 skills.

Spec: `docs/specs/docs-coverage.md`. ELI16: `docs/specs/docs-coverage.eli16.md`. Side-effects review: `upgrades/side-effects/docs-coverage.md`.

This is the foundation for two follow-on capabilities tracked separately: bulk doc updates (Phase 2 of the current sprint) and a weekly audit job that surfaces drift via Telegram (Phase 5).

## What to Tell Your User

Nothing user-visible. This release adds a CI check that enforces documentation coverage on instar's own development pipeline. Agents continue to behave identically.

If a contributor asks why their pull request is failing the new docs coverage job, the failure message names the offending category and the fix is to add a doc mention for the new capability somewhere in the README or under site docs. Per-category floors can be temporarily relaxed via environment variables for one-off pull requests that genuinely need to skip the check.

## Summary of New Capabilities

This release is a pure infrastructure addition. No new runtime capabilities for agents. The new CI gate and reporting tool are for instar developers and direct contributors only.

## Evidence

The script was run against current main and produced the baseline coverage numbers above. Seven unit tests verify the enumeration, scoring, CI behavior, and artifact output against a mock repo. The CI workflow runs the script in `--check` mode and uploads the report as an artifact. `npm run lint` passes (TypeScript, destructive-ops lint, LLM-HTTP lint, Codex Rule 1 drift).

The audit that motivated this script remains as evidence: it ran for six passes and never converged. The script's first run reproduces the audit's headline finding (15% coverage) in under one second of deterministic walking — proving the convergence-by-construction claim.
