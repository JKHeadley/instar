# Convergence Report — Failure-Learning Ingestion Sources

**Spec:** `docs/specs/FAILURE-LEARNING-INGESTION-SOURCES-SPEC.md`
**Converged:** v3.1, 3 substantive review rounds + 1 corrective edit · 2026-05-28 · topic 13201
**Reviewers:** 5 internal code-grounded (security, scalability, adversarial, integration, lessons-aware) round 1; 3 (integration, adversarial, lessons-aware) rounds 2–3. External cross-model reviewers (GPT/Gemini/Grok) skipped — abbreviated convergence; the mandatory lessons-aware pass ran every round. Standards-Conformance gate not invoked as a live HTTP call (running server predates the route); lessons-aware read the constitution doc directly as the substitute.

## ELI10 Overview

We already built a system that's supposed to watch for problems in how the agent builds things and learn from them — but it's been sitting there with an empty notebook, because nothing automatically tells it when something breaks. This spec is the part that gives it eyes: four automatic ways to notice trouble (a build failing, a change getting undone, a shipped feature breaking, a part of the system falling back to a backup) so it fills its own notebook without anyone typing anything.

The big thing the review process did: it caught that the *first* draft confidently described plugging into two existing "hooks" that **don't actually exist the way the draft claimed**. One ("tell me when something degrades") was a single phone line already in use — plugging in would have hung up on the existing caller. The other was pointed at the wrong switchboard entirely. Review forced both to be re-grounded against the real code and replaced with small, real, new connection points. It also caught a subtle self-trap (the learning system's own repair work could look like a new failure and feed itself), an empty-notebook-but-growing-junk-drawer problem (a hidden table would balloon forever), and a sneaky way a fake "I'm undoing this change" message could mark someone else's problem as solved. All fixed.

The honest headline for you: this grew. The first draft read like "wire up four feeds." After three rounds of review it's clear it also needs a handful of small, additive changes to neighboring parts (add a couple of real connection points, widen one list of categories, and finish two things the *parent* spec promised but never actually built). None of it re-architects anything — but it's a real build, recommended in three small slices, not an afternoon's plumbing.

## Original vs Converged

