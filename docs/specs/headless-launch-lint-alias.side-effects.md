# Side-Effects Review — headless-launch funnel lint: alias resolution

**Version / slug:** `headless-launch-lint-alias`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent, laptop)`
**Second-pass reviewer:** `peer audit — classed this check DEFEATABLE and SAFETY-FLOOR`

## Summary of the change

`scripts/lint-no-unfunneled-headless-launch.js` refuses any reference to `buildHeadlessLaunch` outside a closed four-entry allowlist. It located its target by matching that literal name per line, so the audit's stated bypass held: *"Export a wrapper or alias from an allowlisted module, then call makeHeadlessLaunch(...) elsewhere; the non-funnel launch path is real, but the name is gone."*

This adds two resolution layers. **Local:** bindings resolve to a fixpoint — aliased import, `{ X: Alias }` destructure, `const C = X` re-binding, namespace member, and computed access over a collapsed concatenation. **Cross-module:** the CLOSED allowlist is parsed (via the TypeScript AST) for names it hands out that resolve to the builder — direct re-bindings, renamed re-exports, and single-statement pass-through wrappers, to a fixpoint across files — and those names are guarded at any non-allowlisted importer. Detection is extracted into exported pure functions and the CLI body is guarded behind a direct-invocation check.

## Decision-point inventory

No decision point added or removed. One is widened at its input: "does this file reach the headless builder?" The allowlist, the funnel location, the import-is-a-violation rule, the message text for the canonical name, and the exit contract are unchanged.

## 1. Over-block

**The dominant risk, and the reason the fix is narrower than it could be.** This lint blocks commits; a check that flags correct code gets switched off, which is a worse outcome than the hole.

The sharp failure mode was concrete: the funnel itself (`SessionManager.spawnSession`) calls the builder. Had "exported function that references the builder" counted as a handout, every ordinary spawn callsite in `src/` would have been flagged. So only a DIRECT re-binding or a single-statement pass-through counts.

Second bound: a derived alias name is guarded only when **imported from the module that mints it** (specifier basename matched against the minting file). A locally-defined function of the same name is never absorbed. The canonical name keeps its shipped any-reference semantic.

Ten opposite-direction controls pin this, including the two that would have caught the flood: a real-work exported function is not an alias, and the LIVE allowlist mints no alias today (asserted against the actual tree, so a future refactor that accidentally creates one is visible). Decisive: **the real repo lints CLEAN before and after, exit 0 both ways.**

## 2. Under-block

Four residuals, named in the header and pinned by tests asserting they are NOT caught:

- A **non-pass-through wrapper** in an allowlisted module (two statements, not one). The direct price of the over-block bound above. Closing it needs a "does this do real work" judgment a commit-blocking lint should not be making.
- A **runtime-computed member** (`m[process.env.K]`) — not statically readable.
- **Re-assignment after declaration** — caught at the assignment line, not at the later call. Partial, not absent.
- A consumer importing an alias through a **barrel**. Mitigated structurally: the barrel is not allowlisted, so re-exporting the alias through it fails the lint at the barrel. The chain cannot be built without tripping this first.

## 3. Level-of-abstraction fit

Alias-export discovery uses the TS AST because precision matters most there and the inputs are four known TS files; per-file detection stays text-based because the scan set includes `.sh`, which no TS parser reads. Both are exported so they can be driven with fixtures rather than only end-to-end. The direct-invocation guard belongs at the module boundary.

## 4. Signal vs authority compliance

The lint IS authority — it fails a commit — unchanged in kind and scope. Only what it can see is widened. The tree passes clean, so no new blocking condition is introduced.

## 4b. Judgment-point check (Judgment Within Floors standard)

None. Deterministic AST predicates, regex forms, and bounded fixpoints (10 passes). No heuristic, model call, or threshold.

## 5. Interactions

Blast radius: one script. New dependency on `typescript`, already a devDependency and already imported by `scripts/lint-telegram-egress-boundary.mjs` in the same lint chain. The new exports have exactly one importer (the new test). The module previously had one `process.exit(1)` path and **no guard** — importing it would have run the full repo walk and could have killed a test run; the guard closes that. `package.json` invocation unchanged. The pre-existing `tests/unit/lint-no-unfunneled-headless-launch.test.ts` passes untouched, including its allowlist-closure assertion.

## 6. External surfaces

None. No network, persisted state, credential, telemetry, or route. It reads source at lint time exactly as before — this change touches the CHECK, never the spawn path.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The canonical-name message and the clean-summary line are unchanged. Alias violations get a distinct message naming the resolved symbol and the module that handed it out, so the reader is not left guessing why an unremarkable-looking name was refused.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified — build-time check, no shared state.

## 8. Rollback cost

Very low. One script, one new test file, one commit; no migration, persisted state, or config flag.

## Evidence pointers

- **Bypass reproduced against the shipped check before any edit**, positive control caught in the same run: the audit's cross-module alias → 0 hits; namespace + split-literal computed access → 0 hits; aliased import → import line caught, CALL SITE blind; plain import+call → caught. Reproduced **end-to-end in the real tree**: one appended line in the allowlisted `src/core/frameworkSessionLaunch.ts` plus a new `src/core` consumer left a live non-funnel launch path while the script printed `clean`, exit 0.
- **Three semantic mutations, three precise reds.** Neutering cross-module seeding fails exactly the 2 cross-module tests (26 pass). Widening the wrapper rule to "any exported function touching the builder" fails exactly the 1 real-work control (27 pass). Removing the per-line concatenation collapse fails exactly the 3 non-binding computed forms (28 pass).
- **One mutation initially failed to red, and that was the finding.** The first computed-access test used `const s = m['a'+'b'](…)`, which the BINDING rule already catches — so it proved nothing about the line it was written for. Rewritten to three forms with no binding to catch them (returned, bare statement, object property), the mutation reds properly. A test passing for the wrong reason is indistinguishable from coverage until something depends on it.
- Source restored **byte-identical** after every mutation (sha256 `273c44ba…` before and after each).
- Real repo: `node scripts/lint-no-unfunneled-headless-launch.js` → `clean`, exit 0 BEFORE and AFTER. Full `npm run lint` chain exit 0; `tsc --noEmit` clean.
- 39/39 across the new evasion suite and the pre-existing lint test.

## Class-Closure Declaration

Class: **"a lint that identifies its target by matching a NAME as literal text is defeated by ordinary renaming."**

**Closed for THIS lint:** local binding chains to a fixpoint (aliased import, destructure, re-binding, namespace member, computed access over a split literal), and cross-module names minted by the closed allowlist as direct re-bindings, renamed re-exports, or single-statement pass-through wrappers.

**NOT closed — stated so it is not read as more than it is:**
- A non-pass-through wrapper in an allowlisted module. **Deliberate**, and the direct cost of not flagging the funnel itself.
- A runtime-computed member.
- Re-assignment after declaration at the CALL site (the assignment is caught).
- A consumer importing through a barrel — though the barrel itself fails, so the chain cannot be built silently.
- **Cross-module resolution is scoped to the ALLOWLIST only.** A name minted in some other non-allowlisted module is not traced; that module would have to reference the canonical name, which fails.

**NOT closed repo-wide.** This is the 4th of the peer audit's 25 defeatable checks (per the tally quoted in the previous closure, PR #1877). By that count 21 remain, 14 of them classed SAFETY-FLOOR. I have not independently re-verified the audit's list, so treat the remaining count as inherited, not measured.

**NOT attempted:** the funnel's own runtime behaviour. This lint proves nobody reaches the builder outside the funnel; it proves nothing about whether the funnel makes the right spawn decision once reached.
