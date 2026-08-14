# Side-Effects Review — telegram-egress lint: fetch alias resolution

**Version / slug:** `telegram-egress-lint-alias`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `instar-codey — ranked this #2 of the remaining 24 by consequence`

## Summary of the change

`scripts/lint-telegram-egress-boundary.mjs` proves exactly one file may `fetch` a Telegram Bot API URL. Its recogniser handled bare `fetch`, `x.fetch`, `fetch.call/apply` and `x['fetch']`, and its header named the remaining gap explicitly: *"a fetch bound to a DIFFERENT name (`const send = fetch; send(url)`) […] needs alias resolution this does not do."* This adds `collectFetchAliases(sf)` — an AST pass collecting variable declarations whose initialiser IS the fetch function, resolved to a fixpoint — threads the alias set through `isFetchCall`/`isFetchTarget`, guards the CLI body behind a direct-invocation check, and **corrects both places in the header that stated the gap as open**.

## Decision-point inventory

No decision point added or removed. One is widened at its input: "is this call a fetch?" The door location, the guard requirement, the URL recogniser and the exit contract are unchanged.

## 1. Over-block

The dominant risk: this lint blocks commits, so a resolver that over-matched would flag correct code across `src/`. Bounded by construction — a name is bound only when a variable declaration's initialiser satisfies `isFetchTarget` (the identifier `fetch`, or a property access whose final name is `fetch`), seeded from nothing else; the fixpoint only grows through names already bound; and resolution is per-file. Four opposite-direction controls pin it (unrelated initialiser, differently-named property, no-reference file, the string `'fetch'`). Decisive: **the real repo lints CLEAN before and after**.

Chosen deliberately over a text scan for `= fetch`, which would also match a property named `fetch` on an unrelated object — the AST distinguishes them and was already available since the file is parsed.

## 2. Under-block

Three residuals, now named in the header in place of the one it previously named: re-assignment after declaration (`let send; send = fetch;`), a fetch arriving as a function PARAMETER, and a wrapper imported from another module. All need flow or cross-module analysis this check does not do. **Two are pinned by tests asserting they are NOT caught**, so the boundary is documented rather than assumed.

## 3. Level-of-abstraction fit

Alias collection belongs beside the other AST recognisers in the lint, and is exported so it can be driven with fixtures rather than only end-to-end. The CLI guard belongs at the module boundary.

## 4. Signal vs authority compliance

The lint IS authority — it fails a commit — unchanged in kind and scope. Only what it can see is widened; the tree passes clean, so no new blocking condition.

## 4b. Judgment-point check (Judgment Within Floors standard)

None. Deterministic AST predicates and a bounded fixpoint. No heuristic, model call, or threshold.

## 5. Interactions

Blast radius: one script. The new export has exactly one importer (the new test). The module previously had FOUR `process.exit(1)` paths and no guard, so any importer would have run the full scan and could have killed the process — the guard closes that. `package.json` invocation unchanged; `tests/unit/telegram-egress-boundary.test.ts` tests the DOOR, not the lint, and is unaffected.

## 6. External surfaces

None. No network, persisted state, credential, telemetry, or route. It reads source at lint time exactly as before — this change touches the CHECK, never the egress path.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Violation and clean-summary text unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified — build-time check, no shared state.

## 8. Rollback cost

Very low. One script, one new test file, one commit; no migration, persisted state, or config flag.

## Evidence pointers

- The gap was not discovered by me — the lint's own header declared it, at two separate places, and both are corrected here rather than left stating something now false.
- Negative control executed: making `collectFetchAliases` return an empty set fails **3 tests / passes 6** — the 6 being all four over-match controls and both pinned known-gaps. Source restored byte-identical (sha + 14,818 bytes).
- Real repo lints CLEAN before and after (exit 0 both ways).
- Import-safety verified both modes: as a CLI it prints its clean summary and exits 0; imported, it does not run the scan.
- 9/9 in `tests/unit/telegram-egress-lint-alias.test.ts`.

## Class-Closure Declaration (display-only mirror)

Class: "a check defeatable by binding its target to another name." Closed for THIS lint for local variable declarations, followed to a fixpoint. **NOT closed** for re-assignment after declaration, parameters, or cross-module wrappers — all three named in the header and two pinned by tests. **NOT closed repo-wide**: this is the 3rd of the peer audit's 25 defeatable checks; 22 remain, 14 of them classed SAFETY-FLOOR.
