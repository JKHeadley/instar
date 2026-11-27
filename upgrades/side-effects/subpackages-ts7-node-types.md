# Side-Effects Review — threadline-core and witness build under TypeScript 7

**Version / slug:** `subpackages-ts7-node-types`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `not required (two package tsconfig lines; no runtime decision surface)`

## Summary of the change

Tier 1, 2 files. `packages/threadline-core` and `packages/witness` failed to type-check under TypeScript 7 (135 and 61 errors, TS2591 "Cannot find name 'Buffer'/'node:crypto'") because TypeScript 7 no longer includes every `@types/*` package automatically. Both declare `@types/node` already; their `tsconfig.json` now names it with `"types": ["node"]`. `packages/threadline-mcp` already compiled under TS7 (its `@types/ws` pulls the Node types in) and is unchanged.

Evidence, same tree: errors under TS7 135 → 0 and 61 → 0; under TS 5.9 0 → 0. Emitted `.js` is byte-identical between the two compilers (10 and 12 files). Each package's own suite (`node --test`) passes when built with either compiler: threadline-core 20/20, witness 65/65.

Found while moving the root build to TypeScript 7 (#2405); closes feedback fb-968295be-3ff. Nothing builds these packages with TS7 today (their publish workflows install their own `typescript ^5.9`), so this removes a latent trap rather than a live failure.

## Decision-point inventory

None.

## 1. Over-block / 2. Under-block
No block/allow surface. `types: ["node"]` limits automatic type inclusion to `@types/node`; both packages compile with zero errors under both compilers, so nothing they use came from another `@types` package.

## 3. Level-of-abstraction fit
Per-package tsconfig, where the inclusion rule belongs.

## 4. Signal vs authority compliance
Not applicable.

## 5. Interactions
Type inclusion does not affect emit; the published JavaScript is unchanged.

## 6. External surfaces
None (the npm packages' runtime code is unchanged).

## 7. Multi-machine posture
Not applicable.

## 8. Rollback cost
Revert.
