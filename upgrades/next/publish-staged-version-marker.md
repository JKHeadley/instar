# Releases no longer reuse a version npm is still holding

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

npm can hold a freshly published version as "staged" for close to an hour before it shows up. A release run that started in that window picked the same version number again and npm refused it (E409, then 403). This happened twice in a day (1.3.1868 and 1.3.1873): three runs failed and merged work waited 60 to 150 minutes for the next release. Both publishers (`publish.yml` and `npm run release:local`) now push a `published/vX.Y.Z` tag the moment `npm publish` succeeds, before the smoke wait. The version resolver counts the highest `vX.Y.Z` or `published/vX.Y.Z` tag as already used, so the next run picks the next number.

## Evidence

- Unit: `tests/unit/resolve-publish-version.test.ts` (new staged-version cases, including the 1.3.1873 regression input).
- Manual: the resolver CLI with `--tags-from-git` on a real tag list resolves 1.3.1876 from npm 1.3.1875, and 1.3.1881 after a local `published/v1.3.1880` tag.
- Feedback: fb-354bb7b5-b5d.
