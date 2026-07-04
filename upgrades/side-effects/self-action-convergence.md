# Side-Effects Review — Self-Action Convergence (the class-closure guard for self-inflicted loops)

**Version / slug:** `self-action-convergence`
**Date:** `2026-07-04`
**Author:** `echo`
**Second-pass reviewer:** `not required — additive dev-tooling (a defect-class entry, a test ratchet, two lints, a shared detector, a precommit arm, a template clause, a migration, a constitution standard). No runtime decision surface, no routes, no user-facing behavior, no data migration. Everything ships report-only under the pre-existing prGate.classClosure dark default.`

## Summary of the change

Registers `unbounded-self-action` as a formal defect class in the class-closure registry (#1347) — the FIRST product-code member of that program — and builds the live guard that ends it: an N-tick sustained-pressure convergence ratchet (`tests/unit/self-action-convergence.test.ts` + the `src/testing/selfActionRegistry.ts` controller registry), a fail-closed forcing lint (`scripts/lint-no-unregistered-self-action.js`), a shared detector (`scripts/lib/self-action-detect.mjs`), a scope+convergence arm added to the class-closure CI lint (`scripts/class-closure-lint.mjs`), an early-detection arm at instar-dev commit time (`assertSelfActionDeclared` in `scripts/instar-dev-precommit.js`), a `--to-trace`/negative-declaration mode in `scripts/class-closure-declare.mjs`, a one-line side-effects-template clause, its migration (`migrateClassClosureTemplateSelfActionClause`), and the ratified constitution standard "Capacity Safety — No Unbounded Self-Action."

This is the structural fix for the entire self-inflicted-loop class (swap-thrash being the presenting case). It is BBR's temporal twin: Bounded Blast Radius bounds instantaneous MASS; this bounds steady-state FREQUENCY under feedback.

Files touched: `docs/defect-classes.json`, `docs/STANDARDS-REGISTRY.md`, `docs/specs/self-action-convergence.md` (+ `.eli16.md`), `scripts/lib/self-action-detect.mjs` (new), `src/testing/selfActionRegistry.ts` (new), `tests/unit/self-action-convergence.test.ts` (new), `scripts/lint-no-unregistered-self-action.js` (new), `scripts/class-closure-lint.mjs`, `scripts/class-closure-declare.mjs`, `scripts/instar-dev-precommit.js`, `skills/instar-dev/templates/side-effects-artifact.md`, `src/core/PostUpdateMigrator.ts`, `package.json`, plus tests (`tests/unit/self-action-detect.test.ts`, `tests/unit/lint-no-unregistered-self-action.test.ts`, `tests/unit/migrate-class-closure-self-action-clause.test.ts`, `tests/integration/class-closure-lint-self-action.test.ts`).

## Decision-point inventory

- **`unbounded-self-action` defect class** — add (registry semantics) — a protected-path registry entry. Governs fix-time declarations; does not gate runtime.
- **Convergence ratchet + controller registry** — add (CI test) — drives modeled controllers under a pinned worst-case fixture; fails the build (once green) if a registered controller does not settle. Zero runtime authority.
- **Forcing lint** — add (CI lint) — refuses an unregistered self-action controller emit. **Report-only by default** (exits 0 unless `prGate.classClosure.enabled && !dryRun`).
- **Class-closure CI lint scope arm + convergence check** — modify (CI lint) — a self-action diff now requires a declaration; a per-tick-cap-only `howCaught` is flagged. Hard-violations recorded; **fail the build only when enforcing** (dark default).
- **`assertSelfActionDeclared` precommit arm** — add (commit gate) — blocks a self-action src/ change with no declaration/negative. FAIL-OPEN on tooling failure; a genuine one-shot costs one attested negative line.
- **Shared detector** — add (pure library) — the single source for the emit set + scope predicate + the gate decision. Deterministic; never LLM-guesses.
- **Side-effects template clause + migration** — modify (skill template) — the Class-Closure Declaration trigger now names the self-action case; the migration reaches existing agents (Migration Parity).
- **Constitution standard** — add (standards text) — "Capacity Safety — No Unbounded Self-Action," ratified by the operator 2026-07-04.
- **All existing gates** — pass-through — the tone gate, coherence gate, external-operation gate, class-closure gate's existing behavior are unchanged; this composes with #1347, it does not fork it.

## 1. Over-block

**No runtime block/allow surface — over-block N/A.** The only new blocking paths are DEV-TIME gates (the precommit arm + the CI lints), and both ship report-only under the pre-existing `prGate.classClosure` dark default. The precommit arm fails OPEN on any tooling failure (empty diff, no src/ file, unreadable artifact) and offers an explicit one-line negative-declaration escape, so a genuine one-shot / user-driven action is never unescapably blocked. The forcing lint is scoped to controller-SHAPE files to avoid flagging every `retry(` in src/.

## 2. Under-block

**No runtime under-block surface.** The completeness guarantee (every controller registered) is report-only until the operator flips enforcing on measured declaration population, per #1347's own criterion. Until then a NEW self-action can still ship un-registered — the honest, deliberate soak posture; the E2 CI lint + E3 precommit arm are the earlier backstops, and the string-based scope is named as an accident-deterrent (the obfuscation-resistant closure is the follow-on funnel, Part B).

## 3. Ordering / idempotency

The migration is idempotent (marker short-circuit). The declare `--to-trace` mode is idempotent (identical block → no change). The ratchet + lints are pure re-runnable evaluations. No persistent runtime state, no ordering dependency.

## 4. Signal vs. Authority

Compliant. The detector is DETERMINISTIC — it forces a declaration, it never LLM-guesses (Signal vs. Authority). The ratchet + lints are structure, not willpower. The convergence proof is a CI ratchet, not discretionary prose. No new blocking authority is granted to any LLM path.

## 5. Feedback loops

**This spec IS the answer to the feedback-loop question** the swap-thrash review never answered. The change adds NO new runtime control loop — it adds a CI/commit-time invariant that PROVES other control loops converge. It cannot itself spiral (it is a stateless test/lint run per CI invocation).

## 6. External surfaces

None. No HTTP routes, no external API calls, no network egress. All new surfaces are local dev-tooling (a test, two lints, a shared library, a commit-gate arm, a registry entry, a template clause, a migration, a standard).

## 7. Multi-machine posture

`unified` (repo-resident). The registry entry, the lints, the detector, the ratchet, and the standard all ride the git repo itself (the replication medium), reaching every checkout on `git pull` — matching #1347's declared posture. The template clause reaches existing deployed agents through the PostUpdateMigrator migration. No machine-local state, no per-machine divergence.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (this change REGISTERS the class AND builds its closing guard; the self-referential canonical closure).
- **`closure`** — `guard`.
- **`guardEvidence`** — `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the ratchet drives every registered self-action controller N ticks under a pinned sustained-pressure fixture (all accounts hot / veto never clears / no progress) and asserts the action count SETTLES to a small bound that does NOT scale with the horizon — steady-state convergence via each controller's settling brake (all-hot / projected-load / exponential-backoff+breaker / suppress-unchanged), with the declared Eternal-Sentinel exemption asserting a P19 rate floor instead. A per-tick cap would NOT satisfy this — it bounds one pass, never the loop. }`

The machine-readable counterpart lives in the commit's decision-audit entry (persisted from the instar-dev trace by `writeDecisionAudit`), which the CI class-closure lint reads. This mirror is display-only and is never summed with it (C1).
