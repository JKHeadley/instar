# Side-Effects Review — ESM require() bug fixes + standards-gate re-arm

**Version / slug:** `esm-require-fixes-gate-rearm`
**Date:** `2026-06-03`
**Author:** `Echo (instar-dev agent)`
**Tier:** `1` (small / low-risk — bugfix + test/config; no new capability, no block/allow surface)
**Second-pass reviewer:** `not required`

## Summary of the change

Fixes three genuine latent ESM bugs and re-arms the two standards-gates that should
have caught them but were parked in the CI flaky-exclude list.

The package is ESM (`"type":"module"`, tsconfig `Node16`), where a bare CommonJS
`require(...)` is undefined and throws `ReferenceError` at runtime. Three runtime
files used a bare `require()`:
- `src/commands/reflect.ts:355` — lazy `require('../core/intelligenceProviderFactory.js')`
  inside `resolveIntelligence()`; `instar reflect run` would throw when it hits this.
- `src/monitoring/SessionWatchdog.ts:713` — lazy `require('./frameworkProcessSignals.js')`
  during child-process detection; throws on the watchdog's polling path.
- `src/core/PostUpdateMigrator.ts:1137` — lazy `require('./Config.js')` for
  `detectCodexPath` inside a try/catch (so it silently returned null → codex never
  detected).

Fixes:
- `reflect.ts`, `SessionWatchdog.ts` — bind a real `require` via
  `createRequire(import.meta.url)` (the repo's existing idiom, see
  `NativeModuleHealer.ts:44`). Preserves the deliberate lazy-load semantics exactly,
  but now ESM-legal.
- `PostUpdateMigrator.ts` — `detectCodexPath` is ALREADY statically imported at the
  top of the module (line 56), so the lazy require was redundant; replaced with a
  direct call to the static import. No shim needed.

Gate re-arm + test corrections:
- `tests/unit/esm-compliance.test.ts` — teach the guard to recognize the legitimate
  `require = createRequire(import.meta.url)` ESM binding (otherwise the naive
  `require(` regex false-positives on `node-abi-mismatch.ts`, which already uses the
  pattern correctly to re-load a native module after an ABI rebuild — which static
  `import` cannot express).
- `tests/unit/no-silent-fallbacks.test.ts` — baseline corrected 186→437 with
  evidence (the 186 was set by a `[skip ci]` release while the true count was already
  431; the +6 to 437 is line-shift re-counts, zero new fallbacks).
- `tests/unit/feature-delivery-completeness.test.ts` — track the previously-untracked
  `Token-Burn Alerts` migrator section.
- `src/data/builtin-manifest.json` — regenerated against current source.
- `vitest.push.config.ts` — RE-ARM `esm-compliance` + `no-silent-fallbacks` (removed
  from `FLAKY_TESTS`) so these standards-gates run in CI again. They were quarantined,
  which is exactly how the three bare-require bugs reached main unnoticed.

## Decision-point inventory
- `reflect.ts / SessionWatchdog.ts` require binding — **modify (mechanics only)** —
  same lazy load, now via a real ESM `require`. No behavior change beyond "no longer
  throws."
- `PostUpdateMigrator.ts` — **modify** — use the existing static import; drops a
  silent-null path (codex detection now actually works).
- Test guards + push config + manifest — **modify/add** — no runtime surface.

## 1. Over-block
No block/allow surface. The two re-armed gates are CI test gates, not runtime gates.
They cannot block a running agent; they can only fail a PR's CI (their intended job).

## 2. Under-block
The esm-compliance guard previously UNDER-blocked (it was excluded, so it caught
nothing — three real require() bugs slipped through). Re-arming restores the intended
coverage. The createRequire recognition is precise (`require\s*=\s*createRequire\s*\(`)
so it does not newly under-block: a file only earns the skip by establishing a real
ESM `require` binding.

## 3. Level-of-abstraction fit
Correct. The runtime fixes operate at the module-loading layer (the bug's layer). The
gate changes operate at the CI-config layer. Neither reaches into business logic.

## 4. Signal vs authority compliance
**Required reference:** docs/signal-vs-authority.md
- [x] No block/allow runtime surface of its own. The re-armed tests are SIGNALS to CI
  (a PR fails), not runtime authorities. No agent decision is gated by this change.

## 5. Interactions
- **Double-fire / shadowing:** none. The require fixes are byte-equivalent loads.
- **PostUpdateMigrator:** the static `detectCodexPath` import already existed and is
  used elsewhere; calling it directly cannot introduce a cycle that the static import
  didn't already have.
- **no-silent-fallbacks baseline:** exact-count ratchet on a hyperactive main may need
  a future bump if a large mechanical sweep lands (as happened 3× before) — that is the
  ratchet working, not a regression. Re-measured fresh before merge.
- **esm-compliance:** a future dependency-introduced `require()` will now (correctly)
  fail CI — that is the gate doing its job.

## 6. External surfaces
None. No new route, no new persistent state, no config default change. `vitest.push.config.ts`
is build/test tooling, not shipped agent config.

## 7. Rollback cost
Trivial. Revert the commit: the require fixes go back to throwing (status quo ante),
and the two gates return to FLAKY_TESTS. No state, no migration, no user-visible change.

## Conclusion
Low-risk Tier-1 bugfix. Three real latent ESM `require()` ReferenceErrors fixed using
the repo's established `createRequire` idiom (or, for PostUpdateMigrator, the existing
static import). The standards-gates that exist to catch this class of bug are re-armed
and verified green under the real CI push config. Clear to ship.

## Evidence pointers
- `tsc --noEmit` clean on the three src edits.
- Re-armed gates pass under the real CI config:
  `npx vitest run --config vitest.push.config.ts tests/unit/esm-compliance.test.ts tests/unit/no-silent-fallbacks.test.ts`
  → 2 files / 7 tests passed.
- Root-cause evidence for the baseline correction: heuristic count at d0fe838
  (the `[skip ci]` release that set 186) = 431; at HEAD = 437; set-diff shows the +6
  are line-shifted re-counts of the same catch blocks, not new fallbacks.
