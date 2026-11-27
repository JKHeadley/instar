# Side-Effects Review — Type-check and build with the TypeScript 7 native compiler

**Version / slug:** `typescript-7-native-compiler`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (required: harness-changing per Local Verify — package.json scripts + toolchain)`

## Summary of the change

Tier 1, 5 files (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `src/localVerify/harnessClassifier.ts`, its unit test). Adds the TypeScript 7 native compiler as a second devDependency under the alias `typescript-native` (`npm:typescript@7.0.2`, pinned exact) and points the `build`, `lint` (its `--noEmit` step) and `dev` scripts at it by explicit path (`node node_modules/typescript-native/bin/tsc`). The existing `typescript@^5.9.3` devDependency stays, unchanged, because TypeScript 7 no longer ships the classic JavaScript compiler API that 6 lint scripts, 5 tests and `src/localVerify/skipRatchet.ts` load with `require('typescript')` / `import ts from 'typescript'` to parse source. The explicit path matters: with both packages installed, both declare a `tsc` bin and which one `node_modules/.bin/tsc` links to depends on install order (observed both ways: TS7 right after `npm install -D`, TS 5.9 after a later `npm ci`).

Measured on Mama PC (10 logical cores, WSL2), same worktree, warm cache:

| Step | TypeScript 5.9.3 | TypeScript 7.0.2 |
|---|---|---|
| `tsc --noEmit -p .` (type-check) | 68.0 s | 15.4 s |
| `tsc` (emit to `dist/`) | 92.9 s | 23.3 s |
| `npm run build` (whole script) | — | 24.3 s, exit 0 |
| `npm run lint` (whole chain) | — | 143.5 s, exit 0 |

Emit equivalence (TS7 `dist/` vs TS5 `dist/`, same source): 7,852 files each, identical file list; **all `.js` files byte-identical**; 114 `.d.ts` files differ only in quote style (`'a'` vs `"a"`) and union-member order (same types); 1,756 `.js.map` files differ in mapping encoding, every map keeps the same `sources` (the two with empty `mappings` are empty under both, type-only modules). Positive control: a deliberate type error and a missing import each make TS7 exit 1 with the expected TS2322/TS2307 diagnostics.

Second change, from the second-pass review: Local Verify's harness classifier listed `typescript` but not the alias, so a later PR bumping only the TS7 version would have classified `harnessChanging:false` and skipped the independent second pass. `typescript-native` is added to `TOOLCHAIN_PACKAGES` and `@typescript/` (the per-platform native binaries) to `TOOLCHAIN_SCOPES`, with unit tests that fail on the old list (2 failures) and pass on the new one (38/38); `@typescript-eslint/` is asserted not to match.

Effort: 1 build/measure pass, 1 second-pass round (one concern, fixed), 1 commit attempt so far.

## Decision-point inventory

- `Local Verify harness classifier` (`src/localVerify/harnessClassifier.ts`) — modify — the toolchain package list gains `typescript-native` and the `@typescript/` scope, so a change to the compiler the build actually runs routes through the independent second pass. Widens what counts as harness-changing; never narrows it.
- The compiler swap itself adds, modifies and removes no gate, sentinel, filter or authority.

---

## 1. Over-block

Classifier: a PR touching only `@typescript/*` or `typescript-native` entries is now harness-changing and needs a second-pass trace. That is the intended population (those packages are the compiler the build runs); `@typescript-eslint/*` is tested not to match. Compiler swap: no block/allow surface. Nearest analogue: could TS7 reject code TS5 accepts? Measured: zero diagnostics on the current tree, so no current code is rejected. A future TS7-only diagnostic would surface as a normal lint failure on that future PR.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Nearest analogue: could TS7 accept a type error TS5 would catch? The positive control shows it catches assignment and module-resolution errors. TypeScript 7 is the official port of the same checker; a checker-level divergence is possible in principle and would appear as code that type-checks under 7 but not 5. Mitigation: the `typescript@5.9` package remains installed, so `npx -p typescript@5.9.3 tsc --noEmit` (or `node node_modules/typescript/bin/tsc --noEmit`) is a one-command cross-check.

---

## 3. Level-of-abstraction fit

Right layer: the toolchain is selected in `package.json` scripts, which is where every consumer (CI `npm run build` / `npm run lint`, Local Verify's orchestrator which splits those scripts on `&&` and runs each step, developers) already reads it. No consumer had to change.

---

## 4. Signal vs authority compliance

Not applicable — no detector or authority is added or changed. (`docs/signal-vs-authority.md` reviewed; this is a toolchain swap.)

---

## 5. Interactions

- **Local Verify (topic 130715's area):** the orchestrator runs the `build` and `lint` steps from the merge tree's `package.json` after `npm ci`, so it picks up the explicit-path steps with no code change; `src/localVerify/skipRatchet.ts` keeps loading `typescript` (5.9) by name from the run worktree, unchanged. The PR is classified harness-changing (`package.json:scripts`, toolchain), which routes it through the required independent second-pass review — intended.
- **Local Verify re-verify once (by design):** `computePolicyHash()` hashes `TOOLCHAIN_PACKAGES` / `TOOLCHAIN_SCOPES` (`src/localVerify/policy.ts`) into `verifierVersion`, so after this merges every existing Local Verify record reads `verifier-mismatch` and each queued PR re-verifies once. That is the verifier's intended response to any change in itself; it costs one extra verify per queued PR, and the Increasing Throughput topic (130715) is told.
- **TS-API consumers** (`scripts/lint-no-direct-destructive.js`, `lint-no-undefined-erasing-default-merge.js`, `lint-no-unfunneled-headless-launch.js`, `lint-telegram-egress-boundary.mjs`, `lint-canonical-pipeline-completeness.mjs`, `scripts/lib/standards-enforcement-measurement.mjs`, and tests): unchanged, still resolve `typescript` 5.9. Verified: full `npm run lint` exit 0; the 30 unit files and 3 integration files that read the scripts or use the TS API pass (685 + 16 tests).
- **`node_modules/.bin/tsc`** is install-order dependent (see Summary). The two bare-`tsc` callers at the repo root (`tests/setup/build-dist.globalSetup.ts`, `tests/unit/package-completeness.test.ts`) compile the root project identically under either version. The threadline e2e tests run `npx tsc` inside `packages/threadline-mcp` with its own TypeScript: 38 files / 420 tests pass.
- **Sub-packages under TS7 (known, not triggered):** `packages/threadline-core` and `packages/witness` do not compile under TS7 (TS2591, TS7 no longer adds `@types/*` automatically); both compile under 5.9 and nothing builds them with the root compiler (their workflows install their own `typescript ^5.9`). Queued as an instar feedback item so a future move of those packages to TS7 adds `"types": ["node"]` first.
- **`package-lock.json` (fixed after Local Verify):** the first version was regenerated by `npm install` (npm 10.9.8, Linux), which dropped `node_modules/sqlite-vec/node_modules/sqlite-vec-linux-arm64`. npm 10's `npm ci` accepts that; npm 11 (Node 24, the Studio's Local Verify) refuses it as out of sync, which failed the verify at `npm ci` in 3 s twice. The lockfile is now `main`'s exactly, plus only the `typescript-native` and `@typescript/typescript-*` entries and the root devDependency; `npm ci` passes under both npm 11 and npm 10.
- **`pnpm-lock.yaml`:** regenerated by `pnpm add --lockfile-only` so the `ux-impact-pr-gate` workflow's `pnpm install --frozen-lockfile` still matches `package.json`. pnpm also re-resolved the dashboard build's `vite` peer type package from `@types/node@20.19.33` to `@types/node@24.13.3` (type-only, dev tooling, not shipped; both a narrower `pnpm add` and a full re-resolve produced the same result).

---

## 6. External surfaces

None for users or other agents: the published `dist/` JavaScript is byte-identical. Declaration files differ only cosmetically. Source maps differ in encoding but map the same sources. Developers and CI get a faster build. Platform coverage: the TS7 package ships native binaries for linux/darwin/win32 on x64/arm64 (plus others) via optional dependencies, covering CI (ubuntu) and every pool machine (macOS arm64, WSL2 x64).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: it is a build-tool choice resolved per checkout by `npm ci`. Every machine that installs from the lockfile gets the same pinned 7.0.2. No replicated state, no notices, no URLs.

---

## 8. Rollback cost

Revert the PR (one commit). No data, state or migration involved; the shipped JavaScript is identical either way, so no agent behaviour changes on rollback.

## Second-pass review

**Reviewer:** independent subagent
**Verdict:** Concur with the review. The concern I raised first (the harness classifier could not see the TS7 compiler, so a later compiler bump would have skipped the independent second pass) is resolved: `TOOLCHAIN_PACKAGES` now includes `typescript-native` and `TOOLCHAIN_SCOPES` includes `@typescript/` (`src/localVerify/harnessClassifier.ts`), and re-measurement is below. The original concern stays in the bullets for the record.

- **Bare `tsc` resolution:** both packages declare a `tsc` bin. In this worktree `node_modules/.bin/tsc` points to `../typescript/bin/tsc` (TS 5.9.3), which contradicts section 5's claim that it resolves to TS7 after `npm ci`. Which one wins depends on install order. Bare-`tsc` callers at the repo root (`tests/setup/build-dist.globalSetup.ts:71`, `tests/unit/package-completeness.test.ts:319`) compile the root project the same way under either version, so nothing breaks. `.bin/tsserver` is always 5.9 because TS7 ships no tsserver. Section 5 should say "install-order dependent" rather than "TS7".
- **Sub-packages:** `packages/threadline-core` and `packages/witness` fail to compile under TS7: 135 and 61 errors (TS2591 "Cannot find name 'Buffer'/'node:crypto'"), because TS7 no longer adds `@types/*` automatically. Both compile cleanly under 5.9. `packages/threadline-mcp` compiles under TS7 with 0 errors. No current path builds these packages with the root compiler: their publish workflows run their own `npm ci` with their own `typescript ^5.9`, and the threadline e2e tests `npx tsc` only when the package's own `node_modules` exists (the `hasDeps` guard). Still a hazard if someone later points them at the root compiler.
- **Users of the TypeScript JavaScript API:** `require('typescript')` from `src/` resolves to 5.9.3 with `createSourceFile` present. `skipRatchet.loadTypescript` resolves the name `typescript` from the run worktree, so the alias cannot shadow it. TS7's package `exports` only `lib/version.cjs` (no compiler API), which confirms 5.9 has to stay installed.
- **Local Verify build and lint:** the orchestrator runs each `&&` step with `sh -c` from `runDir` after `npm ci` (`orchestrator.ts:387`, `:404-408`). `node node_modules/typescript-native/bin/tsc` is relative to that directory, so it resolves correctly. TS7's `getExePath` reads the package's own name (`typescript`), not the folder name, so the alias works. It needs the `@typescript/typescript-linux-x64` optional dependency; I found no `--omit=optional` in CI or Local Verify, and `npm ci --ignore-scripts` is fine because the native package has no install script.
- **`dist/` equivalence (independent rebuild):** TS5 and TS7 both exit 0 and emit 7,852 files each with the same file list. Every `.js` file is byte-identical. 114 `.d.ts` files differ; the sample I checked differs only in union-member order. This matches the artifact.
- **pnpm-lock.yaml:** `pnpm@10` (the version CI pins) `install --frozen-lockfile --lockfile-only` passes against the new lockfile. As a positive control, the origin/main lockfile fails with "1 dependencies were added: typescript-native". The `@types/node` 20→24 change only alters the `vite` peer variant used by `@tailwindcss/vite` and `vitefu`. `@types/node@24.13.3` was already in the lockfile, and the other importer already used `vite@6.4.3(@types/node@24.13.3)`. Type-only, low risk.
- **Re-check after the fix (run against the TS source with vite-node):** this PR now classifies as `package.json:scripts`, `package.json:toolchain` and `package-lock.json:toolchain`. A PR that only bumps `npm:typescript@7.0.2` classifies as `package.json:toolchain` and `package-lock.json:toolchain` (it was `harnessChanging:false` before the fix). A lockfile change to only the `@typescript/typescript-linux-x64` binary is caught (`package-lock.json:toolchain`). As a negative control, an unrelated `supertest` lock bump stays `harnessChanging:false`. `tests/unit/localVerify/harnessClassifier.test.ts`: 38/38 pass.
- **No false matches from `@typescript/`:** every `@typescript/` entry in `package-lock.json` is one of the 20 `@typescript/typescript-<os>-<arch>` TS7 binaries. The lockfiles contain no `@typescript-eslint/*`, and the prefix match includes the trailing slash, so `@typescript-eslint/` cannot match. The new test also asserts that `@typescript-eslint/parser` is not toolchain.
- **Side effect the artifact should record:** `computePolicyHash()` hashes these lists (`src/localVerify/policy.ts:98`), and the hash feeds `verifierVersion`. Once this deploys, every Local Verify record written under the old verifier stops matching (`verifier-mismatch`), so each pending PR re-verifies once. That is how the verifier is designed to behave on any change to it, and it is not a blocker, but section 5 or section 8 should say so.
- **Updated artifact:** the summary now names 5 files, the decision-point inventory lists the classifier change, and section 5 says "install-order dependent" for `.bin/tsc` and records the threadline-core/witness TS7 hazard. Both match what I measured.

### Round 3 — lockfile rebuilt for npm 11

**Verdict:** Concur. The rebuilt lockfile fixes the npm 11 `npm ci` refusal and adds nothing beyond the intended entries.

- **Structural diff of the staged `package-lock.json` against `origin/main` (352daf534), parsed as JSON:** no top-level differences except `packages`. 0 entries removed. In the root entry (`""`), the only change is `devDependencies.typescript-native: npm:typescript@7.0.2`. Exactly 21 entries are added: `node_modules/typescript-native` (`typescript@7.0.2`, with registry `resolved`/`integrity`, `bin.tsc`, and 20 optional `@typescript/*` dependencies) and the 20 `node_modules/@typescript/typescript-<os>-<arch>` entries. No other entry changed, and `node_modules/sqlite-vec/node_modules/sqlite-vec-linux-arm64` is present again. The worktree copy is byte-identical to the staged copy.
- **Clean-copy `npm ci --ignore-scripts` from the staged files:** npm 10.9.8 exits 0 (486 packages) and npm 11.21.1 exits 0 (486 packages). Both install `typescript` 5.9.3, `typescript-native` 7.0.2 and the `@typescript/typescript-linux-x64` binary, and in both `.bin/tsc` points to `../typescript/bin/tsc`. Positive control: npm 11 on the previous committed lockfile (`HEAD:package-lock.json`, which has 0 `sqlite-vec-linux-arm64` nested entries) fails with "Missing: sqlite-vec-linux-arm64@ from lock file", which reproduces the Studio failure. Both runs used Node 22 on linux-x64, not the Studio's Node 24 on darwin-arm64. The darwin-arm64 binary entry is present and identical to the one in the earlier lockfile.
- **Build/API:** the `build`, `lint` and `dev` scripts still run `node node_modules/typescript-native/bin/tsc` (7.0.2). `require('typescript')` resolves to 5.9.3, and `createSourceFile` is present.
- **pnpm:** `pnpm@10 install --frozen-lockfile --lockfile-only` passes on the staged `pnpm-lock.yaml`.
