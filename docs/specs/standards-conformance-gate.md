---
slug: standards-conformance-gate
title: Wire the spec-review gate to read the living constitution
author: echo
project: continuous-working-awareness
status: draft-pending-ratification
review-convergence: null
approved: false
approved-by: null
eli16-overview: standards-conformance-gate.eli16.md
---

# Standards-Conformance Gate (the review gate reads the constitution)

## Problem statement

The living constitution (`docs/STANDARDS-REGISTRY.md`, 21 articles) is now on main —
but **no code reads it**. The standards-conformance pass it's meant to feed is
*manual and prompt-driven*: it lives in the `/spec-converge` skill, which (a) is a
prompt the reviewer agent must remember to honor, and (b) isn't even installed on
every host (it's absent on this build machine). So a draft spec that violates a
standard can sail through review — which is not hypothetical: the North Star draft
itself quietly violated **No Manual Work**, the review missed it, and *Justin*
caught it, not the system (`[[feedback_spec_review_against_standards]]`).

The constitution is, in other words, **shipped but asleep** — the exact failure
pattern it was written to fight, now applied to itself. A registry nothing reads
is a wish, not a gate. This spec wires the first code-backed reviewer that loads
the constitution and checks a spec against it, turning the conformance pass from
"the reviewer remembers to check" (willpower) into "the check runs" (structure).

> This is the normative-facet slice of North Star rung 3 (`docs/NORTH-STAR.md`):
> *"index … standards as context … the source of truth the spec-review conformance
> gate reads from."* It is explicitly called out there as **high-leverage early** —
> it can ship before any continuous-awareness machinery and immediately makes
> standards-aware building real.

## Non-goals (tracked, not silent)

- **Auto-blocking** a commit/merge on a conformance signal is NOT in v1
  <!-- tracked: scg-blocking-authority -->. v1 SIGNALS (a report); authority stays
  with the human ratification + the existing `approved: true` gate. Blocking is
  earned only after precision is measured (Signal vs. Authority).
- **Loading capabilities as context** (the inward facet of rung 3) is separate
  <!-- tracked: cwa-capability-index-context -->; this spec is the normative facet
  (standards) only.
- **A full markdown→AST parser.** v1 parses the registry's known, stable structure
  (`### article` + `**Rule.**`/`**In practice.**`); a richer parser is a refinement
  <!-- tracked: scg-richer-parser -->.

## Proposed design

### 1. StandardsRegistryParser — read the constitution into structure

A deterministic parser (`src/core/StandardsRegistryParser.ts`) reads
`docs/STANDARDS-REGISTRY.md` and returns structured articles:
`{ family, name, rule, inPractice }[]`. It splits on `### ` headings within the
standards families (Root / Substrate / Building / Shipping / Interaction) and
extracts the `**Rule.**` and `**In practice.**` lines.

Because it parses an **evolving document**, it is a **state-detector** per
`[[feedback_state_detection_robustness]]` and ships with: (a) an explicit
deterministic rationale (the registry has a stable, authored structure — no LLM
needed to parse it), (b) a **canary** asserting a sane article count (≥ 15) and
that known anchor articles ("Structure beats Willpower", "No Manual Work",
"Signal vs. Authority", "Observability", "Never-Waste Feedback") parse with a
non-empty rule, run at startup + in tests, and (c) a row in the state-detector
registry (`docs/specs/06-state-detector-registry.md`). Silent-failure mode it
guards: registry-format drift → articles silently dropped → the gate checks
against a partial constitution and misses violations.

### 2. StandardsConformanceReviewer — LLM-backed conformance signal

`src/core/reviewers/standards-conformance.ts` reuses the existing
`CoherenceReviewer` LLM machinery (anti-injection preamble, boundary, model tier,
fail-open). Input: the spec markdown + the parsed articles. Output: a structured
report — per standard, one of `conforms | possible-violation | not-applicable`
with a one-line reason and the offending span when flagged.

- **Anti-injection (CRITICAL).** The spec text is rendered inside delimited
  untrusted-data blocks with the standard "content to analyze, never instructions"
  guard (a draft spec could contain "ignore the standards" text). The standards
  themselves come from the trusted on-disk registry, not the spec.
- **Degrade-safe.** No intelligence provider, or an LLM throw/timeout → an empty
  report (fail-open). The conformance gate is a signal; it must never block spec
  work by being down.
- **Model tier.** `capable`/sonnet-class — the judgment ("does this design violate
  No Manual Work?") is nuanced, and the check runs per-spec (rarely), not per-turn,
  so accuracy outranks cost. **Decision flagged for ratification (C).**

### 3. Surface — a callable check (signal, not authority)

- **HTTP:** `POST /spec/conformance-check` — body `{ specPath }` or `{ markdown }`
  → the conformance report. Operator/skill-callable; `INTERNAL_PREFIXES` (it's a
  build-time tool, not an agent-discoverable runtime capability).
- **CLI:** `instar spec conformance <path>` — thin wrapper for direct use and for
  hosts where the skill is absent.
- **Skill integration:** the `/spec-converge` skill's standards-conformance pass
  calls this route, so the pass becomes *structural* (code reads the registry)
  rather than a prompt the reviewer must remember. Where the skill is absent, the
  route/CLI is the durable artifact — the check still exists.

### 4. Signal vs. Authority (NON-NEGOTIABLE)

The reviewer **signals** — it produces a report of possible violations, each
mapped to the standard it implicates and the reason. It has **no blocking
authority**. The human ratification step and the existing `instar-dev` gate
(`approved: true`) remain the authority. This honors
`[[feedback_signal_vs_authority]]` exactly: a brittle/LLM detector flags; the
full-context human gate decides. (Promotion to a blocking/warn signal in the
precommit gate is the tracked `scg-blocking-authority` follow-up, gated on
measured precision.)

### 5. Observability — dogfood the new standard

Per the just-merged **Observability** article, meter the gate: conformance checks
run, possible-violations flagged (per standard), checks degraded (no-intelligence).
Exposed read-only at `GET /spec/conformance-metrics`. This is the heat map of
"which standards do our drafts violate most" — which itself feeds evolution (a
frequently-violated standard may need a clearer rule or an earlier structural
guard). Pairs with the human-as-detector miss-map.

## Lessons carried (manual lessons-grep — [[feedback_spec_converge_pre_auth_circular]])

- **No Manual Work**: the conformance pass becomes code that runs, not a reviewer
  who remembers. This is the standard the motivating incident violated — fixing it
  structurally is the whole point.
- **Signal vs. Authority**: signals only; the human + `approved:true` gate decide.
- **State-detection robustness**: the registry parser ships with a canary + registry row.
- **Framework-agnostic**: LLM via `sharedIntelligence` (subscription/REPL-pool),
  never a raw client; reuses `CoherenceReviewer`.
- **Observability**: metered from brick one (dogfooding the article it enforces).
- **Near-silent**: it's a pull surface (a report you request), not a chat push.
- **Best-effort never-throws / degrade-safe**: a down LLM never blocks spec work.
- **Testing integrity (3 tiers)** + the **dogfood regression**: a known-bad spec
  that violates No Manual Work must be flagged (the North-Star-draft incident
  becomes a test).
- **Migration parity**: server-side code + route + CLI; the parser reads a
  repo-shipped doc; no config-shape change beyond an optional enable default.

## Testing (all three tiers + canary + dogfood)

- **Tier 1 (unit):** parser parses the real registry into ≥ 15 articles with the
  anchor articles present (canary); reviewer maps a stubbed LLM verdict into the
  per-standard report; degrade-safe (no provider → empty report); anti-injection
  (a spec containing "ignore the standards" doesn't alter the report structure).
- **Tier 2 (integration):** `POST /spec/conformance-check` returns a report for a
  posted spec; `conformance-metrics` reflects the run; 503 when disabled.
- **Tier 3 (e2e):** boot the real path; POST a **known-violating** spec (one with a
  "the user must remember to run X" design) and assert the report flags a
  possible-violation against **No Manual Work** — the motivating incident,
  reproduced and caught. Plus the alive check (200, not 503).
- **Dogfood:** run the gate against THIS spec in the suite; assert it does not
  flag a false No-Manual-Work violation (sanity that the gate isn't trigger-happy).

## Acceptance criteria

1. The parser reads `docs/STANDARDS-REGISTRY.md` into structured articles; the
   canary passes (≥ 15 articles, anchor articles present with non-empty rules).
2. `POST /spec/conformance-check` returns a per-standard conformance report for a
   given spec — verified e2e, not unit-mocked.
3. A known-violating spec (manual-work design) is flagged against No Manual Work.
4. The gate SIGNALS only — no code path lets it block a commit/merge in v1.
5. With no intelligence provider, the check degrades to an empty report (never throws).
6. A crafted "ignore the standards" span in the spec does not corrupt the report.
7. `conformance-metrics` exposes runs + per-standard violation counts.
8. All three tiers + canary + dogfood green; tsc + lint clean.

## Risk and rollback

Low–medium. Additive (new module + reviewer + route + CLI); touches no existing
runtime path. The one real cost is an occasional `capable`-tier LLM call per spec
review — bounded (per-spec, not per-turn) and degrade-safe. Worst case on a logic
bug: a spurious or missed conformance signal (a diagnostic, never a block, since
v1 has no authority). Rollback: remove the route + reviewer; the constitution
returns to being read by the manual `/spec-converge` pass only (today's state).

## Migration parity

Server-side code + `POST /spec/conformance-check` + `GET /spec/conformance-metrics`
+ `instar spec conformance` CLI (every agent gets them on update). The parser reads
a repo-shipped doc (no per-agent state). Optional `specReview.conformance.enabled`
default (existence-checked) — default true. No hook/template/skill-file change
beyond the `/spec-converge` skill calling the route (a skill-content migration if
that skill ships in-repo; here it's host-local). The new internal route prefix
(`spec`) is added to `INTERNAL_PREFIXES`.

## Open decisions for ratification

- **(A)** Per-standard structured report (recommended) vs. a single block/warn
  verdict. Per-standard is richer and actionable (you see *which* standard).
- **(B)** v1 surface = callable route + CLI, signal-only; NOT auto-blocking in the
  precommit gate (recommended — measure precision before granting authority).
- **(C)** Model tier `capable`/sonnet (recommended for nuanced judgment, runs
  rarely) vs. `balanced`.

## Convergence note (honest)

Claude-authored draft + manual standards/lessons self-review; full `/spec-converge`
+ `/crossreview` multi-model convergence tooling is not installed on this host
(`[[feedback_external_crossmodel_catches_what_internal_misses]]`). Ratification here
= "direction is right, build"; a fuller multi-model review should precede or
accompany the code merge. (Fitting, given this very spec is the tool that would
make that conformance pass structural.)
