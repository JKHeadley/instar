# Side-Effects Review — parallel unit lane, each file once under test:all

**Version / slug:** `parallel-test-lanes`
**Date:** `2026-10-21`
**Author:** `Echo`
**Second-pass reviewer:** `not required (test-harness configuration only; no runtime, gate or fleet surface)`

## Summary of the change

First piece of `docs/specs/local-verify-merge-authority.md` (§1, approved 2026-10-21). `vitest.config.ts` (what `npm test` runs) narrows its `include` to the unit lane (`tests/unit/**`, `tests/real-world-state/**`) and runs files in parallel (`fileParallelism: true`, `minWorkers: 1`, `maxWorkers` from the new `tests/setup/lane-workers.ts`). Previously it also included `tests/integration/**` and `tests/e2e/**`, so `npm run test:all` (unit config, then integration, then e2e) ran every integration and e2e file twice, and the whole unit config ran one file at a time. `vitest.e2e.config.ts` gains `build-dist.globalSetup` because its dist-gated files used to run under the unit config, which built dist. Integration and e2e stay sequential. Files: `vitest.config.ts`, `vitest.e2e.config.ts`, `tests/setup/lane-workers.ts`, `tests/unit/test-lanes-config.test.ts`, `CLAUDE.md` (one wording line), `upgrades/next/parallel-test-lanes.md`.

## Decision-point inventory

No decision-point surface. This changes which test files a config collects and how many worker processes run them; nothing at runtime decides on its output.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The nearest analogue: a unit file that silently depended on running after another file in the same process could fail when files run in parallel. The full unit lane was run at 8 workers on origin/main earlier today with every test passing, and is run again on this branch before merge.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Coverage note: `npm test` alone no longer runs integration or e2e files. That is the intended lane split; `npm run test:all` still runs all three, and CI already ran integration and e2e as separate jobs (the CI unit shards use `vitest.push.config.ts`, which this change does not touch).

---

## 3. Level-of-abstraction fit

The worker count lives in the configs, as the spec says, through one small pure helper so both sides of the rule are unit-tested. It sits under the host test-runner bound (`withTestRunnerBound`), which still clamps a nested or targeted run once it enforces; this change does not re-implement or bypass it.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

Test configuration only.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The worker rule (8 at 12+ cores, else half) is a capacity constant measured on the target host, overridable by `INSTAR_TEST_WORKERS`.

---

## 5. Interactions

- **Host test-runner bound:** each lane still acquires its suite slot through `withTestRunnerBound`; `test:all` holds no slot of its own. A parallel unit lane uses more CPU for less time (measured: under 4 minutes at 8 workers on 16 cores, against tens of minutes sequential). The bound is watch-only today, so two concurrent full runs are not prevented; that is unchanged.
- **Pre-push hook:** runs `scripts/pre-push-smoke.mjs`, not `vitest.config.ts`; unaffected.
- **Command watchdog:** a running suite is protected for its first 60 minutes; a shorter run is further inside that window.
- **e2e lane:** now pays a `tsc` build when dist is stale (a no-op when current). The dist-gated e2e files that used to run only under the unit config now run here, which is where they belong.

---

## 6. External surfaces

None for agents or users. Developers: `npm test` is the unit lane only (as `CLAUDE.md` already labelled it); `npm run test:all` is the full suite.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable — no operator surface touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by nature: the worker count is computed from the cores of the machine running the tests. No state, no replication.

---

## 8. Rollback cost

Revert the commit. No migration, no persisted state.

---

## Conclusion

Low-risk test-harness change that removes the duplicate integration/e2e run from `test:all` and parallelises the unit lane, verified by the full three-lane run on this branch.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/test-lanes-config.test.ts`
- Full three-lane run on the Mac Studio on this branch (times and counts in the PR body).
