<!-- internal-only -->

## What Changed

- New maintainer script `scripts/build-locked-proof.mjs`: the locked-screen test build the spec calls for (`docs/specs/desktop-locked-screen.md`, phase 3). It copies one committed revision into a scratch directory outside the checkout, adds a single `PROOF-RUN-IN-PROGRESS` row for one macOS major to that copy's proven-versions table, versions it `<release>-lockedproof.<n>`, builds it (the Swift helper is unchanged, so its source hash matches the release) and packs it, writing a manifest with the commit, macOS major, helper source hash and package checksum. The committed table is never touched and nothing is published. `--dry-run` shows the row and builds nothing.
- New test: the committed `PROVEN_MACOS_VERSIONS` table fails the unit suite if any row lacks an existing proof record under `docs/proofs/desktop-locked-screen/` for P12 or P15, or carries the test-build marker.

## Evidence

- Unit tests: version naming, macOS major parsing, the rewrite against the real committed source (one row added, the rest of the file byte-identical), refusal of an already-proven version and of a missing declaration, the dry run leaving the committed table's bytes unchanged, refusal of an output directory inside the checkout, and the committed-table check on both sides (empty table passes; marker, stray path and missing record each fail).
