<!-- internal-only -->

## What Changed

Test-only: DesktopStreamManager pacing test now ends its first stream before measuring the second, so a loaded CI runner no longer leaks 67 ms timers into the faster measurement. No user-facing change.
