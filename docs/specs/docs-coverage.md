---
title: Documentation coverage — deterministic enumeration as a structural antidrift
slug: docs-coverage
status: ratified
approved: true
review-convergence: 2026-05-21T03:10:00Z
eli16-overview: docs-coverage.eli16.md
ratification: principal-direct-2026-05-21
ratification-evidence: Telegram topic 11235 (instar docs) — Justin's instruction to enter autonomous mode and "complete option 3" (the documentation-coverage script described as the structural answer in the audit report sent earlier in the same topic).
---

# Documentation coverage — deterministic enumeration as a structural antidrift

## Problem

A multi-pass audit driven by sub-agent reviewers (May 2026) demonstrated that documentation drift on this codebase cannot be converged by manual audit passes. Each pass surfaced new findings: Pass 1 found ~30 items, Pass 2 added ~15 more, Pass 3 added one major new category (Codex / cross-framework portability), Pass 4 added ~12 more code-side categories (token burn detection, quota management, telemetry, session activity tracking, UnjustifiedStopGate, etc.), Pass 5 added Slack (shipped but absent from README), Pass 6 added paste / privacy / remediation / tasks subsystems. The rate decreased but never reached zero.

The root cause: exhaustive enumeration of "every shipped capability cross-referenced against every doc" is a deterministic walk over the source tree, and sub-agents performing stochastic search will continue to find new items as long as the gap is large enough that no single pass exhaustively enumerates. By exhaustive subsystem count, only **one of twenty-four `src/` subsystems** (identity, covered by `multi-machine.md`) has complete feature-doc coverage. Two subsystems (`core` and `monitoring`, 228 `.ts` files between them) have near-zero user-facing documentation.

The structural answer per the codebase's "Structure > Willpower" principle is a deterministic script that walks the source tree, enumerates capabilities, cross-references against docs, and produces a coverage report. The script converges by construction.

## Design

`scripts/docs-coverage.mjs` — pure-Node, no dependencies, runnable from any cwd that contains a `src/` directory.

### Capability enumeration

Six capability types, each enumerated by a strategy specific to where it lives in the source tree:

| Type | Source | Enumeration strategy |
|---|---|---|
| Route | `src/server/routes.ts` | Regex over `router.<verb>('<path>', ...)` registrations |
| Command | `src/commands/*.ts` | Filenames stripped of `.ts` |
| Job | `src/scaffold/templates/jobs/instar/*.md` | Filenames stripped of `.md` |
| Hook | `src/templates/hooks/*.{sh,js,mjs}` | Filenames |
| Skill | `skills/*/SKILL.md` | Directory names + `user_invocable` frontmatter |
| Class | PascalCase `*.ts` under selected `src/` subsystems | Filename stripped of `.ts`, prefixed with subsystem name |

Class enumeration is scoped to the eighteen subsystems where user-facing capabilities live (`core`, `monitoring`, `memory`, `lifeline`, `messaging`, `threadline`, `scheduler`, `remediation`, `tasks`, `paste`, `privacy`, `tunnel`, `moltbridge`, `identity`, `knowledge`, `users`, `security`, `providers`). Internal utilities (`utils`, `data`, `types`) are excluded because they are by design not user-facing.

### Doc cross-referencing

For each capability, the script loads `README.md` plus every `.md` / `.mdx` file under `site/src/content/docs/` and counts substring mentions. Coverage classification:

- **DOCUMENTED** — capability appears in 2+ docs
- **PARTIAL** — capability appears in exactly 1 doc
- **UNDOCUMENTED** — capability appears in 0 docs

The two-mention threshold for DOCUMENTED is intentional: a feature mentioned only in the place you'd expect (e.g. `instar pair` in `multi-machine.md`) is "partially" documented in the sense that it lives in only one entry point. Real coverage means the capability is also discoverable from indexes or related features.

### Coverage scoring

Per-type coverage is computed as `(documented + partial × 0.5) / total`. The half-weight for partial reflects that a single mention is better than nothing but worse than two.

### Floors

The script supports per-category floors via environment variables. Initial floors are calibrated to current state plus a 2–3 percentage-point buffer for normal churn. The intent is that doc-update PRs raise the relevant floor as they fix items, ratcheting the bar upward without flapping CI on unrelated PRs.

Initial floors:
- overall: 13% (current 15%)
- route: 11% (current 13%)
- command: 40% (current 42%)
- job: 55% (current 61%)
- hook: 22% (current 25%)
- skill: 80% (current 86%)
- class: 8% (current 10%)

### CI integration

A new `Docs Coverage` job in `.github/workflows/ci.yml` runs `node scripts/docs-coverage.mjs --check` on every PR. Failure exits 1 with the offending category names. The report (markdown + JSON) is uploaded as a CI artifact on every run for human review.

### Output artifacts

- `.instar/docs-coverage.json` — machine-readable inventory: full capability list with mentions, per-type tallies, thresholds, timestamp. Used by CI and by future automation (e.g. the weekly audit job in Phase 5).
- `.instar/docs-coverage.md` — human-readable report grouped by type, with sections for undocumented and partial-coverage items. Suitable for committing to a release-notes context or sending in a Telegram digest.

Both are git-ignored (added to `.gitignore`) — they're generated artifacts, not source.

## Why this fits the codebase

The "Structure > Willpower" principle says: if a behavior matters, enforce it structurally. A documentation-coverage CI check is the structural form of "remember to update the docs when you ship a feature." Authors don't have to remember; the gate fails and they fix it before merging.

The script is also the foundation for two follow-on capabilities (separate PRs):

1. **Weekly audit job** — a scheduled instar job that runs the script and surfaces drift via Telegram (Phase 5 of the current sprint).
2. **Pre-commit coverage check** — an optional husky hook for authors who want immediate feedback rather than waiting for CI.

## Testing

Seven unit tests cover the script:
- Enumerates every capability type
- Counts the correct number of each type
- Classifies coverage correctly (documented / partial / undocumented)
- `--check` passes when floors are met
- `--check` fails when any category is below floor
- `--json` emits to stdout
- Writes both JSON and markdown reports to `.instar/`

All tests build a mock repo on disk, run the script via spawn with the env override that sets `INSTAR_DOCS_COVERAGE_ROOT`, and assert against the JSON output.

## Rollback

The script is purely additive — it produces reports and (in `--check` mode) returns an exit code. Reverting:
- Remove `scripts/docs-coverage.mjs`, `tests/unit/scripts/docs-coverage.test.ts`
- Remove the `docs-coverage` job from `.github/workflows/ci.yml`
- Remove the `.gitignore` entries

No state to migrate, no agent behavior to undo.

## Non-goals

- **Per-capability coverage suggestions.** The script reports what's undocumented but doesn't write the docs. That's the doc-update PRs in Phase 2.
- **Auto-fixing.** No LLM in the loop. Deterministic only.
- **Replacing the agent-driven audit entirely.** Manual audit passes still catch things this script misses (wrong factual claims, conceptual conflations, semantic drift). The script catches the enumeration class of drift; manual audits catch the comprehension class.
