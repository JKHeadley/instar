<!-- internal-only -->
# Tests load Supertest only where they import it

## What Changed

- `tests/vitest-setup.ts` no longer imports Supertest for every test file.
- New `tests/setup/supertest-with-retry.ts` (the real package plus the existing suite-wide connect retry) and `tests/setup/supertest-alias.ts`; all four vitest configs alias the bare `supertest` specifier to the wrapper.
- New `tests/unit/supertest-retry-alias.test.ts`.
- Side-effects: `upgrades/side-effects/supertest-lazy-load.md`.

## Evidence

60 non-Supertest unit files, A/B twice: summed setup time 18.9 s / 20.5 s → 3.9 s / 2.6 s (~0.27 s per file). Supertest-using tests pass under the alias: 29 unit files (309 tests), 6 integration files (36 tests), 4 e2e files (19 tests).
