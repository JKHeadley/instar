## What Changed

- **Releases are moving again.** npm is holding version 1.3.1384 as "staged" without ever listing it, so every publish since 18:03Z on 2026-10-21 tried to claim 1.3.1384 and failed with `E409 Cannot publish over previously staged version`. Two merges (#2275, #2277) did not ship. This sets package.json to 1.3.1385; the publish workflow uses package.json when it is ahead of npm, so the next release skips the stuck number.

## What to Tell Your User

Nothing changes in how instar behaves. The fixes from #2275 and #2277 arrive in 1.3.1385, and there will be no 1.3.1384.

## Evidence

- Publish runs 39649230045 and 39656475677 on main both end with `npm error 409 Conflict - PUT https://registry.npmjs.org/instar - Cannot publish over previously staged version "1.3.1384"`.
- `registry.npmjs.org/instar` lists `latest: 1.3.1383` and has no 1.3.1384 entry.

## Summary of New Capabilities

- None. This is a release-pipeline fix only.
