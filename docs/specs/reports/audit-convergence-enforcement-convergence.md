# Convergence Report — Audit-Convergence Enforcement

## Cross-model review: codex-cli:gpt-5.5 (real, per-round)

A GPT-tier external pass ran through the agent's codex CLI on every round the body changed (rounds 1–9). From round 3 onward it never returned a MATERIAL/blocker finding — its notes were refinements (jargon density; "the line-oriented markdown validator is the main maintenance risk"; "separate the §6 spec-review flip from the audit design"), all folded or answered in Alternatives/scope-honesty. Rounds 8 and 9: `MINOR ISSUES` (the recurring, already-addressed line-parser note). Gemini (gemini-3.1-pro-preview) ran round 1 clean and degraded to timeout on rounds 2 and 6 — recorded honestly, non-blocking per the skill's degraded-reviewer rule.

## ELI10 Overview

We had a rule that an audit isn't finished after one pass — audit, fix, re-audit until a clean re-check finds nothing new — but nothing enforced it (the system's own checker graded it "documented-only, zero guards"). This makes "converged" a claim the system verifies instead of trusts: a validator stamps an audit report only when its ledger shows ≥2 rounds ending clean with every finding closed and a standing tripwire left behind; the commit gate + a CI ratchet reject any hand-added or fabricated-shape stamp; a secret-scanner stops an audit-about-leaked-credentials from committing the credentials; every agent's instructions gain the default-route rule (single-pass = incomplete); and audit-report PRs route to a human instead of auto-merging. All commit-time checks, docs, and one dev-agent config flag — no runtime behavior change.

## Original vs Converged

The original draft had the right shape but review found it would have been dead code for the common case (a docs-only commit skips the checks it was placed behind), validated the wrong copy of the file, had no server-side re-check, would have committed found secrets when auditing for leaked credentials, carried a hidden third (init.ts) copy of the skill that had already drifted, flipped a config switch dead in the worktrees where commits actually happen, cited registry guards that wouldn't upgrade the standard's grade, declared a multi-machine posture that failed the system's own lint, and leaned its human-eye guarantee on a green-PR auto-merge protection with a deep arm-then-push TOCTOU. The converged version fixes every one, and — the hardest thread — closes the arm-then-push class on both the pre-merge and post-hoc sides while honestly scoping and tracking (ACT-1191) the one residual it cannot close in-repo.

## Iteration Summary

| Round | Reviewers | Material findings | Standards-Conformance Gate |
|-------|-----------|-------------------|----------------------------|
| 1 | 6 internal + codex + gemini | ~24 across all lenses | ran (0 flags) |
| 2 | codex + gemini(degraded) + integration + adversarial | 5 (init.ts drift, config read-point, citation forms, Standard-A posture, symbol-vs-state) | ran (0 flags) |
| 3 | codex (no blocker) + adversarial | 0 material; 3 tightenings folded | ran (0 flags) |
| 4 | codex + adversarial + integration + lessons | 2 (auto-merge arm-then-push TOCTOU; validator not protected) | ran (0 flags) |
| 5 | codex + adversarial | 2 (5-A deterministic zombie; 5-B "closed" overclaim) | ran (0 flags) |
| 6 | codex + 2 adversarial | 1 (6-A post-hoc alarm dead in two-push variant) + arm-time-reference gap | ran (0 flags) |
| 7 | codex + adversarial | 1 (piece-3 operator-spare lacked fail-closed default); pieces 1+2 CONFIRMED complete | ran (0 flags) |
| 8 | codex(MINOR) + adversarial | 1 (operator-spare = deterministic alarm-free lane) | ran (0 flags) |
| 9 | codex(MINOR) + adversarial(shallow CONVERGED) + adversarial(deep) | 1 (unverifiable protectedPaths() verdict unpinned) | ran (0 flags) |
| 10 | codex(MINOR) + adversarial | 1 (unverifiable re-adoption blessed a poisoned head, suppressing its own alarm) | ran (0 flags) |
| 11 | codex(MINOR, no material) + Standard-A lint(clean) + adversarial(CONVERGED) | 0 material | ran (0 flags) |

## The arm-then-push TOCTOU — the sub-problem that drove rounds 4–11

Making "route audit PRs to a human instead of auto-merging" hold against GitHub native auto-merge (which gates on checks, not paths, and stays armed across pushes) took eight rounds of peeling. The converged design is explicitly LAYERED: (1) DETERMINISTIC load-bearing — a `gather()` re-check keyed on GitHub's `autoMergeArmed` flag disarms any armed protected PR, fail-closed across all three `protectedPaths()` verdicts (`hit`/`clean`/`unverifiable`, an exhaustive space); uniform disarm with no operator-spare (the same policy the system already applies to `.github/`); PLUS the merged-state CI ratchet that catches any UNEARNED stamp regardless of merge path. (2) BEST-EFFORT defense-in-depth — the post-hoc `merged-at-unexpected-head` alarm + re-adoption (retaining the last verified-clean head, never blessing an unverified one). The one residual — a sub-tick timing race and a sustained-API-outage corner of the best-effort layer — is stated honestly as bounded by GitHub-side head-pinning (ACT-1191), never claimed airtight. The key move that ended the corner-by-corner treadmill was the layered-guarantee framing: separating what is deterministically airtight from what is honestly best-effort, so a further post-hoc corner is a bounded residual, not a guarantee-breaking hole.

## Convergence verdict

Converged at round 11. Round 11 produced zero material findings: the external pass (codex-cli:gpt-5.5) returned MINOR ISSUES (the recurring, already-addressed line-parser note), both deterministic gates (Standard-A justification lint; constitutional conformance) pass clean, and a completed adversarial re-review returned CONVERGED — confirming (1) no hole in the DETERMINISTIC guarantees (an unearned/hand-added stamp cannot merge uncaught: the CI ratchet fails it at the pushed head AND at merged state; a form-valid *fabricated* ledger is the explicitly-declared ADV-3 residual, not claimed by this layer) and (2) no overstatement (every airtight claim is scoped to the tick boundary or the deterministic layer; the post-hoc layer explicitly disclaims airtightness). Rounds 4–10 each surfaced a real, code-grounded interaction gap in the green-PR auto-merge protected-path handling; each fix was the reviewers' own prescribed remedy, and the last two rounds closed findings by *simplification* (removing the operator-spare) and by *honest layered scoping* rather than by adding mechanism. Several internal adversarial subagents degraded to a repeated harness flake before emitting a verdict across rounds 8–11 — recorded honestly, non-blocking per the skill's degraded-reviewer rule, and redundant with the completed confirmations. Zero open questions. Decision-Completeness: 16 frontloaded decisions, 2 cheap tags (both contested-then-cleared). Ready for operator review and approval.
