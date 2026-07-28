# Side-Effects Review — Audit-Convergence Enforcement

**Version / slug:** `audit-convergence-enforcement`
**Date:** `2026-07-11`
**Author:** `echo`
**Second-pass reviewer:** `spec-converge (11-round convergence, adversarial lens confirmed CONVERGED) + this artifact`

## Summary of the change

Makes an audit's `converged` state a machine-earned, CI-re-verified claim rather than an asserted one — the runtime arm of the "Iterative Audit to Convergence" constitution standard, which the StandardsEnforcementAuditor graded `documented-only` (zero guards). Adds: a validator (`scripts/write-audit-convergence.mjs` + `scripts/audit-secret-patterns.mjs`) that stamps `converged:` only when a `docs/audits/<slug>.md` ledger genuinely earns it (≥2 rounds, zeroed+row-cross-checked final round, closed-enum dispositions, jailed+git-tracked standing-guard XOR closed-enum exemption; fail-closed parse); a precommit gate step (`scripts/instar-dev-precommit.js` Step 1.5, before the in-scope early-exit) that refuses an unearned stamp + secret-scans staged audit reports + enforces canonical-path-only; a CI ratchet (`tests/unit/audit-convergence-reports.test.ts`) re-verifying committed stamps at merged state; the registry grade-flip citation; single-sourced skill content (`src/data/builtinSkillContent.ts` → init.ts scaffold + PostUpdateMigrator migration); a CLAUDE.md default-route section (template + migrator); the husky worktree read-point fix; and arm-time green-PR auto-merge protection for audit-report PRs + the validator's own machinery (`PROTECTED_PATH_PREFIXES`). Decision points: the validator stamp refusal, the precommit gate, the secret-scan hard block, the CI ratchet — all `invariant` (deterministic closed-world format checks). The adversarial arm-then-push gather() hardening is deferred (ACT-1192); GitHub head-pinning (ACT-1191); provenance/outcome/bench remediation from the LLM audit (ACT-1193/1194/1195).

## Decision-point inventory

- `write-audit-convergence.mjs` stamp refusal — add — deterministic ledger-earns-the-stamp check; false claim is never a judgment call.
- `instar-dev-precommit.js` Step 1.5 audit gate — add — refuses an unearned staged stamp; passes an honestly-incomplete report; secret-scan hard-block; canonical-path-only.
- CI ratchet `audit-convergence-reports.test.ts` — add — merged-state re-verification of the same checks.
- green-PR `PROTECTED_PATH_PREFIXES` — modify (extend, never shrink) — audit-report PRs + validator machinery excluded from auto-merge (arm-time).

## 1. Over-block

**What legitimate inputs does this reject that it shouldn't?** An honestly-incomplete audit (no `converged:` claim) passes untouched — only a report CLAIMING converged is validated, so the honest case is never over-blocked. Risk: a benign format variant in a round ledger could be refused; mitigated by tolerant recognizers + a shape-teaching refusal message + the zero-cost escape (drop the `converged:` line). The precommit secret-scan uses conservative high-signal patterns; a false positive blocks a commit but is rare and the message points at the line.

## 2. Under-block

**What failure modes does this still miss?** (a) A form-VALID *fabricated* ledger earns the stamp (the ledger validates FORM, not that a re-sweep ran — the acknowledged ADV-3 residual; raised-cost via required search-angles/surface-delta, not eliminated). (b) An audit written as prose or under a non-canonical path never produces a gated report (canonical-path-only refuses a stamp elsewhere, but can't force routing). (c) The adversarial arm-then-push auto-merge TOCTOU is not closed by the arm-time protection alone (deferred: ACT-1192). All three are documented residuals, not silent gaps.

## 3. Level-of-abstraction fit

Right layer: the validator + precommit + CI ratchet mirror the proven spec-convergence gate (`write-convergence-tag.mjs`). The registry grade-flip is exactly how the StandardsEnforcementAuditor is designed to be fed (resolvable citations). The skill/template deliver the default-route to agents per the Agent Awareness + Migration Parity standards. No lower/higher layer already owns "earned audit convergence."

## 4. Signal vs authority compliance

The precommit + validator hold BLOCKING authority, but only over a closed-world FORMAT invariant (rounds count, zeroed final round cross-checked against rows, closed-enum dispositions, jailed path existence) at a dev-process chokepoint — the documented Signal-vs-Authority exemption class (Judgment Within Floors §3.6 / FD12, the tag-writer precedent). The secret-scan hard-block is the irreversible-action carve-out (committing a credential is unrecoverable). The CONTENT quality/depth of an audit is NOT gated — it stays with the auditor + reviewers (stated as a residual). No brittle open-domain-meaning check holds authority.

## 5. Interactions

- The precommit Step 1.5 runs BEFORE the in-scope early-exit so it fires for docs-only audit commits (the dominant case); the 3 precommit meta-tests were updated to copy the 2 new sibling `.mjs` deps into their sandbox (24 pass).
- The CLAUDE.md section is emitted by `generateClaudeMd()` AND added by `migrateClaudeMd()` (content-sniff, idempotent) — no double-patch; tracked in `feature-delivery-completeness` (123 pass).
- The skill content is single-sourced (`builtinSkillContent.ts`) so init.ts scaffold + the migration cannot drift (4 parity tests).
- `PROTECTED_PATH_PREFIXES` extension composes with the existing green-PR arm-time protected-paths check (142 green-PR tests pass, no regression).

## 6. External surfaces

No new server routes, no background actors, no runtime behavior change for users. The only agent-visible surface: the new CLAUDE.md default-route section + the updated skill (both behavioral guidance). Existing agents receive both via the update path (migration). No timing/conversation-state dependence.

## 7. Multi-machine posture

Validator / precommit gate / CI ratchet / audit report: **unified via git** — git-tracked repo artifacts replicated to every checkout; `.husky/` rides the same tree. `specReview.requireConvergenceReport` is genuinely per-machine config: `machine-local-justification: operator-ratified-exception` (merged commit 742723fc4, PR #1052 — spec #4's dev-first rollout ladder), applied on every machine of the dev agent. The Standard-A justification lint passes clean.

## 8. Rollback cost

Revert the PR (scripts + CI test + docs self-contained). Full reversal of the fleet-delivered text (CLAUDE.md section + migrated skill content) requires a removal migration in `PostUpdateMigrator` — a plain source revert leaves migrated instructions on updated agents. The config flag flips back per-agent. No data migration; committed audit reports remain valid markdown either way.

---

## Second-pass review

**Concur with the review.** The change was driven through 11 rounds of `/spec-converge` (6 internal reviewers + real codex-cli:gpt-5.5 externals every round; the adversarial lens's final verdict was CONVERGED after the deterministic guarantees were confirmed hole-free and the best-effort layer honestly scoped). Every material finding across rounds was folded and independently re-verified against code. The deferred adversarial auto-merge hardening + head-pinning + LLM-audit remediation are tracked (ACT-1191/1192/1193/1194/1195). No concern raised.
