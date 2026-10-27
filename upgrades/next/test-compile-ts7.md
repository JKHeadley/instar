<!-- internal-only -->
# Test-time compiles use the TypeScript 7 compiler

## What Changed

- `tests/setup/build-dist.globalSetup.ts` and `tests/unit/package-completeness.test.ts` compile with `node node_modules/typescript-native/bin/tsc` (the compiler `npm run build` uses since #2405) instead of `npx tsc`, which resolves install-order dependently now that two TypeScript packages are installed.

## Evidence

CI unit shard: ≈39 s from test-step start to first output, spent in the global-setup compile; TypeScript 7 emit is ≈4× faster locally (92.9 s → 23.3 s) with byte-identical `.js` (#2405).
