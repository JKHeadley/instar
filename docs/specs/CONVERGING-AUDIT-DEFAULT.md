---
title: "Report-Backed Converging Audit — the Default Convergence Gate"
slug: "converging-audit-default"
author: "echo"
parent-principle: "Iterative Audit to Convergence"
eli16-overview: "converging-audit-default.eli16.md"
status: "approved"
approved: true
project: "cartographer-conformance"
spec_number: 4
depends-on: "spec-converge skill, StageTransitionValidator, instar-dev-precommit gate"
review-convergence: "2026-06-10T18:10:05Z"
review-iterations: 1
review-completed-at: "2026-06-10T18:10:05Z"
---

# Report-Backed Converging Audit — the Default Convergence Gate

> Spec #4 of `cartographer-conformance`. Goal (operator): "make the
> iterative-converging-audit the default path — not just the formal initiative
> state machine." Grounding the goal against real code revealed two things:
> **(1) a genuine BUG** — the formal convergence gate is broken; **(2)** convergence
> is ALREADY effectively required for any spec that ships code (the instar-dev
> precommit gate blocks an un-converged spec). So the real, valuable work is not
> *new* enforcement — it is making the gate **correct, consistent, and
> report-backed** (proving the converging audit actually RAN, not that a tag was
> hand-added).

## Problem statement (grounded, verified against source)

The convergence gate exists in two places that DISAGREE:

1. **`StageTransitionValidator`** (the formal initiative state machine, behind
   `POST /projects/:id/advance`) blocks `spec-drafted → spec-converged` unless
   `data['review-convergence'] === true` — a **boolean** (`StageTransitionValidator.ts:155`).
   But the canonical converging-audit tooling (`skills/spec-converge/scripts/
   write-convergence-tag.mjs:175`) writes `review-convergence: "<ISO timestamp>"` — a
   **string**. So `"2026-06-10T…" !== true` and the formal gate **REJECTS every
   properly-converged spec**. The formal convergence gate is broken for real specs.
   (Verified: lines quoted above.)

2. **The instar-dev precommit gate** (`scripts/instar-dev-precommit.js`, the ad-hoc
   path that blocks a commit touching source) recognizes `review-convergence` via a
   lenient regex — it accepts the timestamp (so it is NOT broken), but it accepts
   ANY truthy value, including a hand-added tag with **no convergence report behind
   it**. "Converged" there can mean "added a tag," not "ran the audit."

So: the formal gate is **broken**, the two gates are **inconsistent**, and neither
verifies that the converging audit ACTUALLY RAN (its report artifact exists).

## Proposed design

### Part A — Fix the formal gate's tag-format bug (unconditional)

`StageTransitionValidator`'s `spec-drafted → spec-converged` check accepts the
**canonical convergence tag**: a non-empty `review-convergence` value that is either
the ISO-timestamp string the tooling writes OR boolean `true` (back-compat). A new
pure recognizer `isConvergenceTagPresent(value)` (a tiny, dependency-free predicate)
is the single definition of "the tag is present," exported from the validator's
module and unit-tested against both formats + the empty/false cases. This fixes the
formal gate so it can advance a real converged spec.

### Part B — Make the converging audit the DEFAULT by requiring its REPORT (dark-flagged)

The converging audit's real proof-of-work is its **report** at
`docs/specs/reports/<slug>-convergence.md` (written by the spec-converge skill,
Phase 5). Requiring the tag without the report lets a spec fake convergence. So:

- A new config flag **`specReview.requireConvergenceReport`** (default **false** —
  current behavior, dark-safe) added to `ConfigDefaults` beside the existing
  `specReview.conformance` block (deep-merge backfill).
- **The precommit `.js` reads the flag via an ENV VAR, not config** (verified at
  convergence: the precommit script reads NO config file and runs pre-compile, so it
  cannot import the TS config loader). Thread it as
  `process.env.INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT === '1'`, mirroring the existing
  in-file `INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS === '1'` pattern. The husky `.husky/
  pre-commit` hook exports it from config (a one-line read), so config remains the
  source of truth while the script stays config-loader-free. When unset, the new
  precommit branch never executes → byte-identical to today.
- **The formal validator's report check stays UNCONDITIONAL** (verified: it ALREADY
  requires the report via `CONVERGENCE_REPORT_MISSING`, independent of any flag). Part
  B does NOT flag-gate that existing check (doing so would WEAKEN the formal gate).
  The flag's effect is therefore asymmetric and additive: it adds a report check ONLY
  to the **precommit** gate, bringing it UP to the formal gate's strictness when on.
