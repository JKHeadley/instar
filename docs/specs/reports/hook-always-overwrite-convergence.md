# Convergence Report — hookParityRule alwaysOverwrite amendment

## ELI10 Overview

Instar ships built-in hooks (scripts that fire at lifecycle moments like session-start). The policy is clear: when Instar updates, the canonical version of a built-in hook always wins. Always. The Hook primitive that landed last week accidentally broke this policy with a clever-but-wrong stamp pattern — it noticed when a user had edited the rendered hook and refused to overwrite. The protective intent was inverted: silent stuck-on-broken-template is exactly the failure §4 was written to prevent. This release inverts the policy back: always overwrite, but emit an audit signal so any clobbered user edit is recoverable from git.

## Original vs Converged

The amendment doesn't redesign the parity primitive; it restores the documented Migration Parity §4 invariant that the v0.1 implementation broke. The original implementation had verify() flag user-edits AND remediate() refuse to write. The converged shape: verify() still flags, remediate() always overwrites (for rules opting into alwaysOverwrite), and the sentinel emits a new parity:user-edit-overwritten event for audit.

The cleanest abstraction is per-rule: each ParityRule declares its applicable Migration Parity policy. Hooks set alwaysOverwrite=true (§4). Skills leave it undefined (§5 — refuse-on-conflict, dedicated migrations override).

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check (against canonical principles index) | 0 contradictions; 0 deferrals | None |

## Manual lessons-aware findings

See the lessons-engaged frontmatter and the manual lessons-check table in the spec body. Every Part 1 principle (P1-P10) plus relevant Part 2 architectural lessons walked. The amendment is itself a direct fix for the recurrence pattern catalogued at B28 (Spec-converge pre-auth circular). No contradictions, no deferrals.

## Convergence verdict

Converged at iteration 1. This is a tactical amendment to a merged primitive; the lessons-aware reviewer (PR #258) is the structural defense going forward, and this amendment is the corrective for the case already on main when the audit caught it.

## Deviation note

Tactical amendment to merged primitive. Lessons-aware reviewer (PR #258) just merged to its branch but is awaiting re-land to main (the gh PR auto-merge target-rewrite mishap closed it without the changes propagating). Manual lessons-check applied transparently in the spec body against the canonical principles index — same bootstrap pattern PR #258 used.
