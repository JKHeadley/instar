# Side-Effects Review — spawn-cap lint: local re-binding + computed access

**Version / slug:** `spawn-lint-local-rebinding`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `instar-codey — this change exists BECAUSE its sabotage pass broke PR #1874`

## Summary of the change

PR #1874 made `lint-no-unbounded-llm-spawn` resolve local bindings (`as Alias`, `{ Cls: Alias }`) and recognise `new ns.Cls(`. A peer sabotage pass then found **5 evasions, of which 2 are SAME-FILE** — inside the ground that fix claimed:

```ts
import { ClaudeCliIntelligenceProvider } from './core.js';
const C = ClaudeCliIntelligenceProvider; new C({});      // plain re-binding
import * as Providers from './core.js';
new Providers['ClaudeCliIntelligenceProvider']({});      // computed access
```

This resolves `const|let|var Alias = <knownName>` to a **fixpoint** (so chains close) and adds the computed-access form. It also CORRECTS PR #1874's class-closure declaration, which named only cross-module re-export chains and therefore understated the gap.

## Decision-point inventory

No decision point added or removed. The same one is widened at its input again: "is this line a spawn-capable construction?" Forbidden set, allowlist, message and exit contract unchanged.

## 1. Over-block

This is the live risk: treating a variable as the class could flag innocent code. Bounded three ways — the re-binding regex requires the right-hand side to be a name ALREADY in the resolved set (seeded only from the provider classes and their import aliases); resolution is per-file, so a name in one file cannot taint another; and a dedicated control asserts `const C = SomethingElse; new C({})` is NOT flagged. Empirically: **the real repo lints clean before and after** (exit 0 both ways).

The fixpoint loop is bounded to 10 passes and exits early when the set stops growing, so a pathological file cannot spin it.

## 2. Under-block

Three of the five evasions remain, all cross-module: a re-export chain, a double alias across two hops, and a namespace import of a re-export barrel. Per-file text resolution cannot follow a symbol re-exported from another module; closing that needs a cross-module symbol graph and is out of scope. **A test pins this open gap explicitly** so the boundary is documented rather than assumed.

## 3. Level-of-abstraction fit

Unchanged from #1874: binding resolution belongs in the lint, and lives in exported pure functions so fixtures can drive it. The sabotage snippets are used verbatim as fixtures — the reviewer's inputs become the regression tests.

## 4. Signal vs authority compliance

The lint is authority (it fails a commit), unchanged in kind and scope. This changes only what it can see; the tree passes clean, so no new blocking condition.

## 4b. Judgment-point check (Judgment Within Floors standard)

None. Deterministic regex/fixpoint resolution; no heuristic, model call, or threshold.

## 5. Interactions

Blast radius unchanged from #1874: one script, exported functions with a single test importer, CLI body still guarded behind the direct-invocation check. `package.json` invocations and `tests/unit/lint-chain-completeness.test.ts` unaffected.

## 6. External surfaces

None. No network, persisted state, credential, telemetry, or route.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Violation text unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified — build-time check, no shared state.

## 8. Rollback cost

Very low. One script, one test file, one commit; no migration or config.

## Evidence pointers

- The two evasions are the peer's verbatim snippets, reproduced as fixtures.
- Negative control executed: reverting BOTH new patterns fails 4 tests / passes 13 — the 13 including all six opposite-direction controls and the pinned known-gap test. Source restored byte-identical (sha + 9,214 bytes).
- Real repo lints CLEAN before and after (exit 0 both ways).
- 17/17 in `tests/unit/spawn-lint-alias-aware.test.ts` (was 11).

## Class-Closure Declaration (display-only mirror) — CORRECTING PR #1874

PR #1874 declared: *"still evades: a construction reached through a re-export chain."* That was **incomplete**. The sabotage pass found FIVE evasions: three cross-module (re-export chain, double alias across two hops, namespace import of a re-export barrel) and **two same-file** (local re-binding, computed access) which the per-file approach should have covered and did not.

This change closes the two same-file ones. **The three cross-module evasions remain open, are named individually here rather than as one category, and are pinned by a test.** Closing them requires cross-module symbol resolution, which this lint does not do. 24 of Codey's 25 defeatable checks are still untouched.
