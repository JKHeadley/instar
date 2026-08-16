# GPT 5.4 Review: COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md

**Model**: gpt-5.4
**Date**: 2026-04-26
**Focus**: full document
**Status**: Score 8/10, CONDITIONAL approval pending the items below.

---

## Key findings (captured from agent's summary — full transcript was truncated at 4000-token cap during Phase 2 of scalability section)

### Critical / blocking before approval

1. **Internal contradiction — `write-tree` classification.** `write-tree` is listed in `DESTRUCTIVE_GIT_VERBS` (spec line 142) but the migration plan and test plan treat it as read-only (lines 300, 317; WorktreeManager-merkle test row). Must reconcile — pick one classification and update consistently.

2. **Env-var redirection bypass.** `SafeGitOptions.env` accepts arbitrary env vars without constraint. A caller in a tmpdir cwd can redirect a command to mutate the instar source tree by setting `GIT_DIR=/Users/justin/Documents/Projects/instar/.git`, `GIT_WORK_TREE=/Users/justin/Documents/Projects/instar-main`, `GIT_INDEX_FILE`, or `GIT_CONFIG_*`. The cwd-based assertion never fires because the caller's cwd is a tmpdir. Real bypass surface; needs explicit env-var sanitization at the SafeGitExecutor boundary.

3. **Lint coverage gaps.** AST rule needs to cover: `node:child_process` (vs the unprefixed form), destructured-and-renamed bindings (`const { execSync: run } = require('child_process')`), `bash -lc "git ..."` (the binary is `bash`, not `git`, but the command is destructive), template-generated commands (`spawn(cmd, [...])` where `cmd` is `'gi'+'t'`).

4. **Symlink / canonicalization.** Spec's `realpathSync` on `target` is good, but the `cwd`, `-C <dir>`, `--git-dir`, `--work-tree` paths in the args are not canonicalized. A symlinked argument bypasses the cwd check.

5. **"Comprehensive" framing overstated.** Bash-tool invocations from the AI harness, `npx`-mediated git, terminal use by humans — these remain outside the funnel. The spec should say so explicitly with the compensating mechanisms (PR #96 constructor guard for manager classes, CI mutation detector for post-test catch, classic branch protection for origin).

### Substantive but not blocking

6. **Spawn lifecycle.** Guard timing relative to `spawn` (sync assertion completes before fork), stdin-driven mutation paths (`git fast-import`), error semantics on assertion failure mid-pipeline are not specified.

7. **Layer A LLM gate.** No specified behavior when the LLM is unavailable (offline, quota), no override path for known-good specs, no determinism story (model output varies across runs — does the cache invalidate when the model version changes?).

8. **Commitments schema.** No formal lifecycle states (`pending` → `verified` → `violated` → `expired` is mentioned in the existing `CommitmentTracker` but not formally bound to the new commitments file). No validation step. No named actor that runs the due-date checker.

9. **AC-3 wording.** Inconsistency between AC-3 (text says "all destructive callsites migrated") and the shell/npm enforcement scope (the rule is grep-based for those, not AST migration).

---

## Subagent analysis

GPT 5.4 ran into the 4000-token cap during scalability Phase 2 — Phase 3 ("spike handling") and the final prioritized top-5 recommendations were truncated. Findings 1–9 above were captured before the cut.

GPT's strongest unique contribution vs Gemini: the env-var redirection bypass (item 2) — Gemini did not surface this. This is a real attack surface that the spec must close.

Recommend: address items 1, 2, 4 before approval as concrete spec changes. Items 3, 5–9 can be addressed in a "Known boundaries / future hardening" subsection if the costs of in-scoping them now exceed the residual risk.
