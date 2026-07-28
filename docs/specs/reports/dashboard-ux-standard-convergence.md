# Convergence Report — Dashboard UX Standard, glance floors F10/F11 (topic 29836)

## ⚠ Cross-model review: gemini-cli (degraded — CLI routing retries; direct-invoked, findings incorporated)

An external (non-Claude) pass **did run** and materially changed the spec, but not through the
usual `cross-model-review.mjs` wrapper. codex-cli is **not installed** on this machine; gemini-cli
**is** installed and authed. The wrapper (`skills/spec-converge/scripts/cross-model-review.mjs`)
requires `dist/core/crossModelReviewer.js`, and this fresh worktree carries no build — the symlinked
dist from a sibling branch exposes a stale API (`resolveActiveReviewerFrameworks is not a function`).
So the Gemini pass was invoked **directly** (`gemini -p`, the same first-party OAuth login the wrapper
would use). Gemini's CLI reported transient routing errors (`ClassifierStrategy failed: Retry attempts
exhausted`) yet still returned a substantive review; **two of its findings were new and both were
incorporated** (Layer-2→Layer-3 test coverage; the vacuous-all-zero-fixture guard). Treat this as a
genuine-but-degraded external opinion — a real GPT-tier pass (codex) was unavailable, and the Gemini
pass ran outside the audited wrapper. The internal six-reviewer panel + the code-backed
Standards-Conformance Gate carried the bulk of the review.

## ELI10 Overview

The dashboard is where the operator watches the agent. Nine existing rules (F1–F9) already keep it
reachable, labeled, and stable — but a tab can pass all nine and still greet you with a wall of raw
internal records (IDs, `cadence: 1800s`, `atRisk`). This change adds two rules that make every main
view *readable at a glance*: **F10** (the front page is one plain-English headline + at most five
labeled tiles, under 150 words, with no insider jargon) and **F11** (every tile/number/row is
clickable and drills into detail — a list, then the full record — with no dead ends). The jargon and
IDs aren't deleted; they move one or two clicks down.

The rules are enforced by *structure, not willpower*: one shared front-end component
(`dashboard/glance.js`) builds the headline-plus-tiles template and **refuses** to build a glance that
breaks the budget or carries jargon. Automatic tests across three tiers (unit, integration against the
real `/commitments` API, and an end-to-end "is it alive" boot) back it up. This PR ships **Phase 1
only**: the two rules, the shared component, the tests, and one live example — the Commitments tab
gets its new glance layer drilling into the list it already had. The other 26 tabs are "grandfathered"
(allowed to stay as-is) against a survey scorecard and fixed in later phases; the grandfather list is
structurally guaranteed to only shrink. The operator approved this exact shape (three layers, two
floors, four phases) in topic 29836 on 2026-07-10.

## Original vs Converged

The **original** draft correctly captured the operator-approved shape (three layers, F10/F11, the
survey-scorecard baseline, four phases). Convergence — a six-angle internal panel, a code-backed
constitution gate, and an external Gemini pass — hardened it against the ways a future implementer
could satisfy the letter while defeating the intent, and closed two latent foundation gaps:

- **The counts must be TRUE, not just well-formed.** The original headline example ("664 open
  promises") could drill into a *smaller* filtered list — an incoherent number. Converged: the
  reference impl derives every tile and the headline from **one population** (the beacon-watched open
  promises the list already shows), each tile mapped to an **existing server field** (`atRisk`,
  `blockedOn`, `beaconSuppressed`, `hardDeadlineAt`), with a test asserting headline-count ==
  list-length. A wrong headline number — the exact defect the floor exists to prevent — now fails CI.
- **The jargon check is now scoped and safe.** Converged: Layer 1 is declared **100%
  component-authored** — no agent/user free text ever reaches it — so the validator can scan *all* of
  it (headline + every tile label + every tile value) without a free-text hole, and a user phrasing a
  promise with jargon can't blank the operator's glance (that text is Layer-2, sanitized-displayed,
  never vocab-gated).
- **The validator is now bypass-resistant.** Converged: NFKC-normalize + tokenize (split on
  hyphen/underscore/punctuation, per-token max length) before counting/matching; a separator-agnostic
  ID heuristic (letters adjacent to 3+ digits) instead of per-prefix literals; space/unit-tolerant
  cadence matching that excludes year/decade prose; and a curated insider-TERM denylist for
  concept-jargon the form heuristics miss.
- **The floor can't be side-stepped at runtime.** Converged: on a failing spec the component renders
  an **honest degraded glance** (truncated headline + drill), never a raw-record fallback; the whole
  pre-interaction panel is glance-only (no 972-word sibling); and tests drive builders with
  **adversarial fixtures** (large N, null/empty/error, jargon-laden free text), not author-chosen data.
- **F11 got teeth.** Converged: the walk asserts each drill opens a container that is
  non-empty-and-distinct (or an honest F6 empty-state for a zero count), is **non-vacuous** (≥1
  non-zero tile), and continues one layer deeper (tile → list → **record**). Negative controls kill
  both a dead-end tile and a "re-render the same summary" tile; an XSS control proves inert rendering.
- **The ratchet is now structural.** Converged: tests assert **completeness** (every `TAB_REGISTRY` id
  is in exactly one of adopted ∪ grandfathered — a NEW tab in neither fails the build) and
  **monotonicity** (the grandfather set's size ≤ a committed ceiling that only lowers), so "the list
  only shrinks" is a guard, not a comment.
- **Safety + deployment posture stated explicitly.** Converged: an XSS/display-safety contract
  (`sanitizeForDisplay` + `textContent`-only, extracted to a shared module); a Multi-machine posture
  section (stateless renderer → `unified` by construction, no marker needed); and a Migration Parity +
  Agent Awareness note (dashboard ships wholesale via `express.static` from the package dir — existing
  agents get it on update, no `PostUpdateMigrator` entry). A latent frontmatter defect was also fixed:
  the parent-principle read "Structure > Willpower" and did not resolve to the registry article
  "Structure **beats** Willpower" (the code-backed gate caught it — `parentResolved: false`).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, adversarial, integration/multi-machine, decision-completeness, lessons-aware, scalability, Standards-Conformance Gate | ~14 | One coherent synthesis rewrite of F10/F11: Layer-1-component-authored invariant; XSS-safety contract; validator robustness (tokenize/NFKC/denylist/heuristics, no-raw-fallback); whole-panel-at-rest = glance-only; F11 non-empty-and-distinct + negatives; ratchet completeness+monotonicity; population-floor from adopted count; one-population honest tile→field derivation + count-truthfulness; three test tiers; multi-machine posture; migration-parity + dynamic-import guard; parent-principle resolution fix |
| 2 | Standards-Conformance Gate (clean), gemini-cli (external) | 2 | Gemini added: F11 must also test Layer-2→Layer-3; the walk fixture must be non-vacuous (≥1 non-zero tile). Both incorporated |
| 3 | Standards-Conformance Gate (2 by-design re-flags) | 0 new | Added a self-defending clause reconciling the phased grandfathering with *No Deferrals* (floors ship complete; every deferral tracked; ratchet guarantees only-shrinks). No design change |

## Full Findings Catalog

**Round 1 — internal panel + conformance gate**

- *[MATERIAL, security+adversarial+lessons]* Mandate an XSS/injection safety contract for the
  component + a negative-control injection test. **Resolved** — spec §"XSS / display-safety" +
  `sanitizeForDisplay` extraction + F11 XSS control.
- *[MATERIAL, security+adversarial+decision]* Define exactly which strings the validator scans.
  **Resolved** — Layer-1-is-100%-component-authored invariant; validator scans headline + every tile
  label + value; agent free-text confined to Layer 2/3, sanitized-displayed, never vocab-gated.
- *[MATERIAL, adversarial]* Whole-panel escape hatch (clean glance + 972-word sibling). **Resolved** —
  the pre-interaction panel is glance-only; the raw list is Layer-2, drill-gated.
- *[MATERIAL, adversarial]* Runtime "refuses to build" mode undefined → raw-dump fallback. **Resolved**
  — honest degraded glance, never a raw-record fallback; adversarial fixtures required.
- *[MATERIAL, adversarial]* Word tokenizer + ID/cadence regex brittle (glued/spaced/snake/NFKC/unit
  variants). **Resolved** — NFKC + tokenize + per-token cap + separator-agnostic ID heuristic +
  unit-tolerant cadence + denylist; tests cover bypass variants.
- *[MATERIAL, adversarial]* F11 "a layer opens" too weak. **Resolved** — non-empty-and-distinct or
  honest empty-state; both dead-end and re-render-same-summary negatives.
- *[MATERIAL, adversarial]* Grandfather ratchet unenforced. **Resolved** — completeness + monotonic
  ceiling guard.
- *[MATERIAL, adversarial]* Population floor as magic constant. **Resolved** — derived from
  `GLANCE_ADOPTED_TABS.length`; every adopted tab must actually be walked.
- *[MATERIAL, decision-completeness+lessons]* Tile→field derivation + "Open N" vs subset-list count
  incoherence (a builder would have to guess, on a reference every phase copies). **Resolved** — one
  population, explicit tile→server-field table, headline-count == list-length test.
- *[MATERIAL, lessons+integration]* Testing Integrity — only unit tests. **Resolved** — three tiers
  named (unit + integration against real `/commitments` + e2e feature-alive).
- *[MATERIAL, integration+lessons]* Multi-machine posture undeclared (mandatory check). **Resolved** —
  §"Multi-machine posture": stateless renderer, `unified`, no marker.
- *[MATERIAL, integration+lessons]* Migration Parity not stated. **Resolved** — §"Migration Parity +
  Agent Awareness": wholesale static serving from the package dir + dynamic-import guard.
- *[MATERIAL, conformance gate]* parent-principle does not resolve. **Resolved** — "Structure > Willpower"
  → "Structure beats Willpower" (now `parentResolved: true, verdict: fit`).
- *[MINOR, scalability]* replace-don't-append drill container; patch held-open counts via `data-*`
  merge; keep jsdom fixtures small. **Folded into F11 clause + enforcement notes.**
- *[MINOR, security]* vocab check is a readability floor, not a redaction boundary. **Stated in F10.**

**Round 2 — external (gemini) + conformance gate (clean)**

- *[MATERIAL, gemini]* F11 tests 1→2 but not 2→3 (dead-end lists possible). **Resolved** — the walk
  activates a representative Layer-2 row and asserts a Layer-3 record opens.
- *[MATERIAL, gemini]* The walk can pass vacuously on an all-zero fixture. **Resolved** — fixture must
  produce ≥1 non-zero tile; the test asserts ≥1 real (non-empty) drill opened.
- *[repeat, gemini]* jargon validator gameable → denylist (already resolved R1); ratchet hole → CI
  monotonic guard (already resolved R1).

**Round 3 — conformance gate re-flags (adjudicated, no design change)**

- *[Testing Integrity]* Gate read the whole spec (F1–F8 tiers = static + browser smoke) and flagged
  missing integration/e2e. For **F10/F11** all three tiers are explicitly named; the F1–F8 tiers are
  the pre-existing standard's concern, tracked separately. **No change — already satisfied for this change.**
- *[No Deferrals]* Gate flagged the grandfathering/phased retrofits. By design and operator-approved:
  the floors ship **complete** in Phase 1, every deferral is tracked (`topic-29836`), and the ratchet
  guarantees only-shrinks. **Added a self-defending clause; signal-only, never blocks.**

## Convergence verdict

Converged at iteration 3. The final round produced no material findings requiring a spec change (the
two conformance-gate re-flags were adjudicated as by-design and already-satisfied). `## Open questions`
is empty — every decision is frontloaded (FD-1..7) and the operator approved the shape in topic 29836.
The spec is ready for the approved build (Phase 1: the shared component + the two/three-tier tests +
the Commitments reference implementation).
