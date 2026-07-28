# Side-Effects Review — Report-Backed Converging Audit (spec #4, Tier 2)

**Version / slug:** `converging-audit-default`
**Date:** `2026-06-10`
**Author:** `Echo`
**Spec:** `docs/specs/CONVERGING-AUDIT-DEFAULT.md` (converged 1 round + a focused buildability/back-compat review, approved)
**Second-pass reviewer:** `not required — a focused convergence review verified the bug + the byte-identical back-compat + pinned the env-var threading; this review covers the seven dimensions on the as-built code`

## Summary of the change

Fixes the convergence gate and makes the report-backed converging audit the default
(dark): **(A)** `StageTransitionValidator` checked `review-convergence === true`
(boolean) but the real tooling writes a timestamp string — so the formal gate
**rejected every properly-converged spec**; fixed via a pure `isConvergenceTagPresent`
predicate that accepts the canonical timestamp (and boolean `true` for back-compat).
**(B)** A default-off `specReview.requireConvergenceReport` flag that, when on, makes
the precommit gate also require the convergence **report** file (proof the audit ran)
— the precommit reads it via an env var (it runs pre-compile and reads no config).
**(C)** A cross-gate consistency test so the formal validator and the precommit gate
cannot drift apart. **(D)** Surfaces the `cross-model-review` value in diagnostics
(observe-only).

## Files touched

- `src/core/StageTransitionValidator.ts` — `isConvergenceTagPresent` predicate (Part A). The existing `CONVERGENCE_REPORT_MISSING` check is UNCHANGED + unconditional.
- `src/config/ConfigDefaults.ts` + `src/core/types.ts` — `specReview.requireConvergenceReport: false` (deep-merge backfill).
- `scripts/instar-dev-precommit.js` — Step-6 recognition routed through the new pure module; env-gated report check (Part B); cross-model surfacing (Part D).
- `.husky/pre-commit` — fail-open one-liner exporting the env from config.
- NEW `scripts/lib/convergence-recognition.mjs` — the pure recognizer both the precommit and the consistency test use.
- Tests: validator (timestamp acceptance), consistency, `/projects/:id/advance` integration, the real-precommit E2E.

## 1. Over-block

Part A makes the formal gate accept MORE (the timestamp it should always have
accepted) — it can never over-block more than before. Part B's report requirement can
over-block only when the flag is ON (default off); and the formal gate already
required the report unconditionally, so Part B merely brings the precommit to parity.

## 2. Under-block

Could a spec fake convergence? With the flag on, the report file must exist — a
hand-added tag alone no longer passes the precommit. With the flag off, behavior is
unchanged from today (the report requirement is inert). The predicate rejects
empty/false/missing tags (tested).

## 3. Level-of-abstraction fit

The recognition logic is factored into one pure module (`convergence-recognition.mjs`)
the precommit imports; the validator has its own pure predicate; a consistency test
binds them. This is the right shape given the compile boundary (the precommit `.js`
cannot import the TS validator).

## 4. Back-compat safety (the critical dimension — this gate runs on every commit)

The flag defaults false and the precommit's new branch is gated on the env var being
`1`; when unset, the report `fs.existsSync` probe is skipped and the Step-6 checks
reuse the IDENTICAL regexes as before — byte-identical. The `.husky/pre-commit` config
read is fail-open (any error → env unset → today's behavior). **An E2E test runs the
REAL precommit script and proves: env unset → a timestamp-tagged+approved spec with no
report commits cleanly; env=1 + no report → blocked; env=1 + report → commits.** This
very PR's own commit goes through the modified precommit with the flag off — a live
proof the default path works.

## 5. Tier-1 exemption

The precommit's `tier1-lite` path exits before Step 6, so the new report check
correctly does not apply to Tier-1 commits; the consistency test scopes its precommit
fixtures to the tier-2/3 path.

## 6. Security / load

None — build-time gate only. The new checks are local `fs.existsSync`; no network, no
LLM in-gate. No load impact.

## 7. Migration / compatibility

`specReview.requireConvergenceReport` rides `applyDefaults` add-missing deep-merge
(Migration Parity automatic — no `migrateConfig` block). This is a dev-process gate,
NOT an agent-facing runtime capability — so no CLAUDE.md template / migrateClaudeMd
section is required (the feature-completeness test governs only agent-facing
capabilities; verified it stays green) and no new route. Rollback: the flag
default-false IS the rollback.
