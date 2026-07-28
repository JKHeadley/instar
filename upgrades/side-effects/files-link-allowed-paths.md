# Side-effects analysis — files-link-allowed-paths

## ELI16 — what this does

The dashboard's file deep-link endpoint (`GET /api/files/link`) rejected
every request with 403 on default installs, because it carried a private,
drifted copy of the allowed-path check that never learned the `'./'`
project-root convention. The fix extracts the canonical Layer 1–4 check into
one exported helper (`checkRelativePathAllowed`) used by both `validatePath`
and the link route, deleting the duplicate.

## What could this break?

- **validatePath callers** (read/list/download/edit endpoints): behavior is
  intended to be identical — the helper is a verbatim extraction of Layers
  1–4. Verified by the full file-viewer e2e suite (96 tests green
  post-refactor, including never-served, symlink-evasion, and edit paths).
- **Link route behavior change (intended)**: requests that previously 403'd
  under the default config now succeed (the regression being fixed). In the
  OTHER direction the route becomes stricter: absolute paths, traversal, and
  segment-boundary bypasses that the drifted inline check could admit under
  scoped configs are now rejected — strictly safer.
- **Response shapes**: unchanged (200 body, 400/403 error bodies keep their
  fields; 403 error strings now come from the shared check's messages).

## Failure modes considered

- The link route intentionally does NOT gain Layer 5 (existence/symlink
  resolution): it emits a URL, not content; the read endpoints enforce the
  full stack when the link is followed. Documented as a spec non-goal.

## Test coverage

- `tests/unit/fileRoutes-link-allowed-paths.test.ts` — 10 tests, both sides
  of every boundary + the route-level regression pin.
- Existing `fileRoutes-never-served` + `file-viewer-e2e` suites green.