- **Originally:** "the four sources just call the existing `open()` with the existing attribution — near-zero neighbor changes." **After review:** the two key wiring claims were false against the code, so the converged spec specifies two genuinely-new (but small, additive) connection points — `DegradationReporter.addObserver()` and `InitiativeTracker.setRegressionEmitter()` — and is explicit that the build touches four neighbors, each re-grounded to real file:line.
- **Originally:** "re-polling a flaky CI run is harmless because dedup collapses it." **After review:** that protection relied on a counting path the analyzer doesn't actually use. The converged fix is a **constant per-source identity** (`source:ci`, etc.) so a single machine source can *never* manufacture a learned insight on its own — and, as a stated property, crossing the bar to auto-open a tracked item **always requires at least one human-filed record**. Machine signal needs human corroboration.
- **Originally:** the regression source guarded against the learning loop ingesting its own work in one place. **After review:** that left two side doors open (the loop's own fix-PR failing CI, or being reverted). Converged: the self-exclusion covers all three feeds, and the constant-identity rule is the real backstop even if the exclusion ever regresses.
- **Originally:** "a revert closes the matching record." **After review:** a hand-written "this reverts X" could close an unrelated record. Converged: a revert must pass a reachability + diff cross-check, and close is matched on both the feature AND the exact commit.
- **Originally:** "dedup keeps writes bounded." **After review:** a hidden occurrence table grew one row per event forever. Converted to a bounded forensic log with a retention cap, plus a true conflict-upsert so a race increments instead of dropping.
- **New, surfaced by review:** extending the failure categories would have broken the build (a TypeScript "every category needs an entry" map), and two parent-spec promises (exclude resolved failures from analysis; bound the occurrence table) were specified-but-never-built — the converged spec finishes them, which is why no parent re-convergence is needed.

## Iteration Summary

| Round | Reviewers | Material findings | Outcome |
|------|-----------|-------------------|---------|
| 1 | security, scalability, adversarial, integration, lessons-aware (5) | ~6 blockers + ~10 majors — incl. 2 false wiring claims, category-enum clamp, weak poison-resistance, self-reinforcing loop, unbounded occurrence growth | → v2 (all material findings folded) |
| 2 | integration, adversarial, lessons-aware (3) | 1 blocker (`RECOMMENDATION_BY_CATEGORY` total-record tsc break) + 3 majors (origin is a 4-touchpoint change; diversity-gate combination question; occurrence-retention rationale wrong) + minors | → v3 (all folded; lessons-aware: "convergeable") |
| 3 | integration, adversarial (2) | adversarial: CONVERGED (0). integration: 5/6 resolved + 1 major (§4.3 TaskFlow touchpoint over-stated — accuracy, not correctness) | → v3.1 (one-line corrective edit) |
| 3.1 | — | 0 (the TaskFlow wording was a documentation-accuracy fix; build was correct either way; no design change) | **CONVERGED** |

## Full Findings Catalog (by round, severity, resolution)

### Round 1
- **[BL, integration+lessons+scalability] DegradationReporter single-slot `setRemediator`** — v1's "attach as additional consumer" impossible. → v2/v3: new additive `addObserver()`, observers fire before early-returns, remediator unaffected; wiring-integrity test.
- **[BL, integration+lessons] `registerLedgerEmitters` is SharedStateLedger not FailureLedger; InitiativeTracker not an EventEmitter** — wrong wiring point. → new `setRegressionEmitter()` mirroring `setDigestCacheInvalidator`, fired synchronously post-persist.
- **[BL, integration+security] Category enum mismatch** — `build-failure`/`test-failure`/`regression` clamp to `unknown`. → extend enum + reconcile 4 sites (§7).
- **[BL, adversarial] Flaky-CI poisoning / analyzer uses set-count not distinctCounts + filedBy unspecified.** → constant per-source `filedBy`; "always needs a human" property (§5).
- **[BL, adversarial] Self-reinforcing loop via `createInitiative`→`regressed`.** → `origin` propagation + skip across all 3 mapping sources (§4.3).
- **[BL, scalability] `failure_occurrences` unbounded.** → retention cap (forensic-only) (§5).
- **[MAJ] revert auto-close without cross-check (security); CI per-tick cap + gh hardening (scalability/security); SELECT-then-INSERT race (scalability); degradation is inferred→dashboard-only (adversarial); revert resolved-records feed analyzer (adversarial); agent-awareness (lessons); slice project-tracking (lessons).** → all folded into v2/v3.
- **[MIN] `Backlide`→`Backslide` typo; attributionConfidence explicit; tier0 justification; migrateConfig mechanism.** → folded.

### Round 2
- **[BL] `RECOMMENDATION_BY_CATEGORY` total record breaks tsc on enum extension** (integration+adversarial). → §7 adds 3 templates + totality test.
- **[MAJ] origin propagation is a 4-touchpoint change incl. TaskFlow** (integration+adversarial); loop-exclusion was regression-only (adversarial). → §4.3 enumerates touchpoints + extends skip to ci/revert.
- **[MAJ] §5 diversity-combination left as inline open question** (adversarial NEW-1). → resolved as a property (ci+regression max distinctSessions=2).
- **[MAJ] §5 occurrence-retention rationale factually wrong** (adversarial NEW-3). → corrected: occurrences forensic-only; phantom window-alignment removed; duplication flagged.
- **[MIN] observer placement; drop queueMicrotask; reverse-lookup via list(); ON CONFLICT updated_at; revert close-griefing; uniform secret-scrub; reframe §6.1/§5 as parent-conformance.** → all folded.

### Round 3
- **adversarial: CONVERGED** — all 5 prior resolved against code, no new material.
- **[MAJ, integration] §4.3 TaskFlow touchpoint #4 over-stated** — the store is a lossless JSON blob, so `origin` round-trips for free; the spec implied a serializer change that doesn't exist. → v3.1 reframes TP4 as verify-by-test (no serializer). Build was correct either way.
- **[cosmetic] one citation offset (`coerceCategory` :165 vs :167).** Non-material.

## Convergence verdict

**Converged at v3.1.** The final round had exactly one material finding (a documentation-accuracy over-statement of the TaskFlow work, with no design or build-correctness impact), corrected in one edit that introduced nothing new; the adversarial pass independently returned zero material findings. The spec is ready for user review and approval.

**Heads-up for the approver (scope):** review materially widened this from "wire four feeds" to "four feeds + small additive changes to four neighboring subsystems (enum + 2 new APIs + reverse-lookups + origin threading + analyzer status-filter + occurrence retention), two of which finish unbuilt parent-spec promises." Recommended as **three independent slices** (CI+revert first; regression second; degradation — dashboard-only — last, deferrable). Each ships off-by-default and matures on the rollout board. The approver may reasonably scope the initial build to **slice 1 only**.
