# Side-effects review — registry asset freshness

## The change

Two vitest globalSetup files decided whether to regenerate the packed
standards-registry asset by asking only whether its outputs EXIST. Both now share a
`registryAssetIsStale()` helper that compares the oldest output's mtime against the
newest input's. Test-only; no runtime surface.

## Review answers

1. **Over-block.** This is the dominant risk and it got the most care, because the
   check runs at the START of every suite and an over-eager rule regenerates on every
   run. Three conservative cases, each with its own test: equal mtimes are NOT stale;
   no readable input is NOT stale; an empty output list is NOT stale. Measured cost of
   a genuine regeneration is one generator invocation (~1s), and it self-limits — a
   freshly written asset is newer than its inputs, so the next run skips.

2. **Under-block.** mtime is a proxy for content, not content itself. A source edited
   and reverted leaves a newer mtime and triggers one unnecessary regeneration
   (harmless). A content-identical touch does the same. Conversely, a filesystem that
   does not preserve mtimes, or a checkout that sets all mtimes equal, would report
   fresh when stale. A content hash would be exact — the generator already writes a
   `sha256` into its metadata — and that is the stronger version of this fix. NOT done
   here: it means reading and hashing a 450KB document on every suite start, where the
   mtime compare is four `stat` calls, and the sibling `ensureDistBuilt()` this mirrors
   uses mtimes too. Stated rather than implied.

3. **Level-of-abstraction fit.** Correct layer: the setup layer is where every test
   file inherits the guarantee. The file's own history says this explicitly — a
   per-file `beforeAll` bootstrap was found to be invisible to the next file that
   needed it.

4. **Signal vs authority.** Not a gate. It decides whether to run a generator; it
   blocks nothing and rejects no input.

5. **Interactions.** `ensureRegistryAsset()` must still run AFTER `ensureDistBuilt()`
   (the generator imports from `dist/`). Unchanged — only the early-return predicate
   moved. The exported `ensureRegistryAsset(root)` keeps its signature, so the
   production-generator parity ratchet that imports it is unaffected.

6. **External surfaces.** None. Test setup only; nothing ships to an agent or a user.

7. **Multi-machine posture.** Machine-local BY DESIGN — a per-checkout build artifact.
   There is nothing to replicate: each checkout generates its own copy, and the whole
   defect was one checkout trusting its own stale copy.

8. **Rollback cost.** Revert the commit. The helper is additive; the two call sites
   return to a presence check.

## Class closure — what this does NOT close

- **Only these two sites.** A sweep of `tests/setup/` and `scripts/` for
  regenerate-on-presence guards found exactly these two making a regeneration decision
  on existence alone; the other `existsSync` hits are ordinary existence guards, not
  regeneration decisions. The wiring test pins both and fails if either drifts, but it
  knows only about setups that generate THIS asset.
- **`src/data/builtin-manifest.json`** is named in the generator's own comment as
  having a related defect (generated only into `src/data/` while its reader resolves
  module-relative from `dist/data/`). Different feature, different defect, untouched.
- **mtime is not content** — see review answer 2.

## Evidence

- `tests/unit/registry-asset-freshness.test.ts` — 9/9 green.
- Negative controls, BOTH fired and both restored byte-exact: reverting the comparison
  fails THE DEFECT case (1 failed / 8 passed — the 8 passing are the controls, which is
  what makes them controls); reverting one call site to the presence check fails the
  wiring case and names the file.
- Observed live: running the new test in a fresh checkout regenerated the asset
  ("88 articles → src/data + dist/data"). Under the presence check it would have
  skipped, because the outputs existed.
- The originating measurement: three test files / eight assertions failing against a
  three-hour-stale asset; regeneration alone made all 77 pass.
- `tsc --noEmit` exit 0 (run via the real binary — `npx tsc` here is intercepted by a
  shim that exits 0 without typechecking). Full lint chain exit 0 across 45 lints.
