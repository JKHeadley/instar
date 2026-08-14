# Side-Effects Review — lint-no-unbounded-llm-spawn: alias + namespace awareness

**Version / slug:** `spawn-lint-alias-aware`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `originates from instar-codey's lint-name-matching-audit (finding #1 of 25)`

## Summary of the change

`scripts/lint-no-unbounded-llm-spawn.js` enforces §P1 of `docs/specs/forkbomb-prevention-simple.md`: every spawn-capable LLM-CLI provider must be constructed through `buildIntelligenceProvider()`, where the host-wide spawn cap is installed (added after the 2026-06-20 OOM: ~230-289 concurrent spawns, ~90-115GB). It located targets with `new RegExp(\`\\bnew\\s+${cls}\\s*\\(\`)` — the class NAME as literal text. Two ordinary import styles defeat that:

```ts
import { ClaudeCliIntelligenceProvider as Provider } from '...'; new Provider(...)
import * as mod from '...';                                     new mod.ClaudeCliIntelligenceProvider(...)
```

Both are real uncapped constructions and both were invisible. This resolves local bindings first (`as Alias`, `{ Cls: Alias }`) and adds the namespace-qualified form, extracts detection into two exported pure functions, and guards the CLI body behind a direct-invocation check.

## Decision-point inventory

No decision point added or removed. One is **widened at its input**: "is this line a spawn-capable construction?" The forbidden set, the allowlist, the message and the exit contract are unchanged — strictly more real constructions are now visible to the same rule.

## 1. Over-block

Could this now flag legitimate code? That is the live risk, since a lint blocks commits. Four opposite-direction controls pin it: an import alone is not a construction; a comment mentioning the class is not; an unrelated similarly-named class is not; a bare variable of the same name is not. And the decisive empirical check — **the real repo lints CLEAN both before and after** — so this adds zero work to anyone today. Binding resolution is per-file, so an alias in one file cannot flag a same-named symbol in another.

## 2. Under-block

The previous behaviour WAS the under-block. Remaining surface, stated: a construction reached through a re-export chain (`export { X as Y } from '...'` in module A, imported from A elsewhere) still evades, because resolution is per-file text, not a cross-module symbol graph. Codey's audit makes the same point about the general class. Narrowed, not closed.

## 3. Level-of-abstraction fit

Binding resolution belongs in the lint (it owns "what counts as this class here"). Extracting it to exported functions is what makes the rule testable with fixtures instead of only end-to-end over the tree — the same move as `runningTopicIds` in PR #1870, for the same reason: the failure was in HOW the target was identified.

## 4. Signal vs authority compliance

The lint IS authority — it fails a commit. That authority is unchanged in kind and scope: same rule, same allowlist, same exit codes. This changes what the existing authority can SEE. No new blocking condition is introduced, and the tree passes clean.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point. Deterministic regex/binding resolution; no heuristic, model call, or threshold.

## 5. Interactions

Blast radius measured. The module was previously import-unsafe: its CLI body ran at module scope and calls `process.exit(1)` on violation, so ANY importer would have run the scan and could have killed the process. It now has zero importers besides the new test, and the guard makes importing safe. `package.json` invokes it unchanged (lint chain + `lint:no-unbounded-llm-spawn[:staged]`), and `tests/unit/lint-chain-completeness.test.ts` — which asserts the lint is in the chain — still passes.

## 6. External surfaces

None. No network, persisted state, credential, telemetry, or route. Reads source files at lint time exactly as before.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Violation text unchanged (path:line, why, and the two remedies). No new operator-visible strings.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified. A build-time check; no shared state, lease, or replication.

## 8. Rollback cost

Very low. One script, one new test file, one commit; no migration, persisted state, or config flag. Reverting restores the previous matching exactly.

## Evidence pointers

- Blindness confirmed in source before any edit: `PATTERNS = PROVIDER_CLASSES.map((cls) => new RegExp(\`\\bnew\\s+${cls}\\s*\\(\`))`, tested per line — `\bnew\s+Cls` cannot match across a `mod.` qualifier, and an alias replaces the name entirely.
- Negative control executed: restricted to name-only matching with the namespace form disabled, **5 tests fail / 6 pass** — the 6 being the plain-construction case and all four opposite-direction controls. Source restored byte-identical (sha + 8,036 bytes).
- The real repo lints CLEAN before and after (`node scripts/lint-no-unbounded-llm-spawn.js` exit 0 both ways) — no false positives introduced.
- Import-safety verified in both modes: run as a CLI it prints `clean` and exits 0; imported by the test it does NOT run the scan.
- 11/11 in `tests/unit/spawn-lint-alias-aware.test.ts`.

## Class-Closure Declaration (display-only mirror)

Class: "a check that identifies its target by name and is therefore defeatable by renaming." Closed for THIS lint, for aliasing and namespace qualification. **NOT closed** for re-export chains (stated above), and **NOT closed repo-wide** — Codey's audit counts 25 defeatable checks; this is one, chosen first because it guards a safety floor rather than a convention. The remaining 24 are untouched.
