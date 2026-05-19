---
title: "Lessons-aware reviewer — 8th parallel reviewer in /spec-converge"
slug: "lessons-aware-reviewer"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "lessons-aware-reviewer.eli16.md"
review-convergence: "2026-05-19T04:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T04:30:00Z"
review-report: "docs/specs/reports/lessons-aware-reviewer-convergence.md"
review-deviation: "Bootstrap exception. This spec ships the reviewer itself; it cannot run through itself. Same bootstrap pattern /spec-converge used when first introduced. Manual lessons-aware check applied against docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md (just-merged via PR #257); findings documented in the convergence report."
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C, with explicit 2026-05-19 ack: 'Yes, please attend to all of this in autonomous mode')"
approved-date: "2026-05-19"
approval-note: "Pre-authorized after Justin's 2026-05-19 root-cause acknowledgment + explicit go-ahead. This is the structural fix for the spec-converge-pre-auth-circular failure mode (feedback_spec_converge_pre_auth_circular). The reviewer's job is exactly to prevent future PRs of this shape from skipping the lessons check."
lessons-engaged:
  - "P1 (Structure>Willpower): the reviewer is the structural enforcement; not a docs-only request to agents to be lessons-aware."
  - "P3 (Migration Parity): the skill modification ships in the same PR (templates/reviewer-lessons-aware.md + SKILL.md update); no v0.2 deferral."
  - "P10 (Comprehensive-First Directive): no recurrence-risking deferrals — the v0.1 ships the full reviewer prompt + SKILL.md wiring."
  - "L4 (External cross-model review): explicitly addressed — the lessons-aware reviewer is the structural compensation when externals are skipped during abbreviated convergence."
  - "B28 (Spec-converge pre-auth circular): direct fix — this reviewer is what makes self-verify non-circular by injecting an LLM that loads memory + CLAUDE.md + the principles index."
---

# Lessons-aware reviewer — 8th parallel reviewer in /spec-converge

## What this is

The 5th internal reviewer (8th overall, with 3 externals) added to `/spec-converge`. Its only job: check the spec under review against the canonical `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` index + the running agent's `.instar/memory/feedback_*.md` entries + CLAUDE.md principles, and surface every contradiction or unengaged-but-applicable lesson.

This is the structural fix for the failure mode documented at `feedback_spec_converge_pre_auth_circular`: when an author writes a spec AND runs its convergence AND self-verifies it, the self-verify step is circular — the author's framing IS the alignment basis. The lessons-aware reviewer breaks the circle by injecting an LLM whose only context is "what does the catalog say?", independent of the author's framing.

## Why it ships now

A concrete failure made this urgent:

