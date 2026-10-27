<!-- internal-only -->
# Lint runs its steps in parallel; the standards measurement stops repeating git reads

## What Changed

- New `scripts/run-lint-parallel.mjs` and script `lint:parallel`: runs the steps of `scripts.lint` (unchanged, still the single list Local Verify and the wiring tests read) with bounded concurrency, reports every failing step, and prepends `node_modules/.bin` to PATH as `npm run` does. `INSTAR_LINT_CONCURRENCY=1` runs them serially.
- `.husky/pre-commit` and the CI `lint` job call `npm run lint:parallel`.
- `scripts/lib/standards-enforcement-measurement.mjs`: the protected-snapshot reader memoizes `readFile` / `listFiles` / `hasMarker`, whose answers come from a fixed commit.
- Side-effects: `upgrades/side-effects/lint-parallel-runner.md`.

## Evidence

`standards-coverage.mjs --json` 53.4 s → 25.1 s with byte-identical output; git processes per run 891 → ~283. Whole lint chain 153.9 s serial → 105.9 s parallel, all 49 steps passing (the TS 5.9 type-check is the long pole; PR #2405 cuts it to ~15 s). `tests/unit/run-lint-parallel.test.ts` (6 tests: same split as Local Verify, hook/CI wiring, order + run-all-after-failure, serial mode, PATH, concurrency bound); existing measurement, standards-coverage, rollout-evidence and llm-attribution wiring tests pass (84 tests).
