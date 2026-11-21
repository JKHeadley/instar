<!-- bump: patch -->
## What Changed

The disk steward now measures the npm cache again after `npm cache clean`, and records what actually left. Before, an npm error recorded 0 freed even when nearly all of the cache was gone. On the Studio, 13.7 GB went to 0.34 GB and was recorded as 0.

## What to Tell Your User

Nothing to do. Disk cleanup reports now show the real amount freed.

## Summary of New Capabilities

- The npm cache cleanup's freed size is measured, not assumed.

## Evidence

- `tests/unit/diskSteward-pruneCategories.test.ts`: 4 new cases. With `diskSteward.test.ts`, 34 of 34 pass.