- The Conversational-action primitive v0.1 draft (PR #256, pre-amendment) inlined a catalog block directly into `.instar/AGENT.md`, contradicting three already-built defenses (ContextHierarchy, Playbook, Self-Knowledge Tree) plus the Structure-over-Willpower principle.
- A post-CI audit found 5 more material backtracks across the 9 specs in the roadmap: Hook stamp pattern resurrecting the install-if-missing wedge, Sentinel ship-order before backfill, Testing Integrity "no exceptions" being normalized into exceptions, Migration Parity systematically deferred, sentinel auto-mutation without trust wiring.

Each backtrack would have been caught by a reviewer whose job is "what documented lesson does this contradict?" None of the existing 7 reviewers (security/scalability/adversarial/integration + 3 external) carry that brief.

## Design

### Reviewer prompt template

Lives at `skills/spec-converge/templates/reviewer-lessons-aware.md`. The template instructs the reviewer to:

1. Load the spec under review.
2. Load the canonical principles + lessons index (`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`) in full.
3. Load the running agent's `.instar/memory/feedback_*.md` files (per-agent supplementary context).
4. Load the project's `CLAUDE.md` Standards + Anti-Patterns + Key Patterns from Dawn sections.
5. For each Part 1 principle (P1-P10) and Part 2 architectural lesson (L1-L17), check: contradiction (critical) or missing-engagement (high).
6. For each Part 3 behavioral lesson (B1-B39), check if the spec proposes agent-facing behavior and whether it respects the rule.
7. Output structured findings with the same shape as other reviewers.

The template also enumerates specific backtrack-tells (e.g. `applyXBlock(agentMd, ...)` → L1; new `execFileSync('git', ['reset', ...])` → L12) so the reviewer LLM has concrete pattern-matches to apply.

### SKILL.md wiring

Updates `skills/spec-converge/SKILL.md` to:

- Declare the lessons-aware reviewer as the 5th internal reviewer (8th total).
- State the reviewer MUST run on every round, including pattern-instance abbreviated convergence (where externals may be skipped, the lessons-aware reviewer is the structural compensation).
- Update "seven" references to "eight" throughout.
- Add a paragraph explaining the structural purpose: catches the circular self-verify problem.

### Convergence-tag enforcement (deferred to v0.2)

v0.1 enforces lessons-aware participation via the SKILL.md prompt + reviewer template (instructional). v0.2 will add a deterministic check in `write-convergence-tag.mjs` that requires the convergence report contain a `## Lessons-aware findings` section before writing the convergence tag. Tracked as a follow-up, not a recurrence-risking deferral (the prompt-level enforcement is the v0.1 minimum-viable check).

## Bootstrap exception

This spec is the lessons-aware reviewer itself; the reviewer cannot run through itself. Same bootstrap pattern `/spec-converge` used when first introduced (documented in `skills/spec-converge/SKILL.md` under "Bootstrap exception").

**Manual lessons-aware check applied** (against the index at `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`):

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ Engaged — the reviewer is structural enforcement, not a request that agents be lessons-aware |
| P2 Signal vs Authority | N/A — reviewer outputs are signals; the author + the skill orchestrator are the authority |
| P3 Migration Parity | ✓ Engaged — skill change ships in same PR; no v0.2 deferral. The skill template (`templates/reviewer-lessons-aware.md`) is a new file; SKILL.md edits are additive |
| P4 Testing Integrity | Partial — no unit tests for a markdown prompt; integration test = next convergence run that exercises the reviewer (documented as deferred follow-up, not silent) |
| P5 Agent Awareness | N/A — `/spec-converge` is an agent-developer skill, not a user-facing capability |
| P6 Zero-Failure | N/A — no test changes |
| P7 LLM-Supervised Execution | ✓ Engaged — the reviewer IS a Tier-1 LLM supervisor for the spec-convergence pipeline |
| P8 UX & Agent Agency | ✓ Engaged — reviewer gives the spec author a clear voice ("here's what you missed, here's the fix"), graduated agency (findings are advisory; author still drives resolution) |
| P9 Intent Engineering | N/A — reviewer doesn't intersect organizational-intent surfaces |
| P10 Comprehensive-First | ✓ Engaged — v0.1 ships full template + SKILL.md wiring. Convergence-tag enforcement deferred but explicitly NOT recurrence-risking (the v0.1 prompt-level enforcement catches the same failure mode the script-level check would catch) |
| L3 Topology check | ✓ Engaged — confirmed before drafting that this belongs in `skills/spec-converge/` (the convergence skill), not in `src/core/` or as a primitive |
| L4 External cross-model review | ✓ Engaged — the lessons-aware reviewer is the structural compensation when externals are skipped in abbreviated convergence |
| L6 Side-effects review | ✓ Engaged — seven-dimension review at `upgrades/side-effects/feat-lessons-aware-reviewer.md` |
| L9 ELI16 required | ✓ Engaged — sibling `lessons-aware-reviewer.eli16.md` ships in this PR |
| L10 Release notes in same PR | ✓ Engaged — `upgrades/NEXT.md` in this PR |
| B28 Spec-converge pre-auth circular | ✓ Engaged — this spec IS the structural fix |

No contradictions found. Two minor deferrals (P4 integration test, P10 convergence-tag script check) both have explicit non-recurrence-risk justification.

## Implementation slice for this PR

1. This spec + ELI16 + convergence report (with the manual lessons-aware check above).
2. `skills/spec-converge/templates/reviewer-lessons-aware.md` — the reviewer prompt template.
3. `skills/spec-converge/SKILL.md` — updates to enumerate the reviewer, change "seven" to "eight" throughout, document the MUST-run requirement.
4. `upgrades/NEXT.md` + `upgrades/side-effects/feat-lessons-aware-reviewer.md`.
5. Package.json version bump.

## v0.1 deferred items

- **Deterministic convergence-tag enforcement** — `write-convergence-tag.mjs` doesn't yet require the convergence report contain a `## Lessons-aware findings` section. v0.2.
- **Reviewer-specific test scaffold** — no automated test that the reviewer prompt produces useful output. Will land when first cycle of re-auditing merged PRs (next 4 tasks in the roadmap) produces enough sample output to validate.
- **Cross-repo reviewer** — the prompt assumes a single `.instar/memory/` location. For cross-repo specs (where lessons are split between Echo's memory and the spec author's memory), needs disambiguation. v0.2.
