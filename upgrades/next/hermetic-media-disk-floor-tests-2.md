# One more media test no longer depends on the test machine's free disk

<!-- internal-only -->

## What Changed

tests/integration/mobile-remote-media-graph-seam.test.ts built a real App conversation service whose media store applied the production 5 percent disk floor to the host volume, so on a nearly full machine all three of its setups failed with 507 media-disk-floor (PR 3932's run on the M5). It now passes the service's existing mediaDiskSpace option with a fixed ample reading, as the other media integration tests already do. A search of the unit, integration and e2e tiers found no other fixture that writes media through a real store without a fixed reading. The production floor is unchanged.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).

## Evidence

PR 3932's M5 run (about 33 GB free against the 46.3 GiB floor) failed all three setups of this file with HTTP 507 media-disk-floor. The fix is the same fixed reading the passing media integration tests use (for example tests/integration/mobile-native-media.test.ts).
