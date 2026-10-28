<!-- internal-only -->
# threadline-core and witness build under TypeScript 7

## What Changed

- `packages/threadline-core/tsconfig.json` and `packages/witness/tsconfig.json` name `"types": ["node"]`, so they type-check under TypeScript 7 (which no longer includes `@types/*` automatically) as well as 5.9.

## Evidence

TS7 errors 135 → 0 and 61 → 0 (TS 5.9 stays 0); emitted `.js` byte-identical between compilers; package suites pass built with either compiler (20/20, 65/65).
