# Side-Effects Review — gitignore the generated builtin-manifest (end the conflict loop)

**Version / slug:** `manifest-gitignore-end-conflict-loop`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required (internal dev-workflow change, no runtime/user surface)`

## Summary of the change

`src/data/builtin-manifest.json` is a GENERATED build artifact (`scripts/generate-builtin-manifest.cjs`, run as the first step of `npm run build` and again by `prepublishOnly`) that was nevertheless committed to git. Because every skill/hook PR regenerates it, it conflicted on git on a fast-moving main almost every time main advanced — a structural, unwinnable resolve→CI→re-conflict loop (one docs PR hit it 5×). This change stops committing it: adds it to `.gitignore`, `git rm --cached`s it (file stays on disk), and makes the single test that reads it self-generate it if absent.

## Decision-point inventory

1. **`.gitignore`** — add `src/data/builtin-manifest.json`. The conflict becomes impossible because nothing commits the file.
2. **`git rm --cached src/data/builtin-manifest.json`** — untrack it; the on-disk file is untouched.
3. **`tests/unit/builtin-manifest.test.ts`** — `beforeAll` regenerates the file if missing (it's the only test that reads it).

## 1. Publish path (does the package still ship the manifest?)

YES — verified. A `.npmignore` EXISTS, so npm uses `.npmignore` (not `.gitignore`) when packing; the manifest is not in `.npmignore`, so it remains in the tarball. Confirmed with `npm pack --dry-run` after gitignoring: the tarball still lists `src/data/builtin-manifest.json` (61.4kB). `prepublishOnly: npm run build` regenerates it before publish, so it always exists at pack time. No package.json `files` change needed.

## 2. Runtime path (does anything break if the file is missing?)

NO — `CapabilityMapper.loadBuiltinManifest()` is the only runtime reader; it guards with `if (fs.existsSync(...))` inside a try/catch and `return {}` otherwise — a missing manifest degrades to an empty capability map, never a crash. (Pre-existing behavior, unchanged.)

## 3. Test/CI path

- `builtin-manifest.test.ts` is the only test reading the file; it now regenerates it in `beforeAll`. Verified: `rm` the file → run the test → it regenerates and all 9 assertions pass.
- CI's "Build" job runs `npm run build` (regenerates the manifest); the unit-test job's `builtin-manifest.test.ts` self-generates. No CI step asserts a clean git tree against the committed manifest, so removing it eliminates (rather than introduces) a drift-failure class.
- The other files matching "builtin-manifest" in tests reference the unrelated playbook `builtin-manifests/` directory, not this file.

## 4. Reversibility

Fully reversible: `git add -f src/data/builtin-manifest.json`, drop the `.gitignore` line, revert the test `beforeAll`. No state, no format, no migration.

## 5. Blast radius

`.gitignore` (1 line + comment), `tests/unit/builtin-manifest.test.ts` (a `beforeAll`), and the untracking of one generated JSON. NO runtime `src/*.ts` change. Build/publish/CI behavior is identical because the file is still produced at build time.

## Evidence pointers

- `npm pack --dry-run` (with the file gitignored) lists `src/data/builtin-manifest.json` in the tarball.
- `node_modules/.bin/vitest run tests/unit/builtin-manifest.test.ts` after `rm`-ing the file: 9 passed; file regenerated.
- `tsc --noEmit` clean; `no-silent-fallbacks` ratchet unchanged (no src catches touched).
