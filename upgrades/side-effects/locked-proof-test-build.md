# Side-Effects Review — locked-screen test build script

**Version / slug:** `locked-proof-test-build`
**Date:** `2026-11-02`
**Author:** `Echo`
**Tier:** 1 (maintainer script + test, no runtime source change). Size: 2 new scripts (~170 lines), 1 new test file. Effort: no spec rounds, first commit attempt.

## Summary of the change

The locked-screen spec says P12 and P15 run "on a test build" that "alone compiles in a test proven-versions table; no environment variable, config key or route can reach it in dist". That build did not exist. This adds:
1. `scripts/lib/locked-proof-build.mjs`: pure helpers (version naming, macOS major parsing, the table rewrite, the committed-table proof check).
2. `scripts/build-locked-proof.mjs`: `git archive` of a committed revision into a scratch directory outside the checkout, rewrite of the scratch copy's `src/core/DesktopProvenVersions.ts` (one `PROOF-RUN-IN-PROGRESS <version>` row), version `<release>-lockedproof.<n>`, `npm run build`, `npm pack --ignore-scripts`, manifest with commit, macOS major, helper `sourceHash`, tgz SHA-256.
3. `tests/unit/locked-proof-build.test.ts`, including a guard that every committed table row cites existing proof records for P12 and P15 and never the marker.

## Decision-point inventory

- The macOS-version admission decision (`provenVersion`) is unchanged. The test build only feeds it a different table in a scratch copy, which is the mechanism the spec names.

## 1. Over-block

None: no runtime path changes.

## 2. Under-block

- Someone could copy the marker row into the committed table by hand; the new unit test fails the suite in that case.
- The test package could be installed somewhere other than the throwaway user. It is never published to npm and carries a distinct version; installation is a deliberate act by the proof setup scripts. The proof agent must run with auto-update off, or the updater would replace it with the latest release (handled by the setup scripts in the next PR).

## 3. Level-of-abstraction fit

A build-time source rewrite is exactly what the spec asks for (no env/config/route reaches the table). Kept as a maintainer script, not shipped runtime code.

## 4. Signal vs authority compliance

No decision logic added. The unit guard is a CI check on committed data.

## 5. Interactions

- `npm run build` in the scratch copy runs the normal build chain, including the lock-file signer, which degrades to unsigned without the release key (documented behaviour).
- The scratch copy symlinks this checkout's `node_modules` for the build and removes the link before packing.
- `tests/e2e/desktop-locked-lifecycle.test.ts` still asserts the shipped table is empty; unchanged.

## 6. External surfaces

None for users or agents. `scripts/` ships in the npm package, so the script is present in installs but does nothing unless run from a git checkout.

## 7. Multi-machine posture

Machine-local by design: a build tool run on one Mac for that Mac's macOS major.

## 8. Rollback cost

Delete the scripts and test. Nothing persists.

## Conclusion

Adds the spec's missing test build, plus a guard that the committed table can only hold proven rows. Tier 1.

## Second-pass review (if required)

Not required: no gate, session lifecycle or messaging change.

## Evidence pointers

- `tests/unit/locked-proof-build.test.ts`
