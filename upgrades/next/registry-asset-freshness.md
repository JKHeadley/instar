<!-- internal-only -->

## What Changed

The two vitest globalSetup files that prepare the packed standards-registry asset
(`tests/setup/build-dist.globalSetup.ts` and
`tests/setup/ensure-registry-asset.globalSetup.ts`) decided whether to regenerate it
on PRESENCE alone — `if (outputs.every(exists)) return`. An asset generated from an
older revision of `docs/STANDARDS-REGISTRY.md` was therefore never regenerated.

Both now consult a shared `registryAssetIsStale()` helper that compares the oldest
output's mtime against the newest input's (`docs/STANDARDS-REGISTRY.md`,
`docs/standards-registry-floor.json`, `package.json`) — the same shape the sibling
`ensureDistBuilt()` twelve lines above already used.

## Evidence

- Measured 2026-08-15: in a checkout whose asset was generated at 17:59 from a source
  three hours newer, `standards-registry-asset`, `standards-enforcement-auditor` and
  `standards-coverage-route` failed with 8 assertions. Regenerating the asset alone
  made all 77 pass.
- `tests/unit/registry-asset-freshness.test.ts` — 9/9.
- Negative controls, both fired: reverting the comparison fails THE DEFECT case
  (1 failed / 8 passed); reverting one call site to the presence check fails the
  wiring case, naming the file. Both sources restored byte-exact.
- The wiring guard matches the MODULE SPECIFIER, not the imported identifier, so an
  aliased import cannot defeat it — the alias blindness found in an invariant test
  earlier this week.
- `tsc --noEmit` exit 0; full lint chain exit 0 across 45 lints.
