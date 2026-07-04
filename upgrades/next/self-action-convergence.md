---
user_announcement:
  - audience: agent-only
    maturity: stable
    summary: >
      Registered "unbounded / oscillating self-action" as a formal defect class
      and built the CI ratchet that proves every self-triggered controller
      settles under sustained pressure — the structural fix for the
      self-inflicted-loop class (swap-thrash, topic-floods, the reaper's
      17,503 kill-requests/day). Ships report-only; enforces after a clean soak.
---

## What Changed

Maintainer-only development machinery — the first product-code member of the
class-closure program (#1347), and the constitution standard it enforces.

- **New defect class `unbounded-self-action`** in `docs/defect-classes.json`
  (severity `critical`, seeded-closed at the 20 already-fixed instances). A
  post-seed recurrence fires the deterministic re-raise at lint time.
- **The live guard** — `tests/unit/self-action-convergence.test.ts` drives every
  controller in the new `src/testing/selfActionRegistry.ts` registry N ticks
  under a pinned sustained-pressure fixture (all accounts hot / veto never clears
  / no progress) and asserts the action count SETTLES to a small bound that does
  NOT scale with the horizon. Seeded with faithful convergence models of four
  real controllers (proactive swap monitor, age-kill backoff, promise-beacon
  notify, and a declared Eternal-Sentinel liveness heartbeat exercising the P19
  exemption).
- **The forcing lint** — `scripts/lint-no-unregistered-self-action.js`
  (emit-anchored, fail-closed once enforcing) refuses an unregistered self-action
  controller emit so a NEW self-action inherits the invariant. **Report-only by
  default** — it reports the population of unregistered controllers and exits 0
  until `prGate.classClosure.dryRun:false`.
- **The detector + scope** — `scripts/lib/self-action-detect.mjs` is the single
  shared source (emit set + controller-shape predicate + the gate decision). It
  widens the class-closure CI lint's scope (`scripts/class-closure-lint.mjs`) so
  a self-action diff requires a `classClosure` declaration, adds a
  convergence-addressed check (a per-tick-cap-only `howCaught` is flagged), and
  powers `assertSelfActionDeclared` in `scripts/instar-dev-precommit.js` — the
  early arm at the LIGHT commit path #1035 (swap-thrash) slipped through. Both new
  hard-violation conditions land report-only under the existing
  `prGate.classClosure.dryRun` default.
- **`scripts/class-closure-declare.mjs`** gains `--to-trace` (write the block into
  the instar-dev trace, the E3 declaration host) and an explicit negative
  declaration (`--closure n/a --reason`), the trace-level analog of the lint's
  allowlist.
- **The standard** "Capacity Safety — No Unbounded Self-Action" added to
  `docs/STANDARDS-REGISTRY.md` (operator-ratified 2026-07-04) — BBR's temporal
  twin: BBR bounds instantaneous MASS, this bounds steady-state FREQUENCY under
  feedback.
- **Migration Parity** — `migrateClassClosureTemplateSelfActionClause` extends the
  deployed side-effects template's Class-Closure trigger with the self-action
  clause for existing agents.

Named follow-on increments (own specs, NOT built here): the unified default-on
self-action backpressure primitive (the obfuscation-resistant funnel), and the
swap decoupling / live credential re-pointing (the durable swap fix).
<!-- tracked: CMT-1911 -->

## Evidence

- `tests/unit/self-action-convergence.test.ts` — the ratchet: 26 cases, every
  registered controller settles (count ≤ boundK, horizon-independent at 2×ticks,
  no single target thrashed), the Eternal-Sentinel honors its P19 rate floor,
  wiring-integrity (no vacuous/no-op controllers), verb-superset coherence, and
  grader-parity (the three new guards grade ratchet/lint/gate).
- `tests/unit/self-action-detect.test.ts` — the shared detector + the pure gate
  decision (both precommit call sites): emit true-positives, comment/prose
  false, fail-open on empty diff, all declaration branches.
- `tests/unit/lint-no-unregistered-self-action.test.ts` — the forcing lint's pure
  evaluator: unmarked → violation, marked+registered → clean, marked-unregistered
  → violation, allowlisted → clean, no-emit / non-shape → skipped.
- `tests/integration/class-closure-lint-self-action.test.ts` — the CI lint's
  self-action scope arm over synthetic diffs: good guard declaration → clean; no
  declaration → hard violation (report-only exit 0, enforcing exit 1); a
  per-tick-cap-only `howCaught` → convergence-addressed violation.
- `tests/unit/migrate-class-closure-self-action-clause.test.ts` — the migration:
  stock template updated, idempotent, customized-left-untouched, no-op when absent.
- Full lint chain (`npm run lint`) green — including the new forcing lint
  (report-only) and the class-closure grader-parity. `tsc --noEmit` clean.

## What to Tell Your User

This is maintainer-only development machinery — there is nothing for you to do or
notice in day-to-day use. If your operator asks "why do we keep fighting the same
runaway loops (account swaps, notification floods, the reaper firing thousands of
kill requests)?" — the answer is: those were 20 instances of ONE unnamed defect
class, and this change names it (unbounded self-action) and builds the automatic
CI test that proves any self-triggered action settles under sustained pressure
instead of running away. It ships report-only first (it logs what it would flag)
and only starts blocking after a clean soak, per the class-closure gate's own dark
default — so it changes nothing about how I respond to you today.

## Summary of New Capabilities

- **A new defect class + its guard.** "Unbounded / oscillating self-action" is now
  a registered class with a live CI ratchet (`tests/unit/self-action-convergence.test.ts`)
  that drives every self-triggered controller under worst-case pressure and fails
  the build if the action count doesn't converge — the temporal twin of Bounded
  Blast Radius (which caps how many run at once; this caps how often one fires).
- **A forcing lint + a shared detector** so a NEW self-triggered action inherits
  the convergence check instead of earning a bespoke brake after it breaks
  something — caught at both the commit gate and CI.
- **A ratified constitution standard** — "Capacity Safety — No Unbounded
  Self-Action" (`docs/STANDARDS-REGISTRY.md`).
- No user-facing surface, no routes, no config to set. Report-only until the
  operator flips enforcing.
