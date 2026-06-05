<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The generated `src/data/builtin-manifest.json` is no longer committed to git. It was a build artifact (produced by `scripts/generate-builtin-manifest.cjs` during `npm run build` and `prepublishOnly`) that, because every skill/hook PR regenerates it, conflicted on a fast-moving main almost every time main advanced — an unwinnable resolve→CI→re-conflict loop (one docs PR hit it 5×). It is now `.gitignore`d and untracked. The published package still ships it (the `.npmignore` allowlist, not `.gitignore`, governs packing — verified with `npm pack --dry-run`), the build regenerates it before publish, the sole runtime reader already degrades gracefully if it's absent, and the one test that reads it now self-generates it in a `beforeAll`. Net: future skill/hook PRs stop fighting this file; build/publish/CI are unchanged.

## Evidence

- `npm pack --dry-run` (with the file gitignored) still lists `src/data/builtin-manifest.json` (61.4kB) in the tarball — the `.npmignore` allowlist governs packing.
- `vitest run tests/unit/builtin-manifest.test.ts` after deleting the file: regenerates it in `beforeAll`, all 9 assertions pass.
- `tsc --noEmit` clean; `no-silent-fallbacks` ratchet unchanged.
