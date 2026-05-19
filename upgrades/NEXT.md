# Upgrade Guide — v1.0.8

<!-- bump: patch -->

## What Changed

Adds an 8th reviewer to the /spec-converge pipeline: the lessons-aware reviewer. Its only job is to check a draft spec against the canonical Instar Design Principles + Lessons Learned index (the previous release) plus the running agent's local memory entries, then surface any documented lesson the spec contradicts or fails to engage with.

This is the structural fix for the recurrence pattern we just walked through: across six recently-merged primitive PRs, multiple specs backtracked on already-documented lessons — the AGENT.md context-bloat trap, the Migration Parity standard, the Testing Integrity standard, the install-if-missing wedge for built-in hooks. None of the seven existing reviewers (4 internal perspective-based + 3 external cross-model) carried the brief "does this spec respect what we've already learned." The author was running convergence on their own spec under hybrid-C pre-authorization that included a self-verify step against the foundational specs they themselves had written — a circular check that surfaced nothing.

The lessons-aware reviewer breaks the circle by injecting a reviewer whose only context is the catalog of paid-for lessons, independent of the spec author's framing. When a spec contradicts a lesson, the reviewer flags it as a critical finding. When a spec touches a surface a lesson covers but never engages with the lesson, the reviewer flags it as a high finding. Findings are signals, not authority — the convergence orchestrator + spec author + user (via the approved tag) decide whether to ship.

Two artifacts: a reviewer prompt template at skills/spec-converge/templates/reviewer-lessons-aware.md and a SKILL.md update that declares the reviewer, changes references from seven reviewers to eight, and locks the lessons-aware reviewer as non-skippable even in pattern-instance abbreviated convergence. v0.1 enforcement is prompt-level — the SKILL.md states the reviewer MUST run. v0.2 will add a deterministic check in the convergence-tag writer that refuses to stamp the spec without a lessons-aware findings section in the report.

Bootstrap exception applied: this spec ships the reviewer itself, so the reviewer cannot run through itself. A manual lessons-aware check is documented in the spec body against the canonical index — same bootstrap pattern /spec-converge used when first introduced.

## What to Tell Your User

- "The spec-converge skill now has an eighth reviewer whose only job is to check a draft against everything we've already learned. The four internal perspective reviewers and three external cross-model reviewers stayed the same; the new one reads the principles and lessons index that landed in the previous release and flags anything the spec contradicts or forgets to engage with. This is the structural defense against the backtracks we hit when the spec author was also the one running convergence under pre-authorization."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Lessons-aware reviewer (8th in /spec-converge) | Runs automatically on every convergence round. Findings are surfaced in the convergence report alongside the other seven reviewers' output. |
| Non-skippable in abbreviated convergence | Pattern-instance abbreviated convergence may skip the three externals to save cost, but the lessons-aware reviewer always runs — the structural defense against circular self-verify. |
| Per-agent lessons loaded | Reviewer reads the running agent .instar/memory/feedback_*.md entries plus the canonical index, so per-agent specific lessons surface even before promotion. |

## Deferred (Tracked Follow-ups)

- v0.2 deterministic convergence-tag enforcement: refuse to write the review-convergence tag unless the report contains a lessons-aware findings section.
- v0.2 cross-repo reviewer: today the prompt assumes a single agent memory location; cross-repo specs need disambiguation between author memory and Echo memory.
- Re-audit of the six already-merged primitive PRs (#252 through #256 plus foundationals) using the new reviewer; amendment PRs for the critical findings already catalogued (Hook stamp pattern vs Migration Parity built-in always-overwrite rule; Sentinel ship-order vs backfill).
