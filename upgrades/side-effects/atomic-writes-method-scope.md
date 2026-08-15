# Side-Effects Review — atomic-writes check scopes to method bodies

**Version / slug:** `atomic-writes-method-scope`
**Date:** `2026-08-15`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1. Test-only change; no file under src/, scripts/, .husky/ or skills/ is touched, so there is no runtime path and no shipped behaviour. The change makes an existing check stricter and adds no authority.`

## Summary of the change

`tests/unit/atomic-writes-consistency.test.ts` verifies that state-writing modules use
write-to-tmp-then-rename, so a crash mid-write cannot leave a truncated state file. **It could not
detect the defect it exists to detect.**

Measured, not argued — a bare `fs.writeFileSync` of durable session state inserted into
`saveSession`, a DECLARED method of a DECLARED module:

| check | verdict against that mutation |
|---|---|
| shipped | **21/21 PASSED** |
| this change | **1 failed / 31 passed**, naming file, method, deciding body, line |

Both runs were made in the SAME worktree against the SAME mutated source, with the shipped check
restored from git alongside the new one — subject and control share a boundary rather than being
compared across two checkouts.

Three causes, all fixed:

1. **Scoping.** `inSaveMethod` was set when a method NAME appeared on a line and never reset, while
   `hasWriteFile`/`hasRename` were re-zeroed at each occurrence. Only the window from the LAST name
   mention to EOF survived to the assertion — measured at **125 of 617 lines (20%)** in
   `StateManager.ts`, leaving three of its four declared methods structurally unreachable. Within
   that window the booleans were file-scope, so a rename in one method vouched for a write in another.
2. **File-scope substring checks.** `source.includes('renameSync')` and `source.includes('.tmp')` are
   satisfied by one occurrence anywhere, comments included.
3. **Silent declaration rot.** A missing file was `it.skip`ped; a missing method simply never set the
   flag. Both are failures now.

## What enabling (3) immediately found

**Two of the ten declared (module, method) pairs name methods that do not exist.** `saveState` has
ZERO occurrences in `src/core/StateManager.ts` and ZERO in `src/monitoring/QuotaTracker.ts` — verified
by grep with a control (`saveSession(`, `appendEvent(`, `persistUsers(` all found). QuotaTracker's
real writer is `updateState()`, which is correctly atomic and had never been verified by this test.
The declared list is corrected in the same change.

## Decision-point inventory

- `tests/helpers/atomicWriteScope.ts` — ADD. `stripComments` (quote-aware, line-count preserving),
  `methodBodies` (brace-matched, string-aware, declaration-vs-call aware), `delegateTargets`,
  `classifyMethod`.
- `tests/unit/atomic-writes-consistency.test.ts` — REWRITTEN to per-method assertions; declared list
  corrected; missing file/method now fail; anti-vacuity assertion added.
- `tests/unit/atomic-write-scope.test.ts` — ADD. 18 tests pinning the primitives and both directions.
- No file under `src/`, `scripts/`, `.husky/` or `skills/` is touched. No runtime decision added.

## 1. Over-block

**The dominant risk, and it nearly bit me.** The obvious fix — require a rename in each declared
method's own body — would have FAILED on `StateManager`, the best-written module in the set, because
it routes every write through a private `atomicWrite()` funnel and its save methods contain no write
call at all. Failing the single-funnel pattern this codebase argues for everywhere else would be a
false red on exemplary code.

So one level of `this.helper()` delegation is resolved and the funnel is what gets verified — which
also means `StateManager`'s writes are now genuinely checked, where previously nothing checked them.

Six controls, each with a test, all passing under BOTH the old and new behaviour:

- delegation to a genuine atomic funnel → `atomic-via-funnel`, not a violation;
- in-body tmp-then-rename → `atomic-inline`;
- a method that legitimately writes nothing → `no-write`, no invented violation;
- a commented-out write is not a write;
- a CALL site (`this.saveSession({...})` inside another method) is not a declaration — treating it as
  one is precisely how the old flag conflated two methods;
- an unbalanced brace yields no body rather than a wrong region, so a syntax error elsewhere cannot
  become a false verdict here.

**Verified against the real tree: 32/32 green.** The production code is atomic everywhere the check
now looks, including through the funnel.

**A defect in my own helper, caught by these controls before it shipped:** the first `methodBodies`
required a declaration at line start. That works on real source (which indents declarations) and
returned `found: false` for every hand-written fixture — so five tests failed loudly rather than
passing vacuously. The matcher now decides by the PRECEDING token (start / `{` / `}` / `;` after
skipping modifiers), which rejects `this.save(` and `helper(save(1))` as calls while accepting a
declaration that does not begin its own line.

## 2. Under-block

Stated in the source rather than implied:

- **Population.** The module list is CURATED and holds 7 entries. Hundreds of files under `src/` call
  `writeFileSync`; this test says nothing about any of them. A heuristic sweep suggested a state-writing
  population in the low hundreds, but that heuristic missed 2 of the 7 KNOWN-good modules, so it is not
  a defect count and is not quoted as one. Widening the population is separate work with real
  over-block risk and is deliberately not attempted here.
- **Delegation depth.** One level, one file. A helper calling another helper, or an imported writer,
  is not resolved — that needs a symbol graph, not text.
- **Write vocabulary.** Only `writeFileSync`/`renameSync`. A module writing via a stream, `fs.promises`,
  or a third-party helper is invisible.

## 3. Level-of-abstraction fit

Same layer as the existing check — source-text analysis in a unit test, no AST, no type information,
no new dependency. The brace matcher is the minimum needed to answer "which method is this line in?",
which is the question the original flag was trying and failing to answer.

## 4. Signal vs authority compliance

A test, not a runtime authority. It gates CI only. It gained teeth (it can now fail) but no new
decision-making power over agent behaviour.

## 5. Interactions

- Runs in the existing unit shards; no new script, no lint-chain entry, no CI wiring change.
- `tsc --noEmit` exit 0 — **but stated honestly: `tsconfig.json` excludes `tests`, so that run says
  nothing about these files.** Their correctness is evidenced by the suite passing, not by the compiler.
- No source module, route, config key, or state file touched.

## 6. External surfaces

None. Developer tooling. The Agent Awareness Standard does not apply — no agent capability is added.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correct.** A unit test reads files in one checkout and returns an exit
code. No durable state, no user-facing notice, no generated URL, no runtime decision — nothing to
replicate, merge on read, or strand on a topic transfer. Every machine runs it over its own checkout
of the same tracked source and reaches the same verdict; determinism comes from the source tree, not
from coordination.

## 8. Rollback cost

`git revert` of three test files. No migration, no state, no deployed artifact, no runtime impact.

## Conclusion

Ship. A check that could not fail on its own subject now fails on it, two stale declarations are
repaired, the best-written module in the set is verified for the first time, and the limits are named
in the source rather than implied.

## Evidence pointers

- `tests/unit/atomic-write-scope.test.ts` — 18/18 green (6 defect cases, 6 over-block controls, 6 primitives).
- `tests/unit/atomic-writes-consistency.test.ts` — 32/32 green against the real tree.
- **Both-directions proof in ONE worktree:** shipped check vs the mutation → 21/21 PASSED; new check
  vs the SAME mutation → 1 failed / 31 passed. `src/core/StateManager.ts` restored byte-exact
  (sha match, zero probe markers, zero stray files).
- Stale declarations verified by grep with a control that fired.
- `tsc --noEmit` exit 0 (boundary stated above: tests are excluded from that config).
- Tier **1** declared: `classifyTier` reports riskFloor 1 with no safety-invariant match, and `tests/`
  is outside `inScope()`, so the size heuristic contributes nothing either.
