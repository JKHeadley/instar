# Convergence Report — Failure-Learning Loop

**Spec:** `docs/specs/FAILURE-LEARNING-LOOP-SPEC.md` · **Companion:** `FAILURE-LEARNING-LOOP-SPEC.eli16.md`
**Author:** echo · **Topic:** 13201 · **Converged:** 2026-05-26 (v4, 3 rounds)
**Reviewers each round:** security, scalability, adversarial, integration, lessons-aware (all code-grounded against the real instar source).

## ELI10 Overview

We build features, ship them, and weeks later something breaks — and right now the lesson from that breakage lives in one person's head and disappears. This adds a smart "incident book": when something we built fails, it gets recorded automatically, traced back to the spec/project that produced it AND the exact build-and-review tools used to make it, and then a quiet analyzer looks at the accumulated pile and surfaces process-level patterns ("bugs of this kind keep coming from work that skipped a review step"). Crucially it closes the loop: a pattern becomes a tracked, human-approved improvement, which ships through our normal build pipeline, and then the system *verifies* whether that kind of failure actually went down — reopening the issue (with a cap) if it didn't, instead of assuming success.

Two things make it trustworthy rather than dangerous. First, it can never change the process on its own — by construction it only ever opens a to-do and a draft for a human to approve (it literally never creates the kind of record the autonomous approver acts on). Second, it's honest about its own limits: attribution is automatic where the trail is clean and one-tap where it isn't, guesses are labeled as guesses, and patterns are only escalated when there's genuinely diverse supporting evidence (not two coincidences). It's scoped to Instar's own development — which is exactly where the "different build skills for Instar vs other work" idea lives — and it ships dark, maturing on the rollout board we built last week, so it's its own first test case.

## Original vs Converged (in plain terms)

- **The "easy first step" was wrong.** v1 claimed we could catch failures for free by reusing a signal the system already tracks. Review (4 reviewers, code-grounded) found that signal actually means "a release switch was flipped backward" or "a commit was rebased away" — not "a shipped feature broke." The converged spec makes the honest first step a fix-commit that names the feature it repairs, plus a one-tap diagnosis, and fixes the test that would otherwise have passed while proving nothing.
- **The "never changes the process on its own" promise had a hole, twice.** v1 asserted it; v2 tried to enforce it with a tag the deciding code couldn't see, plus there was a second back-door path. v3/v4 made it structural by *removal*: the loop never creates the record type the autonomous approver acts on, so auto-implementation is unreachable — a wall, not a sign.
- **Scope got honest.** Tracing failures to the exact build/review tools only works where those tools run — inside Instar's own development. The converged spec says so plainly instead of pretending it ships to every agent (the machinery literally isn't bundled to them).
- **Poisoning got hardened.** A single bad session, a flaky test, a reverted feature, or a forged commit trailer could all have skewed the "which tool is bad" stats. The converged spec adds dedup, a source-diversity requirement, attribution-type weighting, liveness decay, and trailer cross-checks.
- **The verify step got real.** v1's "did the fix work?" had no active driver and no confounder control. The converged spec gives it a definite verification window with a forced terminal verdict, exposure-normalized counts, and a reopen cap — so it can neither park forever nor fool itself.
- **A security boundary that couldn't be delivered was dropped, not faked.** The "you can't do this over the remote tunnel" guard didn't actually hold for the default tunnel type. Rather than ship a guarantee that isn't real, the converged spec drops the write-boundary claim (relying on an audit trail) and makes the sensitive internal detail simply never leave the server over any web route.

## Iteration Summary

| Round | Reviewers who flagged material issues | Blockers | Majors | Minors | Spec changes |
|-------|----------------------------------------|----------|--------|--------|--------------|
| 1 | all 5 | 3 (regression-signal misattribution; autonomous auto-implement contradiction; forgeable provenance + injectable text) | ~10 (poisoning, verify-step, hot-path, store/concurrency, job-retire, trace-delivery, telegram-topic, multi-machine, parity, dep-order, rollback, redaction, supervision) | ~10 | full v2 rewrite |
| 2 | security, scalability, adversarial, integration, lessons | 2 (guard placed where it can't see origin + bypass route; trace-enrichment migration targets an unshipped file) | 1 (F12 transport) | ~6 | v3 (by-construction guard; self-hosting scope; minors) |
| 3 | security, integration | 0 | 1 (F12 still insufficient vs quick tunnels) | 1 (storage wording) | v4 (drop false boundary + internal-only full detail; dedicated SQLite table) — **adversarial + lessons-aware declared convergence** |

## Full Findings Catalog

The complete finding-by-finding catalog with severities, the reviewer who raised each, and the exact resolution + spec section lives in **§10 / §10.1 of the spec** (round 3, round 2, and round 1 tables). Highlights:

- **R1 BL-1 (blocker, 4 reviewers):** existing `regressed` transition = rollout-backslide / merge-unreachability, not functional failure; no event hook; two writers; not edge-triggered → first slice = bugfix-commit + agent-diagnosed; regression rewritten as new edge-triggered detection emitted from `InitiativeTracker.update()`; dogfood E2E driven by the real trigger.
- **R1 BL-2 / R2-BL-2 (blocker):** "never auto-implements" → resolved **by construction** (loop never mints an `EvolutionProposal`; the auto-implement path only acts on proposals). Round-3 adversarial verified no path exists.
- **R1 BL-3 / R2-BL-3 (blocker):** forgeable provenance + injectable failure text + undeliverable migration → claims-vs-verified provenance, enum-constrained untrusted-text classifier, template-keyed recommendations, and toolchain provenance **scoped to instar-self-hosting** (the file isn't shipped to agents).
- **Metric poisoning (majors):** dedupeKey+occurrenceCount, source-diversity gate (≥K sessions ∧ ≥J commits), attribution-type weighting, liveness/decay, trailer cross-check, `filedBy` audit, server-side join validation.
- **Verify step (majors):** active verification window + forced terminal verdict, exposure normalization, reopenCount cap → `inconclusive`, correlational labeling.
- **R3-sec-F12 (major):** the tunnel write-boundary couldn't be delivered → dropped the false claim (audit-trail detective control instead) and made `detail.full` internal-only (never served by any HTTP route).
- **Deploy/store/supervision:** analyzer ships as an off-by-default template (never retired-swept); dedicated indexed SQLite table; `supervision: tier1` with a Haiku validator; near-silent insight push to the existing system topic (not a new one) with a stable identity; rollback semantics; multi-machine reconciliation.

## Convergence verdict

**Converged at round 3.** Adversarial and lessons-aware reviewers explicitly declared convergence after code-verifying that the two round-2 blocker fixes are genuine structural properties (not re-asserted claims). The two remaining round-3 findings (one security major, one integration minor) were resolved in v4 by *removing* surface — dropping an undeliverable security boundary in favor of an honest audit control + internal-only detail, and declaring a dedicated indexed store — which introduces no new design surface to re-review. The spec is ready for user review and approval. Per the instar-dev gate, `approved: true` is the user's step.
