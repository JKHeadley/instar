<!-- internal-only -->
## What Changed

instar.sh now answers `/mac/appcast.xml` with a redirect to the Instar Mac app's signed update feed, stored on the `mac-app` GitHub release. The Mac app checks this address to update itself. The address is unlinked and no page changes.

## Evidence

`tests/unit/site-mac-appcast.test.ts` passes (302 to the release feed, no-store, not prerendered).
