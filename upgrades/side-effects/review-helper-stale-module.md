# Side-Effects Review — Review helper skips stale reviewer builds; model refusal gets its own reason

**Version / slug:** `review-helper-stale-module`
**Date:** `2026-11-28`
**Author:** `echo (engine feature optimization session)`
**Second-pass reviewer:** `independent subagent (see Second-pass review)`

## Summary of the change

Reported by the Studio session that owns jobs, projects and one source of truth (2026-11-28). On the Studio, `skills/spec-converge/scripts/cross-model-review.mjs` loaded `/…/.instar/agents/echo/dist/core/crossModelReviewer.js`: an untracked build in the agent root, with no instar `package.json` beside it, whose Codex model table still named `gpt-5.5`. The ChatGPT-account surface refuses that id, and the helper returned only `degraded: error`.

Two changes:
1. `cross-model-review.mjs`: the module ladder gains two candidates right after the first, `ROOT/.instar/shadow-install/node_modules/instar` and `ROOT/node_modules/instar`. Inferred from the loaded path (the only layout where candidate 1 is `<agent home>/dist`): the Studio ran the helper from `<agent home>/skills/...` (SKILL.md's documented form), so ROOT was the agent home and its real install was never on the list: the orphan `<agent home>/dist` was the only candidate that existed. The ladder also assesses each candidate (`assessModuleCandidate`). It skips `orphan-build` (no `package.json` named `instar` two levels above `dist/core/`) and `stale-build` (a checkout with `src/`, where `src/core/crossModelReviewer.ts` or `src/providers/adapters/openai-codex/models.ts` is newer than its built counterpart, or that counterpart is missing). `selectReviewerModule` takes the first usable candidate. If none is usable but one exists, it loads that one and sets `moduleStale: true`. Every output carries `resolvedModulePath`, plus `moduleSkipped` / `moduleStale` when they apply. `main()` runs only when the file is executed directly, so the unit tests can import the selectors.
2. `src/core/crossModelReviewer.ts` `classifyReviewFailure`: new class `model-unsupported` for the ChatGPT-account "not supported" refusal (adapter wording "Codex subscription auth rejected model: …") and "model … does not exist / unsupported". It is checked before the quota and rate words.

Tier 1: small and fully reverted by a revert. No spec; this overview and the ELI16 are the review surface.

## Decision-point inventory

- Module candidate choice in the helper: modify. It picks which built file serves an advisory review. It gates no information flow and blocks no action, and the review result is still never blocking.
- `classifyReviewFailure`: modify, adding one label. It is a display/diagnostic class with no authority, as the keyword-intent ratchet already records.

---

## 1. Over-block

The helper blocks nothing. A legitimate checkout whose `src/` file times are newer than `dist/` without any real change (a fresh `git checkout` touches files) is skipped in favour of the installed copy. That is a correct outcome (the install is current), or the same file with `moduleStale: true` when no install exists. The review still runs. One caveat: switching branches rewrites source files, so a correct checkout build can read as stale, and the next candidate (an install, possibly an older version) is used. The output names the skip, so this is visible.

## 2. Under-block

A stale build that does carry an instar `package.json` and no `src/` (an old published package left in a candidate path) is still loaded. Version comparison across candidates is not attempted. The shadow install is refreshed on every update, so this case is narrow. A model refused with wording other than the patterns above still reads `error`. The generic pattern needs the refusal right after the model id, so a parameter refusal that mentions the model stays `error` on purpose.

## 3. Level-of-abstraction fit

Right layer. The ladder lives in the helper. The fix makes its own choice honest rather than adding a second resolver. The failure class lives in the one function every family uses.

## 4. Signal vs authority compliance

Compliant. Neither change holds blocking authority. The freshness check only reorders which file is loaded and reports what it skipped. The failure class is a label.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The freshness rule is an enumerable invariant (a build older than its source is stale by definition), and the result is advisory.

## 5. Interactions

- `tests/integration/cross-model-review-module-resolution.test.ts`: its fake shadow installs now carry `package.json` (`{"name":"instar"}`), as a real install does, and the installed-layout case asserts `moduleStale` is absent, so it is earned by a fresh install and not by the fallback. "Checkout context resolves candidate 1": it still passes wherever `dist/` was built after `src/` was last written (CI and the helper host build fresh). On a dev checkout with edited, unbuilt sources it now resolves the install instead, which is the intended fix.
- `classifyReviewFailure` is shared by the gemini, grok and claude families. The new patterns name a model refusal only; grok's weekly-wall and rate classes are unchanged (`tests/unit/grok-review-failure-classification.test.ts` passes).
- The installed copy is delivered by the existing `PostUpdateMigrator` single-file copy of `cross-model-review.mjs`. No new file is introduced, so installed copies keep working.

## 6. External surfaces

The helper's JSON output gains fields (`moduleSkipped`, `moduleStale`, and `resolvedModulePath` on full runs). Readers that parse it take known keys only. A degraded reason value `model-unsupported` is new. It flows into the convergence report's external-review line as text.

## 6b. Operator-surface quality

No operator surface. Not applicable.

## 6c. Delight the user

Screenshots: no visible change — the helper runs inside the review process; the person sees only that outside reviews work again.

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local BY DESIGN: the helper inspects files on the machine it runs on, which is what it loads. Nothing is stored or replicated.

## 8. Rollback cost

A revert of this PR. No state, no migration, no data.

## Conclusion

Safe to ship as Tier 1.

## Second-pass review (if required)

**Reviewer:** independent subagent, read-only (no tests run), 2026-11-28.

Round 1: concern raised. (1) Blocking: from `<agent home>/skills/...` the ladder never listed the agent's own install, so the orphan would be skipped and then loaded anyway with `moduleStale: true`, and the unit test built its candidate list by hand. (2) The integration fixtures had no `package.json`, so they passed only through the fallback. (4) File-time staleness after a branch switch. (5) The generic pattern could not cross the dot in `gpt-5.5`, and it took a parameter refusal. (7) The artifact claimed more than the test proved.

Fixed: the ROOT-level install candidates; a unit test that imports a COPY of the real script placed at `<agent home>/skills/spec-converge/scripts/` and runs the real `moduleCandidates()`; `package.json` in the integration fixtures plus the `moduleStale` assertion; the pattern now needs the refusal right after the id, with tests for `gpt-5.5` and the parameter refusal; §1, §2 and §5 corrected. Items 3 and 6 found no defect.

Round 2: **Concur with the review.** Item 1 is closed for every location the migrator installs to and for the `<agent home>/skills/...` run; the copied-script test runs the real `moduleCandidates()`; the fixture edits and the pattern are right. Non-blocking notes kept: a temp path with a space would break ROOT's URL decoding (predates this change); a generic refusal that puts the id before the word "model" is still `error` (disclosed in §2); the Studio layout is inferred from the loaded path.

## Evidence pointers

- `tests/unit/cross-model-review-module-freshness.test.ts`, `tests/unit/crossModelReviewer.test.ts` (5 files, 115 tests, exit 0 on the M5 via the heavy-work wrapper).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in shipped code (module resolution and an error classifier), not in a prompt, hook, config, skill text or standards text.
