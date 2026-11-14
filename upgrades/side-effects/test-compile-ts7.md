# Side-Effects Review — test-time compiles use the TypeScript 7 compiler

**Version / slug:** `test-compile-ts7`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (required: harness-changing — tests/setup/**)`

## Summary of the change

Tier 1, test harness, 3 call sites. Follows #2405 (TypeScript 7 for `build` / `lint` / `dev`). Three places in the test harness still compiled `src/` with `npx tsc`:

- `tests/setup/build-dist.globalSetup.ts` — runs before every vitest invocation and compiles `dist/` when it is missing or stale. On CI every test job starts from `npm ci` with no `dist/`, so every job compiles: the unit shard measured spent 17:48:51 → 17:49:30 (≈39 s) between starting the test step and the first output, nearly all of it this compile.
- `tests/unit/package-completeness.test.ts` — compiles when `dist/` bin files are missing (the same CI situation, normally already covered by the global setup).
- `tests/integration/PostUpdateMigrator-packageTemplateShape.test.ts` — compiles `dist/` unconditionally before packing (found by the second pass; under TypeScript 5.9 this compile alone took 3 m 43 s on a loaded machine against a 120 s integration test timeout).

With two TypeScript packages installed (#2405), `npx tsc` runs whichever one npm linked to `.bin/tsc` last — install-order dependent. All three now call the TypeScript 7 compiler by path (`node node_modules/typescript-native/bin/tsc`, or `process.execPath` with that path in the `execFileSync` call), the same compiler `npm run build` uses, which emits byte-identical JavaScript (verified in #2405 across all 1,963 `.js` files) roughly 4× faster (92.9 s → 23.3 s locally).

Expected effect: ≈25–30 s less per CI test job before the first test runs (≈10 jobs per CI run), and the same on any local run that has to rebuild `dist/`.

## Decision-point inventory

None.

## 1. Over-block
No block/allow surface. If `typescript-native` were absent (a checkout predating #2405), the compile would fail loudly — this change lands only after #2405, which adds it.

## 2. Under-block
Could tests now run against different `dist/` output? No: the emitted `.js` is byte-identical between the two compilers (#2405 evidence, independently repeated by its reviewer); declaration-file differences are cosmetic and no test reads `.d.ts` text.

## 3. Level-of-abstraction fit
Matches `npm run build`, so tests and the shipped package are compiled by one compiler.

## 4. Signal vs authority compliance
Not applicable.

## 5. Interactions
- Local Verify classifies `tests/setup/**` as harness-changing → independent second pass (this PR).
- CI unit/integration/e2e jobs all go through the global setup.

## 6. External surfaces
None.

## 7. Multi-machine posture
Machine-local test configuration.

## 8. Rollback cost
Revert.

## Second-pass review

**Reviewer:** independent subagent
**Verdict:** Concur with the review. My one concern is resolved: `tests/integration/PostUpdateMigrator-packageTemplateShape.test.ts:46-47` now calls `process.execPath` with `node_modules/typescript-native/bin/tsc`. On a re-check, nothing else in `tests/`, the vitest configs or `scripts/` compiles root `src/` with `tsc`; the five remaining `npx tsc` calls are the `packages/threadline-mcp` ones, which are out of scope. I re-ran that integration test myself: 2/2 passed in 81.6 s. One wording nit, not blocking: the Summary still says "Two places" before listing three.

- Call sites: grepped `tests/`, `vitest*.config*`, `scripts/`, `.husky`, `.github`, `src/` for `npx tsc` / `bin/tsc` / `'tsc'`. Only the two changed lines and the integration test above compile root `src/`. The five `tests/e2e/threadline/*` `npx tsc` calls run with `cwd: packages/threadline-mcp`. That package declares `typescript ^5.9.0` but has no `node_modules` of its own, so it resolves the root `node_modules/.bin/tsc` (now `-> ../typescript/bin/tsc`, 5.9.3). That is correct for those packages and out of scope. The other matches are string fixtures (`ScopeCoherenceTracker`, `session-watchdog-test-runner-floor`, `localVerify/orchestrator`).
- Emit equivalence: built `src/` with both compilers into separate `--outDir` scratch dirs. Both produced 1,963 `.js` files, and none of them differ. The 1,870 differing files are all `.d.ts` (114), `.d.ts.map` (1,009) and `.js.map` (747). No test reads `dist` `.d.ts` or `.map` content; the only grep hit is fixture path strings in `file-classifier.test.ts`. Time: TS7 took 26 s, TS 5.9 took 3 m 43 s (wall time, on a loaded machine). The integration config's `testTimeout` is 120 s (`vitest.integration.config.ts:15`), which makes the leftover 5.9 call above more of a timeout risk than the changed ones.
- Global setup, real `vitest run` with the change applied:
  - (a) `dist/` missing (moved aside into scratch): compiles, writes `dist/core/cartographerDetect.worker.js`, `dist/cli.js` mode 755, registry asset generated, tests pass.
  - (b) fresh: no rebuild (`dist/cli.js` mtime unchanged, 3.4 s run).
  - (c) stale (touched `src/cli.ts`): rebuilds, mode stays 755.
  - (d) `vitest list` with stale src: no build (mtime unchanged), so the early return at `build-dist.globalSetup.ts:60` holds.
- `package-completeness.test.ts:319`: same compiler plus `chmod 0755`; only runs when bin files are missing.
- CI: test jobs use plain `npm ci` (`ci.yml:309,335,368,395,423,445`). The native binary is an `optionalDependency` (`@typescript/typescript-linux-x64` is locked at `package-lock.json:3022`). `typescript-native` has no install scripts, so the `npm ci --ignore-scripts` job (`ci.yml:131`) is also unaffected, and that job runs no build anyway.
- Node 20 vs 22: `lib/tsc.js` uses `process.execve` only when it exists (node ≥22.15) and otherwise falls back to `execFileSync` with exit-status propagation. The package's `engines` field is `>=16.20.0`. I ran only on node 22.23.2 locally; node 20 is covered by #2405's CI build/lint.
- Nothing else unsafe: the change is two command strings in the test harness. Rollback is a revert.
