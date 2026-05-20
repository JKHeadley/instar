# Convergence Report — Codex-only init zero .claude/ (PR 2 of 4)

## ELI10 Overview

PR 1 exposed `--framework codex-cli` but install still wrote Claude files
anyway. This PR makes the flag actually mean what it says: codex-only
installs produce zero `.claude/` directory, zero CLAUDE.md, while still
rendering canonical identity + AGENTS.md shadow. Default behavior
unchanged.

## Original vs Converged

Audit blocker 4 framing: "installClaudeSettings unconditional." Verified:
also true of `installSmartFetch`, `installGitSyncGate`, `installHealthWatchdog`,
the standalone path's manual `.claude/` build, the CLAUDE.md writes at
lines 411 / 989, and `refreshScripts` (called from `refreshHooksAndSettings`).
Converged scope adds the gate at all five sites — fresh init,
existing-project init, standalone init, refreshHooksAndSettings,
refreshScripts.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check + 3-case isolated-fs test + 8 total post-rebase | 0 (after empirical "actual `.claude/` contents" verification corrected initial under-gating) | None |

## Manual lessons-aware findings

Engaged P1, P4 (3 new + 5 from PR 1 = 8 total), P6, P10 (all 5 sites
gated), L1 (audit-driven, verified empirically with a tmpdir probe),
L6/L9/L10. No contradictions.

**Process note (from this session):** the first pass of this PR only
gated `installClaudeSettings` and the skills install. An empirical test
caught that `refreshScripts` was also writing `.claude/scripts/git-sync-gate.sh`
and `.claude/scripts/smart-fetch.py` (called transitively by
`refreshHooksAndSettings`). The audit's framing of "the unconditional
installClaudeSettings call" was incomplete; only running the test caught
it. Same per-finding-verification discipline that caught Gap 5's inertness
in the morning's session.

## Convergence verdict

Converged at iteration 1 after the empirical-test correction. PR 3-4
remaining for full install/wizard portability.

## Deviation note

Operator pre-authorized autonomous-mode for the four-PR series. Scope
expanded mid-PR (from "gate installClaudeSettings" to "gate all `.claude/`
writes including refreshScripts and standalone") after the test caught
under-gating; documented here, not silent.