- **Tier-1 exemption (verified):** the precommit has a `tier1-lite` path that exits
  BEFORE the convergence/approval check (a Tier-1 commit needs no converged spec). The
  new report check sits in the same Step-6 (tier-2/3) region, so it correctly does NOT
  apply to Tier-1 commits — and the consistency test (Part C) scopes its precommit
  fixtures to the tier-2/3 path.

### Part C — Gate consistency (Structure beats Willpower)

The precommit gate (a pre-compile `.js`, so it CANNOT import the TS validator) and
the TS validator must AGREE on "is this spec converged?". They cannot share a TS
module across the compile boundary, so consistency is enforced **by a test**, not by
hope: a unit test feeds a shared table of spec-frontmatter fixtures (timestamp tag /
boolean tag / no tag / report-present / report-missing) to BOTH the validator's
`isConvergenceTagPresent` + report check AND the precommit's recognition logic, and
asserts they return the SAME converged verdict for every fixture (under both flag
states). A drift between the two gates fails CI. (The precommit's recognition is
factored into a tiny pure exported function so the test can call it directly.)

### Part D — Surface the cross-model-review status (observe-only)

The converging audit records a `cross-model-review` frontmatter flag
(`codex-cli:<model>` | `degraded-all-rounds` | `unavailable` | `skipped-abbreviated`).
The gates' diagnostic output SURFACES this value (e.g. "converged — cross-model:
unavailable") so an operator/agent sees whether external review actually ran — never
blocking on it (Signal vs. Authority), just making the audit's depth visible.

## Security & data-egress

None — this is a build-time gate change. No network, no LLM in the gate path
(the converging audit's LLM calls are upstream, in the spec-converge skill). The
report-existence check is a local `fs.existsSync`.

## Migration & Deployment / Agent Awareness

- **Config:** `specReview.requireConvergenceReport` (default false) added to
  `ConfigDefaults` `SHARED_DEFAULTS` (deep-merge backfill; existence-checked).
- **Not an agent-facing capability:** the convergence gate is a dev-process gate
  (precommit hook + the formal state machine), NOT a user-invokable runtime
  capability — so no CLAUDE.md template / migrateClaudeMd section is required (the
  feature-completeness test only governs agent-facing capabilities). No new route.
- **Back-compat (critical — this gate ships every commit):** with the flag default
  false, the precommit gate's behavior is **byte-identical to today** (the report
  requirement is inert) — verified by a test that the default path accepts a
  timestamp-tagged, approved spec with no report (today's specs). The formal-gate
  bug-fix is purely additive (it accepts MORE than before — the timestamp it should
  always have accepted — and never less).
- **Rollback:** the flag default-false IS the rollback; no migration reversal.

## Test plan (3 tiers)

- **Tier 1 (unit):**
  - `isConvergenceTagPresent`: true for a timestamp string + boolean true; false for
    empty / false / missing.
  - **StageTransitionValidator bug-fix**: a spec with `review-convergence:
    "<timestamp>"` + a present report now PASSES `spec-drafted → spec-converged`
    (previously rejected); a spec with no tag still fails; a spec with the tag but a
    MISSING report fails (the existing `CONVERGENCE_REPORT_MISSING` path).
  - **precommit recognition (pure fn)**: accepts a timestamp-tagged + approved spec
    with the flag off (today's behavior); with the flag ON, rejects the same spec if
    its report is missing, accepts it if the report exists.
  - **gate-consistency**: the shared fixture table yields IDENTICAL converged
    verdicts from the validator path and the precommit path, under both flag states.
- **Tier 2 (integration):** `POST /projects/:id/advance` advances a real
  timestamp-tagged + reported child spec from `spec-drafted → spec-converged`
  (proving the bug-fix works through the real route) — mirror an existing `/advance`
  test; and is still blocked when the report is missing.
- **Tier 3 (E2E):** run the REAL `scripts/instar-dev-precommit.js` (as the hook does)
  in a fixture repo: with the flag off, a timestamp-tagged+approved spec + staged
  source commits cleanly; with `requireConvergenceReport` on, the same commit is
  BLOCKED until the report file is present. Proves the shipped gate behaves correctly
  end-to-end under both flag states.

## Open questions (resolved by decision)

- **(Resolved — decided)** Consistency enforced by a cross-gate test, not a shared TS
  module (the precommit runs pre-compile and cannot import TS).
- **(Resolved — dark-safe)** Report requirement ships behind a default-false flag;
  today's workflow is unchanged until an operator opts in.
- **(Resolved — out of scope)** Auto-registering ad-hoc specs into the formal
  InitiativeTracker, and a proactive session-start un-converged-spec nudge, are
  larger workflow changes not owed here — the bug-fix + report-backing + consistency
  are the grounded, valuable core. The cross-model-review *default-on* enforcement is
  also out of scope (cross-model availability is host-dependent; forcing it would
  block on a missing codex login — Signal vs. Authority keeps it observe-only).
