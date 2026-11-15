# Side-Effects Review — main CI green: route docs over the floor, own-suite probe asks for a worker count

**Version / slug:** `fix-main-red-1114`
**Date:** `2026-11-14`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1. Four files changed plus records, no `src/` change. (1) Docs: a new reference page `site/src/content/docs/reference/ledger-and-request-routes.md`, its sidebar entry in `site/astro.config.mjs`, and four inventory sections in `site/src/content/docs/reference/api.md` document 22 routes from their handlers in `src/server/routes.ts` (`/blockers*`, `/authorization-requests*`, `/failures/analysis|insights|:id`, `/framework-issues*`), lifting Docs Coverage route coverage from 54.35% to 56.64% (floor 55%). (2) Test: in `tests/integration/test-runner-bound-meta.test.ts`, the `ownSuite` nested child now passes `--maxWorkers=5`. Case (d2) asserted more than 4 probes ran at once, but the child had no worker count, so its pool was vitest's default `availableParallelism() - 1`: 3 on a 4-core GitHub runner, where it failed every run. Effort: one pass, one review round.

## Decision-point inventory

No decision-point surface. The docs change is text. The test change alters only the fixture child's argv; the test-runner bound (`tests/setup/test-runner-bound.config-eval.ts`, the globalSetup, `src/core/testRunnerRunClassifier.ts`) is untouched.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. On the test's own power: if a future regression routed the own-suite child down the nested-clamp path, config-eval would strip the pool flag (`neutralizePoolShapingArgv`) and clamp the pool to 4, so the child would measure at most 4 and (d2) would fail as intended; it would also fail on the ledger assertions (`own-suite-unclamped` missing, `clampStash` reading `nested` instead of `own-suite`). The CLI-proof case in the same file already shows a CLI `--maxWorkers=32` is defeated by the clamp. This block runs with the clamp active; in a dry-run posture the overlap check could not tell the paths apart (true before this change too), and the `would-clamp` ledger assertion is what catches it.

---

## 3. Level-of-abstraction fit

The defect was in the test, not the code: the measurement depended on host core count. Fixing it in the test fixture's argv mirrors production in substance: Local Verify always asks its unit lane for an explicit width (`INSTAR_TEST_WORKERS`, `src/localVerify/orchestrator.ts`, which `vitest.config.ts` turns into a config `maxWorkers`); the test asks through the CLI flag, and both end at 4 or fewer under a wrong clamp. The assertion `> 4` is correct and kept.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Documentation and a test fixture argument only.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** none. The docs page adds text; the coverage script counts substring mentions, and these routes had zero mentions.
- **Double-fire:** none.
- **Races:** the own-suite child now runs 5 forks instead of the host default; on large hosts that is fewer than before (15 on the Studio), on 4-core runners two more short sleeping probes. No shared state.
- **Feedback loops:** none. Open PR #2742 documents eight other routes by appending to the end of `api.md`; this change inserts sections in the middle, so the two do not overlap.

---

## 6. External surfaces

The public docs site gains one reference page and a sidebar link. No runtime, agent, state, or messaging surface changes. No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable: no runtime behavior, state, notices, URLs or status surfaces change. Machine-local by design only in the trivial sense that a test runs where it is run; the fix removes its dependence on the machine's core count.

---

## 8. Rollback cost

Pure docs and test change — revert. No persistent state, no user-visible effect.

---

## Conclusion

Both main-red checks are fixed at their cause: the route docs gap is closed with accurate documentation of 22 routes, and case (d2) no longer measures the host's core count while keeping its power to catch a wrongly clamped own-suite child. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Claude Opus 5.5), given the diff and the code, not this artifact's conclusion
**Independent read of the artifact: concur**

First read: concern on wording only. It independently found the same (d2) root cause (vitest 2.1.9 default `availableParallelism - 1` = 3 on a 4-vCPU runner) and judged the `--maxWorkers=5` edit a correct fix that keeps the assertion's power under the active clamp, with low flake risk. It flagged doc sentences that overstated the 503 switch naming, the blocker error codes, the Self-Unblock run requirement (`selfUnblockRunId`, all kinds) and the `resolved` settle requirements, plus artifact wording (`clamp` event that has no producer; release-note count). All were fixed; on re-read it concurred with no remaining inaccuracy.

---

## Evidence pointers

- `node scripts/docs-coverage.mjs --check` → route 57% (56.64%), passed; before 54% (54.35%).
- Failing main run 43614916183 log: windows `probe-1..3 ≈ 4180 ms, probe-4..5 = 151 ms` — three ran together until the 4 s barrier deadline, then two: a pool of 3.
- 4-CPU shim repro of (d2): see the PR body Evidence.
